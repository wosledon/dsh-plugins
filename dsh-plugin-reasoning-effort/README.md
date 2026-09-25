English | [中文](README.zh.md)

# dsh-plugin-reasoning-effort

Adds a "set reasoning effort per model" UI for **custom (manually declared) providers**.

DSH's model picker only lists the reasoning levels **the adapter has published**.
For custom routes that are not in the pi-ai catalog, the adapter gets no reasoning
metadata at all, so not even an Effort row appears in the model picker, and the UI
has "no reasoning-effort input of any kind"; and
`dsh-client-ui-settings-models` **deliberately** provides no provider-level effort
control:

> There is deliberately no reasoning-effort control, here or on the editor card:
> effort is a per-MODEL capability, and the models under one provider disagree
> about it, so a provider-scoped control can only be set to a value some of them
> reject.

The config layer has in fact supported this for a long time: `@deepseek-ai/dsh-llm-pi-ai`
lets each model declare
`providers.<route>.models[].reasoningEfforts`. What this plugin adds is exactly that
missing editing UI, and it strictly follows the design premise that "effort is a
per-model capability".

## What it does

Inside every provider card on "Settings → Models" (in the slot the official code
reserves for this, `settings.models.provider-card`) it adds one editor row per model:

- **Inherit** — omit `reasoningEfforts`, keeping the capability the installed
  catalog has for that model;
- **No reasoning** — write `reasoningEfforts: false`;
- **Custom** — declare the wire spelling level by level, for example
  `{ low: low, high: high }`; leaving `off` blank writes `null`, meaning "supports
  turning off thinking, but sends no parameter at all";
- When the route protocol is `openai-completions`, it additionally offers a
  three-state switch for `compat.supportsReasoningEffort` (inherit / true / false) —
  when the gateway protocol cannot be detected automatically, you must declare it
  explicitly before reasoning parameters are sent.

Reads: `remote.settings.describe()`; writes: `remote.settings.mutate()`.
It adds no Host service, event, or tool.

### Why the write granularity is the whole `models` array

Path editing on the settings document only descends into **plain objects** (arrays,
for which `isPlainObject` is false, are not descended into).
Writing `['providers', route, 'models', '0', 'reasoningEfforts']` would break `models`
apart into `{ "0": … }`, so this plugin writes back the whole
`['providers', route, 'models']` segment, leaving the other fields (`id` / `name` /
`contextWindow` / `input` / `compat`, etc.) exactly as they were.

For the write-back it prefers the **raw user-layer array** (`namespace.user`), to avoid
freezing schema defaults into the user layer; only when the user layer has no such
array does it fall back to the resolved value (`namespace.value`).

## Directory structure

```
dsh-plugin-reasoning-effort/
├── package.json          # dsh.bundle.patch + dsh.client declarations
├── cordis.patch.yml      # bundle patch: inserts one host entry line
├── index.js              # host side: empty implementation (only the browser side has behaviour)
├── client.js             # browser side: lazy factory + slot registration + card component
├── icon.svg              # plugin page icon
├── locale/{en,zh}.json   # plugin page title and description
├── scripts/verify-contract.mjs   # contract self-check (for development, not installed with the package)
├── README.md             # English (default)
└── README.zh.md          # Chinese
```

The host side exists only because `dsh-client-modules` scans the
`package.json dsh.client` declarations of **enabled Loader entries** only; the browser
bundle is obtained via `exports["./client"]`. Without that line, `client.js` would
never make it into `window.__DSH_BOOT__`.

## Installation (already done on this machine)

```text
plugin_manager install_bundle  target: file:E:\repos\dsh-plugins\dsh-plugin-reasoning-effort
```

It does two things: it adds the package to the profile's `dependencies`, and it appends
`dsh-plugin-reasoning-effort` to the `dsh.profile.bundles` of `package.json`. The
current profile is `C:\Users\Administrator\.dsh\profiles\desktop`.

### Reinstall after changes

