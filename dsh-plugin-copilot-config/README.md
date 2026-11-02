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
| `.github/chatmodes/*.chatmode.md` | chat modes | `description`, `mode` from frontmatter |
| `.github/agents/*.agent.md` | custom agents | `description` from frontmatter |
| other `.github/**/*.md` | other | kept so nothing under `.github` is hidden |

Frontmatter is parsed as a flat `key: value` block — `name`, `description`,
`applyTo`, `mode` — never as YAML. A title falls back from frontmatter `name` to
the first heading to the file name.

## Where it appears

A left-sidebar **Copilot 配置** panel lists the files grouped by kind. Selecting
one renders it (headings, lists, code fences, quotes, inline code) and shows a
**File links** section. Every relative markdown link is resolved against the
file that contains it and turned into a `dsh-resource://file/session/<id>/<path>`
address, so clicking it opens that file in the right sidebar's Document preview —
the same surface the Files tab uses. Links inside fenced code are never treated
as links, and external links open in a new window.

## How the agent reads it

Two mechanisms, one data path:

- a `copilot_config` tool with `action: "list"` and `action: "read"` plus a
  repository-relative `path`;
- a prompt section per Session, built from the project's own
  `copilot-instructions.md` plus an index of the other files with their
  `applyTo` scopes, bounded at 16 KiB.

Both call the same scanner, which walks `.github` through `ctx.fs` with hard
bounds: 300 files, depth 4, 256 KiB per file, 500 directory entries. Missing
`.github` is a normal state — the panel shows an empty state and the prompt
section is simply absent.

## Requirements and security

- Reads only the Session's working directory (or the Host default directory when
  no Session is available); it never walks outside it and never writes.
- The Web UI reads through a token-protected same-origin route
  (`/plugin-copilot-config/api/*`); the token is per process and handed only to
  the local page.
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

## Verification

```text
node scripts/verify-contract.mjs
# verify-contract: 150 assertions passed
```

Covers classification, frontmatter, title derivation, link resolution and
`dsh-resource://` addresses, the markdown block/inline parser (including code
fences), the scanner against an in-memory filesystem, the HTTP API's token and
route contract, the tool's parameters/output/execute, the Host wiring through a
fake context (tool, static section, per-agent section, route), and the Client
module's static contract.

Live checks against the desktop profile:

- `GET /plugin-copilot-config/api/bootstrap` → 200 with a token; without the
  token → 401.
- With a real Session whose workspace carries a `.github` fixture: `config`
  reported `present: true` with both files classified and `applyTo` parsed, and
  `file` returned blocks plus two resolved links with sidebar addresses (the
  link inside the code fence was excluded). The fixture was removed afterwards.
- `Tool.listTools` shows `copilot_config` with the documented parameters.
- A React render smoke test drives the page: list → select → rendered markdown →
  file links → right-sidebar open.

## Files

```text
index.js               Host entry: tool, prompt sections, API route
lib/copilot.js         Pure helpers: classification, frontmatter, markdown, links, addresses
lib/scan.js            ctx.fs scanner and prompt rendering
lib/server.js          Token-protected local API
lib/tool.js            The copilot_config tool definition
client.js              Sidebar panel + configuration page + markdown renderer
scripts/verify-contract.mjs
locale/{en,zh}.json    Inventory title/description
icon.svg               Original artwork
README.md / README.zh.md
```
