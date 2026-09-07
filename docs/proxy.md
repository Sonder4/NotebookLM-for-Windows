# Independent Proxy & VPS Tunnel

The app never touches your system proxy. Only its own `persist:notebooklm`
session (the NotebookLM panes) gets rules, applied through Chromium's proxy
resolver — so the rest of your desktop keeps its own network settings.

## Modes

| Mode | Data path | Use when |
|---|---|---|
| `off` | direct | no proxy needed |
| `system` | OS proxy | you already run a system-wide proxy |
| `tunnel` | panes → local SOCKS (`127.0.0.1:18080`) → **embedded sing-box** → VPS (`vless+reality` / `hysteria2`) | you have your own VPS; zero other software needed |
| `vps` | panes → a plain `http://`/`socks5://` proxy URL | proxy is reachable without filtering in the path |
| `mainland` | only `[*.]google.com` & friends via the proxy URL, everything else direct | local client (Mihomo/sing-box) already running, want split routing |
| `manual` | raw Chromium `proxyRules` | power users |

Switch modes from the Settings modal (⚙ → Proxy) or the CLI:

```bash
nbd proxy set --mode tunnel
nbd proxy set --mode mainland --server socks5://127.0.0.1:7890
nbd proxy set --mode vps --server "http://user:pass@[2001:db8::1]:8443"
nbd proxy check
```

## The embedded tunnel (`tunnel` mode) — recommended for mainland networks

Chromium cannot speak VLESS/Hysteria2 natively, and a **plaintext HTTP CONNECT
proxy carrying `CONNECT notebooklm.google.com:443` is keyword-reset by the
GFW** (verified empirically: `ip.sb` / `github.com` / `baidu.com` pass,
all Google hostnames RST). The reliable pattern is a local tunnel client whose
data plane is a filtering-resistant stream. This app embeds one:

```
NotebookLM panes (persist:notebooklm session)
  → socks5://127.0.0.1:18080        (sing-box local inbound, child process)
  → vless+reality tcp/443            (your VPS, IPv4 or IPv6)
  → VPS egress → NotebookLM
```

### Setup (any machine, ~30 seconds)

1. Install & start the app (`nbd launch`).
2. Import your node URI — from v2rayN/Clash subscriptions or your provider:

   ```bash
   nbd tunnel import "vless://<uuid>@[2001:db8::1]:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=example.com&fp=chrome&pbk=<public-key>&type=tcp#my-vps"
   # or
   nbd tunnel import "hysteria2://<password>@[2001:db8::1]:444/?sni=example.com#my-vps"
   ```

   The URI is stored 0600 in `<userData>/tunnel/uri.txt` and never leaves the
   machine. Importing also switches `proxyMode` to `tunnel`.
3. `nbd proxy check` → expect `"ok": true`.

The sing-box binary is resolved from (in order): packaged
`<resources>/sing-box/bin/`, `<userData>/bin/` (use `nbd tunnel download` to
fetch the latest release from GitHub), or your `PATH`. You can also drop your
own binary at `<userData>/bin/sing-box`.

### Why not just point the app at a plain proxy on the VPS?

The repo ships `server/add-http-inbound.sh`: an idempotent script that adds an
authenticated sing-box **HTTP CONNECT inbound** (dual-stack `::`, default port
8443) to an existing sing-box server, opens the firewall, and prints a ready
`nbd proxy set` URL. That works fine **where no filtering sits in the path**
(overseas machines, many campus networks with unrestricted egress), but on
mainland networks the plaintext `CONNECT <google-host>` line gets reset — use
`tunnel` mode there instead.

## Split routing (`mainland` mode)

Routes only these domains through the proxy; everything else goes direct:

```
[*.]google.com  [*.]googleusercontent.com  [*.]gstatic.com  [*.]googleapis.com
[*.]goog  [*.]googlevideo.com  [*.]gvt1.com  [*.]gvt2.com  [*.]recaptcha.net
```

Typical use: Mihomo/Clash mixed port on `127.0.0.1:7890`:

```bash
nbd proxy set --mode mainland --server socks5://127.0.0.1:7890
```

## Environment overrides (CI/agents)

| Var | Effect |
|---|---|
| `NBD_PROXY_MODE` | force mode (wins over settings) |
| `NBD_PROXY_URL` | force proxy server URL |
| `NBD_CONTROL_PORT` / `NBD_USER_DATA` / `NBD_CONTROL_DISABLE` | control-server overrides, see [agent-cli.md](agent-cli.md) |

## Credentials & security

- Tunnel URIs: `<userData>/tunnel/uri.txt`, `config.json` (0600).
- HTTP-proxy basic-auth: `<userData>/proxy-auth.json` (0600), supplied to
  Chromium through Electron's `login` event — never embedded in proxy rules.
- Nothing credential-bearing is committed to the repo; settings.json holds
  only mode/server/rules (no passwords).