pnpm **copies** `file:` dependencies instead of symlinking them, so after changing
`client.js` you must get the new files into the profile:

```text
plugin_manager remove_bundle   target: dsh-plugin-reasoning-effort
plugin_manager install_bundle  target: file:E:\repos\dsh-plugins\dsh-plugin-reasoning-effort
```

(Repeating `install_bundle` directly returns `changed: false` / `ambiguous-install`.)
After reinstalling, refresh the page — only then does the browser get the new bundle.

### Uninstall

```text
plugin_manager remove_bundle   target: dsh-plugin-reasoning-effort
```

## Usage

1. Open "Settings → Models";
2. Expand a custom provider (for example `stepfun` in this profile);
3. Find "Reasoning effort (per model)" at the bottom of the card;
4. Choose **Custom** → expand → fill in the level spellings → save.

Taking `stepfun` as an example, after saving, that model's entry in the profile's
`cordis.patch.yml` becomes:

```yaml
- id: llm-pi-ai
  config:
    providers:
      stepfun:
        api: openai-completions
        models:
          - id: step-3.7-flash
            name: step-3.7-flash
            contextWindow: 262144
            input: [text, image]
            reasoningEfforts:
              off: null      # blank: supports turning off thinking, but does not send this parameter
              low: low
              high: high
            compat:
              supportsReasoningEffort: true
```

The exact spellings must follow the gateway documentation: values such as `low` /
`medium` / `high` are common on OpenAI-compatible endpoints, but the values are yours
to fill in — the plugin makes no assumptions.

### Two host hard rules (the plugin already validates them for you before saving)

1. Every level other than `off` must have a non-empty spelling, otherwise the host
   rejects it **before any network I/O**;
2. At least one thinking level must be declared; if all you want is to turn thinking
   off, choose "No reasoning", which writes `reasoningEfforts: false`.

## Verification status

Verified:

- The package and the patch manifest parse, and the `insert` line name matches the
  package name;
- The browser side registers a lazy factory under the package name as its id, and the
  factory returns a valid Cordis plugin object;
- `apply()` registers **keyed** cells on `settings.models.provider-card` only, with keys
  taken from the real `settingsNs` of `remote.llm.listConfigurableProviders()`;
- Write shape: a single `set` operation, with the path landing on
  `providers/<route>/models` (not on an array element), the value being the complete
  `models` array, carrying back the `revision` that was read;
- Level mapping rules: blank `off` → `null`, levels left unfilled get no key, declaring
  only `off` is rejected, inheritance mode writes no field, the `compat` three-state and
  unrelated fields are preserved, and the original object is not mutated;
- The host entry `include:reasoning-effort` is `active`;
- The actual client slots: there is a live placeholder on each of the three keys
  `llm-pi-ai` / `llm-deepseek` / `llm-deepseek-account`, which are exactly the
  namespaces the settings page actually dispatches.

Not verified (this requires you to operate the page; this session has no browser control):

- The card's **visual presentation** (colors, spacing, consistency with host controls);
- The **save round trip**: after clicking "Save", writing back to the profile and
  appearing in the next `describe()`.

Self-check script (does not render React; it only verifies the assembly shape and the
mapping rules, 49 assertions in total):

```powershell
node scripts/verify-contract.mjs
```

It reads the pure mapping functions through the `plugin.__internals` test seam — Cordis
only reads `inject` / `apply` / `name` / `Config`, so extra exports are ignored.

## Known limitations

- It only covers provider namespaces that have a `models` array; catalog-style routes
  such as the official DeepSeek ones do not show this section (their models are not in a
  `models` array).
- A hand-declared, not-yet-saved "add provider" draft card has no catalog row, so this
  section is not rendered for it until it is saved as a real route (established
  host-side behaviour).
- It provides no provider-level effort default — consistent with the official design,
  effort is a per-model capability.
- There is no build step: `client.js` is a browser bundle that can be loaded directly
  (`window.__ModuleLoader__.load({ id, factory })`, where the factory returns the plugin
  object).
