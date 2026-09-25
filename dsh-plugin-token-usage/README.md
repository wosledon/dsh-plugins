English | [中文](README.zh.md)

# dsh-plugin-token-usage

**Show the provider-reported token usage, grouped by `(provider, model)`**: a live indicator
in the conversation header for the session you are in, and a standalone page that adds up
**across sessions**. Every number comes from what the provider adapter actually reported —
**nothing is estimated and no cost is computed**.

The built-in `@deepseek-ai/dsh-token-meter` already registers a session projection named
`tokenUsage`, whose four buckets are the same ones used here:

> It carries the **whole-session** totals, so it can answer "how many tokens did this session
> use", but not "how much of that was model A and how much was model B".

This plugin fills exactly that gap: the host computes the per-model split once and ships it to
the browser as a `wire.view`, and a bounded host scan produces the cross-session table that
the browser side cannot compute by itself.

## What it does

- **Live session indicator**: a seat in the conversation header utilities slot
  (`conversation.session.header.utilities`, id `token-usage`, order 40). It shows this
  session's total token count; clicking it opens a popover with the per-model breakdown — each
  model's total, a share bar, its call count, and **the four buckets** (input, output, cache
  read, cache write). The projection already carries those buckets per row; rendering only the
  total would answer "which model cost the most" but not "was that input or output, and how
  much of it was cached". When the session has no reported usage yet, the indicator
  **renders nothing** instead of leaving an empty badge in the header.
- **Standalone page**: a sidebar panel icon (`sidebar.panellist`, id `token-usage`, order 30)
  plus a main-area page (`main`, the same key). This page is the **cross-session** table by
  model — model, input, output, cache read, cache write, total and share — sorted by total
  descending, paginated at **20 rows per page**, with a **Refresh** button. Above the table sit
  two charts: a donut of the share by model, then a **per-day contribution heatmap** (one column
  per week, one row per weekday, darker = more tokens that day). The heatmap opens on the **last 30
  days of the data** — anchored at the latest day *in the data*, not at today, because a stale
  timeline would otherwise be rendered as a band of empty columns — and carries a date-range control:
  two date inputs plus `Last 7 days` / `Last 30 days` / `All` presets. Whatever you type is **clamped
  to the data's real span and written back into the input** (what the box shows is what the chart
  draws); clearing an input means "no limit on that end". Hovering or focusing a cell shows a
  **custom overlay** instead of the native `title` (the native tooltip's styling is rendered by the
  OS and cannot be customised with CSS); the cell keeps its `aria-label`, so accessibility does not
  regress.
- **Real numbers only**: the counts come from the `usage` field on `assistant/message` events
  in the session log, exactly as the provider adapter reported it. The plugin **estimates
  nothing and computes no cost**.

## Why it is designed this way

### Provider-reported usage only, in the same four buckets as the official projection

The four buckets are `uncachedInputTokens`, `outputTokens`, `cacheReadTokens` and
`cacheWriteTokens` — the same accounting as the official `@deepseek-ai/dsh-token-meter`
`tokenUsage` projection. `reasoningTokens` is deliberately **not** one of them: it is usually
a subset of `outputTokens`, so a column of its own would both disagree with the official
numbers and invite anyone to add it into the total twice.

Fields the adapter does not report are recorded as `0` and never guessed: when an adapter does
not report cache usage, that means "not reported", not "there was no cache". Negative values
and `NaN` are treated as "not reported" as well, and fractional counts are floored.

### The per-model split is computed on the Host, not in the browser

The official practice rule is explicit:

> When the Client needs a value derived from a session, declare `wire.view` on the Host
> projection. The value reaches the Client already computed; the Client does not fold session
> events itself.

So the host side registers a **session projection unit of its own**, `tokenByModel`
(`stateVersion: 1`, with a `stateSchema`, an `init`, a pure `apply` that returns the same
reference for irrelevant events, and a `wire` block carrying `viewSchema` and `view`). The
browser side only calls `useProjection('tokenByModel')` and renders what it gets; it never
touches the event stream.

