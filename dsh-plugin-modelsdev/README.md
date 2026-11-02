English | [中文](README.zh.md)

# dsh-plugin-modelsdev

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
browses the public [models.dev](https://models.dev) catalog inside
**Settings → Models** and imports a provider plus its models as a working
`llm-pi-ai` route.

models.dev publishes 235 providers and roughly 9,000 model descriptors: endpoint,
required environment variables, context window, output cap, input modalities and
reasoning levels. That is almost exactly what `@deepseek-ai/dsh-llm-pi-ai` needs
for `providers.<route>`, so this plugin turns a catalog entry into a valid
settings write instead of asking you to copy values by hand.

## Where it appears

The plugin registers one cell in the official `settings.models.footer` slot, below
the provider rows and the **Add model provider** control:

```
Settings → Models
  DeepSeek Account
  DeepSeek
  … provider rows …
  [ Add model provider ]
  ┌ models.dev 目录 ────────────────────────────── [浏览目录] ┐   ← this plugin
  │ search providers · provider list · model picker          │
  │ Provider ID · display name · protocol · endpoint · key    │
  └───────────────────────────────────────────────────────────┘
```

It is a repository-external plugin: it uses the slot contract that
`@deepseek-ai/dsh-client-ui-settings-models` exports for third-party bundles and
does not patch the Models page itself.

## Use it

1. Open **Settings → Models** and expand **models.dev 目录 / models.dev catalog**.
2. Search for a provider. The catalog is fetched once by the Host and cached for
   six hours; **刷新目录 / Refresh catalog** forces a refresh.
3. Pick the models to expose. The plugin preselects every non-deprecated chat
   model of that provider; **全选 / 清空** and the model search narrow the set.
4. Check the prefilled connection values:
   - **Provider ID** — the settings key and request route. A free id is derived
     from the models.dev id (`Acme AI` → `acme-ai`) and automatically suffixed
     when it already exists.
   - **API protocol** — inferred from the provider's `npm` field. Providers that
     pi-ai already ships can keep **Use installed catalog**.
   - **API base URL** — inferred from the provider's `api` field, normalized for
     the selected protocol.
   - **API key** — optional. The field shows the credential reference that will
     be written (`ACME_API_KEY` when models.dev supplies one, otherwise
     `<ROUTE>_API_KEY`) and whether it is already configured.
5. Press **导入到 DSH / Import into DSH**. The route appears immediately in the
   provider list; open that row to keep editing in the native editor.

## What gets written

The settings write lands in the `llm-pi-ai` namespace, at
`providers.<route>`. For example, importing MiniMax with its Anthropic-compatible
endpoint writes:

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      minimax:
        displayName: MiniMax (minimax.io)
        apiKeyEnv: MINIMAX_API_KEY
        api: anthropic-messages
        baseURL: https://api.minimax.io/anthropic
        models:
          - id: MiniMax-M3
            contextWindow: 1000000
            maxTokens: 524288
            input: [text, image]
          - id: MiniMax-M3.1-Flash
            contextWindow: 1000000
            maxTokens: 524288
            input: [text, image]
            reasoningEfforts:
              low: low
              medium: medium
              high: high
              xhigh: xhigh
              max: max
```

The API key itself never enters this document. It is stored through the
credential seam under `apiKeyEnv` (`remote.credentials.set`), and the route
resolves it per request, so a rotated key applies without a restart.

A catalog provider that reports **native authentication** (Bedrock, Vertex and
similar chains) keeps it when you leave the key field empty: the write then omits
`apiKeyEnv` instead of pinning authentication to a single environment variable.
Typing a key — or a reference the page already sees as configured — writes the
reference as usual.

## Mapping rules

| models.dev | Written as | Notes |
| --- | --- | --- |
| `provider.id` | route id, default | Lowercased; non-alphanumerics become `-`; suffixed if the route exists |
| `provider.name` | `displayName` | Editable in the form |
| `provider.api` | `baseURL` | Normalized per protocol; `${PLACEHOLDER}` endpoints are dropped and must be filled by hand |
| `provider.npm` | `api` | `@ai-sdk/anthropic` → `anthropic-messages`; `@ai-sdk/openai*` and `@ai-sdk/azure` → `openai-completions` |
| `provider.env[0]` | `apiKeyEnv` | Used when it is a valid POSIX identifier, else `<ROUTE>_API_KEY` |
| `model.id` | `models[].id` | — |
| `model.name` | `models[].name` | Omitted when equal to the id |
| `limit.context` | `contextWindow` | Omitted when absent |
| `limit.output` | `maxTokens` | Omitted when absent |
| `modalities.input` | `input` | `image` when the model accepts images; always includes `text` |
| `reasoning_options[].type = effort` | `reasoningEfforts` | `none` → `off`; values outside pi-ai's seven levels are dropped; `toggle` / `budget_tokens` are **not** guessed |
| `status = deprecated` | excluded | Also excluded: embedding, image, realtime, reranking, speech, transcription and video models |

**Catalog routes versus hand-declared routes.** A provider that pi-ai's installed
catalog already ships needs no `api` or `baseURL`: the adapter keeps each
model's own protocol and endpoint. The plugin detects that case through
`llm.listConfigurableProviders()` and asks `llm.discoverModels()` for the
installed model ids. Models inside that catalog are written as `{ id }` only, so
the adapter's own metadata wins. Models outside it get full metadata, and the
form then requires an explicit protocol (and an endpoint when the catalog has no
default). Providers pi-ai does not ship are always written with `api`,
`baseURL` and full metadata.

**Anthropic base URLs.** The Anthropic Messages adapter appends `/v1/messages`,
so models.dev endpoints such as `https://api.minimax.io/anthropic/v1` are written
as `https://api.minimax.io/anthropic`. OpenAI protocols keep their `/v1`.

## Architecture

| Half | File | Role |
| --- | --- | --- |
| Host | `index.js` | Mounts one exact HTTP route, `/plugin-modelsdev/catalog`, on `ctx.webServer` |
| Host | `lib/catalog.js` | Fetches `https://models.dev/api.json`, projects it to a compact offline-friendly payload, caches it in process memory, serves GET/HEAD, falls back to a stale cache on upstream failure |
| Client | `client.js` | Renders the footer section, drives the catalog browser, infers connection facts, and writes through `remote.settings.mutate` + `remote.credentials.set` |

The Host projection is about 1.1 MB (233 providers, 7,600+ chat models); the raw
upstream document is about 6 MB. Descriptions and pricing are not sent to the
browser because DSH's model surfaces do not use them.

The route is deliberately not under `/api`: it is a read-only, same-origin
catalog endpoint, not a Remote RPC namespace. The plugin can be pointed at a
mirror with the `DSH_MODELSDEV_URL` environment variable.

## Limitations

- **No overwrite.** An existing `providers.<route>` is detected and the form
  refuses the write; change the Provider ID to create another route, or edit the
  existing route in the native Models editor.
- **No pricing.** models.dev cost data is dropped during projection because DSH
  does not display it.
- **Reasoning is conservative.** `effort` options are mapped; `toggle` and
  `budget_tokens` models get no `reasoningEfforts` rather than an invented wire
  value.
- **Protocols stay narrow.** Only the three protocols `llm-pi-ai` accepts are
  offered. Bedrock, Vertex, Azure-native and Codex routes must come from pi-ai's
  own catalog.
- **The catalog is a snapshot.** It is cached for six hours per process; the
  refresh button bypasses the cache. A stale cache is served when models.dev is
  unreachable.
- **Non-text models are excluded.** Embedding, image, speech and similar models
  cannot be driven by the DSH model loop.

## Install and update

```text
plugin_manager install_bundle   target: file:E:\repos\dsh-plugins\dsh-plugin-modelsdev
```

To update an installed copy, remove and reinstall (pnpm copies `file:`
dependencies rather than linking them):

```text
plugin_manager remove_bundle    target: dsh-plugin-modelsdev
plugin_manager install_bundle   target: file:E:\repos\dsh-plugins\dsh-plugin-modelsdev
```

A Host-side change also needs a Harness restart because Node caches the imported
module; the browser half reloads with the page.

## Verification

The package has a zero-dependency self-check covering the Host projection, cache,
stale fallback, HTTP route and every pure mapping used by the browser half:

```text
node scripts/verify-catalog.mjs
# verify-catalog: 107 assertions passed
```

The plugin was installed into the desktop profile and verified live: the catalog
route returned 233 providers / 7,619 models (1.09 MB) and the
`settings.models.footer` slot reported the `modelsdev-catalog` occupant as
active. Visual inspection of the rendered section requires the authenticated
Harness page; this repository's development environment could not attach to it,
so no screenshot is recorded.

## License

MIT. models.dev data is fetched at runtime and is not redistributed by this
package. The icon is original artwork.
