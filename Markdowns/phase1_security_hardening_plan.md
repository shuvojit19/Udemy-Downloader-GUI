# Phase 1: Security Hardening — Implementation Plan

**Repository:** [shuvojit19/Udemy-Downloader-GUI](https://github.com/shuvojit19/Udemy-Downloader-GUI)  
**Phase:** 1 of 4 — Security Hardening  
**Objective:** Enforce Electron security sandbox (`contextIsolation: true`, `nodeIntegration: false`)

---

## Critical Finding: Why Phase 1 Cannot Be Executed in Isolation

> [!CAUTION]
> After exhaustively auditing every file in the renderer process, I must report a critical architectural constraint: **Phase 1 (context isolation) cannot be safely implemented without simultaneously executing significant portions of Phase 2 (modular refactoring).**

### The Root Cause

The renderer process (`app/app.js`, 3,175 lines) uses Node.js APIs **pervasively** — not through a thin IPC layer, but as deeply embedded business logic on virtually every line. Setting `contextIsolation: true` and `nodeIntegration: false` would instantly break **100% of the application's functionality**.

### Exhaustive Inventory of Node.js API Usage in the Renderer

| Category | API | Usage Count | Example Locations |
|:---|:---|:---:|:---|
| **File System** | `fs.existsSync` | ~30+ | Download checks, verification, audit |
| | `fs.statSync` | ~15+ | File size validation, verification |
| | `fs.mkdirSync` | ~8 | Directory creation for courses |
| | `fs.writeFileSync` | ~10 | Save subtitles, logs, playlists |
| | `fs.appendFileSync` | ~5 | M3U8 chunk concatenation |
| | `fs.readFileSync` | ~5 | Read existing files |
| | `fs.readdirSync` | ~3 | Directory listing for verification |
| | `fs.unlinkSync` | ~3 | Delete temp/partial files |
| | `fs.createReadStream` | ~2 | VTT to SRT conversion streams |
| | `fs.createWriteStream` | ~2 | Stream pipe targets |
| | `fs.renameSync` | ~2 | File reordering (utils.js) |
| | `fs.access` | 1 | Download path permission check |
| **Path** | `path.join`, `path.resolve` | ~20+ | All file path construction |
| **Electron IPC** | `ipcRenderer.on` | 1 | `saveDownloads` channel |
| | `ipcRenderer.send` | 1 | `quitApp` channel |
| **Electron Remote** | `remote.session` | 3 | Auth token interception |
| | `remote.dialog` | 2 | Folder picker, error dialog |
| | `remote.BrowserWindow` | 1 | Login popup window |
| **Electron Shell** | `shell.openPath` | 2 | Open download folder |
| | `shell.openExternal` | 6 | Open URLs in browser |
| **Process** | `process.noDeprecation` | 1 | Suppress deprecation warnings |
| | `process.on('uncaughtException')` | 1 | Global error handler |
| | `process.on('unhandledRejection')` | 1 | Global rejection handler |
| **Node Globals** | `__dirname` | 1 | Notification icon path |
| | `require()` | 11 | All module imports |
| **HTTP/Network** | `axios` | ~20+ | API calls throughout |
| | `https` | ~5 | Direct HTTPS requests |
| **Third-Party Node** | `mt-files-downloader` | ~10 | Multi-threaded file downloads |
| | `sanitize-filename` | ~15 | Filename sanitization |
| | `node-vtt-to-srt` | ~3 | Subtitle format conversion |
| | `cookie` | 1 | Auth cookie parsing |
| | `dialogs` | ~5 | Native alert/prompt dialogs |
| | `electron-settings` | ~30+ | All persistent storage (via Settings) |

### What This Means

If we simply flip `nodeIntegration: false` and `contextIsolation: true`:

1. **Every `require()` call fails** — jQuery, axios, fs, path, all services → entire app is blank
2. **Every `fs.*` call fails** — no downloads, no verification, no file checks
3. **Every `shell.*` call fails** — no folder opening, no URL launching
4. **`remote` module is gone** — no login popup, no folder picker dialog, no error dialogs
5. **`electron-settings` fails** — all persistent state (history, preferences) is lost
6. **`mt-files-downloader` fails** — the entire download engine stops working

> [!IMPORTANT]
> Creating a `contextBridge` IPC bridge for all of these (~200+ distinct call sites) would require wrapping the **entire application's business logic** into main-process IPC handlers. That IS Phase 2 — not Phase 1.

---

## Revised Strategy: Incremental Security Hardening

Instead of a "big-bang" context isolation flip that breaks everything, I propose an **incremental approach** that delivers real security improvements while keeping the app functional:

### Step 1: Eliminate `remote` Module (Safe, Immediate)

The `remote` module is the most dangerous API — it gives the renderer synchronous access to main-process objects. We can eliminate it by moving its 3 usages to IPC handlers.

| Current Usage | Location | Replacement |
|:---|:---|:---|
| `remote.dialog.showOpenDialogSync()` | `app.js:275` | IPC channel `show-open-dialog` → main process handler |
| `remote.dialog.showErrorBox()` | `app.js:3151` | IPC channel `show-error-box` → main process handler |
| `remote.BrowserWindow` + `remote.session` | `app.js:370-403` | IPC channel `open-login-window` → main process handles entire login flow |

#### [MODIFY] [main.js](file:///C:/Users/smcloudtest007/Downloads/Udemy-Downloader-GUI/main.js)

Add IPC handlers for dialog and login window operations:

```diff
+const { app, BrowserWindow, Menu, ipcMain, screen, shell, dialog, session } = require("electron");

+// ═══════════════════════════════════════════════════════════════════
+// IPC HANDLERS — Replace `remote` module usage from renderer process
+// ═══════════════════════════════════════════════════════════════════

+// Handle folder picker dialog (replaces remote.dialog.showOpenDialogSync)
+ipcMain.handle("show-open-dialog", async (event, options) => {
+    const win = BrowserWindow.fromWebContents(event.sender);
+    const result = await dialog.showOpenDialog(win, options);
+    return result.filePaths;
+});

+// Handle error dialog (replaces remote.dialog.showErrorBox)
+ipcMain.on("show-error-box", (event, { title, message }) => {
+    dialog.showErrorBox(title, message);
+});

+// Handle Udemy login window creation (replaces remote.BrowserWindow + remote.session)
+ipcMain.handle("open-login-window", async (event, { subdomain }) => {
+    const win = BrowserWindow.fromWebContents(event.sender);
+    const cookie = require("cookie");
+    
+    return new Promise((resolve, reject) => {
+        const loginWindow = new BrowserWindow({
+            width: 800,
+            height: 600,
+            parent: win,
+            modal: true,
+        });
+        
+        session.defaultSession.webRequest.onBeforeSendHeaders(
+            { urls: ["*://*.udemy.com/*"] },
+            (request, callback) => {
+                const token = request.requestHeaders.Authorization
+                    ? request.requestHeaders.Authorization.split(" ")[1]
+                    : cookie.parse(request.requestHeaders.Cookie || "").access_token;
+                
+                if (token) {
+                    loginWindow.destroy();
+                    session.defaultSession.clearStorageData();
+                    session.defaultSession.webRequest.onBeforeSendHeaders(
+                        { urls: ["*://*.udemy.com/*"] },
+                        (req, cb) => cb({ requestHeaders: req.requestHeaders })
+                    );
+                    resolve({ token, subdomain: new URL(request.url).hostname.split(".")[0] });
+                }
+                callback({ requestHeaders: request.requestHeaders });
+            }
+        );
+        
+        const loginUrl = subdomain && subdomain !== "www"
+            ? `https://${subdomain}.udemy.com`
+            : "https://www.udemy.com/join/login-popup";
+        loginWindow.loadURL(loginUrl);
+        
+        loginWindow.on("closed", () => {
+            resolve(null); // User closed without logging in
+        });
+    });
+});
```

#### [MODIFY] [main.js](file:///C:/Users/smcloudtest007/Downloads/Udemy-Downloader-GUI/main.js) — Disable `enableRemoteModule`

```diff
 webPreferences: {
     nodeIntegration: true,
-    enableRemoteModule: true,
+    enableRemoteModule: false, // SECURITY: Remote module disabled — use IPC instead
     contextIsolation: false,
     preload: "./preload.js"
 }
