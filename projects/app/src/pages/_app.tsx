import type { AppProps } from 'next/app';
import Script from 'next/script';

import Layout from '@/components/Layout';
import { appWithTranslation } from 'next-i18next';

import QueryClientContext from '@/web/context/QueryClient';
import ChakraUIContext from '@/web/context/ChakraUI';
import I18nContextProvider from '@/web/context/I18n';
import { useInitApp } from '@/web/context/useInitApp';

import '@/web/styles/reset.scss';
import NextHead from '@/components/common/NextHead';

// 函数App接收一个AppProps类型的参数
function App({ Component, pageProps }: AppProps) {
  // 使用useInitApp获取feConfigs、scripts、title
  const { feConfigs, scripts, title } = useInitApp();

  // 返回一个包含NextHead、scripts、Layout、Component的组件
  return (
    <>
      <NextHead
        title={title}
        // 获取description
        desc={
          feConfigs?.systemDescription ||
          process.env.SYSTEM_DESCRIPTION ||
          // 默认description
          `${title} 是一个大模型应用编排系统，提供开箱即用的数据处理、模型调用等能力，可以快速的构建知识库并通过 Flow 可视化进行工作流编排，实现复杂的知识库场景！`
        }
        // 获取favicon
        icon={feConfigs?.favicon || process.env.SYSTEM_FAVICON}
      />
      {scripts?.map((item, i) => <Script key={i} strategy="lazyOnload" {...item}></Script>)}

      <QueryClientContext>
        <I18nContextProvider>
          <ChakraUIContext>
            <Layout>
              <Component {...pageProps} />
            </Layout>
          </ChakraUIContext>
        </I18nContextProvider>
      </QueryClientContext>
    </>
  );
}

// 使用next-i18next库，将App函数转换为可翻译的函数
export default appWithTranslation(App);
