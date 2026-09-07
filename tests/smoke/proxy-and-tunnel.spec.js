// @ts-check
const { test, expect } = require('@playwright/test');
const proxy = require('../../src/proxy');
const tunnel = require('../../src/tunnel');

const fakeSettings = (values) => {
    const store = { proxyMode: 'off', proxyServer: '', proxyRules: '', tunnelPort: 18080, ...values };
    return { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
};

test.describe('tunnel URI parsing', () => {
    const vless = 'vless://11111111-2222-3333-4444-555555555555@[2001:db8::1]:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=example.com&fp=chrome&pbk=PUBLICKEY123&type=tcp#my-vps';

    test('parses a reality vless URI with bracketed IPv6', () => {
        const p = tunnel.parseTunnelUri(vless);
        expect(p).toBeTruthy();
        expect(p.protocol).toBe('vless');
        expect(p.server).toBe('2001:db8::1');
        expect(p.port).toBe(443);
        expect(p.uuid).toBe('11111111-2222-3333-4444-555555555555');
        expect(p.flow).toBe('xtls-rprx-vision');
        expect(p.sni).toBe('example.com');
        expect(p.fingerprint).toBe('chrome');
        expect(p.publicKey).toBe('PUBLICKEY123');
        expect(p.name).toBe('my-vps');
    });

    test('parses hysteria2 URIs (hy2 alias, plain ipv4)', () => {
        const p = tunnel.parseTunnelUri('hy2://secretpass@203.0.113.9:444/?sni=example.com&insecure=0#fast');
        expect(p).toBeTruthy();
        expect(p.protocol).toBe('hysteria2');
        expect(p.server).toBe('203.0.113.9');
        expect(p.port).toBe(444);
        expect(p.password).toBe('secretpass');
        expect(p.sni).toBe('example.com');
        expect(p.insecure).toBe(false);
    });

    test('rejects garbage', () => {
        expect(tunnel.parseTunnelUri('http://example.com')).toBeNull();
        expect(tunnel.parseTunnelUri('vless://nohost')).toBeNull();
        expect(tunnel.parseTunnelUri('')).toBeNull();
    });

    test('builds a valid sing-box config', () => {
        const p = tunnel.parseTunnelUri(vless);
        const cfg = tunnel.buildSingBoxConfig(p, 18099);
        expect(cfg.inbounds[0]).toMatchObject({ type: 'socks', listen: '127.0.0.1', listen_port: 18099 });
        expect(cfg.outbounds[0]).toMatchObject({ type: 'vless', tag: 'vps', server: '2001:db8::1', server_port: 443 });
        expect(cfg.outbounds[0].tls.reality.enabled).toBe(true);
        expect(cfg.route.final).toBe('vps');
    });
});

test.describe('proxy config resolution', () => {
    test('off resolves to direct', () => {
        const cfg = proxy.resolveConfig(fakeSettings({ proxyMode: 'off' }), '/tmp');
        expect(cfg.mode).toBe('off');
        expect(cfg.rules).toBe('');
    });

    test('vps mode strips credentials into chromium rules', () => {
        const cfg = proxy.resolveConfig(fakeSettings({
            proxyMode: 'vps',
            proxyServer: 'http://user:pass@[2001:db8::1]:8443',
        }), '/tmp');
        expect(cfg.mode).toBe('vps');
        expect(cfg.rules).toBe('[2001:db8::1]:8443');
        expect(cfg.rules.includes('user')).toBe(false);
    });

    test('mainland mode scopes rules to Google domains only', () => {
        const cfg = proxy.resolveConfig(fakeSettings({
            proxyMode: 'mainland',
            proxyServer: 'socks5://127.0.0.1:7890',
        }), '/tmp');
        expect(cfg.mode).toBe('mainland');
        expect(cfg.rules).toContain('[*.]google.com=socks5://127.0.0.1:7890');
        expect(cfg.rules).not.toContain('[*.]baidu.com');
    });

    test('mainland without a server falls back to direct instead of black-holing', () => {
        const cfg = proxy.resolveConfig(fakeSettings({ proxyMode: 'mainland', proxyServer: '' }), '/tmp');
        expect(cfg.mode).toBe('off');
        expect(cfg.reason).toBeTruthy();
    });

    test('env overrides win over settings', () => {
        process.env.NBD_PROXY_MODE = 'off';
        const cfg = proxy.resolveConfig(fakeSettings({ proxyMode: 'vps', proxyServer: 'http://203.0.113.1:8443' }), '/tmp');
        expect(cfg.mode).toBe('off');
        delete process.env.NBD_PROXY_MODE;
    });

    test('parseProxyUrl handles user:pass and ipv6', () => {
        const p = proxy.parseProxyUrl('http://me:pw@[2001:db8::53]:8443');
        expect(p).toMatchObject({ scheme: 'http', host: '2001:db8::53', port: 8443, username: 'me', password: 'pw' });
        expect(proxy.isValidServer('socks5://127.0.0.1:7890')).toBe(true);
        expect(proxy.isValidServer('http://[2001:db8::1]:99999')).toBe(false);
    });

    test('validateRules catches broken entries', () => {
        expect(proxy.validateRules('[*.]google.com=socks5://127.0.0.1:7890')).toBeNull();
        expect(proxy.validateRules('[*.]google.com=')).toBeTruthy();
    });
});

test.describe('control server helpers', () => {
    const { normalizeNotebookUrl } = require('../../src/control-server');

    test('accepts notebooklm urls and bare ids, rejects foreign hosts', () => {
        expect(normalizeNotebookUrl('https://notebooklm.google.com/notebook/abc-123')).toContain('/notebook/abc-123');
        expect(normalizeNotebookUrl('2cee26cc-794b-4a20-b1a7-daaaaaaa0000')).toContain('notebook/2cee26cc');
        expect(normalizeNotebookUrl('https://evil.example.com/notebook/x')).toBeNull();
        expect(normalizeNotebookUrl('')).toBeNull();
    });
});
