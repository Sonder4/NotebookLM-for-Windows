function openLink(url) {
    if (window.api && window.api.openExternal) window.api.openExternal(url);
}

const $ = (id) => document.getElementById(id);

// ---------- Window controls ----------
$('min-btn').addEventListener('click', () => window.api && window.api.windowAction('minimize'));
$('max-btn').addEventListener('click', () => window.api && window.api.windowAction('maximize'));
$('close-btn').addEventListener('click', () => window.api && window.api.windowAction('close'));

// ---------- Opacity ----------
const opacitySlider = $('opacity-slider');
if (window.api) {
    window.api.getOpacity().then(v => { if (typeof v === 'number') opacitySlider.value = v; });
    opacitySlider.addEventListener('input', (e) => window.api.setOpacity(parseFloat(e.target.value)));
}

// ---------- Pane manager (1 / 2 / 3 panes) ----------
const paneContainers = [
    { container: $('view1-container'), webviewId: 'notebookView1', errorId: 'err1' },
    { container: $('view2-container'), webviewId: 'notebookView2', errorId: 'err2' },
    { container: $('view3-container'), webviewId: 'notebookView3', errorId: 'err3' },
];
let paneCount = 1;
let activePaneIndex = 0;

const paneToggle = $('pane-toggle');

function applyPaneCount(n) {
    paneCount = Math.max(1, Math.min(3, n));
    paneContainers.forEach((p, i) => {
        if (i < paneCount) p.container.classList.remove('hidden');
        else p.container.classList.add('hidden');
    });
    paneToggle.textContent = `窗格：${paneCount}`;
    if (activePaneIndex >= paneCount) activePaneIndex = 0;
}

paneToggle.addEventListener('click', () => {
    const next = paneCount === 3 ? 1 : paneCount + 1;
    applyPaneCount(next);
    if (window.api) window.api.settingsSet('paneCount', next);
});

// Track active pane via focus events on webviews
paneContainers.forEach((p, i) => {
    const wv = $(p.webviewId);
    if (!wv) return;
    wv.addEventListener('focus', () => { activePaneIndex = i; });
    // Webview clicks bubble through host; use mouseenter as a hint
    wv.addEventListener('mouseenter', () => { activePaneIndex = i; });
});

function getActiveWebview() {
    const idx = activePaneIndex < paneCount ? activePaneIndex : 0;
    return $(paneContainers[idx].webviewId);
}

// ---------- Error / retry overlays ----------
paneContainers.forEach(({ webviewId, errorId }) => {
    const wv = $(webviewId);
    const overlay = $(errorId);
    if (!wv || !overlay) return;
    wv.addEventListener('did-fail-load', (e) => {
        // -3 is ERR_ABORTED (navigation aborted), often benign — ignore.
        if (e.errorCode === -3) return;
        overlay.classList.add('show');
        const body = overlay.querySelector('.err-body');
        if (body && e.errorDescription) {
            body.textContent = `${e.errorDescription}. Check your connection or try again.`;
        }
    });
    wv.addEventListener('did-finish-load', () => overlay.classList.remove('show'));
});

document.querySelectorAll('[data-retry]').forEach(btn => {
    btn.addEventListener('click', () => {
        const wv = $(btn.getAttribute('data-retry'));
        if (wv && wv.reload) wv.reload();
    });
});
document.querySelectorAll('[data-open-browser]').forEach(btn => {
    btn.addEventListener('click', () => openLink('https://notebooklm.google.com/'));
});

// ---------- Always-on-top ----------
const pinToggle = $('pin-toggle');
if (window.api) {
    window.api.getAlwaysOnTop().then(on => updatePinUI(!!on));
    pinToggle.addEventListener('click', async () => {
        const cur = pinToggle.classList.contains('active');
        const next = await window.api.setAlwaysOnTop(!cur);
        updatePinUI(!!next);
    });
}
function updatePinUI(on) {
    pinToggle.classList.toggle('active', on);
    pinToggle.textContent = on ? '📌 已置顶' : '📌 置顶';
}