An `assistant/message` event carries the identity of the call in
`message.source` (`{ kind: 'model', provider, model }`), so folding by
`(provider, model)` is done by `lib/fold.js` and the sorted rows are produced on the host.

Why not reuse the official `tokenUsage` projection: it holds the four buckets for the whole
session only, with no per-model breakdown — and the breakdown is the whole point here.

### The cross-session total can only be scanned on the Host

The cross-session aggregate belongs to no single session, so it does not fit in a session
projection. And `ctx.sessionQuery`'s methods are **not** `@Remote`, so the browser side cannot
read another session's log at all. The only way through is:

1. the host lists sessions, reads their logs (newest first), folds the `assistant/message`
   events, and writes the summary into the plugin settings;
2. the browser side reads it back with `remote.settings.describe()`.

Why settings in particular: `ctx.remote.*` is a **whitelist fixed at compile time**, and a
third-party pure-JS plugin cannot add a Remote namespace — there is no registration entry
point at all. `remote.settings` is the one general read/write channel, and this route has
already been proven on a real device by the sibling plugin `dsh-plugin-scheduled-tasks`.

### The scan is bounded, and it says so

- **`scanLimit` defaults to 200 sessions**, and can be configured in `cordis.patch.yml`.
- Sessions are scanned **newest first** (by creation time). When the log holds more sessions
  than the limit, the page says so in plain words — "Scanned the N most recent of M sessions;
  older ones are not included" — instead of quietly under-counting.
- A session log that cannot be read is **skipped and counted**, and the page shows how many
  were skipped next to the scan note.
- Reading history costs O(sessions × events), so a scan runs only when the client asks for a
  refresh or when nothing has ever been scanned. The host checks once a minute, but a check
  with no pending request and a summary already in hand does no work at all.

### A few other choices

- **Refresh is a request, not a scan**: the button writes a single
  `internal.refreshRequestedAt` timestamp into the plugin settings, and the host consumes it on
  its next pass and scans there. The page reads the settings snapshot when it mounts, so the
  new table appears once the host has finished and the page reads again.
- **`internal` is `.volatile()` in the Config schema**: `@deepseek-ai/dsh-settings`
  `describe()` projects volatile nodes only, and `mutate()` throws when there are none. Every
  value that has to be read back by the UI (the cross-session summary, the refresh request)
  lives under `internal`.
- **Unattributable calls still add up**: when a message's `source.kind` is not `model`
  (system prompt, tool results), the usage goes into an `unknown/unknown` bucket and is
  counted separately, so the total still matches the provider instead of silently losing
  tokens.
- **Sorting lives in the pure layer**: `rowsOf` sorts by total descending with a stable
  tie-break on the key, so the host and the client can never disagree about the order.
- **Tokens only, no money**: DSH has a route-pricing mechanism, but it needs vendor pricing
  data. This plugin deliberately does not estimate, rather than stating a misleading amount.

## Directory structure

```
dsh-plugin-token-usage/
├── package.json          # dsh.bundle.patch + dsh.client declarations
├── cordis.patch.yml      # bundle patch: inserts the host entry with id token-usage
├── index.js              # host side: projection registration + bounded cross-session scan
├── lib/constants.js      # dependency-free constants (namespaces, projection key, buckets, limits)
├── lib/fold.js           # pure functions: buckets, folding by (provider, model), rows, formatting
├── lib/config.js         # Config schema (schemastery): scanLimit + volatile internal
├── lib/store.js          # settings layer: read/write the summary, consume the refresh request
├── lib/projection.js     # the tokenByModel session projection unit plus its wire.view schema
├── lib/summary.js        # cross-session scan: list sessions, read, fold, count skips
├── client.js             # browser side: two surfaces + page and meter components
├── locale/{en,zh}.json   # plugin page title and description
├── icon.svg              # panel icon (currentColor, 24x24)
├── scripts/test-fold.mjs # lib/fold.js pure-function tests (zero dependencies)
├── CONTRACT.md           # Interface Freeze v1 (team collaboration contract)
├── README.md             # English (default)
└── README.zh.md          # Chinese
```

