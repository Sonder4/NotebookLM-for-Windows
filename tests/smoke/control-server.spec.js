// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const { launchApp, cleanup } = require('../helpers');

// End-to-end: the app must expose its loopback control server with bearer
// auth, and honor proxy/settings mutations coming in through it.

function readToken(userDataDir) {
    return fs.readFileSync(path.join(userDataDir, 'control-token'), 'utf8').trim();
}

// The server persists its actually-bound port (it walks forward if 8787 is busy).
function readPort(userDataDir) {
    try {
        return Number(fs.readFileSync(path.join(userDataDir, 'control-port'), 'utf8').trim());
    } catch (e) { return 8787; }
}

async function api(userDataDir, method, route, body) {
    return fetch(`http://127.0.0.1:${readPort(userDataDir)}${route}`, {
        method,
        headers: { 'Authorization': `Bearer ${readToken(userDataDir)}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

test.describe('agent control server', () => {
    let ctx;
    test.beforeEach(async () => { ctx = await launchApp(); });
    test.afterEach(async () => { if (ctx) await cleanup(ctx); });

    test('rejects unauthenticated requests', async () => {
        await ctx.app.firstWindow();
        const res = await fetch('http://127.0.0.1:8787/health');
        expect(res.status).toBe(401);
    });

    test('health + status respond with the bearer token', async () => {
        await ctx.app.firstWindow();
        await new Promise((r) => setTimeout(r, 500));
        const health = await (await api(ctx.userDataDir, 'GET', '/health')).json();
        expect(health.ok).toBe(true);
        const status = await (await api(ctx.userDataDir, 'GET', '/status')).json();
        expect(status.ok).toBe(true);
        expect(status.app.platform).toBe(process.platform);
        expect(status.window).toBeTruthy();
        expect(status.tunnel).toHaveProperty('running');
    });

    test('panes change through the control server', async () => {
        const window = await ctx.app.firstWindow();
        await window.waitForLoadState('domcontentloaded');
        const res = await api(ctx.userDataDir, 'POST', '/panes', { count: 2 });
        const body = await res.json();
        expect(body.ok).toBe(true);
        const s = await window.evaluate(() => window.api.settingsGetAll());
        expect(s.paneCount).toBe(2);
    });

    test('proxy set applies mode and rejects invalid input', async () => {
        const window = await ctx.app.firstWindow();
        await window.waitForLoadState('domcontentloaded');

        const bad = await api(ctx.userDataDir, 'POST', '/proxy', { mode: 'bogus' });
        expect(bad.status).toBe(400);

        const good = await (await api(ctx.userDataDir, 'POST', '/proxy', {
            mode: 'mainland',
            server: 'socks5://127.0.0.1:7890',
        })).json();
        expect(good.ok).toBe(true);
        expect(good.proxy.mode).toBe('mainland');
        expect(good.proxy.rules).toContain('[*.]google.com=socks5://127.0.0.1:7890');

        const s = await window.evaluate(() => window.api.settingsGetAll());
        expect(s.proxyMode).toBe('mainland');
    });
});
