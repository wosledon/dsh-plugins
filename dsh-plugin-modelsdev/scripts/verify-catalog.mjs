/**
 * models.dev 插件的自检脚本（零第三方依赖）。
 *
 * 覆盖两层：
 *   1. 宿主目录服务：原始目录投影、缓存/过期/强制刷新/失败回退、HTTP 路由；
 *   2. 浏览器半的纯映射：协议推断、端点归一化、凭据引用、模型/供应商 profile、
 *      导入前校验。
 *
 * 运行：
 *   node scripts/verify-catalog.mjs
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  CATALOG_PATH,
  compactModel,
  createCatalogService,
  projectCatalog,
  reasoningEffortNames,
} from '../lib/catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let checks = 0;

function ok(value, message) {
  assert.ok(value, message);
  checks += 1;
}

function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}

/* ------------------------------------------------------------------ */
/* 1. 投影                                                             */
/* ------------------------------------------------------------------ */

const fixture = {
  zeta: {
    id: 'zeta',
    name: 'Zeta',
    api: 'https://z.example/v1/',
    npm: '@ai-sdk/openai-compatible',
    env: ['ZETA_API_KEY'],
    doc: 'https://docs.z.example',
    models: {
      'z-1': {
        id: 'z-1',
        name: 'Z One',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high', 'high', 'ultra'] }],
        limit: { context: 200000, output: 64000 },
        modalities: { input: ['text', 'image', 'pdf'] },
      },
      'z-embed': { id: 'z-embed', type: 'embedding' },
      'z-old': { id: 'z-old', status: 'deprecated' },
      'z-image': { id: 'z-image', modalities: { input: ['image'] } },
      'z-2': { id: 'z-2' },
    },
  },
  alpha: {
    id: 'alpha',
    name: 'Alpha',
    api: 'https://${HOST}/v1',
    npm: '@ai-sdk/anthropic',
    env: 'not-an-array',
    models: {
      'a-1': { id: 'a-1', limit: { context: 1000 } },
    },
  },
  empty: { id: 'empty', models: {} },
};

const projected = projectCatalog(fixture);
equal(projected.providers.length, 2, 'providers with at least one chat model survive');
equal(projected.providers.map((provider) => provider.id), ['alpha', 'zeta'], 'providers sort by display name');
equal(projected.providers[1].api, 'https://z.example/v1', 'trailing slash is trimmed from api');
equal(projected.providers[1].doc, 'https://docs.z.example', 'doc is kept');
equal(projected.providers[1].env, ['ZETA_API_KEY'], 'env is copied');
equal(projected.providers[0].api, undefined, 'placeholder api is dropped');
equal(projected.providers[0].env, [], 'non-array env becomes empty');
equal(projected.providers[1].models.map((model) => model.id), ['z-1', 'z-2'], 'non-chat and deprecated models are dropped');
const zOne = projected.providers[1].models[0];
equal(zOne.name, 'Z One', 'display name differs from id and is kept');
equal(zOne.context, 200000, 'context limit is projected');
equal(zOne.maxTokens, 64000, 'output limit is projected');
equal(zOne.image, true, 'image modality is projected');
equal(zOne.reasoning, true, 'reasoning flag is projected');
equal(zOne.efforts, ['off', 'low', 'high'], 'effort values are aliased, deduped and filtered');
ok(!('cost' in zOne), 'pricing is not sent to the browser');
equal(projected.providers[0].models[0].context, 1000, 'context survives for catalog routes');
assert.throws(() => projectCatalog(null), /not an object/);
checks += 1;

equal(reasoningEffortNames([{ type: 'effort', values: 'low medium max' }]), ['low', 'medium', 'max'], 'space separated effort values are split');
equal(reasoningEffortNames([{ type: 'toggle' }, { type: 'budget_tokens' }]), [], 'toggle and budget options are not mistaken for levels');
equal(reasoningEffortNames([{ type: 'effort', values: ['none', 'none', 'minimal'] }]), ['off', 'minimal'], 'none aliases to off and duplicates collapse');

equal(compactModel({ id: 'm', type: 'embedding' }), undefined, 'embedding models are not projected');
equal(compactModel({ id: 'm', modalities: { input: ['video'] } }), undefined, 'models without text input are not projected');

/* ------------------------------------------------------------------ */
/* 2. 缓存与路由                                                        */
/* ------------------------------------------------------------------ */

const rawText = JSON.stringify(fixture);

function responseOf(text, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() { return text; },
  };
}