`lib/fold.js` is a **zero-dependency pure-function layer**: it imports nothing but
`lib/constants.js`, it is shared by the host side and by the self-check script, and it runs
under plain Node without any shim.

## Installation

```text
plugin_manager install_bundle  target: file:E:\repos\dsh-plugins\dsh-plugin-token-usage
```

It does two things: adds the package to the profile's `dependencies`, and appends
`dsh-plugin-token-usage` to the profile's `dsh.profile.bundles`. The patch layer only inserts
one host entry:

```yaml
- insert:
    - id: token-usage
      name: 'dsh-plugin-token-usage'
```

The browser side does not need to be declared in the patch: `dsh-client-modules` scans the
`package.json dsh.client` of enabled Loader entries and then takes the bundle through
`exports["./client"]`. The Loader row id `token-usage` is also the plugin's settings
namespace, which is what the browser side uses when it writes a refresh request.

### Reinstall after changes

pnpm **copies** `file:` dependencies rather than symlinking them, so after changing
`client.js` / `lib/*.js` the profile must be made to pick up the new files:

```text
plugin_manager remove_bundle   target: dsh-plugin-token-usage
plugin_manager install_bundle  target: file:E:\repos\dsh-plugins\dsh-plugin-token-usage
```

(Repeating `install_bundle` directly returns `changed: false` / `ambiguous-install`.)
After reinstalling, **refresh the page** so that the browser picks up the new bundle.

### Uninstall

```text
plugin_manager remove_bundle   target: dsh-plugin-token-usage
```

## Usage

1. Click the "Token usage" icon in the sidebar to enter the page (the same page is also
   mounted in the `main` area under the key `token-usage`);
2. the table is the cross-session aggregate, one row per `(provider, model)`;
3. the footer shows how many sessions were scanned out of how many, how many logs were
   skipped, and when the last scan ran;
4. in a conversation, the header indicator shows this session's total; click it to open the
   per-model breakdown.

### Where the numbers come from

The only input is the `usage` object on `assistant/message` events of the session log
(`{ inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?,
reasoningTokens? }`). It is normalized into four buckets:

| Column | Bucket | Comes from |
| --- | --- | --- |
| Input | `uncachedInputTokens` | `usage.inputTokens` — the input that did not hit the cache |
| Output | `outputTokens` | `usage.outputTokens` |
| Cache read | `cacheReadTokens` | `usage.cacheReadTokens` (0 when the adapter does not report it) |
| Cache write | `cacheWriteTokens` | `usage.cacheWriteTokens` (0 when the adapter does not report it) |

Only events carrying real usage count as an attempt; a retry leaves its own
`assistant/message`, so the call count is the billing count. A model row's provider and model
come from `message.source`; a call whose `source.kind` is not `model` lands in the
`unknown/unknown` row, which the session indicator labels "Unattributed".

Pressing **Refresh** queues a request rather than scanning in the page: the browser writes
`internal.refreshRequestedAt` through `remote.settings.mutate()`, and the host fulfils it on
its next pass (a check runs once a minute). The page reads the settings snapshot when it
mounts, so the new numbers appear after the host has finished the scan and the page reads
again. If the profile cannot persist settings, the button is disabled and says so.

## Verification status

### Automated checks (all exit 0, actually run in this session)

```powershell
node scripts/test-fold.mjs        # all passed: 81 assertions
node scripts/test-summary.mjs     # all passed: 35 assertions
node scripts/verify-layout.mjs    # all passed: 260 layout and structure assertions
node scripts/verify-contract.mjs  # all passed: 292 assembly-shape assertions
```

`verify-contract.mjs` is the one that earns its keep on a plugin like this, because four
of this package's properties cannot be checked by running it:

