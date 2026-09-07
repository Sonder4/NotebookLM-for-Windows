const {
    app, BrowserWindow, Tray, Menu, ipcMain, shell, Notification, session,
    globalShortcut, clipboard, nativeTheme, dialog, screen
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const AutoLaunch = require('auto-launch');
const { autoUpdater } = require('electron-updater');
const settings = require('./settings');
const proxy = require('./proxy');
const { TunnelManager } = require('./tunnel');
const { createControlServer } = require('./control-server');

app.setName('NotebookLM-for-Windows');

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

let mainWindow;
let quickClipOverlay;
let tray;
let isQuitting = false;

// Single instance: a second launch focuses the existing window instead of
// stacking another process (and another dock entry) on top of it.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

let currentAccelerator = null;

const appLauncher = new AutoLaunch({ name: 'NotebookLM-for-Windows' });

// Embedded VLESS/Hysteria2 tunnel (sing-box child process) — see tunnel.js
const tunnel = new TunnelManager({ userDataDir: null, app });
// Set once app is ready and userData path is known.

// ------------------------------------------------------------------ proxy

const notebooklmSession = () => session.fromPartition('persist:notebooklm', { cache: true });

async function applyProxyNow() {
    const result = await proxy.applyProxy(notebooklmSession(), settings, app.getPath('userData'), tunnel.status());
    if (result.ok) {
        controlServer && controlServer.setLastProxyConfig(result.config);
    }
    return result;
}

// Chromium asks for proxy credentials via the `login` event (vps mode).
app.on('login', (event, webContents, details, authInfo, callback) => {
    if (!authInfo || !authInfo.isProxy) return;
    const config = proxy.resolveConfig(settings, app.getPath('userData'), tunnel.status());
    if (config.mode !== 'vps' || config.host !== authInfo.host) return;
    const auth = proxy.loadAuth(app.getPath('userData'));
    if (!auth.username && !auth.password) return;
    event.preventDefault();
    callback(auth.username, auth.password);
});

function createWindow() {
    const initialOpacity = settings.get('opacity');
    const alwaysOnTop = settings.get('alwaysOnTop');

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        frame: false,
        // Liquid-glass window: transparent so the rounded shell + backdrop
        // blur in index.html can show through; degrades to an opaque rounded
        // shell when no compositor is available.
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: true,
        icon: path.join(__dirname, '../assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            webviewTag: true,
            nodeIntegration: false,
            contextIsolation: true,
        },
        autoHideMenuBar: true,
        alwaysOnTop: !!alwaysOnTop,
    });

    if (typeof initialOpacity === 'number') {
        try { mainWindow.setOpacity(initialOpacity); } catch (e) { /* Wayland */ }
    }

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.on('maximize', () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window-state', true);
    });
    mainWindow.on('unmaximize', () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window-state', false);
    });

    mainWindow.on('close', (event) => {
        if (isQuitting) return;
        // Opt-in tray mode, and the macOS dock convention.
        if (isMac || (settings.get('closeToTray') && tray)) {
            event.preventDefault();
            mainWindow.hide();
            return;
        }
        // X11: the WM's WM_DELETE path and Electron's own destroy race each
        // other — the second X DestroyWindow fails and the 'closed' event is
        // lost, leaving a headless process. Cancel the immediate close and
        // route it through app.quit() so the window is destroyed exactly
        // once, by the shutdown path.
        event.preventDefault();
        isQuitting = true;
        setImmediate(() => app.quit());
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        // Quit with the main window: hidden helper windows (quick-clip
        // overlay) otherwise keep a headless process — and a dock icon —
        // alive after the user closed the app.
        if (!isMac && !settings.get('closeToTray')) {
            isQuitting = true;
            app.quit();
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    // Push initial theme to renderer once loaded
    mainWindow.webContents.on('did-finish-load', () => {
        sendThemeToRenderer();
    });
}

function createTray() {
    // Tray support is optional (needs AppIndicator on GNOME); a missing tray
    // must not break startup or trap the window in hide-on-close mode.
    try {
        const iconPath = path.join(__dirname, '../assets', 'icon.png');
        tray = new Tray(iconPath);

        const contextMenu = Menu.buildFromTemplate([
            { label: '显示主界面', click: () => mainWindow && mainWindow.show() },
            { label: '设置', click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.webContents.send('open-settings');
                }
            }},
            { type: 'separator' },
            { label: '退出', click: () => { isQuitting = true; app.quit(); } },
        ]);

        tray.setToolTip('NotebookLM 桌面版');
        tray.setContextMenu(contextMenu);

        tray.on('click', () => {
            if (!mainWindow) return;
            mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
        });
    } catch (err) {
        console.error('tray unavailable:', err.message);
        tray = null;
    }
}

