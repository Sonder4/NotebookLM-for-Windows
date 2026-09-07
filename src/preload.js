const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    showNotification: (title, body) => ipcRenderer.send('show-notification', { title, body }),
    getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
    setAutoLaunch: (enable) => ipcRenderer.invoke('set-auto-launch', enable),
    openExternal: (url) => ipcRenderer.send('open-external', url),

    // Window controls
    windowAction: (action) => ipcRenderer.send('window-controls', action),

    // Opacity
    setOpacity: (value) => ipcRenderer.send('set-opacity', value),
    getOpacity: () => ipcRenderer.invoke('get-opacity'),

    // Always-on-top
    setAlwaysOnTop: (value) => ipcRenderer.invoke('set-always-on-top', value),
    getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),

    // Theme
    setTheme: (value) => ipcRenderer.invoke('set-theme', value),
    onTheme: (callback) => ipcRenderer.on('theme-changed', (_, v) => callback(v)),

    // Settings
    settingsGetAll: () => ipcRenderer.invoke('settings:get-all'),
    settingsSet: (key, value) => ipcRenderer.invoke('settings:set', key, value),

    // Hotkey
    setHotkey: (accelerator) => ipcRenderer.invoke('set-hotkey', accelerator),

    // Notes export
    saveNotesMarkdown: (payload) => ipcRenderer.invoke('notes:save-markdown', payload),

    // Listeners
    onQuickClip: (callback) => ipcRenderer.on('quick-clip', (_, text) => callback(text)),
    onOpenSettings: (callback) => ipcRenderer.on('open-settings', () => callback()),

    // Agent-driven navigation & pane control (control-server -> renderer)
    onNavigate: (callback) => ipcRenderer.on('navigate-active', (_, url) => callback(url)),
    onPanesChanged: (callback) => ipcRenderer.on('panes-changed', (_, n) => callback(n)),

    // Notes export straight to a file path (agent CLI), skipping the dialog
    onExportNotesToFile: (callback) => ipcRenderer.on('export-notes-to-file', (_, p) => callback(p)),
    saveNotesFileTo: (payload) => ipcRenderer.invoke('notes:save-to-file', payload),

    // Proxy / embedded tunnel (settings UI)
    getProxyConfig: () => ipcRenderer.invoke('proxy:get-config'),
    applyProxy: () => ipcRenderer.invoke('proxy:apply'),
    checkProxy: () => ipcRenderer.invoke('proxy:check'),
    getTunnelStatus: () => ipcRenderer.invoke('tunnel:status'),
    setTunnelUri: (uri) => ipcRenderer.invoke('tunnel:set-uri', uri),
    startTunnel: () => ipcRenderer.invoke('tunnel:start'),
    stopTunnel: () => ipcRenderer.invoke('tunnel:stop'),

    // Quick-clip overlay (used only by overlay window)
    onQuickClipText: (callback) => ipcRenderer.on('quick-clip-text', (_, text) => callback(text)),
    quickClipConfirm: (text) => ipcRenderer.send('quick-clip:confirm', text),
    quickClipCancel: () => ipcRenderer.send('quick-clip:cancel'),
});
