English | [中文](README.zh.md)

# dsh-plugin-scheduled-tasks

**Trigger the model to run a task from a prompt on a schedule**: write one prompt,
give one time expression, and when the time comes DSH **actually opens a new session
and runs the model**, writing the result into the run log.

The built-in `@deepseek-ai/dsh-schedule` does something else:

> It only delivers a piece of **reminder text into an existing session** when the time
> comes, and waits for you to go look at it.
> It **triggers no model execution at all** —— if nobody opens that session and nobody
> sends a message, nothing happens.

This plugin fills in exactly that gap: `ctx.agentLoop.createAgent(...)` creates a session
belonging to that run, `agent.followup(prompt)` wakes up one turn, and then it waits for
the **durable event** `turn/end` to finish. Even if no window is watching it at the time,
the task still runs to completion and its result lands in the log.

## What it does

- **Menu entry points**: a sidebar panel icon (`sidebar.panellist`, id `scheduled-tasks`,
  order 20) and a main-area page (`main`, the same key); opening the panel is the task
  management page.
- **5 kinds of time expression**: interval `every`, daily `daily`, weekly `weekly`,
  five-field cron, one-shot `once`.
- **Real execution**: every trigger generates the sessionId
  `scheduled-task-<taskId>-<epochMs>`, creates a new agent, drives one turn, takes the last
  assistant text as the result summary, and calls `dispose()` at the end whether it
  succeeded or failed.
- **Run log**: a host-side ring buffer (200 entries by default); a run writes a `running`
  entry at the start and **replaces it in place** with a terminal state
  (`ok` / `error` / `timeout` / `skipped`) at the end, carrying a `sessionId` you can jump to.
- **Tasks can carry a skill and run constraints**: optional `skill` (instructs the
  execution body to load that skill first), a `tools` whitelist, `workspaceRoot` (the cwd
  for that run), and `model` (overrides provider/model).
- **Creation through conversation**: registers the 5 model tools
  `scheduled_task_create` / `_list` / `_update` / `_delete` / `_run`, and registers the
  `scheduled-tasks` skill —— just say "summarize yesterday's git commits for me every day
  at 9am" and the task is created.

## Why it is designed this way

### Config is the only persisted state

The config document (the Loader row id is `scheduled-tasks`, which is also the settings
namespace) is the database:

```jsonc
{
  "enabled": true,            // master switch
  "tickMs": 30000,            // scheduler poll interval
  "maxConcurrentRuns": 2,     // concurrency limit within one tick
  "runTimeoutMs": 1800000,    // single-run timeout (30 minutes)
  "logLimit": 200,            // number of log ring-buffer entries
  "workspaceRoot": null,      // default cwd
  "tasks": [ /* ScheduleTask[] */ ],
  "internal": { "log": [ /* LogRecord[] */ ], "runs": { /* in-flight dedup markers */ } }
}
```

Task definitions, in-flight dedup markers, and the run log all live in this one document:
uninstalling/reinstalling the plugin leaves no second copy of the state, and all writes go
through the optimistic concurrency control of `ctx.settings.mutate` (carrying the `revision`
just read every time), so the UI and the host editing a task at the same time cannot
overwrite each other.

### Why the client uses no custom Remote

The namespaces of the DSH client's `ctx.remote` are a **whitelist fixed at compile time**:
only names pre-declared in official bundles (`settings`, `workspaceFiles`, `llm`, …) exist,
and a third-party pure-JS plugin **cannot add** a namespace —— it is not that "it isn't
documented", there is simply no registration entry point at all.

So the browser half of this plugin has no custom Remote whatsoever; it only reuses the
existing `ctx.remote.settings.describe()` / `mutate(ns, ops, revision)` as its read/write
channel:

- read: find this plugin's entry in `describe()`, and take the task list, the log and the
  `revision`;
- write: `mutate(CONFIG_NS, [{ op: 'set', path: [...], value }], revision)`;
- concurrency: settings are CAS semantics; if the revision does not match, re-`describe()`
  and retry once, and if it still fails, tell the user to retry rather than overwriting
  someone else's change;
- degradation: when `ctx.settings` / `remote` are missing, render read-only or show a hint,
  and never throw an exception that drags the plugin down.