// ---------- Theme ----------
function applyTheme(theme) {
    document.body.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
    $('theme-toggle').textContent = theme === 'dark' ? '☀' : '🌙';
}
if (window.api) {
    window.api.onTheme(applyTheme);
}
$('theme-toggle').addEventListener('click', async () => {
    if (!window.api) return;
    const all = await window.api.settingsGetAll();
    // Cycle system -> light -> dark -> system
    const next = all.theme === 'system' ? 'light' : all.theme === 'light' ? 'dark' : 'system';
    await window.api.setTheme(next);
    if (next !== 'system') applyTheme(next);
});

// ---------- Auto-launch ----------
const autoLaunchToggle = $('autoLaunchToggle');
if (window.api) {
    window.api.getAutoLaunch().then(enabled => { autoLaunchToggle.checked = enabled; });
    autoLaunchToggle.addEventListener('change', (e) => window.api.setAutoLaunch(e.target.checked));

    const closeToTrayToggle = $('closeToTrayToggle');
    if (closeToTrayToggle) {
        window.api.settingsGetAll().then(s => { closeToTrayToggle.checked = !!s.closeToTray; });
        closeToTrayToggle.addEventListener('change', (e) => window.api.settingsSet('closeToTray', e.target.checked));
    }
}

// ---------- Webview IPC (notebook events) ----------
function setupWebviewEvents(webviewId) {
    const webview = $(webviewId);
    if (!webview) return;
    webview.addEventListener('ipc-message', (event) => {
        if (event.channel === 'notebook-event') {
            const { title, body } = event.args[0];
            if (window.api && window.api.showNotification) window.api.showNotification(title, body);
        } else if (event.channel === 'notes-extracted') {
            handleNotesExtracted(event.args[0]);
        }
    });
}
paneContainers.forEach(p => setupWebviewEvents(p.webviewId));

// ---------- Quick-Clip ----------
if (window.api) {
    window.api.onQuickClip((text) => {
        const wv = getActiveWebview();
        try { wv.send('quick-clip-paste', text); }
        catch (e) { console.error("Could not send to webview", e); }
    });
}

// ---------- Drag & drop ----------
document.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });

document.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    const dt = e.dataTransfer;
    if (!dt) return;

    // URL drop: text/uri-list
    const uri = dt.getData('text/uri-list') || dt.getData('text/plain');
    if (uri && /^https?:\/\//i.test(uri.trim())) {
        const wv = getActiveWebview();
        try { wv.send('url-drop', uri.trim()); } catch (err) { console.error(err); }
        return;
    }

    if (dt.files && dt.files.length > 0) {
        const filePaths = Array.from(dt.files).map(f => f.path);
        const wv = getActiveWebview();
        try { wv.send('file-drop', filePaths); } catch (err) { console.error(err); }
    }
});

// ---------- Agent-driven navigation & pane control ----------
if (window.api) {
    window.api.onNavigate((url) => {
        const wv = getActiveWebview();
        if (!wv) return;
        try { wv.loadURL(url); } catch (e) { console.error('navigate failed', e); }
    });
    window.api.onPanesChanged((n) => {
        applyPaneCount(n);
        paneCount = Math.max(1, Math.min(3, n));
    });
    // Maximized windows drop the rounded liquid-glass corners.
    if (window.api.onWindowState) {
        window.api.onWindowState((max) => document.body.classList.toggle('maximized', !!max));
    }
}

// ---------- Export notes ----------
let pendingExport = false;
let pendingExportPath = null;

$('export-btn').addEventListener('click', () => {
    const wv = getActiveWebview();
    if (!wv) return;
    pendingExport = true;
    try { wv.send('extract-notes'); }
    catch (e) { pendingExport = false; console.error(e); }
});

// Agent flow: write extracted notes straight to a path (no dialog)
if (window.api && window.api.onExportNotesToFile) {
    window.api.onExportNotesToFile((filePath) => {
        const wv = getActiveWebview();
        if (!wv) {
            window.api.saveNotesFileTo({ path: filePath, content: '' })
                .catch(() => {});
            return;
        }
        pendingExportPath = filePath;
        try { wv.send('extract-notes'); }
        catch (e) {
            pendingExportPath = null;
            window.api.saveNotesFileTo({ path: filePath, content: '' }).catch(() => {});
        }
    });
}

