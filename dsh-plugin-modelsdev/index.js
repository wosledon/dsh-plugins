/**
 * 宿主侧：把 models.dev 目录挂成一条只读 HTTP 路由。
 *
 * 浏览器半（`./client`）在“设置 → 模型”页底部渲染目录浏览器；它需要的目录
 * 数据由这里提供，原因有三个：
 *
 *   - 目录原始 JSON 约 6 MB、投影后约 1.2 MB，放在宿主进程里只抓一次；
 *   - 浏览器不需要处理 models.dev 的跨域/网络失败；
 *   - 页面刷新不会重新下载整包，缓存生命周期由宿主统一管理。
 *
 * 路由默认是 `/plugin-modelsdev/catalog`，只接受 GET/HEAD。它不属于 `/api`
 * 命名空间，因此不经过 RPC 网关，浏览器用同源 fetch 就能读到。
 */

import { CATALOG_PATH, CATALOG_URL, createCatalogService } from './lib/catalog.js';

/** 允许用环境变量指向镜像；默认使用 models.dev 官方目录。 */
function catalogUrl() {
  try {
    const override = typeof process === 'object' && process !== null ? process.env?.DSH_MODELSDEV_URL : undefined;
    if (typeof override === 'string' && /^https?:\/\/\S+$/.test(override)) return override;
  } catch {
    /* 读取环境变量失败时退回官方地址 */
  }
  return CATALOG_URL;
}

export function apply(ctx) {
  const service = createCatalogService({
    url: catalogUrl(),
    log(message, error) {
      try {
        const logger = ctx.logger;
        if (logger !== undefined && logger !== null && typeof logger.warn === 'function') {
          logger.warn(message, error);
        }
      } catch {
        /* 日志出口不可用时保持安静 */
      }
    },
  });

  // 只依赖 webServer：没有 Web 表面的 profile 里插件保持休眠，而不是加载失败。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: CATALOG_PATH,
        handler: (req, res) => service.serve(req, res),
      }),
      'modelsdev: catalog route',
    );
  });
}
