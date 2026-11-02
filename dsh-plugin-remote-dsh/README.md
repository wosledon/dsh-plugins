English | [中文](README.zh.md)

# dsh-plugin-remote-dsh

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
turns remote machines into DSH Web workspaces you can open in the local sidebar.

It reads `~/.ssh/config`, lets you add remotes manually, and — per remote — can
probe the machine, install the official DSH CLI globally, start its Web profile,
tunnel it back over SSH, and open the remote UI in the right-sidebar Browser. The
remote workspace and its conversations live on the remote machine; the local
window is just the viewer.

## Where it appears

A first-class entry in the left sidebar:

```text
左栏
  …
  远程 DSH          ← this plugin
  …

主面板
  Remote DSH hosts
  ┌ alpha ─ ssh config ─ 未启动 ───────────────┐
  │ probe · install/upgrade · start · logs     │
  │ port 3080                                  │
  └────────────────────────────────────────────┘
  ┌ home ─ ssh config ─ 运行中 :3080 ──────────┐
  │ open · restart · stop · logs               │
  └────────────────────────────────────────────┘
```

## Host discovery

The Host half parses `Host` and `Include` lines from `~/.ssh/config`, skips
wildcard patterns, and runs `ssh -G <alias>` for every concrete alias. Effective
`HostName`, `User`, `Port`, `IdentityFile`, and `ProxyJump` therefore come from
OpenSSH itself rather than a reimplementation of `ssh_config` matching.

Manual hosts are stored in `$DSH_HOME/remote-dsh/state.json` and merged with the
ssh-config hosts. Manual fields: label, SSH target (`user@host` or an alias), SSH
port, identity file, proxy jump, and the remote Web port.

## Two start modes

| Mode | Command | When |
| --- | --- | --- |
| **npx** (default) | `npx -y @deepseek-ai/dsh@latest web --host 127.0.0.1 --port <port> --no-open` | No preinstalled `dsh`; uses the npx cache, resolves `@latest` on each start |
| **global** | `npm install -g --prefix ~/.npm-global @deepseek-ai/dsh@latest` then `~/.npm-global/bin/dsh web --host 127.0.0.1 --port <port> --no-open` | One user-global copy, upgradeable through the same button; no sudo |

Switch modes at the top of the page. In global mode the card shows
**安装 / 升级**, which runs `npm install -g --prefix ~/.npm-global` and reports
the resulting `dsh --version`. The prefix is user-owned, so a system-wide
`/usr/local` owned by root is not required.

**npm registry.** The page has a registry field, defaulting to
`https://registry.npmmirror.com`. It is passed via `npm_config_registry` (npx) or
`--registry` (install), so a broken or private `.npmrc` on the remote cannot make
the start hang. Change it to `https://registry.npmjs.org` or your own registry;
leave it empty to use the remote `.npmrc`. Before starting npx mode the plugin
runs a short `npm view <pkg> version` preflight so an unreachable registry fails
in seconds instead of after the start timeout.

Both modes start the **official** `dsh web`; the plugin only chooses where the
binary comes from.

## What happens on Start

1. Probe the remote (`command -v node/npm/npx/dsh`, versions, npm global prefix).
2. Start the remote Web profile on `127.0.0.1:<port>` in the background with
   `setsid` (or `nohup`), logging to `~/.dsh-remote/web-<port>.log`.
3. Poll the log for `dsh web: <url>?token=…`.
4. Open a local SSH tunnel with the **same port**:
   `ssh -N -L <port>:127.0.0.1:<port> <host>`.
5. Rewrite the URL to `http://127.0.0.1:<port>/?token=…` and expose it as a
   local URL. Starting does **not** switch panels or open a window.

The right Sidebar is per Session. The Remote DSH page is a root panel with no
on-screen Session, so it does not try to move the page into a Session. Starting a
remote leaves the page in place; the running card gains a single **Browser**
button that ensures the tunnel and opens a normal browser window.

### Session launcher

Enter any local Session and click **Remote DSH** in the session header, or pick
the same entry in the right Sidebar's guide. That opens the launcher tab, which
lists every **running** remote. Each row is a single click target: activating it
ensures the SSH tunnel and opens the remote URL as a Browser tab in the current
Session. There is no sidebar/browser choice in the launcher — the Remote DSH page
is the browser route.

The launcher calls the plugin's `open` API first, so it also re-establishes a
tunnel that died with a Harness restart. This is the intended way to view a
remote workspace next to a local conversation.

**Local port conflicts.** Each running remote needs its own local port. If the
requested local port is already used by another remote's tunnel, Start probes the
next ports and picks the first pair that is free on **both** sides. Remote and
local keep the same number, so the token URL is still opened under the authority
the remote Web bound. The card updates to the chosen port and shows a notice.

The remote Web binds loopback only; the SSH tunnel carries the traffic. Stop kills
the local tunnel and the remote process group, and the state file remembers the
PID/URL/log so **Open** can re-establish a dead tunnel after a Harness restart.

**Port conflicts.** Before touching the log or spawning anything, the plugin
checks the remote port. If it is occupied, Start returns `PORT_IN_USE` with the
listener PID and command. The page then offers to stop that listener and restart
only when it is a `dsh web` process — sessions are preserved, but the old token
URL stops working. A non-DSH listener is never killed; choose another port
instead.

## Remote access and jump hosts

The remote Web binds `127.0.0.1` and is **never reached directly over the LAN**.
Local access is an SSH local forward:

