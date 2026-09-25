# dsh-plugin-ssh-workspace

SSH remote workspace: let an Agent actually work on remote hosts, with a management panel.

> **Status: in development, unverified.** The host half is written; the browser half is
> being written by a subagent. **Not yet done:** syntax check, self-check scripts,
> install, real-machine restart, push. This note will be removed once all of that is.

## What it does

The Agent runs commands, lists directories and reads files on remote hosts through a
set of Tools; you manage hosts, probe connectivity and review command history in a panel.

**Architecture: Tools, not a replaced `fs`/`shell` service.**

`fs` and `shell` are abstract services in the host pipeline, so replacing them is
theoretically possible. But "can a third-party plugin override a base implementation at
a scope the Agent can see" is unverified, and betting on it costs the whole feature.
Tools are an extension point already proven to work on a real machine (the
scheduled-tasks plugin), so:

| Capability | Where it lands |
| --- | --- |
| Agent runs remote commands | the `ssh_exec` tool |
| Agent reads remote files | the `ssh_read_file` / `ssh_list_dir` tools |
| You manage hosts, probe, review history | the panel (browser half) |

The cost: the Agent's **local** file tools keep pointing at the local workspace.
That matches the per-workspace binding choice, and it also means a misconfigured host
can never break local work.

## Why the system `ssh` instead of npm's `ssh2`

1. No third-party dependency — a package with native modules has a high chance of not
   installing into the profile at all.
2. It reuses the `~/.ssh`, `ssh-agent` and `known_hosts` already on the machine, so
   **a private key never enters this plugin's storage**. That is the direct consequence
   of supporting key auth only.
3. Key exchange and encryption belong to `ssh`; this plugin neither implements nor
   should implement the SSH protocol.

One implementation detail worth recording: `spawn`, not `execFile`. `execFile`'s
`maxBuffer` fails outright with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` when exceeded, so
"long output" gets reported as "execution failed" and the interface cannot say whether
it was truncated. Accumulating by hand here sets only `truncated` on overflow.

## Security boundary

`ssh_exec` lets the model run **arbitrary commands** on a remote host. That is the point
of the plugin, and it also means that once a host is configured the model has that
user's full privileges on that machine. Three things narrow it:

1. **`hostId` is required** — a tool cannot discover or reach a host that was never
   configured.
2. **Key auth only.** No password is ever stored; the key stays in your own `~/.ssh`.
3. **`enableTools: false` turns the whole tool set off** — the panel still works, but
   the model cannot touch the remote.

There is no command allowlist: it would add friction to everyday use such as a plain
`grep`. The real boundary is which hosts are configured and under which identity, and
that is already decided by `hostId` plus the key.

Host-key policy is `StrictHostKeyChecking=accept-new`: a first connection to a new host
does not prompt (and under BatchMode it cannot prompt, it would only fail), while a
changed host key is still refused — that is the actual man-in-the-middle risk.

## Install

```powershell
plugin_manager install_bundle "file:E:\repos\dsh-plugins\dsh-plugin-ssh-workspace"
```

Host-half changes **require restarting the host** to take effect (Node's ESM cache is
keyed by resolved path; `remove_bundle` + `install_bundle` reloads the row, not the
module).

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `hosts` | `[]` | Remote hosts |
| `hosts[].identityFile` | — | Private key path. **Key auth only, no passwords** |
| `timeoutMs` | `30000` | Wall-clock cap per execution, capped at 300000 |
| `maxListEntries` | `500` | Directory listing cap per call |
| `enableTools` | `true` | Whether to register the Agent-facing tools |

Persistence goes through `ctx.configEditor.edit()` (addressed by Loader entry), the only
channel that reliably writes to a row a bundle inserted itself; `remote.settings.mutate()`
is the fallback when the editor is unavailable. Both are tried, succeeding wins.

## Known limitations

- Remote directory browsing needs **GNU findutils** (`find -printf` is a GNU extension
  and BSD/macOS `find` lacks it). An unsatisfied remote returns one clear error rather
  than a silently empty listing.
- `ssh_read_file` suits text files; binary files are damaged by UTF-8 decoding.
- A timeout `SIGKILL`s the local `ssh` process, which on Windows does not reliably reach
  the remote process.
- `find -printf`'s field order deliberately puts the **path first**: a filename may
  legally contain a tab, and with the path first only the last three fields of a record
  are type/size/mtime, with the remainder rejoined as the full path.

## Diagnostics

`internal.lastBoot` records two things, and having them is the point:

- `phase: 'enter'` — `apply()` was called
- `phase: 'ready'` — assembly finished

Another plugin had no observable output at all, which made "never called / threw /
timer never ran / scan never finished" indistinguishable from outside; diagnosis relied
on external CPU sampling and a sibling plugin as a control, and cost several rounds of
restarts. This plugin builds that capability in from the start.
