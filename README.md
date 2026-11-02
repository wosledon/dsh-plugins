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
| [`dsh-plugin-remote-dsh`](dsh-plugin-remote-dsh/README.md) | Turn an SSH host into a remote DSH Web workspace: probe, install the official CLI, start `dsh web`, tunnel it, and open it in the right sidebar | yes (SSH config, install/start/tunnel, local API) | yes (left-sidebar menu + host manager) |

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

### dsh-plugin-remote-dsh

The remote counterpart: a left-sidebar **Remote DSH** menu that reads
`~/.ssh/config` (via `ssh -G`) and lets you add remotes manually. For each host:

- **Probe** `node` / `npm` / `npx` / `dsh` and the npm global prefix.
- **Start** the remote Web profile with the official command — default
  `npx -y @deepseek-ai/dsh@latest web --host 127.0.0.1 --port <p> --no-open`, or
  global mode after `npm install -g --prefix ~/.npm-global @deepseek-ai/dsh@latest`.
  A registry field (default npmmirror) keeps a broken remote `.npmrc` from hanging
  the start.
- The Host opens an SSH tunnel on the same port, parses the
  `dsh web: <url>?token=…` line, and returns a local URL. Starting does not
  switch panels or open a window.
- Running cards have a single **Browser** button; starting never switches panels
  or opens a window.
- The right Sidebar is per Session, so a session-header **Remote DSH** button
  (and a right-Sidebar guide entry) opens a launcher tab. Each running remote is
  one click target there: it opens directly as a Browser tab in the current
  Session.

The remote Web never binds beyond loopback; the SSH local forward carries the
traffic, so the two machines do not need to share a LAN. Any SSH-reachable target
works, and `ProxyJump` / `ProxyCommand` from `~/.ssh/config` (or the manual
host's Proxy jump field) is honored. Local and remote sessions are intentionally
separate. See the
[plugin README](dsh-plugin-remote-dsh/README.md) for modes, security, and
limitations.

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
  node scripts/verify-catalog.mjs      107 assertions

dsh-plugin-remote-dsh
  node scripts/verify-contract.mjs      80 assertions
```

`verify-catalog.mjs` covers the catalog projection (model filtering, reasoning
aliases, api normalization), cache expiry / forced refresh / stale fallback,
concurrent fetches, the HTTP route's 200/404/405/502 responses, and every pure
mapping used by the browser half (protocol inference, endpoint normalization,
credential references, model profiles, import validation).

`verify-contract.mjs` covers ssh-config parsing / `ssh -G`, SSH argument
construction, log URL extraction, probe parsing, manual-host validation, the
state file, the token-protected API, a fake-SSH start/open/stop flow, and the
remote page's style contract.

Live checks performed against the desktop profile:

- `GET /plugin-modelsdev/catalog` → 200, 233 providers, 7,619 chat models,
  1.09 MB in 1.46 s on the first fetch.
- `settings.models.footer` → `modelsdev-catalog` occupant, active.
- `GET /plugin-remote-dsh/api/bootstrap` → 200 with a token; `GET
  /plugin-remote-dsh/api/hosts` → 4 hosts from `~/.ssh/config`, no config
  errors; without the token → 401.
- `sidebar.panellist` and `main` both report the `remote-dsh` occupant as
  active.
- A real remote start through the plugin worked in both modes (npx + npmmirror,
  and a global install into `~/.npm-global`): the remote URL came back, the local
  SSH tunnel served `DeepSeek Harness` (HTTP 200), and stop cleaned up.
- A port conflict returned `PORT_IN_USE` with the listener PID without touching
  its log; an explicit force restart replaced the existing `dsh web` and served
  the new URL through the tunnel.
- With one remote already tunneled on local 3080, starting another remote
  auto-selected 3081 on both sides; both URLs served `DeepSeek Harness`.

The rendered sections need the authenticated Harness page; this development
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

dsh-plugin-remote-dsh/
  index.js              Host entry: API route + tunnel lifecycle
  lib/ssh-config.js     ~/.ssh/config + ssh -G + command builders
  lib/state.js          state.json store and manual-host model
  lib/remote.js         probe / install / start / stop / open / logs
  lib/server.js         Token-protected local API
  client.js             Sidebar icon + Remote DSH page
  scripts/
    verify-contract.mjs Zero-dependency self-check
  cordis.patch.yml
  locale/{en,zh}.json
  icon.svg
  README.md / README.zh.md
```

`_scratch/` is a local, git-ignored development area (extracted DSH sources,
temporary probes); it is not part of any plugin.

## License

MIT — see [LICENSE](LICENSE).
