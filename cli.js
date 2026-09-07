#!/usr/bin/env node
// NotebookLM-for-Windows agent CLI.
//
// Talks to the app's loopback control server (started by the Electron app).
// Every command emits JSON, so Codex / Claude Code / scripts can consume it
// directly. See docs/agent-cli.md.
//
// Usage examples:
//   nbd status
//   nbd tunnel import "vless://…#my-vps"
//   nbd proxy set --mode tunnel
//   nbd proxy check
//   nbd open https://notebooklm.google.com/notebook/<id>

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VERSION = require('./package.json').version;

// ------------------------------------------------------------ app data paths

function userDataDir() {
    if (process.env.NBD_USER_DATA) return process.env.NBD_USER_DATA;
    const name = 'NotebookLM-for-Windows';
    switch (process.platform) {
        case 'win32':
            return path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), name);
        case 'darwin':
            return path.join(require('os').homedir(), 'Library', 'Application Support', name);
        default:
            return path.join(process.env.XDG_CONFIG_HOME || path.join(require('os').homedir(), '.config'), name);
    }
}

function readToken() {
    try { return fs.readFileSync(path.join(userDataDir(), 'control-token'), 'utf8').trim(); }
    catch (e) { return null; }
}

function readPort() {
    if (process.env.NBD_CONTROL_PORT) return Number(process.env.NBD_CONTROL_PORT);
    // The server persists its actually-bound port here (it may have walked
    // forward from the configured port if 8787 was busy).
    try {
        return Number(fs.readFileSync(path.join(userDataDir(), 'control-port'), 'utf8').trim());
    } catch (e) { /* fall through */ }
    try {
        const s = JSON.parse(fs.readFileSync(path.join(userDataDir(), 'settings.json'), 'utf8'));
        if (s.controlPort) return Number(s.controlPort);
    } catch (e) { /* defaults */ }
    return 8787;
}

// ---------------------------------------------------------------- HTTP layer

let portOverride = null;

async function api(method, route, body) {
    const token = readToken();
    if (!token) {
        throw new ConnError(`no control token at ${path.join(userDataDir(), 'control-token')} — start the app once to generate it`);
    }
    const port = portOverride || readPort();
    let res;
    try {
        res = await fetch(`http://127.0.0.1:${port}${route}`, {
            method,
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) {
        throw new ConnError(`cannot reach the control server at 127.0.0.1:${port} (${e.message}). Is the app running? Start it with "nbd launch".`);
    }
    let payload;
    try { payload = await res.json(); } catch (e) { payload = { ok: false, error: `invalid JSON response: ${res.status}` }; }
    return { status: res.status, payload };
}

class ConnError extends Error {}

function out(data) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function die(err, code) {
    process.stderr.write(JSON.stringify({ ok: false, error: String(err.message || err) }) + '\n');
    process.exit(code);
}

async function call(method, route, body) {
    const { status, payload } = await api(method, route, body);
    out(payload);
    process.exit(payload && payload.ok ? 0 : 1);
}

// ---------------------------------------------------------------- arg parsing

function parseArgs(argv) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--port') { portOverride = Number(argv[++i]); continue; }
        if (a.startsWith('--')) {
            const key = a.replace(/^--/, '');
            if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
                flags[key] = argv[++i];
            } else {
                flags[key] = true;
            }
            continue;
        }
        positional.push(a);
    }
    return { positional, flags };
}

const HELP = `notebooklm-desktop (nbd) v${VERSION} — agent CLI for the NotebookLM desktop app

All output is JSON. The Electron app must be running (it hosts the loopback
control server). Connection: <userData>/control-token + port (default 8787).

Connection options:
  --port N                 override the control server port

Commands:
  nbd status                          app, window, panes, proxy, tunnel snapshot
  nbd launch                          start the app if it is not running
  nbd app <show|hide|minimize|maximize|quit>
  nbd open <notebook-id|url>          navigate the active pane to a notebook
  nbd panes <1|2|3>                   set visible pane count
  nbd ghost [on|off]                  ghost (transparency) mode; no arg toggles
  nbd opacity <0.1..1>
  nbd pin <on|off>                    always-on-top
  nbd theme <light|dark|system>
  nbd clip <text>                     paste text into the active pane input
  nbd notes-export <file.md>          extract visible notes to a markdown file
  nbd settings get <key> | set <key> <value> | list
  nbd proxy status                    effective proxy configuration
  nbd proxy check                     connectivity check through the app session
  nbd proxy set [--mode off|system|tunnel|vps|mainland|manual]
                     [--server http://user:pass@host:port | socks5://host:port]
                     [--user U] [--password P] [--rules "chromium rules"]
  nbd tunnel status                   embedded sing-box tunnel state
  nbd tunnel import <vless://…|hysteria2://…>   configure + start the tunnel
  nbd tunnel start | stop | check     lifecycle + SOCKS handshake check
  nbd tunnel download                 fetch the sing-box binary (GitHub)
  nbd help                            this message

Typical agent setup (mainland network, own VPS):
  nbd tunnel import "vless://uuid@[2001:db8::1]:443?...&security=reality..."
  nbd proxy check
  nbd open <notebook-id>`;

// ------------------------------------------------------------------- launch

