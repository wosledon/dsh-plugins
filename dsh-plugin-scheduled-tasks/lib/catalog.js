/**
 * 模型目录。
 *
 * 为什么目录要由宿主写进 Config：客户端的 `ctx.remote` 只有 `listProviders` /
 * `listConfigurableProviders` 两个 `@Remote` 方法，`llm.listModels()` 与
 * `llm.resolveModelInfo()`（推理强度元数据就在那里）**不对客户端开放**。
 * 而 `remote.settings` 是唯一可用的读写通道，所以让宿主把目录算好、
 * 写成只读字段 `internal.catalog`，客户端在它已经在读的那次 `describe()`
 * 里一并拿到——不引入任何新依赖。
 *
 * 刷新策略：装在调度器的 tick 上，但用**长得多的周期**（默认 10 分钟）。
 * 模型目录变化很慢，没必要跟着 30 秒的任务检查刷；而完全不刷又会让
 * 新配置的供应商在客户端选不到。
 */
import { CONFIG_NS } from './config.js';

/** 目录刷新周期（毫秒）。 */
export const CATALOG_TTL_MS = 600_000;

/**
 * 目录为空时的重试周期（毫秒），远短于 TTL。
 * 空目录通常只是"还没准备好"，按 TTL 等 10 分钟会让界面长时间选不到模型。
 */
export const CATALOG_EMPTY_RETRY_MS = 45_000;

/**
 * 从宿主 llm 服务构建模型目录。
 *
 * 全程鸭子类型 + 逐层降级：某个供应商列模型失败只跳过它，绝不抛异常。
 * 目录是「让界面有东西可选」，不是功能正确性的前提——真到运行时如果 provider
 * 或 model 无效，`createAgent` 会报错，那次运行记 `error`，不会白屏。
 *
 * @param {object} ctx 宿主 plugin context
 * @returns {Promise<{ providers: object[], builtAt: number }>}
 */
export async function buildCatalog(ctx) {
  const empty = { providers: [], builtAt: Date.now() };
  const llm = ctx !== null && typeof ctx === 'object' ? ctx.get?.('llm') : undefined;
  if (llm === undefined || llm === null) return empty;

  const rawProviders = await tryCall(llm, 'listProviders');
  if (!Array.isArray(rawProviders)) return empty;

  // 两个来源都要：`listProviders` 覆盖已注册适配器，`listConfigurableProviders`
  // 覆盖手工声明的路由（例如 profile 里自己配的 stepfun）。后者只在前者
  // 缺失时补位，不重复列出同一个供应商。
  const merge = [...rawProviders];
  try {
    const configurable = await llm.listConfigurableProviders();
    if (Array.isArray(configurable)) {
      const known = new Set(merge.map((entry) => idOf(entry)).filter((id) => id !== undefined));
      for (const entry of configurable) {
        const id = idOf(entry);
        if (id === undefined || known.has(id)) continue;
        known.add(id);
        merge.push(entry);
      }
    }
  } catch {
    /* 目录来源少一个不影响用 */
  }

  const providers = [];
  for (const entry of merge) {
    if (entry === null || typeof entry !== 'object') continue;
    const id = idOf(entry);
    if (id === undefined) continue;

    const models = [];
    const rawModels = await tryCall(llm, 'listModels', id);
    const rawList = Array.isArray(rawModels) ? rawModels : [];
    for (const model of rawList) {
      if (model === null || typeof model !== 'object') continue;
      if (typeof model.id !== 'string' || model.id === '') continue;
      // 推理强度在两个来源都可能出现：listModels 直接给，或用 resolveModelInfo 补。
      let reasoning = isObject(model.reasoning) ? model.reasoning : undefined;
      if (reasoning === undefined && typeof llm.resolveModelInfo === 'function') {
        const resolved = await tryCall(llm, 'resolveModelInfo', id, model.id);
        if (isObject(resolved) && isObject(resolved.reasoning)) reasoning = resolved.reasoning;
      }
      models.push({
        id: model.id,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
        ...(typeof model.description === 'string' && model.description !== '' ? { description: model.description } : {}),
        efforts: effortsOf(reasoning),
        ...(isObject(reasoning) && typeof reasoning.defaultEffort === 'string'
          ? { defaultEffort: reasoning.defaultEffort }
          : {}),
      });
    }
    if (models.length === 0) continue;

    providers.push({
      id,
      displayName: typeof entry.displayName === 'string' && entry.displayName !== ''
        ? entry.displayName
        : id,
      models,
    });
  }

  return { providers, builtAt: Date.now() };
}

/**
 * 把 `reasoning` 归一化成一串可选强度。
 * 只保留 id/name，description 对界面没用（会显著放大 Config 体积）。
 */
function effortsOf(reasoning) {
  const efforts = isObject(reasoning) && Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
  const out = [];
  for (const effort of efforts) {
    if (effort === null || typeof effort !== 'object') continue;
    if (typeof effort.id !== 'string' || effort.id === '') continue;
    out.push({
      id: effort.id,
      name: typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id,
    });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * 目录是否该重建。
 *
 * 三种情况都算「该重建」：
 *   1. 从没建过（缺字段）；
 *   2. **建出来是空的**——这几乎总是暂时的（llm 服务还没装配好、
 *      某个适配器初始化慢），用空目录去等满 10 分钟 TTL 会让界面在
 *      这一段时间里完全选不到模型。空目录按短周期重试；
 *   3. 超过 TTL。
 *
 * @param {unknown} catalog
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function catalogStale(catalog, nowMs = Date.now()) {
  if (!isObject(catalog) || !Array.isArray(catalog.providers)) return true;
  if (!Number.isFinite(catalog.builtAt)) return true;
  const age = nowMs - Number(catalog.builtAt);
  if (catalog.providers.length === 0) return age > CATALOG_EMPTY_RETRY_MS;
  return age > CATALOG_TTL_MS;
}

/** 在目录里找某个模型的推理强度选项；找不到返回空数组。 */
export function effortsFor(catalog, provider, model) {
  if (!isObject(catalog) || !Array.isArray(catalog.providers)) return [];
  const entry = catalog.providers.find((item) => item !== null && typeof item === 'object' && item.id === provider);
  if (entry === undefined) return [];
  const found = entry.models.find((item) => item !== null && typeof item === 'object' && item.id === model);
  if (found === undefined || !Array.isArray(found.efforts)) return [];
  return found.efforts;
}

/**
 * 取供应商 id：`id` 优先，其次 `provider`。
 * 两个来源的字段名不同（`listProviders` 用 id，`listConfigurableProviders` 用 provider）。
 */
function idOf(entry) {
  if (entry === null || typeof entry !== 'object') return undefined;
  if (typeof entry.id === 'string' && entry.id !== '') return entry.id;
  if (typeof entry.provider === 'string' && entry.provider !== '') return entry.provider;
  return undefined;
}

async function tryCall(service, method, ...args) {
  try {
    const fn = service[method];
    if (typeof fn !== 'function') return undefined;
    return await fn.call(service, ...args);
  } catch {
    return undefined;
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null;
}
