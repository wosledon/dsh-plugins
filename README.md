English | [中文](README.zh.md)

# dsh-plugins

Third-party plugins for **DeepSeek Harness** (DSH) — the desktop/web harness whose
plugins are declared as *bundles* and loaded by a Cordis-based Loader.

Each plugin here is a self-contained package that can be installed into a DSH
profile with `plugin_manager`. None of them require a build step: the browser half
is a plain JavaScript bundle in the format the DSH module loader expects, and the
host half is ordinary ESM.

## Plugins

| Plugin | What it does | Host half | Browser half |
| --- | --- | --- | --- |
| [`dsh-plugin-reasoning-effort`](dsh-plugin-reasoning-effort/README.md) | Per-model reasoning-effort editor for hand-declared LLM providers, inside Settings → Models | empty (registers nothing) | yes |
| [`dsh-plugin-scheduled-tasks`](dsh-plugin-scheduled-tasks/README.md) | Runs an LLM task on a schedule (cron / interval / daily / weekly / one-shot), with a management panel, per-task run history and conversational creation | yes (scheduler, runner, tools, skill) | yes |
| [`dsh-plugin-token-usage`](dsh-plugin-token-usage/README.md) | Provider-reported token usage grouped by model: a live indicator in the session header plus a cross-session table | yes (session projection + bounded log scan) | yes |

### dsh-plugin-reasoning-effort

DSH's model picker only offers the reasoning levels an adapter *advertises*. For a
custom (hand-declared) route the adapter has no reasoning metadata at all, so not
even an Effort row appears — and `dsh-client-ui-settings-models` deliberately ships
no provider-scoped effort control, because effort is a **per-model** capability.

This plugin fills that gap by contributing a card to the official slot
`settings.models.provider-card`, reading state through `remote.settings.describe()`
and writing through `remote.settings.mutate()`. It adds no host service, event or tool.

### dsh-plugin-scheduled-tasks

At the scheduled time the plugin opens a **fresh session** and has the model run
your prompt. Each task can carry its own model, reasoning effort, working directory,
skill and tool allowlist, and every run is recorded.

- **Menu**: a sidebar panel entry plus a main page with two tabs — *Tasks* and
  *Run log*, each paginated.
- **Run history**: kept per task, so the page grows with the number of tasks rather
  than with the number of runs.
- **Conversational creation**: five model-facing tools
  (`scheduled_task_create` / `list` / `update` / `delete` / `run`) plus a
  `scheduled-tasks` skill, so “every day at 9am summarize yesterday’s git commits”
  becomes a real task.

It is **not** the same as the bundled `@deepseek-ai/dsh-schedule`: that one delivers
reminder text into an existing session and never runs the model.

### dsh-plugin-token-usage

Shows the token usage the provider adapter actually reports, grouped by
`(provider, model)` — **no estimation and no cost figures**. The four buckets match
the official `tokenUsage` projection (`uncachedInputTokens`, `outputTokens`,
`cacheReadTokens`, `cacheWriteTokens`); `reasoningTokens` is deliberately excluded
because it is usually a subset of `outputTokens`.

Reaching that data takes two different routes, because the two views ask different
questions:

- **Per-model, in one session** is a session-derived value, and the official
  guidance is that the client must not fold session events itself. So the host
  registers a session projection named `tokenByModel` with a `wire.view`, and the
  browser half just reads `useProjection('tokenByModel')`. It renders as a seat in
  `conversation.session.header.utilities` — a total with a per-model popover — and
  renders nothing while the session has no usage.
- **Across sessions** belongs to no single session, so no projection can hold it,
  and `ctx.sessionQuery`'s methods are not `@Remote`, so the browser cannot read
  other sessions' logs at all. The host therefore scans them: newest first, capped
  by `scanLimit` (200 by default), folded per model and persisted; the standalone
  page (sidebar panel + main) reads the result back.

It is honest about its bounds: a truncated scan says “scanned the *N* most recent of
*M* sessions”, unreadable logs are counted rather than silently dropped, and calls
that cannot be attributed to a model land in an explicit `unknown/unknown`
“unattributed” row so the totals still add up.

## Install

Install a plugin into the current DSH profile by pointing `plugin_manager` at the
package directory:

```text
plugin_manager install_bundle   target: file:<absolute path to the plugin directory>
```

For example:

```text
plugin_manager install_bundle   target: file:E:\repos\dsh-plugins\dsh-plugin-scheduled-tasks
```

To update an already-installed plugin, remove it first — pnpm copies `file:`
dependencies rather than symlinking them, and a repeated `install_bundle` reports
`ambiguous-install`:

```text
plugin_manager remove_bundle    target: dsh-plugin-scheduled-tasks
plugin_manager install_bundle   target: file:E:\repos\dsh-plugins\dsh-plugin-scheduled-tasks
```

### Two things that surprise people

**1. A host restart may be required.** Refreshing the page only reloads the
*browser* half. The *host* half runs inside the DSH process, and Node's ESM module
cache is keyed by resolved path — so replacing the files on disk does not replace
the already-imported module. If a host-side change (a tool, the scheduler, a new
config field) does not appear, restart the harness.

