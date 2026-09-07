// Loopback-only control HTTP server so agents (Codex, Claude Code, scripts)
// can drive every app feature programmatically. The CLI in cli.js talks to it.
//
// Security model:
//   - binds 127.0.0.1 only, never a public interface
//   - every request must carry the per-install token generated into
//     <userData>/control-token (mode 0600) via `Authorization: Bearer <token>`
//   - disable with NBD_CONTROL_DISABLE=1 or settings controlEnabled=false

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const proxy = require('./proxy');
const { fingerprintOf } = require('./tunnel');

const DEFAULT_PORT = 8787;

function ensureToken(userDataDir) {
    const tokenPath = path.join(userDataDir, 'control-token');
    try {
        const existing = fs.readFileSync(tokenPath, 'utf8').trim();
        if (existing) return { tokenPath, token: existing };
    } catch (e) { /* first run */ }
    const token = crypto.randomBytes(32).toString('hex');
    try {
        fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
        if (process.platform !== 'win32') fs.chmodSync(tokenPath, 0o600);
    } catch (e) {
        console.error('control-server: cannot persist token', e);
    }
    return { tokenPath, token };
}

function normalizeNotebookUrl(input) {
    if (typeof input !== 'string' || !input.trim()) return null;
    const value = input.trim();
    if (/^https?:\/\//i.test(value)) {
        try {
            const u = new URL(value);
            if (!u.hostname.endsWith('notebooklm.google.com')) return null;
            return u.toString();
        } catch (e) { return null; }
    }
    // Bare notebook id (uuid-ish) or full notebooklm path
    if (/^[0-9a-f-]{16,}$/i.test(value)) {
        return `https://notebooklm.google.com/notebook/${value}`;
    }
    if (/^notebook\//i.test(value)) {
        return `https://notebooklm.google.com/${value}`;
    }
    return null;
}

class HttpError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