async function handleNotesExtracted(payload) {
    if (pendingExportPath) {
        const filePath = pendingExportPath;
        pendingExportPath = null;
        await window.api.saveNotesFileTo({
            path: filePath,
            content: (payload && payload.markdown) || (payload && payload.error ? `# export failed\n\n${payload.error}\n` : ''),
        });
        return;
    }
    if (!pendingExport) return;
    pendingExport = false;
    if (!payload || !payload.markdown) {
        if (window.api) window.api.showNotification('导出失败', '未识别到笔记——NotebookLM 界面可能已变化。');
        return;
    }
    if (!window.api) return;
    const result = await window.api.saveNotesMarkdown({
        filename: (payload.title || 'notebooklm-notes') + '.md',
        content: payload.markdown,
    });
    if (result && result.ok) {
        window.api.showNotification('笔记已导出', '已保存到 ' + result.filePath);
    }
}

// ---------- Settings modal ----------
const settingsModal = $('settings-modal');
const settingsBtn = $('settings-btn');
const settingsClose = $('settings-close');
const themeSelect = $('theme-select');
const hotkeyInput = $('hotkey-input');
const hotkeyStatus = $('hotkey-status');
const alwaysOnTopCb = $('always-on-top-cb');
const paneCountSelect = $('pane-count-select');

async function openSettings() {
    if (!window.api) return;
    const s = await window.api.settingsGetAll();
    themeSelect.value = s.theme || 'system';
    alwaysOnTopCb.checked = !!s.alwaysOnTop;
    paneCountSelect.value = String(s.paneCount || 1);
    hotkeyInput.value = s.quickClipAccelerator || '';
    hotkeyStatus.textContent = '';
    // Proxy section
    proxyModeSelect.value = s.proxyMode || 'off';
    proxyServerInput.value = s.proxyServer || '';
    proxyRulesInput.value = s.proxyRules || '';
    try {
        const t = await window.api.getTunnelStatus();
        if (t && t.uriConfigured) proxyTunnelInput.placeholder = `已配置（运行中：${!!t.running}）`;
        else proxyTunnelInput.placeholder = 'vless://uuid@[2001:db8::1]:443?...';
    } catch (e) { /* non-fatal */ }
    updateProxyRows(proxyModeSelect.value);
    proxyStatus.textContent = proxyHelpText(proxyModeSelect.value);
    settingsModal.classList.add('show');
}
settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', () => settingsModal.classList.remove('show'));
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.remove('show'); });
if (window.api && window.api.onOpenSettings) window.api.onOpenSettings(openSettings);

themeSelect.addEventListener('change', async (e) => {
    if (!window.api) return;
    await window.api.setTheme(e.target.value);
});

alwaysOnTopCb.addEventListener('change', async (e) => {
    if (!window.api) return;
    const next = await window.api.setAlwaysOnTop(e.target.checked);
    updatePinUI(!!next);
});

paneCountSelect.addEventListener('change', (e) => {
    if (!window.api) return;
    const n = parseInt(e.target.value, 10) || 1;
    window.api.settingsSet('paneCount', n);
    applyPaneCount(n);
});

// Hotkey capture
hotkeyInput.addEventListener('focus', () => {
    hotkeyInput.classList.add('recording');
    hotkeyStatus.textContent = '请按下组合键…（Esc 取消）';
});
hotkeyInput.addEventListener('blur', () => hotkeyInput.classList.remove('recording'));
hotkeyInput.addEventListener('keydown', async (e) => {
    e.preventDefault();
    if (e.key === 'Escape') { hotkeyInput.blur(); hotkeyStatus.textContent = '已取消'; return; }
    const parts = [];
    if (e.ctrlKey) parts.push('Control');
    if (e.metaKey) parts.push('Command');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    const key = e.key;
    if (!key || ['Control', 'Meta', 'Alt', 'Shift'].includes(key)) {
        hotkeyStatus.textContent = '请包含一个非修饰键';
        return;
    }
    const accel = [...parts, key.length === 1 ? key.toUpperCase() : key].join('+')
        .replace('Control', 'CommandOrControl')
        .replace('Command+Command', 'Command');
    if (!window.api) return;
    const result = await window.api.setHotkey(accel);
    if (result && result.ok) {
        hotkeyInput.value = accel;
        hotkeyStatus.textContent = '已保存';
    } else {
        hotkeyStatus.textContent = `无法绑定 ${accel}（可能被占用），已恢复为 ${result && result.current}。`;
        if (result && result.current) hotkeyInput.value = result.current;
    }
    hotkeyInput.blur();
});