- **The two sides must agree on constants.** `client.js` cannot import `lib/constants.js`
  (a client bundle only gets `require`), so `PANEL_ID`, `CONFIG_NS`, `PROJECTION_KEY` and
  `TOKEN_BY_MODEL_KEY` exist twice. The script parses both sides and compares them, and
  drives the browser side for real through a `window.__ModuleLoader__` stub.
- **The two `formatTokens` implementations must agree value for value.** The duplication is
  unavoidable for the same reason. The script extracts the browser side's copy from
  `__internals` and compares it against `lib/fold.js` across 16 values plus the
  `-1` / `NaN` / `Infinity` edges. A negative control that flips one threshold in either
  file makes it fail, so the comparison is not a rubber stamp.
- **The data shape must survive the hop between the sides.** Host folds, writes
  `internal.summary`, the settings service projects it, the browser reads it back. Any
  mismatch in nesting, field name or case shows up in the UI as "no data" and never as an
  error. The script writes once through the host's real store (capturing the complete raw
  config it submits), wraps that config the way `settings.describe()` returns it, hands it
  to the browser side's real `readSummary` / `normaliseRows`, and compares both ends row by
  row — plus a negative control that misplaces `summary` one level up and requires the
  browser side to find nothing.
- **Persistence must fall back on failure, not on availability.** `mode` selects a
  preference; `persist()` tries both channels and only reports failure when both throw.
  The script proves this behaviourally with stubs — a throwing `configEditor` still ends up
  written through `settings`, and two dead channels return `false`.

Layout conventions are assertions too (`verify-layout.mjs`): every `stu-*` class defined is
used and every class used is defined, colours only via `--dsw-alias-*` (with the one
documented `box-shadow` exception), no `word-break: break-all`, the root does not declare
`height: 100%`, and **all hooks precede the first `return`** in both components — the rule
whose violation blanks the whole slot with React #310.

The chart maths is asserted by **running** it, not by pattern-matching the source, because a
wrong chart renders happily and only lies. Two heatmap properties in particular are pinned:
the columns must line up with calendar weeks (the grid starts on the Sunday of the earliest
day's week, so every cell's row equals its real `getDay()`), and the intensity must occupy
four tiers of one hue (a negative control that collapses it to `total > 0 ? 4 : 0` turns the
suite red).

The date range is pinned the same way: the default window is anchored at the latest day **in the
data** (a negative control that anchors it at today turns the suite red), a typed date is clamped to
the data's real span and written back into the input, `from > to` swaps the two ends instead of
collapsing to a single day, an empty input means "unbounded" rather than a `NaN` date, and a range
with no usage keeps the range controls on screen so the empty state is never a dead end. The custom
tooltip is pinned too: it must not live inside the horizontally scrolling container (which would clip
it), cells must carry `aria-label` and **no** `title` (keeping both shows two tooltips at once), and
its position is clamped inside the card.

The suite covers the pure-function layer — the one both sides of the plugin rely on for
arithmetic:

| Area | Coverage |
| --- | --- |
| `bucketsOf` | all four buckets read from a full report; missing cache fields become 0 rather than a guess; a payload with no input/output at all returns `null`; input/output of 0 is still valid usage; negative and `NaN` values count as "not reported"; `reasoningTokens` never enters any bucket |
| Bucket arithmetic | `totalOf` adds the four buckets and tolerates `null`; `emptyBuckets`; `addBuckets` adds bucket by bucket, does not mutate its arguments and tolerates `undefined` |
| `attemptOf` | only `assistant/message` counts — `assistant/attempt` (stream only, no usage), events without `usage`, junk `usage` and non-object events all return `null` |
| `modelIdentityOf` | `source.kind === 'model'` is required; `system-prompt` and `tool` messages do not count as model calls; a missing model falls back to `provider/unknown`, anything else to `unknown/unknown` |
| `applyAttempt` | purity (irrelevant events return the same reference, the input state is never mutated, a new object is returned); accumulation per key; retries counted as separate attempts; unattributed attempts counted separately while still landing in the `unknown/unknown` bucket |
| `foldEvents` / `rowsOf` | folding a mixed event stream; descending sort by total; a stable tie-break by key; `rows` carry copies of the buckets; empty and `null` states |
| Formatting | the compact form (`1000` → `1K`, `1234` → `1.2K`, `123456` → `123K`, `1000000` → `1M`, `1000000000` → `1B`, negatives and `NaN` → `0`) and the exact thousands-separated form |