```

#### [MODIFY] [app/app.js](file:///C:/Users/smcloudtest007/Downloads/Udemy-Downloader-GUI/app/app.js) — Remove `remote` imports and usage

```diff
-const { shell, remote, ipcRenderer } = require("electron");
-const { dialog, BrowserWindow } = remote;
+const { shell, ipcRenderer } = require("electron");
```

Replace `selectDownloadPath()`:
```diff
-function selectDownloadPath() {
-    const path = dialog.showOpenDialogSync({
-        properties: ["openDirectory"],
-    });
+async function selectDownloadPath() {
+    const path = await ipcRenderer.invoke("show-open-dialog", {
+        properties: ["openDirectory"],
+    });
```

Replace `showAlertError()`:
```diff
 function showAlertError(message, title = "") {
     title = title ? `.:: ${title} ::.` : ".:: Error ::.";
-    dialog.showErrorBox(title, message);
+    ipcRenderer.send("show-error-box", { title, message });
 }
```

Replace `loginWithUdemy()` — move BrowserWindow/session logic to main:
```diff
-function loginWithUdemy() {
-    const session = remote.session;
-    let udemyLoginWindow = new BrowserWindow({ ... });
-    session.defaultSession.webRequest.onBeforeSendHeaders(...);
-    ...
-}
+async function loginWithUdemy() {
+    const subdomain = ui.$subdomainField.val() || "www";
+    Settings.subDomain = subdomain;
+    
+    const result = await ipcRenderer.invoke("open-login-window", { subdomain });
+    if (result) {
+        Settings.accessToken = result.token;
+        Settings.subDomain = result.subdomain;
+        checkLogin();
+    }
+}
```

---

### Step 2: Upgrade Electron Version

> [!WARNING]
> Electron `11.5.0` (current) was released in **2021** and has known CVEs. The `remote` module was fully deprecated in Electron 14+ and removed in Electron 22+.

#### [MODIFY] [package.json](file:///C:/Users/smcloudtest007/Downloads/Udemy-Downloader-GUI/package.json)

```diff
 "devDependencies": {
-    "electron": "11.5.0",
+    "electron": "^28.3.3",
     "electron-builder": "^25.1.8",
```

> [!IMPORTANT]
> **Why Electron 28 and not the absolute latest?**
> - Electron 28 is the last major version that still supports `nodeIntegration: true` with full backward compatibility.
> - It allows our incremental migration: remove `remote` first (Step 1), then tackle `nodeIntegration` later (Phase 2).
> - Electron 29+ has stricter sandboxing defaults that would require Phase 2 to be complete.
> - `electron-settings@3.2.0` (which uses synchronous file access) is compatible with Electron 28.

After upgrading, we also need:
```diff
 "dependencies": {
-    "@sentry/electron": "4.24.0",
+    "@sentry/electron": "^4.24.0",
```

---

### Step 3: Secure the Preload Script

Even with `nodeIntegration: true` still enabled, we should prepare a proper preload bridge for future Phase 2 migration. The new `preload.js` exposes a clean API surface:

#### [MODIFY] [preload.js](file:///C:/Users/smcloudtest007/Downloads/Udemy-Downloader-GUI/preload.js)

```javascript
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
```

---

### Step 4: Add `.gitignore` Entry for Markdowns

#### [MODIFY] [.gitignore](file:///C:/Users/smcloudtest007/Downloads/Udemy-Downloader-GUI/.gitignore)

```diff
 node_modules
 settings.json
+Markdowns/
```

---

## Verification Plan

### Manual Verification
After implementing Steps 1–3:
1. `npm start` → App should launch without errors
2. **Login with Access Token** → Should work (no `remote` usage)
3. **Login with Udemy (browser popup)** → Should open login window via IPC, capture token, and return
4. **Settings → Change download path** → Folder picker should work via IPC `show-open-dialog`
5. **Download a course** → Full download pipeline should work (fs, axios, mt-files-downloader all still available via nodeIntegration)
6. **Verify & DRM Check** → Should display status tags correctly
7. **Close app** → Should save downloads and quit cleanly

### What Changes, What Doesn't

| Feature | Before | After Step 1 |
|:---|:---|:---|
| `remote` module | ✅ Used | ❌ **Removed** — replaced with IPC |
| `nodeIntegration` | `true` | `true` (unchanged — needed for Phase 2) |
| `contextIsolation` | `false` | `false` (unchanged — needed for Phase 2) |
| `enableRemoteModule` | `true` | `false` ✅ **Secured** |
| Login popup | Renderer creates BrowserWindow | Main process creates via IPC ✅ |
| Folder picker | `remote.dialog.showOpenDialogSync` | `ipcRenderer.invoke` ✅ |
| Error dialogs | `remote.dialog.showErrorBox` | `ipcRenderer.send` ✅ |
| Downloads/Verification | Works via `fs`, `axios` | Unchanged — works identically |

---

## Open Questions

> [!IMPORTANT]
> **Question 1:** Do you want me to proceed with this incremental approach (remove `remote` first, keep `nodeIntegration` temporarily), or would you prefer I attempt the full big-bang context isolation that requires rewriting all 200+ Node.js call sites simultaneously?

> [!IMPORTANT]
> **Question 2:** The Electron upgrade from 11.5.0 → 28.x is a major version jump. Should I run `npm install` after the upgrade to verify dependency compatibility, or do you want to handle that manually?

---

## Summary

| Step | Change | Security Impact |
|:---|:---|:---|
| **Step 1** | Remove `remote` module, replace with IPC handlers | 🟢 **High** — eliminates synchronous main-process access from renderer |
| **Step 2** | Upgrade Electron 11 → 28 | 🟢 **High** — patches known CVEs, modernizes runtime |
| **Step 3** | Prepare preload.js bridge structure | 🟡 **Medium** — foundation for future full isolation |
| **Step 4** | Gitignore Markdowns folder | 🔵 **Low** — housekeeping |