function createApplicationMenu() {
    if (!isMac) {
        Menu.setApplicationMenu(null);
        return;
    }
    const template = [
        {
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerQuickClip(accelerator) {
    if (currentAccelerator) {
        try { globalShortcut.unregister(currentAccelerator); } catch (e) {}
    }
    const ok = globalShortcut.register(accelerator, onQuickClipFired);
    if (ok) {
        currentAccelerator = accelerator;
        return true;
    }
    // Fallback to default if the new accelerator failed
    if (accelerator !== settings.DEFAULTS.quickClipAccelerator) {
        const fallback = settings.DEFAULTS.quickClipAccelerator;
        const okFallback = globalShortcut.register(fallback, onQuickClipFired);
        if (okFallback) {
            currentAccelerator = fallback;
            settings.set('quickClipAccelerator', fallback);
        }
    }
    return false;
}

function onQuickClipFired() {
    const text = clipboard.readText();

    // If main window is hidden or minimized, show the mini overlay near cursor.
    if (mainWindow && (!mainWindow.isVisible() || mainWindow.isMinimized())) {
        showQuickClipOverlay(text);
        return;
    }

    if (mainWindow) {
        mainWindow.focus();
        if (text) mainWindow.webContents.send('quick-clip', text);
    }
}

function showQuickClipOverlay(text) {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const width = 420;
    const height = 140;
    const x = Math.min(Math.max(cursor.x - width / 2, display.workArea.x + 10),
        display.workArea.x + display.workArea.width - width - 10);
    const y = Math.min(Math.max(cursor.y - height - 20, display.workArea.y + 10),
        display.workArea.y + display.workArea.height - height - 10);

    if (quickClipOverlay && !quickClipOverlay.isDestroyed()) {
        quickClipOverlay.setBounds({ x, y, width, height });
        quickClipOverlay.show();
        quickClipOverlay.webContents.send('quick-clip-text', text);
        quickClipOverlay.focus();
        return;
    }

    quickClipOverlay = new BrowserWindow({
        width, height, x, y,
        frame: false,
        resizable: false,
        movable: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        transparent: true,
        hasShadow: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    quickClipOverlay.loadFile(path.join(__dirname, 'quick-clip-overlay.html'));
    quickClipOverlay.once('ready-to-show', () => {
        quickClipOverlay.show();
        quickClipOverlay.webContents.send('quick-clip-text', text);
    });
    quickClipOverlay.on('blur', () => {
        if (quickClipOverlay && !quickClipOverlay.isDestroyed()) quickClipOverlay.hide();
    });
}

function sendThemeToRenderer() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const themePref = settings.get('theme');
    const resolved = themePref === 'system'
        ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
        : themePref;
    mainWindow.webContents.send('theme-changed', resolved);
}

// ------------------------------------------------------- notes export to file
// Used by the agent control server: extract notes from the active pane and
// write them straight to a path, skipping the save dialog.

let pendingNoteExport = null;

function exportNotesToFile(win, filePath) {
    return new Promise((resolve) => {
        pendingNoteExport = { resolve, filePath };
        win.webContents.send('export-notes-to-file', filePath);
        setTimeout(() => {
            if (pendingNoteExport) {
                const p = pendingNoteExport;
                pendingNoteExport = null;
                p.resolve({ ok: false, error: 'timeout waiting for notes extraction (is a notebook with notes open?)' });
            }
        }, 20000);
    });
}

// --------------------------------------------------------------- control API

let controlServer = null;

function startControlServer() {
    if (settings.get('controlEnabled') === false || process.env.NBD_CONTROL_DISABLE === '1') {
        console.log('control-server: disabled');
        return;
    }
    controlServer = createControlServer({
        settings,
        deps: {
            getMainWindow: () => mainWindow,
            appVersion: () => app.getVersion(),
            userDataDir: () => app.getPath('userData'),
            sendTheme: sendThemeToRenderer,
            quit: () => { isQuitting = true; app.quit(); },
            tunnel,
            proxy,
            applyProxyNow,
            exportNotesToFile,
        },
    });
    controlServer.start();
}

app.whenReady().then(async () => {
    if (!gotSingleInstanceLock) return;
    settings.init();
    tunnel.userDataDir = app.getPath('userData');

    try {
        session.fromPartition('persist:notebooklm', { cache: true });
    } catch (err) {
        console.error('Session config error:', err);
    }

    createApplicationMenu();
    createWindow();
    // Tray icon only in tray mode — keeps the desktop panel clean otherwise.
    if (settings.get('closeToTray')) createTray();

    // Bring up the embedded tunnel before applying proxy rules, so the
    // session sees the live SOCKS endpoint on first load.
    if (settings.get('proxyMode') === 'tunnel') {
        try { await tunnel.start(); } catch (e) { console.error('tunnel start failed:', e); }
    }
    await applyProxyNow();

    if (isMac) {
        try { app.dock.setIcon(path.join(__dirname, '../assets', 'icon.png')); } catch (e) {}
    }

    // Auto-launch follows settings
    appLauncher.isEnabled().then((isEnabled) => {
        const want = settings.get('autoLaunch');
        if (want && !isEnabled) appLauncher.enable();
        if (!want && isEnabled) appLauncher.disable();
    }).catch((err) => console.error('Auto-launch error:', err));

    registerQuickClip(settings.get('quickClipAccelerator'));

    nativeTheme.on('updated', sendThemeToRenderer);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // electron-updater has no feed for this fork's dev flow; only check for
    // packaged builds that can actually install updates (AppImage/mac/win).
    if (app.isPackaged && (isMac || !isLinux || process.env.APPIMAGE)) {
        autoUpdater.allowPrerelease = false;
        autoUpdater.checkForUpdatesAndNotify();
    }

    startControlServer();

    // Watchdog: catch processes that would otherwise linger headless.
    // 1) window destroyed but 'closed'/window-all-closed swallowed;
    // 2) X11: the WM's close (Alt+F4, dock "close window") races Chromium's
    //    own destroy — the X window dies while Electron still tracks it, so
    //    'closed' never fires. Probe the X server for our window id and exit
    //    when it is gone (silently skipped when xwininfo is unavailable).
    let xProbeTool; // undefined = unresolved, 'none' = unavailable
    setInterval(() => {
        if (isQuitting || isMac) return;
        if (mainWindow && mainWindow.isDestroyed()) {
            isQuitting = true; app.quit(); return;
        }
        if (BrowserWindow.getAllWindows().length === 0) {
            isQuitting = true; app.quit(); return;
        }
        try {
            const wc = mainWindow && mainWindow.webContents;
            if (wc && (wc.isDestroyed() || wc.isCrashed())) {
                console.error('main window surface died (X11) — quitting');
                isQuitting = true; app.quit(); return;
            }
        } catch (e) {
            isQuitting = true; app.quit(); return;
        }
        if (process.platform !== 'linux' || !process.env.DISPLAY || !mainWindow) return;
        if (xProbeTool === 'none') return;
        try {
            const xid = mainWindow.getNativeWindowHandle().readUInt32LE(0);
            // xwininfo succeeds for any live window regardless of which
            // properties it has — xprop would false-positive on a window
            // that lacks the probed property.
            execFile(xProbeTool || 'xwininfo', ['-id', String(xid)], (err) => {
                if (!err) { xProbeTool = xProbeTool || 'xwininfo'; return; }
                if (err.code === 'ENOENT') { xProbeTool = 'none'; return; }
                if (!isQuitting) {
                    console.error('X window closed behind Electron (WM race) — quitting');
                    isQuitting = true; app.quit();
                }
            });
        } catch (e) { /* not on X11 */ }
    }, 3000).unref();

    // Immediate counterpart of the watchdog: the renderer dies the moment
    // its X surface is destroyed.
    app.on('render-process-gone', (event, webContents, details) => {
        if (mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents) {
            console.error('main window renderer gone:', details.reason, '— quitting');
            isQuitting = true;
            app.quit();
        }
    });
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    try { if (controlServer) controlServer.stop(); } catch (e) { /* already gone */ }
    tunnel.stop();
});

app.on('window-all-closed', () => {
    if (isMac) {
        // mac convention: stay in dock
        return;
    }
    // Windows/Linux: quit for real — hiding here used to leave an
    // unclosable background process when no tray was visible.
    app.quit();
});

// ---------- IPC ----------

ipcMain.on('window-controls', (event, action) => {
    if (!mainWindow) return;
    switch (action) {
        case 'minimize': mainWindow.minimize(); break;
        case 'maximize':
            mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
            break;
        case 'close': mainWindow.close(); break;
    }
});

ipcMain.on('set-opacity', (event, value) => {
    if (mainWindow) {
        try { mainWindow.setOpacity(value); } catch (e) { /* Wayland */ }
        settings.set('opacity', value);
    }
});

ipcMain.handle('get-opacity', () => settings.get('opacity'));

ipcMain.on('show-notification', (event, { title, body }) => {
    new Notification({ title, body }).show();
});

ipcMain.on('open-external', (event, url) => shell.openExternal(url));

ipcMain.handle('get-auto-launch', async () => {
    return await appLauncher.isEnabled();
});

ipcMain.handle('set-auto-launch', async (event, enable) => {
    if (enable) await appLauncher.enable(); else await appLauncher.disable();
    settings.set('autoLaunch', !!enable);
    return enable;
});

// Settings IPC
ipcMain.handle('settings:get-all', () => settings.getAll());
ipcMain.handle('settings:set', (event, key, value) => {
    settings.set(key, value);
    if (key === 'closeToTray') {
        if (value && !tray) createTray();
        if (!value && tray) {
            try { tray.destroy(); } catch (e) { /* already gone */ }
            tray = null;
        }
    }
    return settings.get(key);
});

// Always-on-top
ipcMain.handle('set-always-on-top', (event, value) => {
    settings.set('alwaysOnTop', !!value);
    if (mainWindow) mainWindow.setAlwaysOnTop(!!value);
    return !!value;
});
ipcMain.handle('get-always-on-top', () => settings.get('alwaysOnTop'));

// Hotkey rebind
ipcMain.handle('set-hotkey', (event, accelerator) => {
    if (typeof accelerator !== 'string' || !accelerator.trim()) {
        return { ok: false, current: currentAccelerator };
    }
    const ok = registerQuickClip(accelerator);
    if (ok) settings.set('quickClipAccelerator', accelerator);
    return { ok, current: currentAccelerator };
});

// Theme
ipcMain.handle('set-theme', (event, value) => {
    if (!['light', 'dark', 'system'].includes(value)) return settings.get('theme');
    settings.set('theme', value);
    sendThemeToRenderer();
    return value;
});

// Notes export (save dialog)
ipcMain.handle('notes:save-markdown', async (event, { filename, content }) => {
    const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export notes',
        defaultPath: filename || 'notebooklm-notes.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    try {
        fs.writeFileSync(result.filePath, content, 'utf8');
        return { ok: true, filePath: result.filePath };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// Notes export (straight to a path — used by the agent CLI)
ipcMain.handle('notes:save-to-file', async (event, { path: filePath, content }) => {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, String(content), 'utf8');
        const result = { ok: true, path: filePath, bytes: Buffer.byteLength(String(content)) };
        if (pendingNoteExport) {
            pendingNoteExport.resolve(result);
            pendingNoteExport = null;
        }
        return result;
    } catch (e) {
        if (pendingNoteExport) {
            pendingNoteExport.resolve({ ok: false, error: e.message });
            pendingNoteExport = null;
        }
        return { ok: false, error: e.message };
    }
});

// ---------- Proxy / tunnel IPC (settings UI + renderer helpers) ----------

ipcMain.handle('proxy:get-config', () => proxy.resolveConfig(settings, app.getPath('userData'), tunnel.status()));

ipcMain.handle('proxy:apply', async () => {
    const result = await applyProxyNow();
    return result;
});

ipcMain.handle('proxy:check', async () => proxy.checkProxy(notebooklmSession()));

ipcMain.handle('tunnel:status', () => tunnel.status());

ipcMain.handle('tunnel:set-uri', async (event, uri) => {
    const parsed = tunnel.setUri(uri); // throws on invalid input
    if (settings.get('proxyMode') !== 'tunnel') settings.set('proxyMode', 'tunnel');
    await tunnel.start();
    await applyProxyNow();
    return { ok: true, server: { protocol: parsed.protocol, server: parsed.server, port: parsed.port, name: parsed.name }, status: tunnel.status() };
});

ipcMain.handle('tunnel:start', async () => {
    await tunnel.start();
    await applyProxyNow();
    return tunnel.status();
});

ipcMain.handle('tunnel:stop', async () => {
    tunnel.stop();
    await applyProxyNow();
    return tunnel.status();
});

ipcMain.handle('tunnel:download', async (event, onProgress) => {
    return { path: await tunnel.downloadBinary() };
});

// ---------- Quick-clip overlay IPC ----------

ipcMain.on('quick-clip:confirm', (event, text) => {
    if (quickClipOverlay && !quickClipOverlay.isDestroyed()) quickClipOverlay.hide();
    if (mainWindow) {
        if (!mainWindow.isVisible()) mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        if (text) mainWindow.webContents.send('quick-clip', text);
    }
});

ipcMain.on('quick-clip:cancel', () => {
    if (quickClipOverlay && !quickClipOverlay.isDestroyed()) quickClipOverlay.hide();
});

// Auto-updater notifications
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', () => {
    new Notification({
        title: '有可用更新',
        body: '发现新版本，将在后台下载，重启应用后安装。',
    }).show();
});

autoUpdater.on('update-downloaded', () => {
    new Notification({
        title: '更新已就绪',
        body: '新版本已下载完成，重启应用后自动安装。',
    }).show();
});
