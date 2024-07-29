import type { NextApiRequest } from 'next';
import type { SearchTestProps } from '@/global/core/dataset/api.d';
import { authDataset } from '@fastgpt/service/support/permission/dataset/auth';
import { pushGenerateVectorUsage } from '@/service/support/wallet/usage/push';
import { searchDatasetData } from '@fastgpt/service/core/dataset/search/controller';
import { updateApiKeyUsage } from '@fastgpt/service/support/openapi/tools';
import { UsageSourceEnum } from '@fastgpt/global/support/wallet/usage/constants';
import { getLLMModel } from '@fastgpt/service/core/ai/model';
import { datasetSearchQueryExtension } from '@fastgpt/service/core/dataset/search/utils';
import {
  checkTeamAIPoints,
  checkTeamReRankPermission
} from '@fastgpt/service/support/permission/teamLimit';
import { NextAPI } from '@/service/middleware/entry';
import { ReadPermissionVal } from '@fastgpt/global/support/permission/constant';
import { CommonErrEnum } from '@fastgpt/global/common/error/code/common';

async function handler(req: NextApiRequest) {
  const {
    datasetId,
    text,
    limit = 1500,
    similarity,
    searchMode,
    usingReRank,

    datasetSearchUsingExtensionQuery = true,
    datasetSearchExtensionModel,
    datasetSearchExtensionBg = '',
    fileTag = '' // todo 测试的话可以添加默认值 TESTTAG
  } = req.body as SearchTestProps;

  if (!datasetId || !text) {
    return Promise.reject(CommonErrEnum.missingParams);
  }

  const start = Date.now();

  // auth dataset role：检测用户是否有知识库的“读”权限；
  const { dataset, teamId, tmbId, apikey } = await authDataset({
    req,
    authToken: true,
    authApiKey: true,
    datasetId,
    per: ReadPermissionVal
  });
  // auth balance: 检测团队的账户余额；
  await checkTeamAIPoints(teamId);

  // query extension: 检测是否开启问题补全配置，如开启则将对应的搜索文本、对话记录传给AI模型，重新生成检索文本；
  const extensionModel =
    datasetSearchUsingExtensionQuery && datasetSearchExtensionModel
      ? getLLMModel(datasetSearchExtensionModel)
      : undefined;
  const { concatQueries, rewriteQuery, aiExtensionResult } = await datasetSearchQueryExtension({
    query: text,
    extensionModel,
    extensionBg: datasetSearchExtensionBg
  });
  console.log('datasetSearchQueryExtension===', concatQueries, rewriteQuery, aiExtensionResult);

  // 去检索相关数据
  const { searchRes, tokens, ...result } = await searchDatasetData({
    teamId,
    reRankQuery: rewriteQuery,
    queries: concatQueries,
    model: dataset.vectorModel,
    limit: Math.min(limit, 20000),
    similarity,
    datasetIds: [datasetId],
    searchMode,
    usingReRank: usingReRank && (await checkTeamReRankPermission(teamId)),
    fileTag
  });

  // push bill: 更新团队的账单
  const { totalPoints } = pushGenerateVectorUsage({
    teamId,
    tmbId,
    tokens,
    model: dataset.vectorModel,
    source: apikey ? UsageSourceEnum.api : UsageSourceEnum.fastgpt,

    ...(aiExtensionResult &&
      extensionModel && {
        extensionModel: extensionModel.name,
        extensionTokens: aiExtensionResult.tokens
      })
  });
  // 更新apikey的使用记录
  if (apikey) {
    updateApiKeyUsage({
      apikey,
      totalPoints: totalPoints
    });
  }

  // 检索用时记录，返回检索结果
  return {
    list: searchRes,
    duration: `${((Date.now() - start) / 1000).toFixed(3)}s`,
    queryExtensionModel: aiExtensionResult?.model,
    ...result
  };
}

export default NextAPI(handler);
