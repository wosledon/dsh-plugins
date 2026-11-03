English | [中文](README.zh.md)

# dsh-plugin-copilot-config

Reads the GitHub Copilot configuration a project keeps under `.github/` — the same
files VS Code Copilot uses — and makes it available to the agent and to you, with
working file links.

## What it reads

| Path | Kind | Notes |
| --- | --- | --- |
| `.github/copilot-instructions.md` | repository instructions | injected into the prompt for every Session in that project |
| `.github/instructions/**/*.instructions.md` | path instructions | `applyTo` glob and `description` from frontmatter |
| `.github/prompts/*.prompt.md` | reusable prompts | `mode`, `description` from frontmatter |
| `.github/skills/*/SKILL.md` | Agent Skills | `name`, `description` from frontmatter |
| `.github/chatmodes/*.chatmode.md` | chat modes | `description`, `mode` from frontmatter |
| `.github/agents/*.agent.md` | custom agents | `description` from frontmatter |
| other `.github/**/*.md` | other | kept so nothing under `.github` is hidden |

Frontmatter is parsed as a flat `key: value` block — `name`, `description`,
`applyTo`, `mode` — never as YAML. A title falls back from frontmatter `name` to
the first heading to the file name.

An Agent Skill's own payload (`scripts/`, `references/`, `assets/`,
`templates/`, licenses) is not Copilot configuration of its own, so the scan
keeps the `SKILL.md` entry and skips the rest of the skill folder.

## Where it appears

One **right-sidebar tab** per Session — the same column that holds Files and the
Document preview. Open it from the panel's guide (the add control lists a
**Copilot config** entry box) or bind the `copilot-config.open` command in
Settings → Shortcuts; there is no left-sidebar menu row. The tab lists the files
grouped by kind, renders one at a time (headings, lists, code fences, quotes,
inline code), and shows a **File links** section. Every relative markdown link is
resolved against the file that contains it and turned into a
`dsh-resource://file/session/<id>/<path>` address, so clicking it opens that file
in the right sidebar's Document preview — the same surface the Files tab uses.
Links inside fenced code are never treated as links, and external links open in a
new window. Invocable entries carry a `/name` badge.

## Bringing an entry into the conversation with `/`

Type `/` in the composer and the menu lists the project's **Copilot skills**
(prompt files and Agent Skills) and **Copilot agents** (chat modes and custom
agents) beside the built-in commands and skills. A query matches the name you
would type, the title, or the description.

Picking one inserts a chip labelled `/<name>` — `review` for
`.github/prompts/review.prompt.md`, `plan` for `.github/chatmodes/plan.chatmode.md`,
`webapp-testing` for `.github/skills/webapp-testing/SKILL.md`. The name is the
frontmatter `name` when the file declares one, and the file name without its
`.prompt.md` / `.chatmode.md` / `.agent.md` suffix (or the skill directory)
otherwise. Clicking the chip opens the file it came from in the right sidebar.

On send, the chip expands into the file's own content:

```text
<copilot_skill name="review" path=".github/prompts/review.prompt.md">
# Review prompt

Summarize the diff and list risks.
</copilot_skill>
```

so the model reads the instructions it was handed instead of guessing a path. A
chat mode or custom agent uses the same shape under the `copilot_agent` tag. The
sent message renders the block back as a chip that reopens the file. A body
larger than 64 KiB is cut with a visible marker that names the tool that reads
the rest.

A bare `/name` the user types by hand is the same request in plain text: the
prompt context below tells the model which file it names.

## How the agent reads it

Three mechanisms, one data path:

- a `copilot_config` tool with `action: "list"` and `action: "read"` plus a
  repository-relative `path`; `list` also returns the invocable catalog;
- a prompt section per Session, built from the project's own
  `copilot-instructions.md` plus an index of the other files with their
  `applyTo` scopes and of the entries invocable with `/`, bounded at 16 KiB;
- the reference block a `/` pick puts into the message.

All three call the same scanner, which walks `.github` through `ctx.fs` with
hard bounds: 300 files, depth 4, 256 KiB per file, 500 directory entries. Missing
`.github` is a normal state — the tab shows an empty state, the `/` menu
offers nothing, and the prompt section is simply absent.

## Requirements and security

- Reads only the Session's working directory (or the Host default directory when
  no Session is available); it never walks outside it and never writes.
- The Web UI reads through a token-protected same-origin route
  (`/plugin-copilot-config/api/*`); the token is per process and handed only to
  the local page.
- A reference carries the Session it was picked in, so a submit reads the same
  `.github` the menu did. A read that fails blocks the send with its reason
  instead of silently sending a bare `/name`.
- No dependencies: the plugin is plain ESM on the Host and a plain module on the
  Client.

## Known limitations

- Windows remote hosts are irrelevant here — this plugin reads the **local**
  project. Combine it with `dsh-plugin-remote-dsh` for a remote project.
- `AGENTS.md` / `CLAUDE.md` are already handled by `dsh-agent-instructions`; this
  plugin does not duplicate them.
- Reference-style markdown links (`[text][ref]`) and link titles are not parsed.
- The per-Session prompt section is loaded once per agent; edit a configuration
  file and start a new Session (or call the tool) to see the change.
- Two entries can derive the same `/name` (a prompt and a chat mode both called
  `review`, say). The menu shows both rows, and each chip carries its own path,
  but the clipboard projection of a copied chip is the name alone.
- A typed `/name` is not decorated as a chip in the composer: only a pick
  inserts one, so a hand-typed name never turns into a reference by accident.

## Verification

```text
node scripts/verify-contract.mjs
# verify-contract: 344 assertions passed
```

Covers classification (including Agent Skills and their payload folders),
frontmatter, title and invocation-name derivation, the reference block builder,
link resolution and `dsh-resource://` addresses, the markdown block/inline
parser (including code fences), the scanner and its invocable catalog against an
in-memory filesystem, the HTTP API's token and route contract (including
`catalog`), the tool's parameters/output/execute, the Host wiring through a
fake context (tool, static section, per-agent section, route), and the Client
module — its static contract, its pure reference helpers, its `/` source against
both a stubbed API and the real one (candidates, ranking, pick, codec, sidebar
open, cache invalidation), the reference rule against blocks the Host builds,
the runtime wiring through a fake context (tab type, guide entry, shortcut, tab
body, `/` source, chip slot), and the tab body's render.

Live checks against the desktop profile:

- `GET /plugin-copilot-config/api/bootstrap` → 200 with a token; without the
  token → 401.
- With a real Session whose workspace carries a `.github` fixture: `config`
  reported `present: true` with both files classified and `applyTo` parsed, and
  `file` returned blocks plus two resolved links with sidebar addresses (the
  link inside the code fence was excluded). The fixture was removed afterwards.
- `Tool.listTools` shows `copilot_config` with the documented parameters.
- A React render smoke test drives the tab body: mount → config load → grouped
  list → select → rendered markdown → file links → right-sidebar open, with the
  tab's own Session driving every read.

## Files

```text
index.js               Host entry: tool, prompt sections, API route
lib/copilot.js         Pure helpers: classification, frontmatter, markdown, links, addresses, reference blocks
lib/scan.js            ctx.fs scanner, invocable catalog, and prompt rendering
lib/server.js          Token-protected local API
lib/tool.js            The copilot_config tool definition
client.js              Right-sidebar tab + markdown renderer + `/` references
scripts/verify-contract.mjs
locale/{en,zh}.json    Inventory title/description
icon.svg               Original artwork
README.md / README.zh.md
```
