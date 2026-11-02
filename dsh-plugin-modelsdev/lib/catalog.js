/**
 * models.dev 目录：宿主侧的抓取、缓存与 HTTP 路由。
 *
 * 这个模块只做三件事：
 *   1. 从 https://models.dev/api.json 取回原始目录（235 个供应商、约 9 千个模型）；
 *   2. 把它投影成设置页真正需要的紧凑结构（剔除弃用模型、嵌入/图像/语音等
 *      非对话模型，丢掉长描述），整包约 1.2 MB；
 *   3. 通过 `/plugin-modelsdev/catalog` 把缓存结果交给浏览器半。
 *
 * 缓存是**进程内**的：DSH 重启后第一次打开设置页会重新抓取一次。抓取失败时，
 * 只要手里还有旧缓存就照旧返回（带 `stale` 标记），设置页不会因为 models.dev
 * 临时不可用而变空。
 *
 * 所有函数都不依赖 Cordis：`index.js` 只负责把 `serve` 挂到 webServer 上，
 * 自检脚本也可以直接 import 本文件做纯函数断言。
 */

/** models.dev 的公共目录地址。 */
export const CATALOG_URL = 'https://models.dev/api.json';

/** 本插件独占的只读路由，必须与 client.js 中的常量一致。 */
export const CATALOG_PATH = '/plugin-modelsdev/catalog';

/** 默认缓存 6 小时。 */
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/** 单次上游请求的超时。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 上游响应体的上限；当前目录约 6 MB，留出充足余量。 */
export const MAX_UPSTREAM_BYTES = 64 * 1024 * 1024;

/**
 * models.dev 的 `type` 字段描述模型用途。DSH 的模型选择器只为对话模型工作，
 * 所以这些类型全部剔除；没有 `type` 的条目按对话模型处理（当前目录里绝大多数
 * 都是这种）。
 */
export const NON_CHAT_MODEL_TYPES = new Set([
  'embedding',
  'image',
  'realtime',
  'reranking',
  'speech',
  'transcription',
  'video',
]);

/** pi-ai 的推理等级词汇表；models.dev 的 `none` 在这里对应 `off`。 */
const KNOWN_EFFORT_NAMES = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const EFFORT_ALIASES = new Map([
  ['none', 'off'],
  ['off', 'off'],
  ['minimal', 'minimal'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['xhigh', 'xhigh'],
  ['max', 'max'],
]);

function positiveInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function readableName(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * 把一条 `reasoning_options` 读成去重后的等级名。
 *
 * 目录里同一个模型的推理选项可能是单个对象，也可能是数组；`type: 'effort'`
 * 的 `values` 既可能是数组，也可能是空格分隔的字符串。`toggle` /
 * `budget_tokens` 不是「选择器等级」，这里不猜测它们的网线拼写。
 */
export function reasoningEffortNames(options) {
  const list = Array.isArray(options) ? options : options === undefined || options === null ? [] : [options];
  const names = [];
  for (const option of list) {
    if (option === null || typeof option !== 'object') continue;
    if (option.type !== 'effort') continue;
    let values = option.values;
    if (typeof values === 'string') values = values.split(/[\s,]+/);
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const alias = EFFORT_ALIASES.get(value.trim().toLowerCase());
      if (alias === undefined || !KNOWN_EFFORT_NAMES.has(alias) || names.includes(alias)) continue;
      names.push(alias);
    }
  }
  return names;
}

/**
 * 投影一条模型；不是 DSH 能用的对话模型时返回 `undefined`。
 *
 * 紧凑字段刻意很短（`context` / `maxTokens` / `image`），因为整包会随设置页
 * 加载一次，体积直接影响打开速度。
 */
export function compactModel(model) {
  if (model === null || typeof model !== 'object') return undefined;
  if (typeof model.id !== 'string' || model.id === '') return undefined;
  if (NON_CHAT_MODEL_TYPES.has(model.type) || model.status === 'deprecated') return undefined;

  const inputs = Array.isArray(model.modalities?.input) ? model.modalities.input : [];
  // 输入模态明确不含文本的模型（例如纯图像模型）不能用作对话模型。
  if (inputs.length > 0 && !inputs.includes('text')) return undefined;

  const record = { id: model.id };
  if (typeof model.name === 'string' && model.name !== '' && model.name !== model.id) {
    record.name = model.name;
  }
  const context = positiveInteger(model.limit?.context);
  if (context !== undefined) record.context = context;
  const maxTokens = positiveInteger(model.limit?.output);
  if (maxTokens !== undefined) record.maxTokens = maxTokens;
  if (inputs.includes('image')) record.image = true;
  if (model.reasoning === true) {
    record.reasoning = true;
    const efforts = reasoningEffortNames(model.reasoning_options);
    if (efforts.length > 0) record.efforts = efforts;
  }
  return record;
}

/**
 * 投影一个供应商；没有任何可用对话模型时返回 `undefined`。
 *
 * `api` 只接受静态 http(s) 地址。像 `https://${HOST}/v1` 这种占位符地址没有
 * 可用默认值，投影时丢弃，由设置页要求用户手填 —— 猜测一个地址比留空更糟。
 */
export function compactProvider(provider) {
  if (provider === null || typeof provider !== 'object') return undefined;
  if (typeof provider.id !== 'string' || provider.id === '') return undefined;
  if (provider.models === null || typeof provider.models !== 'object') return undefined;

  const models = [];
  for (const model of Object.values(provider.models)) {
    const record = compactModel(model);
    if (record !== undefined) models.push(record);
  }
  if (models.length === 0) return undefined;

  const record = {
    id: provider.id,
    name: readableName(provider.name, provider.id),
    npm: typeof provider.npm === 'string' ? provider.npm : '',
    env: Array.isArray(provider.env)
      ? provider.env.filter((name) => typeof name === 'string' && name !== '')
      : [],
    models,
  };
  if (typeof provider.api === 'string' && /^https?:\/\/\S+$/.test(provider.api) && !provider.api.includes('${')) {
    record.api = provider.api.replace(/\/+$/, '');
  }
  if (typeof provider.doc === 'string' && /^https?:\/\/\S+$/.test(provider.doc)) {
    record.doc = provider.doc;
  }
  return record;
}

/**
 * 把 models.dev 的原始 `api.json` 投影成紧凑目录。
 *
 * 输入形状是「以 provider id 为键的对象」；任何非对象输入都视为无效目录，
 * 直接抛错，避免把上游的维护页/错误页当成合法数据缓存下来。
 */
export function projectCatalog(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('models.dev catalog is not an object');
  }
  const providers = [];
  for (const provider of Object.values(raw)) {
    const record = compactProvider(provider);
    if (record !== undefined) providers.push(record);
  }
  providers.sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }) || left.id.localeCompare(right.id));
  return { providers };
}