function mockResponse() {
  return {
    headersSent: false,
    status: 0,
    headers: {},
    body: '',
    destroyed: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
      this.headersSent = true;
    },
    end(body) {
      this.body = body ?? '';
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

{
  let calls = 0;
  let clock = 1000;
  const service = createCatalogService({
    fetchImpl: async () => { calls += 1; return responseOf(rawText); },
    now: () => clock,
    ttlMs: 1000,
  });
  const first = await service.load();
  equal(calls, 1, 'first load fetches upstream');
  equal(JSON.parse(first.payload).providers.length, 2, 'payload carries the projected providers');
  await service.load();
  equal(calls, 1, 'fresh cache avoids a second fetch');
  clock += 2000;
  await service.load();
  equal(calls, 2, 'expired cache fetches again');
  await service.load({ force: true });
  equal(calls, 3, 'force bypasses the cache');
  ok(service.snapshot() !== undefined, 'snapshot exposes the cached entry');
}

{
  let calls = 0;
  let fail = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = createCatalogService({
    fetchImpl: async () => {
      calls += 1;
      if (fail) return responseOf('', { ok: false, status: 503 });
      await gate;
      return responseOf(rawText);
    },
    now: () => 1,
    ttlMs: 0,
  });
  const left = service.load();
  const right = service.load();
  release();
  const [a, b] = await Promise.all([left, right]);
  equal(calls, 1, 'concurrent loads share one in-flight fetch');
  ok(a === b, 'concurrent loads resolve the same entry');
  await service.load();
  equal(calls, 2, 'zero ttl refetches');
  fail = true;
  const stale = await service.load();
  equal(stale.stale, true, 'failed refresh serves the stale cache');
  ok(JSON.parse(stale.payload).providers.length === 2, 'stale cache keeps the previous catalog');
  ok(typeof stale.error === 'string' && stale.error.includes('503'), 'stale cache records the upstream failure');
}

{
  const service = createCatalogService({
    fetchImpl: async () => { throw new Error('boom'); },
    now: () => 1,
    ttlMs: 0,
  });
  await assert.rejects(() => service.load(), /boom/);
  checks += 1;
  const res = mockResponse();
  await service.serve({ method: 'GET', url: CATALOG_PATH }, res);
  equal(res.status, 502, 'route reports 502 when upstream fails without cache');
  equal(JSON.parse(res.body).error.code, 'MODELSDEV_UPSTREAM', 'route error is structured');
}

{
  const service = createCatalogService({
    fetchImpl: async () => responseOf(rawText),
    now: () => 5,
    ttlMs: 60000,
  });
  const res = mockResponse();
  await service.serve({ method: 'GET', url: CATALOG_PATH }, res);
  equal(res.status, 200, 'route serves the catalog');
  equal(res.headers['content-type'], 'application/json; charset=utf-8', 'route sets a JSON content type');
  equal(res.headers['x-modelsdev-stale'], '0', 'fresh response is marked fresh');
  equal(res.headers['x-modelsdev-fetched-at'], '5', 'response exposes the fetch timestamp');
  equal(JSON.parse(res.body).version, 1, 'payload is versioned');

  const head = mockResponse();
  await service.serve({ method: 'HEAD', url: CATALOG_PATH }, head);
  equal(head.status, 200, 'HEAD is accepted');
  equal(head.body, '', 'HEAD has no body');

  const missing = mockResponse();
  await service.serve({ method: 'GET', url: '/nope' }, missing);
  equal(missing.status, 404, 'unknown path is rejected');

  const wrongMethod = mockResponse();
  await service.serve({ method: 'POST', url: CATALOG_PATH }, wrongMethod);
  equal(wrongMethod.status, 405, 'POST is rejected');
  equal(wrongMethod.headers.allow, 'GET, HEAD', '405 advertises allowed methods');
}

/* ------------------------------------------------------------------ */
/* 3. 浏览器半的纯映射                                                  */
/* ------------------------------------------------------------------ */

let definition;
globalThis.window = {
  __ModuleLoader__: {
    load(value) { definition = value; },
  },
};
await import(pathToFileURL(path.join(here, '..', 'client.js')).href + '?verify=1');
ok(definition !== undefined && definition.id === 'dsh-plugin-modelsdev', 'client bundle registers under the package name');

const client = definition.factory((name) => {
  if (name !== 'react') throw new Error('unexpected require ' + name);
  return { createElement() {}, useState() {}, useCallback() {}, useEffect() {}, useMemo() {} };
});
const pure = client.__internals;
ok(Array.isArray(client.inject) && client.inject.includes('remote.settings'), 'client declares the settings dependency');
equal(typeof client.apply, 'function', 'client exports apply');

equal(pure.protocolFor({ npm: '@ai-sdk/anthropic' }), 'anthropic-messages', 'anthropic npm maps to Messages');
equal(pure.protocolFor({ npm: '@ai-sdk/openai-compatible' }), 'openai-completions', 'openai-compatible maps to Chat Completions');
equal(pure.protocolFor({ npm: '@ai-sdk/openai' }), 'openai-completions', 'openai npm defaults to Chat Completions');
equal(pure.protocolFor({ npm: '@ai-sdk/azure' }), 'openai-completions', 'azure npm defaults to Chat Completions');
equal(pure.protocolFor({ npm: '@ai-sdk/google' }), '', 'unknown npm has no inferred protocol');

equal(
  pure.normalizeBaseURL('https://api.minimax.io/anthropic/v1', 'anthropic-messages'),
  'https://api.minimax.io/anthropic',
  'Anthropic base URLs lose the trailing /v1',
);
equal(
  pure.normalizeBaseURL('https://api.openai.com/v1/', 'openai-completions'),
  'https://api.openai.com/v1',
  'OpenAI base URLs keep /v1 and lose trailing slashes',
);

equal(pure.defaultRoute({ id: 'Acme AI' }), 'acme-ai', 'route ids are lowercased and hyphenated');
equal(pure.defaultRoute({ id: '___' }), 'provider', 'empty route ids fall back');
equal(pure.freeRoute('acme', {}), 'acme', 'free route returns the base when unused');
equal(pure.freeRoute('acme', { acme: {}, 'acme-2': {} }), 'acme-3', 'free route skips taken suffixes');

equal(pure.credentialRefFor({ env: ['ACME_API_KEY'] }, 'acme'), 'ACME_API_KEY', 'models.dev env wins for the credential ref');
equal(pure.credentialRefFor({ env: ['bad-name'] }, 'my route'), 'MY_ROUTE_API_KEY', 'invalid env names fall back to a derived ref');
equal(pure.credentialRefFor({ env: ['302AI_API_KEY'] }, '302ai'), 'P_302AI_API_KEY', 'digit-leading routes get a safe credential prefix');

const model = {
  id: 'acme-large',
  name: 'Acme Large',
  context: 200000,
  maxTokens: 32000,
  image: true,
  reasoning: true,
  efforts: ['off', 'low', 'high'],
};
equal(pure.modelEntry(model, true), { id: 'acme-large' }, 'catalog-known models keep only the id');
equal(pure.modelEntry(model, false), {
  id: 'acme-large',
  name: 'Acme Large',
  contextWindow: 200000,
  maxTokens: 32000,
  input: ['text', 'image'],
  reasoningEfforts: { off: null, low: 'low', high: 'high' },
}, 'unknown models carry the full metadata');
equal(pure.modelEntry({ id: 'text-only', efforts: ['off'] }, false), {
  id: 'text-only',
  input: ['text'],
}, 'toggle-only reasoning is not guessed');
equal(pure.formatTokens(200000), '200K', 'token counts are abbreviated');
equal(pure.formatTokens(1500000), '1.5M', 'millions are abbreviated');
equal(pure.formatTokens(0), '', 'zero has no abbreviation');

const acmeProvider = {
  id: 'acme',
  name: 'Acme',
  api: 'https://api.acme.dev/v1',
  npm: '@ai-sdk/openai-compatible',
  env: ['ACME_API_KEY'],
  models: [
    { id: 'known', context: 1000 },
    { id: 'fresh', name: 'Fresh', context: 2000, maxTokens: 500, image: true, reasoning: true, efforts: ['off', 'high'] },
  ],
};

const baseDetail = {
  providerId: 'acme',
  provider: acmeProvider,
  route: 'acme',
  displayName: 'Acme',
  protocol: 'openai-completions',
  baseURL: 'https://api.acme.dev/v1',
  selected: new Set(['known', 'fresh']),
  installed: new Set(['known']),
};

const customDirectory = {};
const catalogDirectory = { acme: { provider: 'acme', declared: false } };

equal(pure.validateDetail(baseDetail, { providers: {} }, customDirectory), null, 'a complete hand-declared draft validates');
equal(pure.validateDetail({ ...baseDetail, route: 'ACME' }, { providers: {} }, customDirectory), 'errRoute', 'invalid route ids are rejected');
equal(pure.validateDetail(baseDetail, { providers: { acme: {} } }, customDirectory), 'errRouteExists', 'existing routes are refused');
equal(pure.validateDetail({ ...baseDetail, selected: new Set() }, { providers: {} }, customDirectory), 'errModels', 'empty selections are refused');
equal(pure.validateDetail({ ...baseDetail, baseURL: '' }, { providers: {} }, customDirectory), 'errBaseURL', 'hand-declared routes need an endpoint');
equal(pure.validateDetail({ ...baseDetail, baseURL: 'ftp://x' }, { providers: {} }, customDirectory), 'errBaseURLInvalid', 'non-http endpoints are refused');
equal(pure.validateDetail({ ...baseDetail, protocol: '' }, { providers: {} }, customDirectory), 'errProtocol', 'hand-declared routes need a protocol');
equal(
  pure.validateDetail({ ...baseDetail, protocol: '' }, { providers: {} }, catalogDirectory),
  'errProtocol',
  'catalog routes need a protocol for models outside the installed catalog',
);
equal(
  pure.validateDetail({ ...baseDetail, protocol: '', baseURL: '' }, { providers: {} }, catalogDirectory),
  'errBaseURL',
  'catalog routes need an endpoint for models outside the installed catalog',
);
equal(
  pure.validateDetail({ ...baseDetail, protocol: '', baseURL: '', installed: new Set(['known', 'fresh']) }, { providers: {} }, catalogDirectory),
  null,
  'catalog routes with only installed models need no protocol',
);

const customProfile = pure.buildProfile(baseDetail, customDirectory);
equal(customProfile.displayName, 'Acme', 'profile keeps the display name');
equal(customProfile.apiKeyEnv, 'ACME_API_KEY', 'profile records the credential reference');
equal(customProfile.api, 'openai-completions', 'profile records the protocol');
equal(customProfile.baseURL, 'https://api.acme.dev/v1', 'profile records the endpoint');
equal(customProfile.models.length, 2, 'profile writes every selected model');
equal(customProfile.models[0], { id: 'known', contextWindow: 1000, input: ['text'] }, 'hand-declared routes carry full metadata even for installed ids');
ok(customProfile.models[1].reasoningEfforts.high === 'high', 'reasoning levels ride on unknown models');

const catalogProfile = pure.buildProfile({ ...baseDetail, protocol: '', baseURL: '' }, catalogDirectory);
equal(catalogProfile.api, undefined, 'catalog routes omit api when no override is chosen');
equal(catalogProfile.baseURL, undefined, 'catalog routes omit baseURL when no override is chosen');
equal(catalogProfile.models[0], { id: 'known' }, 'installed models stay minimal');
equal(catalogProfile.models[1].input, ['text', 'image'], 'models outside the installed catalog carry full metadata');

const nativeDirectory = { acme: { provider: 'acme', declared: false, nativeAuth: { env: ['AWS_PROFILE'], oauth: false } } };
const nativeBlank = pure.buildProfile({ ...baseDetail, apiKey: '' }, nativeDirectory, { apiKeyConfigured: false });
equal(nativeBlank.apiKeyEnv, undefined, 'native-auth routes omit apiKeyEnv when no key is typed');
const nativeConfigured = pure.buildProfile({ ...baseDetail, apiKey: '' }, nativeDirectory, { apiKeyConfigured: true });
equal(nativeConfigured.apiKeyEnv, 'ACME_API_KEY', 'a configured reference is kept for native-auth routes');
const nativeKey = pure.buildProfile({ ...baseDetail, apiKey: 'sk-test' }, nativeDirectory);
equal(nativeKey.apiKeyEnv, 'ACME_API_KEY', 'typing a key writes the reference even for native-auth routes');

equal(pure.capabilityOf({ id: 'x', api: 'https://x/v1' }, {}), 'ready', 'providers with an endpoint are directly importable');
equal(pure.capabilityOf({ id: 'x' }, {}), 'needs-endpoint', 'providers without an endpoint need manual input');
equal(pure.capabilityOf({ id: 'x' }, { x: { provider: 'x', declared: false } }), 'catalog', 'installed catalog providers need no endpoint');
equal(pure.capabilityOf({ id: 'x' }, { x: { provider: 'x', declared: true } }), 'needs-endpoint', 'hand-declared directory rows need an endpoint');

equal(pure.matchesQuery('Acme Large', 'large'), true, 'search is case-insensitive');
equal(pure.matchesQuery('Acme Large', 'missing'), false, 'search rejects non-matches');

/* ------------------------------------------------------------------ */
/* 4. 按钮样式契约                                                     */
/* ------------------------------------------------------------------ */

const css = pure.CSS;
ok(typeof css === 'string' && css.length > 1000, 'client stylesheet is exported for inspection');
ok(css.includes('.mdv-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-height:30px;border:.5px solid var(--dsw-alias-border-l3)'), 'buttons use the host secondary border');
ok(!css.includes('--dsw-alias-button-contrast-fill') && !css.includes('--dsw-alias-button-primary-fill'), 'buttons have no dark filled variant');
ok(css.includes('.mdv-btn--primary{border-color:var(--dsw-alias-border-l4);font-weight:500}'), 'primary buttons only strengthen the border');
ok(css.includes('.mdv-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary)'), 'buttons get a branded keyboard focus ring');
ok(css.includes('.mdv-provider{') && !/\.mdv-provider\{[^}]*border:[^0]/.test(css), 'provider rows stay borderless');
ok(!css.includes('border:.5px solid var(--dsw-alias-brand-primary)'), 'no control uses the near-black brand color as a border');

/* ------------------------------------------------------------------ */

console.log('verify-catalog: ' + checks + ' assertions passed');
