// Independent per-app proxy configuration.
//
// The app never touches system proxy settings; rules are applied only to the
// app's own `persist:notebooklm` session via Chromium's proxy resolver.
//
// Modes:
//   off      - direct connection, no proxy
//   system   - follow the OS proxy (Chromium default)
//   tunnel   - embedded sing-box client (see tunnel.js): the app spawns its
//              own vless+reality / hysteria2 client to the VPS (e.g. over
//              IPv6) and routes ALL traffic through the local SOCKS inbound.
//              Zero external dependencies on any machine: install the app,
//              import one vless:// URI, done.
//   vps      - full tunnel through a plain remote proxy (http/socks URL).
//              No local client needed, but the CONNECT line is plaintext, so
//              on mainland networks Google hostnames may be keyword-reset.
//              Works fine where no filtering sits in the path.
//   mainland - split routing for local clients (Mihomo/sing-box already
//              running, e.g. mixed-port 127.0.0.1:7890): only Google domains
//              go through the proxy, everything else stays direct.
//   manual   - user-provided Chromium proxyRules string
//
// Proxy URL format accepted from users/agents:
//   http://user:pass@[2001:db8::1]:8443
//   http://user:pass@203.0.113.10:8443
//   socks5://[2001:db8::1]:1080
//
// Chromium proxyRules syntax (https://www.chromium.org/developers/design-documents/network-settings/):
//   "2001:db8::1:8443"                (all schemes through one proxy)
//   "[*.]google.com=socks5://127.0.0.1:7890; ..."  (per-domain routing)
// Unmatched hosts resolve direct.

const path = require('path');
const fs = require('fs');

const PROXY_DOMAINS = [
    '[*.]google.com',
    '[*.]googleusercontent.com',
    '[*.]gstatic.com',
    '[*.]googleapis.com',
    '[*.]goog',
    '[*.]googlevideo.com',
    '[*.]gvt1.com',
    '[*.]gvt2.com',
    '[*.]recaptcha.net',
];

const PROXY_MODES = ['off', 'system', 'tunnel', 'vps', 'mainland', 'manual'];
const PROXY_SCHEMES = ['http', 'https', 'socks5', 'socks4', 'quic'];

// ---------------------------------------------------------------- auth store
// Proxy credentials live in their own 0600 file next to settings.json so they
// never leak into synced/exported settings.

function authFilePath(userDataDir) {
    return path.join(userDataDir, 'proxy-auth.json');
}

function loadAuth(userDataDir) {
    try {
        const parsed = JSON.parse(fs.readFileSync(authFilePath(userDataDir), 'utf8'));
        return { username: String(parsed.username || ''), password: String(parsed.password || '') };
    } catch (e) {
        return { username: '', password: '' };
    }
}

function saveAuth(userDataDir, username, password) {
    const p = authFilePath(userDataDir);
    const clean = { username: String(username || ''), password: String(password || '') };
    if (!clean.username && !clean.password) {
        try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
        return clean;
    }
    fs.writeFileSync(p, JSON.stringify(clean, null, 2), { mode: 0o600 });
    if (process.platform !== 'win32') {
        try { fs.chmodSync(p, 0o600); } catch (e) { /* best effort */ }
    }
    return clean;
}

// ---------------------------------------------------------------- URL parsing

// Parse `scheme://user:pass@host:port` (host may be bracketed IPv6).
function parseProxyUrl(input) {
    if (typeof input !== 'string' || !input.trim()) return null;
    let value = input.trim();
    if (!/^[a-z0-9]+:\/\//i.test(value)) value = 'http://' + value;
    const m = value.match(/^([a-z0-9]+):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?\[([^\]]+)\]|^([a-z0-9]+):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/\[]+)(?::(\d+))?(?:\/.*)?$/i);
    if (!m) return null;
    if (m[4]) {
        // Bracketed IPv6 form; port may follow the ]
        const portMatch = value.match(/\](?::(\d+))?/);
        const scheme = m[1].toLowerCase();
        if (!PROXY_SCHEMES.includes(scheme)) return null;
        const port = portMatch && portMatch[1] ? Number(portMatch[1]) : (scheme === 'https' ? 443 : 80);
        return {
            scheme, host: m[4],
            username: m[2] || '', password: m[3] || '',
            port,
        };
    }
    const scheme = m[5].toLowerCase();
    if (!PROXY_SCHEMES.includes(scheme)) return null;
    return {
        scheme,
        host: m[8] || '',
        port: m[9] ? Number(m[9]) : (scheme === 'https' ? 443 : 80),
        username: m[6] || '', password: m[7] || '',
    };
}

function isValidServer(server) {
    const parsed = parseProxyUrl(server);
    if (!parsed || !parsed.host) return false;
    if (!(parsed.port >= 1 && parsed.port <= 65535)) return false;
    if (!/^[a-zA-Z0-9._-]+$/.test(parsed.host) && !/^[0-9a-f:]+$/i.test(parsed.host)) return false;
    return true;
}