### Why the run log does not go through `remote.workspaceFiles`

That channel needs a `sessionId` to locate workspace files, and `main` is a keyed slot with
**root scope that is not bound to a session** —— the page cannot obtain a `sessionId`. The
log is therefore carried by Config instead, written only by the host and read only by the
client; zero extra cross-process API.

### A few other choices

- **Open a new session per run** rather than stuffing it into an existing session: tasks do
  not pollute each other, they can run concurrently, and the `sessionId` in the log lets you
  jump straight to what that run actually did.
- **Wait for durable events such as `turn/end`** instead of polling `agent/status`: polling
  misses events and wastes ticks, and `runTimeoutMs` covers timeout protection.
- **Hard-code "do not ask for confirmation" into the prompt**: nobody can answer it during
  that run, so asking for confirmation means hanging.
- **cron supports only a five-field subset**: it rejects `L`/`W`/`#`, English names, the
  `@daily` macro, six fields, and step 0. A pure-JS implementation can be fully predictable,
  unit-testable, and cross-platform consistent, instead of quietly producing a wrong next
  fire time.
- **`once` automatically sets `enabled: false` after firing**: a one-shot task stays visible
  in the list but never fires again.

## Directory structure

```
dsh-plugin-scheduled-tasks/
├── package.json          # dsh.bundle.patch + dsh.client declarations
├── cordis.patch.yml      # bundle patch: inserts the host entry with id scheduled-tasks
├── index.js              # host entry: Config, apply, wiring
├── lib/config.js         # Config schema + constants + defaults
├── lib/constants.js      # dependency-free constants (namespace, defaults, field limits)
├── lib/model.js          # pure data: task read/write, validation, serialization
├── lib/cron.js           # pure functions: cron parsing + next fire time + human-readable description
├── lib/store.js          # run-log ring buffer + Config read/write (revision CAS)
├── lib/runner.js         # execution engine: create agent, drive one turn, timeout, dispose
├── lib/scheduler.js      # timer + dispatch + concurrency limit + overlap dedup
├── lib/tools.js          # model tools scheduled_task_*
├── lib/skill.js          # programmatic registration of the scheduled-tasks skill
├── client.js             # browser half: lazy factory + two slots + page components
├── skills/scheduled-tasks/SKILL.md   # human-readable backup of the skill
├── locale/{en,zh}.json   # plugin page title and description
├── icon.svg              # panel icon (currentColor, 24x24)
├── scripts/test-cron.mjs          # cron/model pure-function tests (dev-only, not installed with the package)
├── scripts/test-store.mjs         # store reads/writes and revision-conflict tests
├── scripts/verify-contract.mjs    # assembly-shape self-check (dev-only, not installed with the package)
├── scripts/verify-layout.mjs      # layout and information-architecture rule self-check
├── scripts/verify-render.mjs      # render and interaction self-check (built-in minimal React runtime)
├── CONTRACT.md           # Interface Freeze v1 (team collaboration contract)
├── README.md             # English (default)
└── README.zh.md          # Chinese
```

## Installation

```text
plugin_manager install_bundle  target: file:E:\repos\dsh-plugins\dsh-plugin-scheduled-tasks
```

It does two things: adds the package to the profile's `dependencies`, and appends
`dsh-plugin-scheduled-tasks` to the profile's `dsh.profile.bundles`. The patch layer only
inserts one host entry:

```yaml
- insert:
    - id: scheduled-tasks
      name: 'dsh-plugin-scheduled-tasks'
```

The browser half does not need to be declared in the patch: `dsh-client-modules` scans the
`package.json dsh.client` of enabled Loader entries and then takes the bundle through
`exports["./client"]`.

### Reinstall after changes

pnpm **copies** `file:` dependencies rather than symlinking them, so after changing
`client.js` / `lib/*.js` the profile must be made to pick up the new files:

```text
plugin_manager remove_bundle   target: dsh-plugin-scheduled-tasks
plugin_manager install_bundle  target: file:E:\repos\dsh-plugins\dsh-plugin-scheduled-tasks
```