function launchApp() {
    const repoRoot = __dirname;
    const electronBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
    const child = spawn(fs.existsSync(electronBin) ? electronBin : 'electron', ['.'], {
        cwd: repoRoot,
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
    return { spawned: true, pid: child.pid, mode: fs.existsSync(electronBin) ? 'dev' : 'system-electron' };
}

// -------------------------------------------------------------------- main

async function main() {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    const cmd = positional[0] || 'help';
    const arg = positional[1];
    const arg2 = positional[2];

    try {
        switch (cmd) {
            case 'help': case '--help': case '-h':
                process.stdout.write(HELP + '\n');
                return;

            case '--version': case 'version':
                out({ ok: true, version: VERSION });
                return;

            case 'status':
                return await call('GET', '/status');

            case 'health':
                return await call('GET', '/health');

            case 'launch': {
                // If already running, just report.
                try {
                    const { payload } = await api('GET', '/status');
                    if (payload && payload.ok) {
                        out({ ok: true, alreadyRunning: true, pidHint: 'control server reachable' });
                        return;
                    }
                } catch (e) { /* not running - launch */ }
                const info = launchApp();
                // Wait for the control server to come up.
                for (let i = 0; i < 40; i++) {
                    await new Promise((r) => setTimeout(r, 500));
                    try {
                        const { payload } = await api('GET', '/health');
                        if (payload && payload.ok) {
                            out({ ok: true, ...info, ready: true, waitedMs: (i + 1) * 500 });
                            return;
                        }
                    } catch (e) { /* keep waiting */ }
                }
                out({ ok: false, error: 'app launched but control server did not come up in 20s', ...info });
                process.exit(1);
                return;
            }

            case 'app':
                if (!['show', 'hide', 'minimize', 'maximize', 'quit'].includes(arg)) {
                    throw new ConnError('usage: nbd app <show|hide|minimize|maximize|quit>');
                }
                return await call('POST', '/app', { action: arg });

            case 'open': case 'navigate': {
                if (!arg) throw new ConnError('usage: nbd open <notebook-id|url>');
                return await call('POST', '/open', { url: arg });
            }

            case 'panes': {
                const n = parseInt(arg, 10);
                if (!(n >= 1 && n <= 3)) throw new ConnError('usage: nbd panes <1|2|3>');
                return await call('POST', '/panes', { count: n });
            }

            case 'ghost': {
                const on = arg === undefined ? undefined : ['on', 'true', '1'].includes(arg);
                return await call('POST', '/ghost', { on });
            }

            case 'opacity': {
                const v = Number(arg);
                if (!(v >= 0.1 && v <= 1)) throw new ConnError('usage: nbd opacity <0.1..1>');
                return await call('POST', '/opacity', { value: v });
            }

            case 'pin':
                if (!['on', 'off'].includes(arg)) throw new ConnError('usage: nbd pin <on|off>');
                return await call('POST', '/pin', { on: arg === 'on' });

            case 'theme':
                if (!['light', 'dark', 'system'].includes(arg)) throw new ConnError('usage: nbd theme <light|dark|system>');
                return await call('POST', '/theme', { value: arg });

            case 'clip': {
                const text = positional.slice(1).join(' ');
                if (!text) throw new ConnError('usage: nbd clip <text>');
                return await call('POST', '/clip', { text });
            }

            case 'notes-export': case 'notes':
                if (!arg) throw new ConnError('usage: nbd notes-export <file.md>');
                return await call('POST', '/notes/export', { path: path.resolve(arg) });

            case 'settings': {
                if (arg === 'list') return await call('GET', '/settings');
                if (arg === 'get') {
                    const { payload } = await api('GET', '/settings');
                    if (!payload.ok) { out(payload); process.exit(1); }
                    out({ ok: true, key: arg2, value: payload.settings[arg2] });
                    return;
                }
                if (arg === 'set') {
                    if (arg2 === undefined) throw new ConnError('usage: nbd settings set <key> <value>');
                    let value = positional[3];
                    if (value === 'true') value = true;
                    else if (value === 'false') value = false;
                    else if (value !== undefined && value !== '' && !isNaN(Number(value))) value = Number(value);
                    return await call('POST', '/settings', { key: arg2, value });
                }
                throw new ConnError('usage: nbd settings <list|get|set>');
            }

            case 'proxy': {
                const sub = arg;
                if (sub === 'status' || sub === undefined) return await call('GET', '/proxy');
                if (sub === 'check') return await call('POST', '/proxy/check');
                if (sub === 'set') {
                    const body = {};
                    if (flags.mode !== undefined) body.mode = flags.mode;
                    if (flags.server !== undefined) body.server = flags.server;
                    if (flags.user !== undefined) body.user = flags.user;
                    if (flags.password !== undefined) body.password = flags.password;
                    if (flags.rules !== undefined) body.rules = flags.rules;
                    if (!Object.keys(body).length) throw new ConnError('nothing to set: pass --mode/--server/--user/--password/--rules');
                    return await call('POST', '/proxy', body);
                }
                throw new ConnError('usage: nbd proxy <status|check|set>');
            }

            case 'tunnel': {
                const sub = arg;
                if (sub === 'status' || sub === undefined) return await call('GET', '/tunnel');
                if (sub === 'import') {
                    if (!arg2) throw new ConnError('usage: nbd tunnel import <vless://…|hysteria2://…>');
                    return await call('POST', '/tunnel/import', { uri: arg2 });
                }
                if (sub === 'start') return await call('POST', '/tunnel/start');
                if (sub === 'stop') return await call('POST', '/tunnel/stop');
                if (sub === 'check') return await call('POST', '/tunnel/check');
                if (sub === 'download') return await call('POST', '/tunnel/download');
                throw new ConnError('usage: nbd tunnel <status|import|start|stop|check|download>');
            }

            default:
                throw new ConnError(`unknown command "${cmd}" — see "nbd help"`);
        }
    } catch (e) {
        die(e, e instanceof ConnError ? 2 : 1);
    }
}

main();