// ---------- Proxy & embedded tunnel (settings modal) ----------
const proxyModeSelect = $('proxy-mode-select');
const proxyServerInput = $('proxy-server-input');
const proxyTunnelInput = $('proxy-tunnel-input');
const proxyRulesInput = $('proxy-rules-input');
const proxyServerRow = $('proxy-server-row');
const proxyTunnelRow = $('proxy-tunnel-row');
const proxyRulesRow = $('proxy-rules-row');
const proxyStatus = $('proxy-status');
const proxyApplyBtn = $('proxy-apply-btn');
const proxyCheckBtn = $('proxy-check-btn');

function updateProxyRows(mode) {
    proxyServerRow.style.display = (mode === 'vps' || mode === 'mainland') ? '' : 'none';
    proxyTunnelRow.style.display = mode === 'tunnel' ? '' : 'none';
    proxyRulesRow.style.display = mode === 'manual' ? '' : 'none';
}

function proxyHelpText(mode) {
    switch (mode) {
        case 'tunnel': return '内嵌 sing-box 隧道——粘贴 vless:// 或 hysteria2:// URI 后点击应用。';
        case 'vps': return '全部流量经由 http/socks 代理直连（无需本地客户端）。';
        case 'mainland': return '仅 Google/NotebookLM 域名走代理，其余直连。';
        case 'manual': return '直接填写 Chromium 代理规则。';
        default: return '';
    }
}

if (window.api && proxyModeSelect) {
    proxyModeSelect.addEventListener('change', () => {
        updateProxyRows(proxyModeSelect.value);
        proxyStatus.textContent = proxyHelpText(proxyModeSelect.value);
    });

    proxyApplyBtn.addEventListener('click', async () => {
        proxyStatus.textContent = '正在应用…';
        try {
            const mode = proxyModeSelect.value;
            if (mode === 'tunnel') {
                const uri = proxyTunnelInput.value.trim();
                if (uri) await window.api.setTunnelUri(uri);
                else await window.api.startTunnel();
            } else {
                await window.api.settingsSet('proxyMode', mode);
                const server = proxyServerInput.value.trim();
                if (server) await window.api.settingsSet('proxyServer', server);
                const rules = proxyRulesInput.value.trim();
                if (rules) await window.api.settingsSet('proxyRules', rules);
            }
            const result = await window.api.applyProxy();
            if (result && result.ok) {
                proxyStatus.textContent = `已应用：${JSON.stringify(result.config)}`;
            } else {
                proxyStatus.textContent = `失败：${result && result.error}`;
            }
        } catch (e) {
            proxyStatus.textContent = `失败：${e.message || e}`;
        }
    });

    proxyCheckBtn.addEventListener('click', async () => {
        proxyStatus.textContent = '正在检测 NotebookLM 连通性…';
        try {
            const result = await window.api.checkProxy();
            proxyStatus.textContent = result && result.ok
                ? `可达：HTTP ${result.status}（${result.ms}ms）`
                : `不可达：${result && result.error}`;
        } catch (e) {
            proxyStatus.textContent = `检测失败：${e.message || e}`;
        }
    });
}

// ---------- Init from settings ----------
(async function init() {
    if (!window.api) return;
    try {
        const s = await window.api.settingsGetAll();
        applyPaneCount(s.paneCount || 1);
        updatePinUI(!!s.alwaysOnTop);
        // Theme will be pushed via theme-changed event after did-finish-load
        applyTheme(s.theme === 'dark' ? 'dark' : 'light');
    } catch (e) { console.error('init settings', e); }
})();