function messageOf(error) {
  if (error instanceof Error && error.message !== '') return error.message;
  return String(error);
}

function sendJson(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/**
 * 创建目录服务。
 *
 * @param {object} [options]
 * @param {string} [options.url]      上游地址，默认 models.dev。
 * @param {number} [options.ttlMs]    缓存有效期。
 * @param {number} [options.timeoutMs] 单次抓取超时。
 * @param {() => number} [options.now] 可注入时钟，供自检使用。
 * @param {typeof fetch} [options.fetchImpl] 可注入 fetch，供自检使用。
 * @param {(message: string, error?: unknown) => void} [options.log] 失败日志出口。
 */
export function createCatalogService(options = {}) {
  const url = options.url ?? CATALOG_URL;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = typeof options.log === 'function' ? options.log : () => {};

  /** @type {{ payload: string, fetchedAt: number, stale: boolean, error?: string } | undefined} */
  let cache;
  let inflight;

  async function fetchOnce() {
    if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable');
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'dsh-plugin-modelsdev/0.1.0',
      },
      redirect: 'follow',
      signal,
    });
    if (response === null || typeof response !== 'object' || response.ok !== true) {
      const status = response !== null && typeof response === 'object' ? response.status : 'no response';
      throw new Error(`models.dev responded ${status}`);
    }
    const text = await response.text();
    if (typeof text !== 'string') throw new Error('models.dev returned no body');
    if (text.length === 0) throw new Error('models.dev returned an empty body');
    if (text.length > MAX_UPSTREAM_BYTES) throw new Error('models.dev catalog exceeds the size limit');
    const raw = JSON.parse(text);
    const { providers } = projectCatalog(raw);
    return {
      payload: JSON.stringify({
        version: 1,
        source: url,
        fetchedAt: now(),
        providers,
      }),
      fetchedAt: now(),
    };
  }

  /**
   * 读取目录。`force` 跳过缓存；抓取失败时只要有旧缓存就返回旧缓存。
   * 并发调用共享同一个在途请求。
   */
  async function load({ force = false } = {}) {
    if (!force && cache !== undefined && now() - cache.fetchedAt < ttlMs) return cache;
    if (inflight !== undefined) return inflight;
    inflight = (async () => {
      try {
        const fresh = await fetchOnce();
        cache = { ...fresh, stale: false };
        return cache;
      } catch (error) {
        const message = messageOf(error);
        log('models.dev catalog fetch failed', error);
        if (cache !== undefined) {
          cache = { ...cache, stale: true, error: message };
          return cache;
        }
        throw error;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  }

  function snapshot() {
    return cache === undefined ? undefined : { ...cache };
  }

  /**
   * webServer 的 exact 路由处理函数。只接受 GET / HEAD；未知路径返回 404，
   * 其它方法返回 405。上游失败且无缓存时返回 502 和结构化错误。
   */
  async function serve(req, res) {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname !== CATALOG_PATH) {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown models.dev catalog path' } });
        return;
      }
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET' } }, { allow: 'GET, HEAD' });
        return;
      }
      const force = new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1';
      const entry = await load({ force });
      if (method === 'HEAD') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-modelsdev-fetched-at': String(entry.fetchedAt),
          'x-modelsdev-stale': entry.stale === true ? '1' : '0',
        });
        res.end();
        return;
      }
      sendJson(res, 200, entry.payload, {
        'x-modelsdev-fetched-at': String(entry.fetchedAt),
        'x-modelsdev-stale': entry.stale === true ? '1' : '0',
      });
    } catch (error) {
      log('models.dev catalog route failed', error);
      if (!res.headersSent) {
        sendJson(res, 502, {
          error: { code: 'MODELSDEV_UPSTREAM', message: messageOf(error) },
        });
      } else {
        res.destroy();
      }
    }
  }

  return { load, serve, snapshot };
}
