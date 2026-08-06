/**
 * Preload Script — Electron Security Bridge
 * 
 * PURPOSE: This file runs in a privileged context before the renderer page loads.
 * Currently, with nodeIntegration still enabled, this serves as preparation for
 * the future Phase 2 migration to full context isolation.
 * 
 * When we complete Phase 2 and set contextIsolation: true + nodeIntegration: false,
 * this bridge will be the ONLY way the renderer can access Node/Electron APIs.
 */

const { ipcRenderer } = require("electron");

// ─── IPC Bridge for Main Process Communication ───
// These handlers replace the deprecated `remote` module usage.
// The renderer calls these via ipcRenderer.invoke() / ipcRenderer.send().

// Forward the saveDownloads event from main process to renderer
ipcRenderer.on("saveDownloads", () => {
    // This event is forwarded to the renderer's own listener in app.js
    // No action needed here — app.js listens directly via ipcRenderer.on
});

/**
 * FUTURE PHASE 2 BRIDGE (currently commented out):
 * 
 * When contextIsolation is enabled, uncomment this block to expose
 * a safe, minimal API surface to the renderer via window.electronAPI:
 * 
 * const { contextBridge } = require("electron");
 * 
 * contextBridge.exposeInMainWorld("electronAPI", {
 *     // IPC Communication
 *     onSaveDownloads: (callback) => ipcRenderer.on("saveDownloads", callback),
 *     quitApp: () => ipcRenderer.send("quitApp"),
 *     
 *     // Dialog Operations (replaces remote.dialog)
 *     showOpenDialog: (options) => ipcRenderer.invoke("show-open-dialog", options),
 *     showErrorBox: (title, message) => ipcRenderer.send("show-error-box", { title, message }),
 *     
 *     // Login Operations (replaces remote.BrowserWindow + remote.session)
 *     openLoginWindow: (options) => ipcRenderer.invoke("open-login-window", options),
 *     
 *     // Shell Operations (replaces require("electron").shell)
 *     openPath: (path) => ipcRenderer.invoke("shell-open-path", path),
 *     openExternal: (url) => ipcRenderer.invoke("shell-open-external", url),
 * });
 */