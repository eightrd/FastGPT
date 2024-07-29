import {
  DatasetSearchModeEnum,
  DatasetSearchModeMap,
  SearchScoreTypeEnum
} from '@fastgpt/global/core/dataset/constants';
import { recallFromVectorStore } from '../../../common/vectorStore/controller';
import { getVectorsByText } from '../../ai/embedding';
import { getVectorModel } from '../../ai/model';
import { MongoDatasetData } from '../data/schema';
import {
  DatasetDataSchemaType,
  DatasetDataWithCollectionType,
  SearchDataResponseItemType
} from '@fastgpt/global/core/dataset/type';
import { DatasetColCollectionName, MongoDatasetCollection } from '../collection/schema';
import { reRankRecall } from '../../../core/ai/rerank';
import { countPromptTokens } from '../../../common/string/tiktoken/index';
import { datasetSearchResultConcat } from '@fastgpt/global/core/dataset/search/utils';
import { hashStr } from '@fastgpt/global/common/string/tools';
import { jiebaSplit } from '../../../common/string/jieba';
import { getCollectionSourceData } from '@fastgpt/global/core/dataset/collection/utils';
import { Types } from '../../../common/mongo';

type SearchDatasetDataProps = {
  teamId: string;
  model: string;
  similarity?: number; // min distance
  limit: number; // max Token limit
  datasetIds: string[];
  searchMode?: `${DatasetSearchModeEnum}`;
  usingReRank?: boolean;
  reRankQuery: string;
  queries: string[];
  fileTag?: string;
};