(Repeating `install_bundle` directly returns `changed: false` / `ambiguous-install`.)
After reinstalling, **refresh the page** so that the browser picks up the new bundle.

### Uninstall

```text
plugin_manager remove_bundle   target: dsh-plugin-scheduled-tasks
```

## Usage

1. Click the "Scheduled Tasks" icon in the sidebar to enter the management page (the same
   page is also mounted in the `main` area under the key `scheduled-tasks`);
2. In "New Task", fill in a title + prompt + time expression;
3. In the list you can see the time description, next fire time and latest status, and
   enable/disable / run now / delete;
4. The log area at the bottom shows the most recent runs, expandable to see the summary and
   errors.

### The 5 kinds of time expression

| Form | Meaning | Example |
| --- | --- | --- |
| `every` | every N minutes (30..43200) | every 2 hours → `{"kind":"every","everyMinutes":120}` |
| `daily` | a local time of day, every day | every day at 9am → `{"kind":"daily","time":"09:00"}` |
| `weekly` | certain weekdays every week (1=Monday … 7=Sunday) | Mon/Wed/Fri at 18:30 → `{"kind":"weekly","time":"18:30","weekdays":[1,3,5]}` |
| `cron` | five-field Vixie subset | every 15 minutes from 9 to 18 on weekdays → `{"kind":"cron","expression":"*/15 9-18 * * 1-5"}` |
| `once` | a one-shot epoch in milliseconds (must be in the future) | tomorrow at 8am → `{"kind":"once","at":1767225600000}` |

`daily` / `weekly` / `cron` all compute the next fire time in the **host's local timezone**.

The five-field cron dialect: `minute hour day-of-month month day-of-week`, where each field
supports `*`, a single value, `a-b`, `*/n`, `a-b/n`, and comma lists, and `0` and `7` in
`dow` both mean Sunday; it **rejects** `L` / `W` / `#` / English names / the `@daily` macro /
six fields / out-of-range values / inverted ranges / step 0.

### Create through conversation

No need to open the panel; just state the requirement in the conversation:

- "summarize yesterday's git commits for me every day at 9am"
- "check the build status every 2 hours, and if it's broken summarize the failure log for me"
- "summarize the files changed today every Monday, Wednesday and Friday at 18:30"
- "run a repo health check every 15 minutes between 9am and 6pm on weekdays"
- "run a dependency update check tomorrow at 8am, just this once"