**2. The self-check scripts need one shim.** The `scripts/*.mjs` files are
zero-dependency, but anything that imports a plugin's `lib/config.js` transitively
imports `@deepseek-ai/schemastery`, which ships *with DSH* and is not a dependency
of these packages. To run those scripts under plain Node, make it resolvable — for
example by linking the copy from the DSH installation:

```text
<plugin>/node_modules/@deepseek-ai/schemastery
<plugin>/node_modules/@deepseek-ai/cosmokit
```

That directory is a local testing aid and is git-ignored. Two plugins'
self-checks have no such dependency and run anywhere: `dsh-plugin-reasoning-effort`
and `dsh-plugin-token-usage` (its `test-fold.mjs` touches nothing but `node:` builtins).

## Verification

These plugins are verified by self-check scripts that live in each package and run
with no third-party dependencies. A fresh clone can reproduce every recorded result.

```text
dsh-plugin-reasoning-effort
  node scripts/verify-contract.mjs      49 assertions

dsh-plugin-scheduled-tasks
  node scripts/test-cron.mjs           190 assertions
  node scripts/test-store.mjs           35 assertions
  node scripts/verify-contract.mjs      65 assertions
  node scripts/verify-layout.mjs        54 assertions
  node scripts/verify-render.mjs        57 assertions

dsh-plugin-token-usage
  node scripts/test-fold.mjs            65 assertions
  node scripts/verify-layout.mjs        63 assertions
  node scripts/verify-contract.mjs     261 assertions
```

The suites deliberately cover things that ordinary functional tests miss:

- **`verify-layout.mjs`** turns layout conventions into assertions — that a row uses
  explicit grid columns rather than `flex: 1`, that Chinese long text is never
  `word-break: break-all`, that the root container does not declare `height: 100%`.
  These describe real misalignments that *succeeded* at rendering, so no functional
  test could have caught them.
- **`verify-render.mjs`** implements a minimal React runtime (real state, real
  re-renders) and drives the page through create → switch tab → expand history →
  open form → switch schedule kind. It exists because "the panel is blank" is a
  **render-time** crash: `apply()` does not throw, the slot entry simply dies. It
  also asserts **Hook order** — an effect placed after an early `return` changes the
  hook count between renders and blanks the whole slot.
- Several checks ship with a **negative control**: reverting the fix must make the
  check fail. A passing assertion that cannot fail proves nothing.

What is **not** verified, and cannot be from a terminal: the visual result — colours,
spacing, contrast in light and dark themes. Those need a real page.

## Repository layout

```
.
├── dsh-plugin-reasoning-effort/
│   ├── index.js                 host half (empty by design)
│   ├── client.js                browser half
│   ├── cordis.patch.yml         bundle patch: inserts one host row
│   ├── package.json             dsh.bundle.patch + dsh.client declarations
│   ├── locale/{en,zh}.json
│   └── scripts/verify-contract.mjs
└── dsh-plugin-scheduled-tasks/
    ├── index.js                 host half entry
    ├── lib/                     scheduler, runner, cron, store, tools, skill…
    ├── client.js                browser half: panel + two-tab page
    ├── CONTRACT.md              frozen internal contract (data shapes, invariants)
    ├── cordis.patch.yml
    ├── package.json
    ├── locale/{en,zh}.json
    ├── skills/scheduled-tasks/SKILL.md
    └── scripts/                 the self-check scripts listed above
└── dsh-plugin-token-usage/
    ├── index.js                 host half: tokenByModel projection + bounded cross-session scan
    ├── lib/                     fold (pure), projection, summary, store, config, constants
    ├── client.js                browser half: header indicator + cross-session page
    ├── CONTRACT.md              frozen internal contract (data shapes, invariants)
    ├── cordis.patch.yml
    ├── package.json
    ├── locale/{en,zh}.json
    └── scripts/                 the self-check scripts listed above
```

`_scratch/` is used during development and is git-ignored; see `.gitignore` for why.

## Compatibility

All three plugins were developed and verified against DSH **0.1.7-rc.2**. They use
documented plugin surfaces (the `settings` and `configEditor` services, session
projections, slots, `agentLoop`, `tools`, `skills`), but DSH is pre-release: an
internal API can change between versions. Each cross-service call is written
defensively — a missing optional service degrades the feature instead of failing the
whole plugin — but a behaviour change upstream can still break a feature silently.

One such behaviour is worth calling out because it is not obvious from any signature:
**`ctx.settings.mutate()` addresses an existing entry in the profile patch layer.**
A row supplied by a bundle's own `cordis.patch.yml` (`insert`) has no entry there, so
writes through `settings` do not land. `ctx.configEditor.edit(entry, change)` is
addressed by Loader entry instead, which is why `dsh-plugin-token-usage` prefers it
and keeps `settings` only as a fallback.

## License

[MIT](LICENSE) © 2026 ledon

You are free to use, modify and redistribute these plugins, including
commercially, provided the copyright notice and permission notice are retained.
The software is provided "as is", without warranty of any kind.

Note that DSH itself is a separate product with its own licence. This repository
grants rights to *these plugins only* — it does not grant any rights to DeepSeek
Harness, nor does it imply endorsement by its authors.