### Real-device end-to-end (actually measured in this session on a running Host)

- **Host side activated**: the plugin's Config reports `status: "schema"`. That also proves
  that `zod` and `@deepseek-ai/schemastery` resolve inside the host process.
- **Browser side activated**: the client seat `token-usage` is `active: true` in
  `conversation.session.header.utilities`, listed next to the official `open-in-app` and
  `session-log-download` seats, and it displaced no official control.
- **The projection schema is valid under the real `zod` 4.6.5**: because the host module
  loaded successfully, the static `import { z } from 'zod'` in `lib/projection.js` and every
  `z.*` call in it do hold on the device.

### Not verified (requires manual confirmation on the real page)

- **Visual presentation**: colours, spacing, and contrast under light and dark themes are not
  verified. This session has no control over a browser, and per the official verification
  rules it does **not** do mock previews, screenshots or simulated React rendering to "prove"
  visual effects.
- **The live indicator's actual reading and its popover interaction on a real device**: both
  need browser control and have not been observed.
- **The projection's `wire.view` output has not been validated with `zod` offline**: `zod`
  exists only inside the DSH installation package (`app.asar`), so plain Node cannot resolve
  it and that validation cannot be reproduced offline. What *is* verified is that the schema
  is constructed successfully where `zod` is present (see above).

### Reloading already-installed plugin code

`pnpm` **copies** `file:` dependencies, and the host process caches already-loaded modules.
After changing plugin code:

```text
plugin_manager remove_bundle  target: dsh-plugin-token-usage
plugin_manager install_bundle target: file:E:\repos\dsh-plugins\dsh-plugin-token-usage
```

Then **restart the Host** (or re-enable that Loader entry) before the new JavaScript build is
loaded; refreshing the page alone only gets you the new browser-side bundle. Node's ESM module
cache is keyed by resolved path, so replacing the file on disk does not replace the module
that was already imported — a host-side change (the projection, the scan, the config schema)
will look like "the fix did nothing" until the host is restarted.

### Prerequisites for running the repository's tool scripts

`node scripts/test-fold.mjs` needs nothing: `lib/fold.js` imports only `lib/constants.js`, so
it runs under plain Node with no third-party package. The host's `lib/config.js` does need
`@deepseek-ai/schemastery`, which ships with DSH and is not a dependency of this package — but
no script of this plugin imports it, and no `node_modules` shim is required here.

## Known limitations

- **The live view depends on a Host session projection**: in a profile that has no
  `sessionProjections` (or is missing a `sessionManager`-style service), that view renders a
  single line of fallback text instead of numbers. The plugin as a whole does **not** fail
  because of it — the cross-session page still works.
- **The cross-session range is bounded by `scanLimit`** (200 by default): older sessions are
  not counted, and the page states that explicitly rather than implying the number is the
  whole history.
- **Unattributable calls are kept, not dropped**: usage on a message whose `source.kind` is not
  `model` goes into the `unknown/unknown` row and is counted separately, labelled
  "Unattributed" — so the total reconciles with the provider instead of losing tokens.
- **Tokens only, no cost**: DSH has the route-pricing mechanism, but it needs vendor pricing
  data, and this plugin deliberately does not estimate in order to avoid stating a misleading
  amount of money.
- **Only what the adapter reported**: if a provider reports no cache usage, the cache columns
  show 0, because the plugin does not backfill numbers the provider never sent.
- There is no build step: `client.js` is a directly loadable browser bundle.
