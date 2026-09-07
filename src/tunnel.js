// Embedded sing-box tunnel manager.
//
// Chromium cannot speak VLESS/Hysteria2 natively, and plaintext HTTP CONNECT
// proxies carrying Google hostnames get keyword-reset by the GFW on mainland
// networks. The robust pattern is a local tunnel client whose data plane is a
// Reality/Hysteria2 stream that survives filtering. This module embeds that
// client in the app:
//
//   app panes (persist:notebooklm session)
//     -> socks5://127.0.0.1:<port>   (sing-box local inbound)
//     -> vless+reality / hysteria2   (VPS, e.g. over IPv6)
//     -> VPS egress -> NotebookLM
//
// The sing-box binary is resolved from, in order:
//   1. packaged resources: <resourcesPath>/sing-box/bin/sing-box[.exe]
//   2. app data cache:     <userData>/bin/sing-box[.exe]
//   3. PATH
// and can be downloaded on demand (GitHub releases) when none is found.
//
// Credentials (vless:// / hysteria2:// URIs) are stored 0600 in
// <userData>/tunnel/uri.txt and never leave the machine.

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const DEFAULT_LOCAL_PORT = 18080;
const DOWNLOAD_BASE = 'https://github.com/SagerNet/sing-box/releases/latest/download';

// ---------------------------------------------------------------- URI parsing