export async function searchDatasetData(props: SearchDatasetDataProps) {
  let {
    teamId,
    reRankQuery,
    queries,
    model,
    similarity = 0,
    limit: maxTokens, // 引用的 token上限；
    searchMode = DatasetSearchModeEnum.embedding, // 检索模式；
    usingReRank = false,
    datasetIds = [],
    fileTag
  } = props;

  // fileTag = '';

  /* init params */
  searchMode = DatasetSearchModeMap[searchMode] ? searchMode : DatasetSearchModeEnum.embedding;
  usingReRank = usingReRank && global.reRankModels.length > 0;

  // Compatible with topk limit
  let set = new Set<string>();
  let usingSimilarityFilter = false;

  /* function */
  const countRecallLimit = () => {
    if (searchMode === DatasetSearchModeEnum.embedding) {
      return {
        embeddingLimit: 100,
        fullTextLimit: 0
      };
    }
    if (searchMode === DatasetSearchModeEnum.fullTextRecall) {
      return {
        embeddingLimit: 0,
        fullTextLimit: 100
      };
    }
    return {
      embeddingLimit: 80,
      fullTextLimit: 60
    };
  };

  // 获取有文件tag，且非forbid的集合
  const getFileTagValidData = async () => {
    const collections = await MongoDatasetCollection.find(
      {
        teamId,
        datasetId: { $in: datasetIds },
        'metadata.fileTag': { $eq: fileTag },
        forbid: false
      },
      '_id'
    );

    return {
      fileTagValidCollectionIdList: (collections || []).map((item) => String(item._id))
    };
  };

  const getForbidData = async () => {
    const collections = await MongoDatasetCollection.find(
      {
        teamId,
        datasetId: { $in: datasetIds },
        forbid: true
      },
      '_id'
    );

    return {
      forbidCollectionIdList: collections.map((item) => String(item._id))
    };
  };
  const embeddingRecall = async ({
    query,
    limit,
    forbidCollectionIdList,
    fileTagValidCollectionIdList
  }: {
    query: string;
    limit: number;
    forbidCollectionIdList: string[];
    fileTagValidCollectionIdList: string[];
  }) => {
    // 获取查询语句的向量
    const { vectors, tokens } = await getVectorsByText({
      model: getVectorModel(model),
      input: query,
      type: 'query'
    });

    // 从向量存储中检索最相似的数据点
    const { results } = await recallFromVectorStore({
      teamId,
      datasetIds,
      vector: vectors[0],
      limit,
      forbidCollectionIdList,
      fileTagValidCollectionIdList
    });

    // get q and a: 使用MongoDatasetData模型查询MongoDB数据库
    const dataList = (await MongoDatasetData.find(
      {
        teamId,
        datasetId: { $in: datasetIds },
        collectionId: { $in: Array.from(new Set(results.map((item) => item.collectionId))) },
        'indexes.dataId': { $in: results.map((item) => item.id?.trim()) }
      },
      'datasetId collectionId q a chunkIndex indexes'
    ) // 使用 Mongoose 的 populate 方法来“填充”collectionId 字段。这意味着对于查询结果中的每个文档，它都会查找与 collectionId 关联的文档，并只返回这些关联文档的 name, fileId, rawLink, externalFileId, 和 externalFileUrl 字段。
      .populate('collectionId', 'name fileId rawLink externalFileId externalFileUrl')
      // 告诉 Mongoose 返回纯 JavaScript 对象，而不是 Mongoose 文档。这通常用于提高性能，因为 Mongoose 文档具有额外的功能（如保存、更新等），而这些功能在某些情况下可能不需要。
      .lean()) as DatasetDataWithCollectionType[];

    // add score to data(It's already sorted. The first one is the one with the most points) 将得分添加到每个数据记录中。
    const concatResults = dataList.map((data) => {
      const dataIdList = data.indexes.map((item) => item.dataId);

      const maxScoreResult = results.find((item) => {
        return dataIdList.includes(item.id);
      });

      return {
        ...data,
        score: maxScoreResult?.score || 0
      };
    });

    // 按照分数排序
    concatResults.sort((a, b) => b.score - a.score);

    const formatResult = concatResults.map((data, index) => {
      if (!data.collectionId) {
        console.log('Collection is not found', data);
      }

      const result: SearchDataResponseItemType = {
        id: String(data._id),
        q: data.q,
        a: data.a,
        chunkIndex: data.chunkIndex,
        datasetId: String(data.datasetId),
        collectionId: String(data.collectionId?._id),
        ...getCollectionSourceData(data.collectionId),
        score: [{ type: SearchScoreTypeEnum.embedding, value: data.score, index }]
      };

      return result;
    });

    return {
      embeddingRecallResults: formatResult,
      tokens
    };
  };
  const fullTextRecall = async ({
    query,
    limit
  }: {
    query: string;
    limit: number;
  }): Promise<{
    fullTextRecallResults: SearchDataResponseItemType[];
    tokenLen: number;
  }> => {
    if (limit === 0) {
      return {
        fullTextRecallResults: [],
        tokenLen: 0
      };
    }

    let searchResults = (
      await Promise.all(
        datasetIds.map(async (id) => {
          return MongoDatasetData.aggregate([
            {
              $match: {
                teamId: new Types.ObjectId(teamId),
                datasetId: new Types.ObjectId(id),
                $text: { $search: jiebaSplit({ text: query }) }
              }
            },
            {
              $addFields: {
                score: { $meta: 'textScore' }
              }
            },
            {
              $sort: {
                score: { $meta: 'textScore' }
              }
            },
            {
              $limit: limit
            },
            {
              $lookup: {
                from: DatasetColCollectionName,
                let: { collectionId: '$collectionId' },
                pipeline: [
                  {
                    $match: fileTag
                      ? {
                          $expr: { $eq: ['$_id', '$$collectionId'] },
                          forbid: { $eq: false },
                          'metadata.fileTag': { $eq: fileTag }
                        }
                      : {
                          $expr: { $eq: ['$_id', '$$collectionId'] },
                          forbid: { $eq: true }
                        }
                  },
                  {
                    $project: {
                      _id: 1 // 只需要_id字段来确认匹配
                    }
                  }
                ],
                as: 'collection'
              }
            },
            {
              $match: {
                collection: fileTag ? { $ne: [] } : { $eq: [] }
              }
            },
            {
              $project: {
                _id: 1,
                datasetId: 1,
                collectionId: 1,
                q: 1,
                a: 1,
                chunkIndex: 1,
                score: 1
              }
            }
          ]);
        })
      )
    ).flat() as (DatasetDataSchemaType & { score: number })[];

    // resort
    searchResults.sort((a, b) => b.score - a.score);
    searchResults.slice(0, limit);

    const collections = await MongoDatasetCollection.find(
      {
        _id: { $in: searchResults.map((item) => item.collectionId) }
      },
      '_id name fileId rawLink'
    );

    return {
      fullTextRecallResults: searchResults.map((item, index) => {
        const collection = collections.find((col) => String(col._id) === String(item.collectionId));
        return {
          id: String(item._id),
          datasetId: String(item.datasetId),
          collectionId: String(item.collectionId),
          ...getCollectionSourceData(collection),
          q: item.q,
          a: item.a,
          chunkIndex: item.chunkIndex,
          indexes: item.indexes,
          score: [{ type: SearchScoreTypeEnum.fullText, value: item.score, index }]
        };
      }),
      tokenLen: 0
    };
  };
  const reRankSearchResult = async ({
    data,
    query
  }: {
    data: SearchDataResponseItemType[];
    query: string;
  }): Promise<SearchDataResponseItemType[]> => {
    try {
      const results = await reRankRecall({
        query,
        documents: data.map((item) => ({
          id: item.id,
          text: `${item.q}\n${item.a}`
        }))
      });

      if (results.length === 0) {
        usingReRank = false;
        return [];
      }

      // add new score to data
      const mergeResult = results
        .map((item, index) => {
          const target = data.find((dataItem) => dataItem.id === item.id);
          if (!target) return null;
          const score = item.score || 0;

          return {
            ...target,
            score: [{ type: SearchScoreTypeEnum.reRank, value: score, index }]
          };
        })
        .filter(Boolean) as SearchDataResponseItemType[];

      return mergeResult;
    } catch (error) {
      usingReRank = false;
      return [];
    }
  };
  const multiQueryRecall = async ({
    embeddingLimit,
    fullTextLimit
  }: {
    embeddingLimit: number;
    fullTextLimit: number;
  }) => {
    // multi query recall
    const embeddingRecallResList: SearchDataResponseItemType[][] = [];
    const fullTextRecallResList: SearchDataResponseItemType[][] = [];
    let totalTokens = 0;

    let forbidCollectionIdList: string[] = [];
    let fileTagValidCollectionIdList: string[];

    // 如果搜索没有带fileTag参数，则按照原来逻辑，只过滤非禁用的集合
    if (!fileTag) {
      const forbidCollectionRes = await getForbidData();
      forbidCollectionIdList = forbidCollectionRes.forbidCollectionIdList;
    } else {
      // 如果搜索传入了fileTag, 则用过滤带tag并且非禁用的集合
      const res = await getFileTagValidData();
      fileTagValidCollectionIdList = res?.fileTagValidCollectionIdList;
    }

    console.log(
      '-------fileTagIdValidList, forbidCollectionIdList-----',
      fileTagValidCollectionIdList,
      forbidCollectionIdList
    );

    // 首先分别获取 embedding、fulltext 的召回语料；
    await Promise.all(
      queries.map(async (query) => {
        const [{ tokens, embeddingRecallResults }, { fullTextRecallResults }] = await Promise.all([
          embeddingRecall({
            query,
            limit: embeddingLimit,
            forbidCollectionIdList,
            fileTagValidCollectionIdList
          }),
          fullTextRecall({
            query,
            limit: fullTextLimit
          })
        ]);
        totalTokens += tokens;

        embeddingRecallResList.push(embeddingRecallResults);
        fullTextRecallResList.push(fullTextRecallResults);
      })
    );

    // rrf concat
    const rrfEmbRecall = datasetSearchResultConcat(
      embeddingRecallResList.map((list) => ({ k: 60, list }))
    ).slice(0, embeddingLimit);
    const rrfFTRecall = datasetSearchResultConcat(
      fullTextRecallResList.map((list) => ({ k: 60, list }))
    ).slice(0, fullTextLimit);

    return {
      tokens: totalTokens,
      embeddingRecallResults: rrfEmbRecall,
      fullTextRecallResults: rrfFTRecall
    };
  };

  /* main step */
  // count limit: 根据检索模式设置向量检索和文本检索的限制
  const { embeddingLimit, fullTextLimit } = countRecallLimit();

  // recall
  const { embeddingRecallResults, fullTextRecallResults, tokens } = await multiQueryRecall({
    embeddingLimit,
    fullTextLimit
  });
  // console.log('---multiQueryRecall---', embeddingRecallResults, fullTextRecallResults);

  // ReRank results
  const reRankResults = await (async () => {
    if (!usingReRank) return [];

    set = new Set<string>(embeddingRecallResults.map((item) => item.id));
    const concatRecallResults = embeddingRecallResults.concat(
      fullTextRecallResults.filter((item) => !set.has(item.id))
    );

    // remove same q and a data
    set = new Set<string>();
    const filterSameDataResults = concatRecallResults.filter((item) => {
      // 删除所有的标点符号与空格等，只对文本进行比较
      const str = hashStr(`${item.q}${item.a}`.replace(/[^\p{L}\p{N}]/gu, ''));
      if (set.has(str)) return false;
      set.add(str);
      return true;
    });
    return reRankSearchResult({
      query: reRankQuery,
      data: filterSameDataResults
    });
  })();

  // embedding recall and fullText recall rrf concat:对重复的数据去重并使用最高得分；计算 rrfScore 并以其为依据排序；
  const rrfConcatResults = datasetSearchResultConcat([
    { k: 60, list: embeddingRecallResults },
    { k: 60, list: fullTextRecallResults },
    { k: 58, list: reRankResults }
  ]);

  // remove same q and a data: 结果去重
  set = new Set<string>();
  const filterSameDataResults = rrfConcatResults.filter((item) => {
    // 删除所有的标点符号与空格等，只对文本进行比较
    const str = hashStr(`${item.q}${item.a}`.replace(/[^\p{L}\p{N}]/gu, ''));
    if (set.has(str)) return false;
    set.add(str);
    return true;
  });

  // score filter：根据用户设置的最小分数过滤数据
  const scoreFilter = (() => {
    if (usingReRank) {
      usingSimilarityFilter = true;

      return filterSameDataResults.filter((item) => {
        const reRankScore = item.score.find((item) => item.type === SearchScoreTypeEnum.reRank);
        if (reRankScore && reRankScore.value < similarity) return false;
        return true;
      });
    }
    if (searchMode === DatasetSearchModeEnum.embedding) {
      usingSimilarityFilter = true;
      return filterSameDataResults.filter((item) => {
        const embeddingScore = item.score.find(
          (item) => item.type === SearchScoreTypeEnum.embedding
        );
        if (embeddingScore && embeddingScore.value < similarity) return false;
        return true;
      });
    }
    return filterSameDataResults;
  })();

  // token filter
  const filterMaxTokensResult = await (async () => {
    const tokensScoreFilter = await Promise.all(
      scoreFilter.map(async (item) => ({
        ...item,
        tokens: await countPromptTokens(item.q + item.a)
      }))
    );

    const results: SearchDataResponseItemType[] = [];
    let totalTokens = 0;

    for await (const item of tokensScoreFilter) {
      totalTokens += item.tokens;

      if (totalTokens > maxTokens + 500) {
        break;
      }
      results.push(item);
      if (totalTokens > maxTokens) {
        break;
      }
    }

    return results.length === 0 ? scoreFilter.slice(0, 1) : results;
  })();

  return {
    searchRes: filterMaxTokensResult,
    tokens,
    searchMode,
    limit: maxTokens,
    similarity,
    usingReRank,
    usingSimilarityFilter
  };
}
