# Agent CLI — `nbd` (notebooklm-desktop)

The desktop app hosts a **control server** (loopback HTTP + bearer token) and
ships a CLI so agents — Codex, Claude Code, scripts — can drive every app
feature programmatically. All output is JSON.

## Architecture

```
Codex / Claude Code / shell
    │  nbd <command>            (cli.js, plain Node, no deps)
    ▼
http://127.0.0.1:8787   Authorization: Bearer <token>
    │
    ▼
Electron main process  ──►  window / panes / ghost / proxy / embedded tunnel
```

- The server binds `127.0.0.1` only — never a public interface.
- Auth token lives at `<userData>/control-token` (0600), generated on first app start.
- Disable with `NBD_CONTROL_DISABLE=1` or `settings.controlEnabled=false`.

## Connection discovery

The CLI resolves, in order:

| What | Source |
|---|---|
| port | `--port` flag → `NBD_CONTROL_PORT` env → `<userData>/settings.json:controlPort` → `8787` |
| token | `<userData>/control-token` |
| userData | `NBD_USER_DATA` env → platform default (`~/.config/NotebookLM-for-Windows` on Linux) |

## Install

```bash
# from this repo
npm link                 # puts `nbd` and `notebooklm-desktop` on PATH
# or run directly
node cli.js status
```

`nbd launch` starts the app if it is not already running (dev checkout: via
`node_modules/.bin/electron .`).

## Command reference

All commands print JSON; exit code `0` = ok, `1` = command failed, `2` = could
not reach the control server.

| Command | Effect |
|---|---|
| `nbd status` | app version/platform, window state, panes, ghost, proxy + tunnel snapshot |
| `nbd health` | cheap liveness check |
| `nbd launch` | start the app, wait until the control server responds |
| `nbd app <show\|hide\|minimize\|maximize\|quit>` | window lifecycle |
| `nbd open <notebook-id\|url>` | navigate the active pane (accepts a bare notebook UUID or a `notebooklm.google.com` URL) |
| `nbd panes <1\|2\|3>` | visible pane count |
| `nbd ghost [on\|off]` | ghost (transparency) mode; toggles without an argument |
| `nbd opacity <0.1..1>` | window opacity |
| `nbd pin <on\|off>` | always-on-top |
| `nbd theme <light\|dark\|system>` | theme |
| `nbd clip <text>` | paste text into the active pane's input (same path as Quick-Clip) |
| `nbd notes-export <file.md>` | extract visible notes to markdown, straight to a file |
| `nbd settings list` / `get <key>` / `set <key> <value>` | raw settings access |
| `nbd proxy status` | effective proxy configuration |
| `nbd proxy check` | fetch `https://notebooklm.google.com/` through the app session (reflects the real pane path) |
| `nbd proxy set --mode <m> [--server URL] [--user U] [--password P] [--rules R]` | change proxy config atomically |
| `nbd tunnel status` | embedded sing-box state |
| `nbd tunnel import <vless://…\|hysteria2://…>` | store the URI (0600) and start the tunnel |
| `nbd tunnel start` / `stop` / `check` | lifecycle + local SOCKS handshake test |
| `nbd tunnel download` | download the sing-box binary from GitHub releases |

## Example: agent bootstrap (one-shot)

```bash
nbd launch
nbd tunnel import "vless://<uuid>@[2001:db8::1]:443?security=reality&sni=example.com&fp=chrome&pbk=<key>&type=tcp#my-vps"
nbd tunnel check && nbd proxy check
nbd open 2cee26cc-794b-4a20-b1a7-d0e3f1000000
nbd panes 2
```

## HTTP API (for non-CLI agents)

Same surface, straight HTTP. Routes mirror the CLI 1:1:

```
GET  /health  /status  /settings  /proxy  /tunnel
POST /settings {key,value} | {…partial}
POST /proxy {mode?,server?,user?,password?,rules?}
POST /proxy/check
POST /tunnel/import {uri,start?}   /tunnel/start  /tunnel/stop  /tunnel/check  /tunnel/download
POST /open {url|notebook}   /panes {count}   /opacity {value}
POST /ghost {on?}   /pin {on}   /theme {value}   /clip {text}
POST /notes/export {path}
POST /app {action}
```

Auth: `Authorization: Bearer <token>`.

## Security notes

- The token is a 256-bit random secret scoped to one machine profile.
- Anything that can read `<userData>/control-token` can drive the app — treat
  it like a session cookie.
- The server never binds non-loopback; there is no CORS surface for websites
  (requests from web origins fail the token check and Chromium's private
  network access policy).