The model first restates the request for confirmation ("just to confirm: automatically
summarize the previous day's git commits every day at 09:00, is that right?"), and only
calls `scheduled_task_create` after the user confirms; when the time or the content is
vague it should ask a follow-up question first rather than guess. The time expression is
**always translated by the model into a structured `schedule`**; the user never has to write
cron.

## Feature: model and reasoning effort, task editing

Each task can specify, individually:

- **the model** (provider + model); if omitted, it follows the session's default model;
- **reasoning effort**, listing only the levels **that model itself declares**
  (`reasoning.efforts`), and with the first entry being "model default" (no field written,
  so the model's own default effort takes effect);
- **working directory** (the cwd for that run);
- **skill**, **tools whitelist**, **enable/disable**.

A task can be **edited**: clicking "Edit" on a task row opens the same form, and the title /
prompt / time / model and so on can all be changed; saving is an **in-place replacement**
(`id` and `createdAt` are unchanged), so the run history connects up with that task;
runtime fields such as `lastRunAt` / `nextRunAt` / `lastStatus` are not managed by the form
and are not wiped out by the whole-record write-back.

Where the model catalog comes from: the client cannot reach `llm.listModels` (it is not
`@Remote`), so the host computes it and writes it into `internal.catalog`, and the UI picks
it up together with the `describe()` it already has to read anyway —— introducing no new
Remote dependency.

## Verification status

### Automated checks (all exit 0, actually run in this session)

```powershell
node scripts/test-cron.mjs        # all passed: 190 assertions
node scripts/test-store.mjs       # all passed: 35 assertions (namespace=scheduled-tasks)
node scripts/verify-contract.mjs  # all passed: 65 assembly-shape assertions
node scripts/verify-layout.mjs    # all passed: 54 layout and information-architecture assertions
node scripts/verify-render.mjs    # all passed: 57 render and interaction assertions
```

Together they amount to **401 assertions**, covering:

| Area | Coverage |
| --- | --- |
| `lib/cron.js` | the accepted surface of the five-field cron dialect (`*`/single value/range/step/comma list, dow 0 and 7 being synonymous) and the **rejected surface** (`L`/`W`/`#`/English names/`@` macros/six fields/out-of-range/inverted range/step 0); the boundaries of the 5 schedule kinds and day/week rollovers; `0 0 30 2 *` returning `null` as it has no solution |
| `lib/model.js` | the shape and uniqueness of `newTaskId` (including robustness when `random` is always 0), acceptance/rejection by `normalizeTask`, `isTaskDue`, and `advanceTask` not mutating the original object and correctly disabling `once` |
| `lib/store.js` | memory and on-disk consistency of `appendLog`/`updateLog`/`setRunState` under both `describe()` semantics — deep copy and **live reference** — plus revision-conflict retries and `logLimit` trimming |
| Assembly shape | manifest and patch are valid; `client.js` registers the factory under the package name, `apply` registers **exactly** `sidebar.panellist` and `main` (`id`/`key` are both `scheduled-tasks`); `index.js` returns no cleanup function, a second `apply` on the same ctx is idempotent, different ctxs each assemble their own; no file has a `@deepseek-ai/*` runtime import |
| Layout structure | the closed loop between CSS class names and JSX references (no dead classes, no unstyled classes); row/title classes must not carry `flex:1`; in-row layout uses grid with explicit columns (log row `auto minmax(0,1fr) auto`, task row `minmax(0,1fr) auto`); long Chinese copy does not use `break-all`; the root container declares no `height:100%` and builds no scrolling of its own |

**Why `verify-layout.mjs` exists**: the misalignments exposed by real-device screenshots
(the log row's badge and timestamp pushed all the way right, cards nested inside cards, the
segmented control's rounded corners cut off after wrapping) **cannot be caught by any
functional assertion** —— they all "render successfully". This script turns layout
conventions into assertable rules, and it has been through a **negative control**: reverting
it to the old style (log rows using flex, title classes with `flex:1` added) reports exactly
those 2 failures.

### Real-device end-to-end (actually measured in this session on a running Host)

- **Host half activated**: `Config.listConfigs` finds `include:scheduled-tasks`
  (status `schema`); the five `scheduled_task_*` tools and the `scheduled-tasks` skill
  actually appear in the session's tool/skill catalog.
- **Browser half activated**: the live client slot shows `sidebar.panellist` has an active
  placeholder `{ id: "scheduled-tasks", order: 20 }`, and `main` has an active placeholder
  `{ key: "scheduled-tasks" }`.
- **Conversation creation works**: `scheduled_task_create` really creates a task
  successfully and reads it back; the task definition lands in the profile's
  `cordis.patch.yml` (`- id: scheduled-tasks` → `config.tasks`).
- **Actually ran the model once**: `scheduled_task_run` made the plugin **open a separate,
  independent session**
  (`C:\Users\Administrator\.dsh\sessions\_no-cwd\scheduled-task-<id>-<ts>\`), and that run's
  `lastStatus` was written back as `ok`. This is precisely the essential difference between
  this plugin and the built-in `dsh-schedule`.

### Three real defects caught and fixed by this real-device verification

The automated assertions **failed** to find them; one real run exposed them —— which is also
why "install it and run it once" cannot be skipped:

1. **A run that never started was recorded as `ok`**: the semantics of `agent.whenIdle()` are
   "the end of the current active interval", but after `followup()` the driving may not have
   started work yet, in which case it returns immediately. On a real device this showed up
   as: the session has only a session header line and did nothing, yet the log wrote `ok`.
   Now the decision is made in two stages (first wait for work to start, then wait for idle),
   and anything that never started is always recorded as `error`, never falsely reported as
   success.
2. **A periodic task could silently never fire**: `isTaskDue` only looks at `nextRunAt`, and
   it used to be written only at process startup and at the end of a run. A task created in
   the UI or written in by hand editing would be missing `nextRunAt` for the whole lifetime
   of that process. Now every tick schedules one round for tasks that are "enabled but have
   no `nextRunAt`" (the computed time point is in the future and does not fire in the current
   round).
3. **`scheduled_task_run` returned `status: "unknown"`**: `lib/tools.js` expected the run
   record itself, whereas the wiring layer at the time returned a `{ ok: true, record }`
   wrapper. Now both sides agree on "return the record itself", and the tool layer is also
   compatible with the wrapped form.

### Not verified (requires manual confirmation on the real page)

- **Visual presentation**: the panel icon's colors/line width, the layout of the task list
  and the form, consistency with host controls, and contrast under light/dark themes —— none
  of these are verified. This session has no control over a browser, and per the official
  verification rules it does **not** do mock previews, screenshots or simulated React
  rendering to "prove" visual effects.
- **The actual timing of clicking "Run now"**: the client only writes it as a request entry
  in `internal.manualRuns`, which the host consumes on the next tick (≤ `tickMs`, 30 seconds
  by default). So after clicking the button the log does not update immediately; you have to
  wait one tick and refresh —— this is a design tradeoff, but the felt experience of "how
  long after clicking do I see the result" has not been confirmed on the page.
- **The cross-timezone conversion of `once`** and its behavior when it disagrees with the
  user's local clock.
- When the settings document is manually corrupted (`tasks` mixed with non-objects, invalid
  cron), the page's fault tolerance only filters/rejects; this has not been walked through
  on a real device.

### Reloading already-installed plugin code

`pnpm` **copies** `file:` dependencies, and the host process caches already-loaded modules.
After changing plugin code:

```text
plugin_manager remove_bundle  target: dsh-plugin-scheduled-tasks
plugin_manager install_bundle target: file:E:\repos\dsh-plugins\dsh-plugin-scheduled-tasks
```

Then **restart the Host** (or re-enable that Loader entry) before the new JavaScript build is
loaded; refreshing the page alone only gets you the new browser-half bundle. This session
measured it after changing the runner: the file on disk was already updated, but
`scheduled_task_run` in the same process was still running the old code (this is normal in
Docker-style incremental development, but when troubleshooting it is easy to misjudge it as
"the fix did not work").

### Prerequisites for running the repository's tool scripts

`scripts/*.mjs` and `lib/config.js` need `@deepseek-ai/schemastery`, which is provided by the
dsh installation and is not among this plugin's dependencies. To run these scripts under
plain Node, a resolvable copy is needed, for example by creating the following under the
plugin directory:

```text
node_modules/@deepseek-ai/schemastery  ->  the package of the same name in the dsh installation
node_modules/@deepseek-ai/cosmokit     ->  schemastery's dependency
```

That directory is only used for local testing; it is already outside `files` in
`package.json` and will not be included in published content.

## Known limitations

- **The host must be running**: the scheduler runs inside the DSH host process, so if the
  application is closed there is no trigger at all; after reopening, the next fire time is
  recomputed from the current time, and missed triggers are not caught up.
- **Single-machine local timezone**: `daily` / `weekly` / `cron` are all interpreted in the
  host's local timezone, so in a multi-machine/cross-timezone deployment the same expression
  fires at different times on different machines.
- **cron is only a five-field subset**: no second-level granularity, no `L`/`W`/`#`, no
  English names and no `@daily` macro.
- **The log is capped**: by default only the most recent 200 entries are kept (`logLimit`)
  and earlier records are trimmed; an in-progress record is replaced in place for the same
  `seq` and is not counted twice.
- **Concurrency is capped**: by default at most 2 tasks per tick (`maxConcurrentRuns`), and
  a task that is already running is skipped by an overlapping trigger (`internal.runs` dedup);
  a single run exceeding `runTimeoutMs` (30 minutes by default) is recorded with the terminal
  state `timeout`.
- **Tasks live in the plugin settings, not in a session**: the client adds no Remote and the
  page can only read/write through `remote.settings`, so tasks cannot be shared directly with
  other plugins by session-level tools.
- **`skill` is a hint, not an enforcement**: the execution body is only asked to load the
  specified skill; whether it actually does depends on that turn's model judgment.
- There is no build step: `client.js` is a directly loadable browser bundle.
