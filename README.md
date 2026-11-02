English | [中文](README.zh.md)

# dsh-plugins

Third-party plugins for **DeepSeek Harness** (DSH) — the desktop/web harness whose
plugins are declared as *bundles* and loaded by a Cordis-based Loader.

Each plugin here is a self-contained package that can be installed into a DSH
profile with `plugin_manager`. None of them require a build step: the browser side
is a plain JavaScript bundle in the format the DSH module loader expects, and the
host side is ordinary ESM.

## Plugins

| Plugin | What it does | Host side | Browser side |
| --- | --- | --- | --- |
| [`dsh-plugin-modelsdev`](dsh-plugin-modelsdev/README.md) | Browse the models.dev provider/model catalog inside Settings → Models and import a provider plus its models as a working `llm-pi-ai` route | yes (cached catalog HTTP route) | yes (footer section + importer) |

### dsh-plugin-modelsdev

models.dev publishes endpoints, credential variables, context windows, output
caps, input modalities and reasoning levels for 235 providers and roughly 9,000
models. DSH's Models page can express most of that in `providers.<route>` for
`@deepseek-ai/dsh-llm-pi-ai`, but asks you to type it in. This plugin closes the
gap:

- **Host half** fetches `https://models.dev/api.json` once per process, projects
  it to a ~1.1 MB compact payload (drops descriptions, pricing, deprecated and
  non-chat models), caches it for six hours, and serves it at
  `/plugin-modelsdev/catalog`. Upstream failure falls back to the stale cache.
- **Browser half** registers a section in the official
  `settings.models.footer` slot. Search a provider, pick models, confirm the
  inferred protocol / endpoint / credential reference, paste an API key, and
  press **Import into DSH**. The write goes through
  `remote.settings.mutate('llm-pi-ai', …)`; the key goes through
  `remote.credentials.set` and never enters the settings document.

It distinguishes **catalog routes** (providers pi-ai already ships, where model
metadata and protocol come from the installed catalog) from **hand-declared
routes** (OpenAI-compatible gateways and Anthropic-compatible endpoints, which
need an explicit `api` and `baseURL`). Anthropic endpoints are normalized because
the adapter appends `/v1/messages`; `none` reasoning is mapped to `off`, while
`toggle` / `budget_tokens` models get no invented effort map.

See the [plugin README](dsh-plugin-modelsdev/README.md) for the full mapping
table, the exact settings shape, and limitations.

## Install

Install a plugin into the current DSH profile by pointing `plugin_manager` at the
package directory:

```text
plugin_manager install_bundle   target: file:<absolute path to the plugin directory>
```

For example:

```text
plugin_manager install_bundle   target: file:E:\repos\dsh-plugins\dsh-plugin-modelsdev
```

To update an installed plugin, remove it first — pnpm copies `file:`
dependencies rather than linking them, and a repeated `install_bundle` reports
`ambiguous-install`:

```text
plugin_manager remove_bundle    target: dsh-plugin-modelsdev
plugin_manager install_bundle   target: file:E:\repos\dsh-plugins\dsh-plugin-modelsdev
```

### Things that surprise people

**1. A host restart may be required.** Refreshing the page only reloads the
*browser* side. The *host* side runs inside the DSH process, and Node's ESM module
cache is keyed by resolved path — so replacing the files on disk does not replace
the already-imported module. If a host-side change (the catalog route, the
projection) does not appear, restart the harness.

**2. The catalog route is same-origin, not `/api`.** `/plugin-modelsdev/catalog`
is a read-only HTTP route registered on `ctx.webServer`, so the browser fetches it
without going through the Remote RPC gateway. It requires no credential because it
serves public catalog data; set `DSH_MODELSDEV_URL` to point it at a mirror.

## Verification

The plugin ships a self-check that runs with no third-party dependencies:

```text
dsh-plugin-modelsdev
  node scripts/verify-catalog.mjs      106 assertions
```

It covers the catalog projection (model filtering, reasoning aliases, api
normalization), cache expiry / forced refresh / stale fallback, concurrent
fetches, the HTTP route's 200/404/405/502 responses, and every pure mapping used
by the browser half (protocol inference, endpoint normalization, credential
references, model profiles, import validation).

Live checks performed against the desktop profile:

- `GET /plugin-modelsdev/catalog` → 200, 233 providers, 7,619 chat models,
  1.09 MB in 1.46 s on the first fetch.
- `settings.models.footer` → `modelsdev-catalog` occupant, active.

The rendered section needs the authenticated Harness page; this development
environment could not attach to that page, so no screenshot is recorded and
visual verification remains unavailable.

## Repository layout

```text
dsh-plugin-modelsdev/
  index.js              Host entry: mounts the catalog route
  lib/catalog.js        Fetch, project, cache, serve
  client.js             Web bundle: footer section + importer
  scripts/
    verify-catalog.mjs  Zero-dependency self-check
  cordis.patch.yml      Bundle patch (one Loader row)
  locale/{en,zh}.json   Inventory title/description
  icon.svg              Original artwork
  README.md / README.zh.md
```

`_scratch/` is a local, git-ignored development area (extracted DSH sources,
temporary probes); it is not part of any plugin.

## License

MIT — see [LICENSE](LICENSE).