function parseQueryPairs(query) {
    const out = {};
    for (const pair of String(query || '').split('&')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        if (eq === -1) { out[pair] = ''; continue; }
        try {
            out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
        } catch (e) {
            out[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
    }
    return out;
}

function splitHostPort(host, portRaw) {
    let h = host || '';
    const m = h.match(/^\[(.+)\]$/);
    if (m) h = m[1];
    return { host: h, port: Number(portRaw) };
}

// vless://uuid@host:port?encryption=none&flow=xtls-rprx-vision&security=reality
//   &sni=...&fp=chrome&pbk=...&sid=...&type=tcp#name
function parseVlessUri(uri) {
    const m = String(uri || '').trim().match(/^vless:\/\/([^@]+)@(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?([^#]*)(?:#(.*))?$/i);
    if (!m) return null;
    const { host, port } = splitHostPort(m[2], m[3]);
    const q = parseQueryPairs(m[4].replace(/^[/?]+/, ''));
    if (!host || !port) return null;
    return {
        protocol: 'vless',
        uuid: m[1],
        server: host,
        port,
        flow: q.flow || '',
        security: q.security || (q.pbk ? 'reality' : 'tls'),
        sni: q.sni || '',
        fingerprint: q.fp || '',
        publicKey: q.pbk || '',
        shortId: q.sid || '',
        network: q.type || 'tcp',
        name: m[5] ? decodeURIComponent(m[5]) : 'vps',
    };
}

// hysteria2://password@host:port/?sni=...&insecure=0
function parseHysteria2Uri(uri) {
    let s = String(uri || '').trim();
    if (/^hy2:\/\//i.test(s)) s = 'hysteria2://' + s.slice(6);
    const m = s.match(/^hysteria2:\/\/([^@]+)@(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?([^#]*)(?:#(.*))?$/i);
    if (!m) return null;
    const { host, port } = splitHostPort(m[2], m[3]);
    const q = parseQueryPairs(m[4].replace(/^[/?]+/, ''));
    if (!host || !port) return null;
    return {
        protocol: 'hysteria2',
        password: m[1],
        server: host,
        port,
        sni: q.sni || '',
        insecure: q.insecure === '1' || String(q.insecure).toLowerCase() === 'true',
        name: m[5] ? decodeURIComponent(m[5]) : 'vps',
    };
}

function parseTunnelUri(uri) {
    const s = String(uri || '').trim();
    if (!s) return null;
    if (/^vless:\/\//i.test(s)) return parseVlessUri(s);
    if (/^(hysteria2|hy2):\/\//i.test(s)) return parseHysteria2Uri(s);
    return null;
}

// ------------------------------------------------------------ config building

function buildSingBoxConfig(parsed, localPort) {
    const config = {
        log: { level: 'warn', timestamp: true },
        inbounds: [{
            type: 'socks',
            tag: 'socks-in',
            listen: '127.0.0.1',
            listen_port: localPort,
        }],
        outbounds: [],
        route: { final: 'vps', auto_detect_interface: true },
    };
    if (parsed.protocol === 'vless') {
        const tls = { enabled: true, server_name: parsed.sni || parsed.server };
        if (parsed.fingerprint) tls.utls = { enabled: true, fingerprint: parsed.fingerprint };
        if (parsed.security === 'reality' || parsed.publicKey) {
            tls.reality = { enabled: true, public_key: parsed.publicKey, short_id: parsed.shortId || '' };
        }
        config.outbounds.push({
            type: 'vless',
            tag: 'vps',
            server: parsed.server,
            server_port: parsed.port,
            uuid: parsed.uuid,
            flow: parsed.flow || '',
            tls,
        });
    } else if (parsed.protocol === 'hysteria2') {
        config.outbounds.push({
            type: 'hysteria2',
            tag: 'vps',
            server: parsed.server,
            server_port: parsed.port,
            password: parsed.password,
            tls: { enabled: true, server_name: parsed.sni || parsed.server, insecure: !!parsed.insecure },
        });
    } else {
        throw new Error(`unsupported tunnel protocol: ${parsed.protocol}`);
    }
    config.outbounds.push({ type: 'direct', tag: 'direct' });
    return config;
}

// ---------------------------------------------------------------- file stores

function writeSecretFile(p, content) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, { mode: 0o600 });
    if (process.platform !== 'win32') {
        try { fs.chmodSync(p, 0o600); } catch (e) { /* best effort */ }
    }
}

// ------------------------------------------------------------ process manager

class TunnelManager {
    constructor({ userDataDir, app = null, defaultPort = DEFAULT_LOCAL_PORT } = {}) {
        this.userDataDir = userDataDir;
        this.defaultPort = defaultPort;
        this.proc = null;
        this.running = false;
        this.startedAt = null;
        this.lastError = null;
        this.localPort = null;
        this.parsed = null;
        this.app = app; // electron app, optional (used for resourcesPath)
    }

    tunnelDir() { return path.join(this.userDataDir, 'tunnel'); }
    configPath() { return path.join(this.tunnelDir(), 'config.json'); }
    uriPath() { return path.join(this.tunnelDir(), 'uri.txt'); }
    logPath() { return path.join(this.tunnelDir(), 'sing-box.log'); }

    loadUri() {
        try { return fs.readFileSync(this.uriPath(), 'utf8').trim() || null; } catch (e) { return null; }
    }

    saveUri(uri) {
        if (!uri) { try { fs.unlinkSync(this.uriPath()); } catch (e) { /* gone */ } return; }
        writeSecretFile(this.uriPath(), String(uri).trim() + '\n');
    }

    // -------------------------------------------------------------- binary

    binaryPath() {
        const exe = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
        const candidates = [];
        if (this.app && typeof this.app.isPackaged === 'boolean' && this.app.isPackaged && process.resourcesPath) {
            candidates.push(path.join(process.resourcesPath, 'sing-box', 'bin', exe));
        }
        candidates.push(path.join(this.userDataDir, 'bin', exe));
        for (const p of candidates) {
            try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* next */ }
        }
        // PATH lookup
        for (const dir of (process.env.PATH || '').split(path.delimiter)) {
            if (!dir) continue;
            const p = path.join(dir, exe);
            try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* next */ }
        }
        return null;
    }

    async downloadBinary(onProgress) {
        const platformMap = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
        const archMap = { x64: 'amd64', arm64: 'arm64', arm: 'armv7' };
        const platform = platformMap[process.platform];
        const arch = archMap[process.arch];
        if (!platform || !arch) throw new Error(`no sing-box build for ${process.platform}/${process.arch}`);

        // Resolve latest version via the GitHub API redirect.
        const verRes = await fetch('https://api.github.com/repos/SagerNet/sing-box/releases/latest');
        if (!verRes.ok) throw new Error(`cannot resolve sing-box version: HTTP ${verRes.status}`);
        const tag = (await verRes.json()).tag_name || '';
        const ver = tag.replace(/^v/, '');
        const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
        const url = `${DOWNLOAD_BASE}/sing-box-${ver}-${platform}-${arch}.${ext}`;
        if (onProgress) onProgress(`downloading ${url}`);

        const res = await fetch(url);
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
        const archivePath = path.join(os.tmpdir(), `sing-box-${Date.now()}.${ext}`);
        fs.writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()));

        const binDir = path.join(this.userDataDir, 'bin');
        fs.mkdirSync(binDir, { recursive: true });
        const exe = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
        const dest = path.join(binDir, exe);
        if (ext === 'zip') {
            const { execSync } = require('child_process');
            const tmpUnzip = path.join(os.tmpdir(), `sb-unzip-${Date.now()}`);
            fs.mkdirSync(tmpUnzip, { recursive: true });
            execSync(`powershell -NoProfile -Command "Expand-Archive -Force '${archivePath}' '${tmpUnzip}'"`);
            const found = execSync(`powershell -NoProfile -Command "Get-ChildItem -Recurse '${tmpUnzip}' -Filter sing-box.exe | Select-Object -First 1 -ExpandProperty FullName"`).toString().trim();
            if (!found) throw new Error('sing-box.exe not found in archive');
            fs.copyFileSync(found, dest);
        } else {
            const { execSync } = require('child_process');
            const tmpExtract = path.join(os.tmpdir(), `sb-extract-${Date.now()}`);
            fs.mkdirSync(tmpExtract, { recursive: true });
            execSync(`tar xzf '${archivePath}' -C '${tmpExtract}'`);
            const found = execSync(`find '${tmpExtract}' -name sing-box -type f | head -1`).toString().trim();
            if (!found) throw new Error('sing-box binary not found in archive');
            fs.copyFileSync(found, dest);
            fs.chmodSync(dest, 0o755);
        }
        try { fs.unlinkSync(archivePath); } catch (e) { /* temp */ }
        return dest;
    }

    // -------------------------------------------------------------- control

    setUri(uri) {
        const parsed = parseTunnelUri(uri);
        if (!parsed) throw new Error('invalid tunnel URI (expected vless://… or hysteria2://…)');
        this.saveUri(uri.trim());
        this.parsed = parsed;
        return parsed;
    }

    currentUri() { return this.loadUri(); }

    status() {
        const binary = this.binaryPath();
        return {
            installed: !!binary,
            binaryPath: binary,
            running: this.running && !!this.proc && !this.proc.killed,
            localPort: this.localPort,
            pid: this.proc ? this.proc.pid : null,
            startedAt: this.startedAt,
            lastError: this.lastError,
            server: this.parsed ? { protocol: this.parsed.protocol, server: this.parsed.server, port: this.parsed.port, name: this.parsed.name } : null,
            uriConfigured: !!this.loadUri(),
        };
    }

    async start() {
        if (this.running && this.proc) return this.status();
        const uri = this.loadUri();
        if (!uri) { this.lastError = 'no tunnel URI configured'; return this.status(); }
        const parsed = parseTunnelUri(uri);
        if (!parsed) { this.lastError = 'stored tunnel URI is invalid'; return this.status(); }
        const binary = this.binaryPath();
        if (!binary) { this.lastError = 'sing-box binary not found (call downloadBinary or vendor it)'; return this.status(); }

        // Pick a free local port starting from the configured one.
        let port = this.defaultPort;
        for (let i = 0; i < 20; i++) {
            if (await this.portFree(port)) break;
            port += 1;
        }

        const config = buildSingBoxConfig(parsed, port);
        writeSecretFile(this.configPath(), JSON.stringify(config, null, 2));

        this.proc = spawn(binary, ['run', '-c', this.configPath()], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const logFd = fs.openSync(this.logPath(), 'a');
        fs.writeSync(logFd, `\n===== start ${new Date().toISOString()} =====\n`);
        this.proc.stdout.on('data', (d) => fs.writeSync(logFd, d));
        this.proc.stderr.on('data', (d) => fs.writeSync(logFd, d));
        this.proc.on('exit', (code, signal) => {
            fs.writeSync(logFd, `===== exit code=${code} signal=${signal} =====\n`);
            this.running = false;
            this.proc = null;
            this.startedAt = null;
        });

        // Wait for the SOCKS port to accept connections.
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            if (!(await this.portFree(port))) {
                this.running = true;
                this.startedAt = new Date().toISOString();
                this.localPort = port;
                this.parsed = parsed;
                this.lastError = null;
                return this.status();
            }
            if (!this.proc || this.proc.killed) break;
            await new Promise((r) => setTimeout(r, 200));
        }
        this.lastError = 'sing-box did not open the local SOCKS port in time (see tunnel/sing-box.log)';
        try { this.proc && this.proc.kill(); } catch (e) { /* ignore */ }
        return this.status();
    }

    stop() {
        if (this.proc) {
            try { this.proc.kill(); } catch (e) { /* ignore */ }
            this.proc = null;
        }
        this.running = false;
        this.startedAt = null;
        return true;
    }

    portFree(port) {
        return new Promise((resolve) => {
            const srv = net.createServer();
            srv.once('error', () => resolve(false));
            srv.once('listening', () => srv.close(() => resolve(true)));
            srv.listen(port, '127.0.0.1');
        });
    }

    // Verify the local SOCKS port actually tunnels: TCP connect + version byte.
    async check() {
        if (!this.running || !this.localPort) return { ok: false, error: 'tunnel not running' };
        return new Promise((resolve) => {
            const started = Date.now();
            const s = net.connect(this.localPort, '127.0.0.1');
            s.setTimeout(5000);
            s.once('connect', () => {
                // SOCKS5 greeting: version 5, 1 method, no-auth (0x00)
                s.write(Buffer.from([0x05, 0x01, 0x00]));
            });
            s.once('data', (buf) => {
                const ok = buf.length >= 2 && buf[0] === 0x05 && buf[1] === 0x00;
                s.destroy();
                resolve(ok
                    ? { ok: true, ms: Date.now() - started, localPort: this.localPort }
                    : { ok: false, error: 'unexpected SOCKS handshake response' });
            });
            s.once('timeout', () => { s.destroy(); resolve({ ok: false, error: 'SOCKS handshake timeout' }); });
            s.once('error', (e) => resolve({ ok: false, error: e.message }));
        });
    }
}

function fingerprintOf(uri) {
    return crypto.createHash('sha256').update(String(uri || '').trim()).digest('hex').slice(0, 12);
}

module.exports = {
    TunnelManager,
    parseTunnelUri,
    parseVlessUri,
    parseHysteria2Uri,
    buildSingBoxConfig,
    DEFAULT_LOCAL_PORT,
    fingerprintOf,
};