```text
ssh -N -L <port>:127.0.0.1:<port> <ssh-target>
```

Same-LAN is therefore not required: any SSH-reachable target works — a public
IP/DDNS name, a Tailscale/ZeroTier address, or a host behind a bastion. Because
ssh-config hosts are handed to `ssh` as an alias, `ProxyJump` and `ProxyCommand`
from `~/.ssh/config` apply. Manual hosts expose a **Proxy jump** field, and the
tunnel passes it as `-J`.

If `ssh <alias>` itself fails from the local machine, the plugin cannot reach
that host; fix SSH reachability first. Password/2FA prompts are not supported
(`BatchMode=yes`); use a key or ssh-agent.

## Configuration and state

No plugin Config schema. State lives in
`$DSH_HOME/remote-dsh/state.json`:

```json
{
  "settings": { "mode": "npx", "spec": "latest", "registry": "https://registry.npmmirror.com" },
  "manualHosts": [],
  "instances": {
    "home": {
      "remotePort": 3080,
      "localPort": 3080,
      "pid": 12345,
      "url": "http://127.0.0.1:3080/?token=…",
      "logPath": "/home/ledon/.dsh-remote/web-3080.log",
      "mode": "npx",
      "spec": "latest"
    }
  }
}
```

The local API is mounted at `/plugin-remote-dsh/api/`. `GET bootstrap` returns a
per-process token; every other route requires it in `x-remote-dsh-token`. The
token is delivered only to the same-origin local page, so a remote Web page
loaded in the sidebar cannot drive the plugin.

## Requirements

- **Remote OS**: Linux or macOS, with `sh` and either `npx` (npx mode) or `npm`
  (global mode installs into `~/.npm-global`, so no sudo is required).
- **SSH**: key or ssh-agent authentication with `BatchMode=yes`; passwords and
  2FA prompts are not supported. The host key must already be trusted (normal
  `known_hosts`). `ProxyJump` from `~/.ssh/config` is honored.
- **Remote model**: the remote Web profile is independent. Sign in / configure a
  model in the remote UI on first open; this plugin does not copy the local
  account or credentials.
- **Local port**: one remote per local port. Multiple remotes need distinct ports.

## Security

- The remote Web binds `127.0.0.1`; it is never exposed on the network by this
  plugin. The local tunnel is an SSH process on the local machine.
- The tokenized remote URL is stored locally in the state file and opened in the
  sidebar; treat that file as sensitive.
- The local API token prevents a remote page (a different origin) from calling
  install/start/stop. The remote page can still be a normal remote DSH UI.
- `npm install -g --prefix ~/.npm-global` runs remote package install scripts as
  the SSH user; use a trusted registry and a least-privilege remote account.
- The default registry is npmmirror; change it to npmjs or your own if needed.
  Leaving the field empty uses the remote `.npmrc`.

## Known limitations

- Windows remote hosts are not supported.
- No password/2FA SSH authentication; key/agent only.
- Start waits up to 180 s for the URL (first `npx` download can be slow).
- The remote model/account setup is manual in the remote UI.
- No automatic background health check; **Open** reconciles a dead local tunnel,
  and **Stop** clears the stored instance.
- This is not a session federation: local and remote sessions stay separate.
- One local tunnel per running remote; if the requested port is busy the plugin
  auto-picks the next pair free on both sides.

## Verification

```text
node scripts/verify-contract.mjs
# verify-contract: 80 assertions passed
```

Covers ssh-config parsing / `ssh -G`, SSH argument construction, log URL
extraction, probe parsing, manual-host validation, state persistence, API token
routing, the fake-SSH start/open/stop flow, and the client style contract.

Live checks in the desktop profile:

- `GET /plugin-remote-dsh/api/bootstrap` → 200 with a token
- `GET /plugin-remote-dsh/api/hosts` → 4 hosts from `~/.ssh/config`,
  `mode: npx`, no config errors; without the token → 401
- `sidebar.panellist` and `main` both report the `remote-dsh` occupant as active
- A React render smoke test drives probe → start → sidebar open with a fake API
- **Real remote:** started a test host through the local API in both modes.
  npx with `https://registry.npmmirror.com` and a global install into
  `~/.npm-global` both printed the remote URL; the local SSH tunnel served
  `DeepSeek Harness` (`HTTP 200`), and **Stop** removed the remote process and
  local tunnel. The global install reported `0.2.1-rc.5` after adding 616
  packages in 19 s. The test instances were stopped afterwards.
- **Port conflict:** a second host already had a `dsh web` listening on 3080.
  Start without force returned `PORT_IN_USE` naming its PID, left its log
  untouched, and no process was spawned. Start with `force` stopped that
  `dsh web` and started a fresh one; the new token URL served the UI through the
  tunnel.
- **Local port conflict:** with one host already tunneled on local 3080, starting
  a second host with the same requested port auto-picked 3081 on both sides.
  Both token URLs served the UI (`HTTP 200`) at the same time.

## Files

```text
index.js                 Host entry: API route + tunnel lifecycle
lib/ssh-config.js        ~/.ssh/config + ssh -G + command builders
lib/state.js             state.json store and manual-host model
lib/remote.js            probe / install / start / stop / open / logs
lib/server.js            token-protected local API
client.js                sidebar icon + Remote DSH page
scripts/verify-contract.mjs
locale/{en,zh}.json
icon.svg
```