// Chromium rules host:port, without credentials.
function toRulesSpec(parsed) {
    const needsBrackets = parsed.host.includes(':');
    const host = needsBrackets ? `[${parsed.host}]` : parsed.host;
    if (parsed.scheme === 'http') return `${host}:${parsed.port}`;
    return `${parsed.scheme}://${host}:${parsed.port}`;
}

function buildMainlandRules(server) {
    const parsed = parseProxyUrl(server);
    if (!parsed) return '';
    const spec = toRulesSpec(parsed);
    return [...new Set(PROXY_DOMAINS)].map((d) => `${d}=${spec}`).join('; ');
}

// ---------------------------------------------------------------- resolution

// settings keys involved: proxyMode, proxyServer, proxyRules, tunnelPort.
// `tunnelStatus` is the live tunnel.status() (may be null before start).
function resolveConfig(settings, userDataDir, tunnelStatus) {
    let mode = settings.get('proxyMode') || 'off';
    let server = settings.get('proxyServer') || '';

    // Environment overrides win over stored settings (handy for agents/CI).
    if (process.env.NBD_PROXY_MODE && PROXY_MODES.includes(process.env.NBD_PROXY_MODE)) {
        mode = process.env.NBD_PROXY_MODE;
    }
    if (process.env.NBD_PROXY_URL) {
        server = process.env.NBD_PROXY_URL;
    }

    switch (mode) {
        case 'off':
            return { mode: 'off', server: '', rules: '' };
        case 'system':
            return { mode: 'system', server, rules: '' };
        case 'tunnel': {
            const running = tunnelStatus && tunnelStatus.running;
            const port = (tunnelStatus && tunnelStatus.localPort)
                || Number(settings.get('tunnelPort')) || 18080;
            if (!running) {
                return {
                    mode: 'tunnel', server: '', rules: '', reason:
                        'embedded tunnel not running yet; traffic stays direct until it comes up',
                };
            }
            return {
                mode: 'tunnel',
                server: `socks5://127.0.0.1:${port}`,
                rules: `socks5://127.0.0.1:${port}`,
                tunnel: tunnelStatus,
            };
        }
        case 'vps': {
            const parsed = parseProxyUrl(server);
            if (!parsed || !isValidServer(server)) {
                return { mode: 'off', server, rules: '', reason: 'no valid proxy server configured for mode "vps"; falling back to direct' };
            }
            return { mode: 'vps', server, rules: toRulesSpec(parsed), host: parsed.host, port: parsed.port, scheme: parsed.scheme };
        }
        case 'mainland': {
            const parsed = parseProxyUrl(server);
            if (!parsed || !isValidServer(server)) {
                return { mode: 'off', server, rules: '', reason: 'no valid proxy server configured for mode "mainland"; falling back to direct' };
            }
            return { mode: 'mainland', server, rules: buildMainlandRules(server) };
        }
        case 'manual': {
            const rules = String(settings.get('proxyRules') || '').trim();
            return { mode: 'manual', server, rules };
        }
        default:
            return { mode: 'off', server: '', rules: '' };
    }
}

async function applyProxy(session, settings, userDataDir, tunnelStatus) {
    const config = resolveConfig(settings, userDataDir, tunnelStatus);
    const chromiumConfig =
        config.mode === 'off'
            ? { mode: 'direct' }
            : config.mode === 'system'
                ? { mode: 'system' }
                : { proxyRules: config.rules, proxyBypassRules: '<local>' };
    try {
        await session.setProxy(chromiumConfig);
        return { ok: true, config };
    } catch (e) {
        return { ok: false, error: e.message, config };
    }
}

// Real connectivity check through the proxied session (not the default
// session), so the result reflects what the NotebookLM panes actually use.
async function checkProxy(session) {
    const started = Date.now();
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        const res = await session.fetch('https://notebooklm.google.com/', {
            method: 'GET',
            signal: controller.signal,
            redirect: 'follow',
        });
        clearTimeout(timer);
        return { ok: true, status: res.status, ms: Date.now() - started };
    } catch (e) {
        return { ok: false, error: String(e && e.message || e), ms: Date.now() - started };
    }
}

function validateRules(rules) {
    if (!rules || !rules.trim()) return null;
    for (const entry of rules.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
        const eq = entry.indexOf('=');
        if (eq === -1) continue; // bare proxy spec, valid
        const host = entry.slice(0, eq).trim();
        const spec = entry.slice(eq + 1).trim();
        if (!spec) return `empty proxy spec for "${host}"`;
        if (!/^[a-z*?0-9.\[\]:-]+$/i.test(host)) return `invalid host pattern "${host}"`;
        if (!isValidServer(spec)) return `invalid proxy spec "${spec}"`;
    }
    return null;
}

module.exports = {
    PROXY_DOMAINS,
    PROXY_MODES,
    PROXY_SCHEMES,
    parseProxyUrl,
    toRulesSpec,
    buildMainlandRules,
    resolveConfig,
    applyProxy,
    checkProxy,
    isValidServer,
    validateRules,
    loadAuth,
    saveAuth,
    authFilePath,
};