function createControlServer({ settings, deps }) {
    let server = null;
    let boundPort = null;
    let lastProxyConfig = null;

    const ghostState = { on: false, previousOpacity: 1.0 };

    function json(res, code, payload) {
        const body = JSON.stringify(payload, null, 2);
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(body + '\n');
    }

    function ok(res, payload) { json(res, 200, { ok: true, ...payload }); }
    function fail(res, code, error) { json(res, code, { ok: false, error }); }

    function requireMainWindow() {
        const w = deps.getMainWindow();
        if (!w || w.isDestroyed()) throw new HttpError(503, 'main window not available');
        return w;
    }

    function snapshotStatus() {
        const w = deps.getMainWindow();
        const s = settings.getAll();
        return {
            app: {
                version: deps.appVersion(),
                platform: process.platform,
                uptimeSec: Math.round(process.uptime()),
            },
            window: w && !w.isDestroyed() ? {
                visible: w.isVisible(),
                minimized: w.isMinimized(),
                maximized: w.isMaximized(),
                alwaysOnTop: w.isAlwaysOnTop(),
                opacity: w.getOpacity(),
            } : null,
            panes: s.paneCount,
            theme: s.theme,
            quickClipAccelerator: s.quickClipAccelerator,
            ghost: ghostState.on,
            proxy: deps.proxy.resolveConfig(settings, deps.userDataDir(), deps.tunnel.status()),
            tunnel: deps.tunnel.status(),
        };
    }

    async function route(req, res, body) {
        const url = new URL(req.url, 'http://127.0.0.1');
        const p = url.pathname.replace(/\/+$/, '') || '/';
        const method = req.method;

        if (method === 'GET' && p === '/status') return ok(res, snapshotStatus());
        if (method === 'GET' && p === '/settings') return ok(res, { settings: settings.getAll() });

        if (method === 'POST' && p === '/settings') {
            if (body && typeof body === 'object' && !Array.isArray(body)) {
                if (body.key !== undefined) {
                    settings.set(String(body.key), body.value);
                } else {
                    const allowed = { ...body };
                    delete allowed.ok;
                    settings.setMany(allowed);
                }
            }
            return ok(res, { settings: settings.getAll() });
        }

        if (method === 'GET' && p === '/proxy') {
            return ok(res, {
                proxy: deps.proxy.resolveConfig(settings, deps.userDataDir(), deps.tunnel.status()),
                lastApplied: lastProxyConfig,
            });
        }

        if (method === 'POST' && p === '/proxy') {
            const { mode, server, rules, user, password } = body || {};
            if (mode !== undefined) {
                if (!proxy.PROXY_MODES.includes(mode)) throw new HttpError(400, `invalid mode "${mode}" (expected: ${proxy.PROXY_MODES.join(', ')})`);
                settings.set('proxyMode', mode);
            }
            if (server !== undefined) {
                if (server && !proxy.isValidServer(server)) throw new HttpError(400, `invalid proxy server "${server}" (expected scheme://host:port, e.g. http://[2001:db8::1]:8443)`);
                settings.set('proxyServer', String(server || ''));
            }
            if (user !== undefined || password !== undefined) {
                const auth = deps.proxy.loadAuth(deps.userDataDir());
                deps.proxy.saveAuth(deps.userDataDir(), user !== undefined ? user : auth.username, password !== undefined ? password : auth.password);
            }
            if (rules !== undefined) {
                const err = proxy.validateRules(String(rules || ''));
                if (err) throw new HttpError(400, `invalid rules: ${err}`);
                settings.set('proxyRules', String(rules || ''));
            }
            const result = await deps.applyProxyNow();
            if (!result.ok) return fail(res, 500, `setProxy failed: ${result.error}`);
            return ok(res, { proxy: result.config });
        }

        if (method === 'POST' && p === '/proxy/check') {
            const w = requireMainWindow();
            const result = await proxy.checkProxy(w.webContents.session);
            return ok(res, { check: result, proxy: proxy.resolveConfig(settings, deps.userDataDir(), deps.tunnel.status()) });
        }

        // ---------------- embedded tunnel (vless/hysteria2 -> VPS) ----------------

        if (method === 'GET' && p === '/tunnel') {
            return ok(res, { tunnel: deps.tunnel.status() });
        }

        if (method === 'POST' && p === '/tunnel/import') {
            const uri = String((body || {}).uri || '').trim();
            if (!uri) throw new HttpError(400, 'uri required (vless://… or hysteria2://…)');
            let parsed;
            try {
                parsed = deps.tunnel.setUri(uri); // throws on invalid
            } catch (e) {
                throw new HttpError(400, e.message);
            }
            if ((body || {}).start !== false) {
                await deps.tunnel.start();
                await deps.applyProxyNow();
            }
            if (settings.get('proxyMode') !== 'tunnel') settings.set('proxyMode', 'tunnel');
            await deps.applyProxyNow();
            return ok(res, {
                imported: { protocol: parsed.protocol, server: parsed.server, port: parsed.port, name: parsed.name, fingerprint: fingerprintOf(uri) },
                tunnel: deps.tunnel.status(),
                proxy: deps.proxy.resolveConfig(settings, deps.userDataDir(), deps.tunnel.status()),
            });
        }

        if (method === 'POST' && p === '/tunnel/start') {
            await deps.tunnel.start();
            await deps.applyProxyNow();
            return ok(res, { tunnel: deps.tunnel.status() });
        }

        if (method === 'POST' && p === '/tunnel/stop') {
            deps.tunnel.stop();
            await deps.applyProxyNow();
            return ok(res, { tunnel: deps.tunnel.status() });
        }

        if (method === 'POST' && p === '/tunnel/check') {
            const result = await deps.tunnel.check();
            return ok(res, { check: result });
        }

        if (method === 'POST' && p === '/tunnel/download') {
            try {
                const binPath = await deps.tunnel.downloadBinary();
                return ok(res, { path: binPath });
            } catch (e) {
                return fail(res, 500, e.message);
            }
        }

        if (method === 'POST' && (p === '/open' || p === '/navigate')) {
            const target = normalizeNotebookUrl((body || {}).url || (body || {}).notebook);
            if (!target) throw new HttpError(400, 'provide "url" (https://notebooklm.google.com/...) or a notebook id');
            const w = requireMainWindow();
            if (!w.isVisible()) w.show();
            if (w.isMinimized()) w.restore();
            w.focus();
            w.webContents.send('navigate-active', target);
            return ok(res, { navigated: target });
        }

        if (method === 'POST' && p === '/panes') {
            const count = parseInt((body || {}).count, 10);
            if (!(count >= 1 && count <= 3)) throw new HttpError(400, 'count must be 1..3');
            settings.set('paneCount', count);
            const w = requireMainWindow();
            w.webContents.send('panes-changed', count);
            return ok(res, { panes: count });
        }

        if (method === 'POST' && p === '/opacity') {
            const value = Number((body || {}).value);
            if (!(value >= 0.1 && value <= 1)) throw new HttpError(400, 'value must be 0.1..1');
            const w = requireMainWindow();
            w.setOpacity(value);
            settings.set('opacity', value);
            ghostState.on = value < 1;
            return ok(res, { opacity: value });
        }

        if (method === 'POST' && p === '/ghost') {
            const want = (body || {}).on;
            const turnOn = typeof want === 'boolean' ? want : !ghostState.on;
            const w = requireMainWindow();
            if (turnOn && !ghostState.on) {
                ghostState.previousOpacity = w.getOpacity() || 1;
                ghostState.on = true;
            } else if (!turnOn) {
                ghostState.on = false;
            }
            const value = turnOn ? 0.35 : (ghostState.previousOpacity || 1);
            w.setOpacity(value);
            settings.set('opacity', value);
            return ok(res, { ghost: turnOn, opacity: value });
        }

        if (method === 'POST' && p === '/pin') {
            const on = !!(body || {}).on;
            settings.set('alwaysOnTop', on);
            const w = requireMainWindow();
            w.setAlwaysOnTop(on);
            return ok(res, { alwaysOnTop: on });
        }

        if (method === 'POST' && p === '/theme') {
            const value = (body || {}).value;
            if (!['light', 'dark', 'system'].includes(value)) throw new HttpError(400, 'value must be light|dark|system');
            settings.set('theme', value);
            deps.sendTheme();
            return ok(res, { theme: value });
        }

        if (method === 'POST' && p === '/clip') {
            const text = String((body || {}).text || '');
            if (!text) throw new HttpError(400, 'text required');
            const w = requireMainWindow();
            if (!w.isVisible()) w.show();
            w.focus();
            w.webContents.send('quick-clip', text);
            return ok(res, { sent: true, length: text.length });
        }

        if (method === 'POST' && p === '/notes/export') {
            const filePath = String((body || {}).path || '').trim();
            if (!filePath) throw new HttpError(400, 'path required (absolute .md file path)');
            const w = requireMainWindow();
            const result = await deps.exportNotesToFile(w, filePath);
            if (!result.ok) return fail(res, 500, result.error || 'export failed');
            return ok(res, { path: result.path, bytes: result.bytes });
        }

        if (method === 'POST' && p === '/app') {
            const action = (body || {}).action;
            const w = requireMainWindow();
            switch (action) {
                case 'show': w.show(); w.focus(); break;
                case 'hide': w.hide(); break;
                case 'minimize': w.minimize(); break;
                case 'maximize': w.isMaximized() ? w.unmaximize() : w.maximize(); break;
                case 'close': w.close(); break;
                case 'quit': deps.quit(); break;
                default: throw new HttpError(400, 'action must be show|hide|minimize|maximize|close|quit');
            }
            return ok(res, { action });
        }

        if (method === 'GET' && p === '/health') return ok(res, { health: 'ok' });
        throw new HttpError(404, `no route for ${method} ${p}`);
    }

    function start() {
        if (server) return boundPort;
        const { token } = ensureToken(deps.userDataDir());
        let port = Number(process.env.NBD_CONTROL_PORT) || Number(settings.get('controlPort')) || DEFAULT_PORT;
        const portFile = path.join(deps.userDataDir(), 'control-port');

        server = http.createServer((req, res) => {
            const auth = req.headers.authorization || '';
            if (auth !== `Bearer ${token}`) {
                return fail(res, 401, 'missing or invalid bearer token (see <userData>/control-token)');
            }
            const chunks = [];
            let size = 0;
            req.on('data', (c) => {
                size += c.length;
                if (size > 1024 * 1024) { req.destroy(); return; }
                chunks.push(c);
            });
            req.on('end', async () => {
                let body = {};
                if (chunks.length) {
                    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
                    catch (e) { return fail(res, 400, 'body must be valid JSON'); }
                }
                try {
                    await route(req, res, body);
                } catch (e) {
                    if (e instanceof HttpError) return fail(res, e.code, e.message);
                    console.error('control-server:', e);
                    return fail(res, 500, e.message);
                }
            });
        });

        server.on('error', (e) => {
            if (e.code === 'EADDRINUSE') {
                port += 1;
                server.listen(port, '127.0.0.1');
                return;
            }
            console.error('control-server error:', e.message);
        });

        server.listen(port, '127.0.0.1');
        server.on('listening', () => {
            boundPort = port;
            try { fs.writeFileSync(portFile, String(port) + '\n', { mode: 0o644 }); } catch (e) { /* best effort */ }
            console.log(`control-server: listening on http://127.0.0.1:${boundPort} (token: ${deps.userDataDir()}/control-token)`);
        });
        return port;
    }

    function stop() {
        if (server) server.close();
        server = null;
        boundPort = null;
        try { fs.unlinkSync(path.join(deps.userDataDir(), 'control-port')); } catch (e) { /* best effort */ }
    }

    function port() { return boundPort; }

    return { start, stop, port, setLastProxyConfig: (c) => { lastProxyConfig = c; } };
}

module.exports = { createControlServer, ensureToken, DEFAULT_PORT, normalizeNotebookUrl };
