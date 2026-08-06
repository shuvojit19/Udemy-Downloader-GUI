process.noDeprecation = true;

// PHASE 1: Added dialog and session imports — these were previously accessed
// via the deprecated `remote` module from the renderer process.
const { app, BrowserWindow, Menu, ipcMain, screen, shell, dialog, session } = require("electron");
const { join } = require("path");

require("./environments.js");

const { version: appVersion, vars } = require("./package.json");

// const isDebug = !app.isPackaged;
const isDebug = process.argv.indexOf("--developer") != -1;

if (isDebug) {
    console.log("Debug mode enabled");
    process.env.DEBUG_MODE = true;
    require('electron-reload')(__dirname, {
        electron: join(__dirname, 'node_modules', '.bin', 'electron'),
        hardResetMethod: 'exit'
    });
}

if (app.isPackaged) {
    process.env.IS_PACKAGE = true;

    const Sentry = require('@sentry/electron');
    Sentry.init({ dsn: process.env.SENTRY_DSN });
}
else {
    process.env.SENTRY_DSN = "" //não logar em modo desenvolvedor
}

let downloadsSaved = false;

function createWindow() {
    const size = screen.getPrimaryDisplay().workAreaSize
    // Create the browser window.
    let win = new BrowserWindow({
        title: `Udeler | Udemy Course Downloader - v${appVersion} ${process.env.SENTRY_DSN == undefined ? "" : " 🕘"}`,
        minWidth: 650,
        minHeight: 550,
        width: 650,
        height: size.height - 150,
        icon: "./app/assets/images/build/icon.png",
        resizable: true,
        maximizable: true,
        webPreferences: {
            nodeIntegration: true,
            enableRemoteModule: false, // PHASE 1: Disabled — replaced with IPC handlers below
            contextIsolation: false,   // TODO Phase 2: Enable once all Node APIs are bridged
            preload: "./preload.js"
        }
    });

    win.loadFile("app/index.html");
    // win.webContents.on("did-finish-load", () => {
    //   // console.log("did-finish-load");
    //   win.setTitle(`Udeler | Udemy Course Downloader - v${appVersion}`);
    // });

    // Open the DevTools.
    if (isDebug) {
        win.openDevTools(); //{ mode: 'detach' });
        win.maximize();
    }

    // win.webContents.on('did-start-loading', (e) => {
    //   saveOnClose(e);
    // });

    win.on("close", event => {
        saveOnClose(event);
    });

    // Emitted when the window is closed.
    win.on("closed", () => {
        // Dereference the window object, usually you would store windows
        // in an array if your app supports multi windows, this is the time
        // when you should delete the corresponding element.
        win = null;
    });

    const template = [
        {
            label: app.name,
            submenu: [
                // { role: "about" },
                // { type: "separator" },
                { role: "quit" }
            ]
        },
        {
            label: "View",
            submenu: [
                // { role: "reload" },
                { role: "forcereload" },
                // {
                //   label: 'Refresh',
                //   click: async () => {
                //     saveOnClose(null);
                //   }
                // },
                { type: "separator" },
                { role: "resetZoom" },
                { role: "zoomin" },
                { role: "zoomout" },
                { type: "separator" },
                { role: "togglefullscreen" }
            ]
        },
        {
            label: 'GitHub Repo',
            submenu: [
                {
                    label: 'This Version',
                    click: () => {
                        shell.openExternal('https://github.com/heliomarpm/udemy-downloader-gui/releases')
                    }
                },
                { type: "separator" },
                {
                    label: 'Original (Archived)',
                    click: () => {
                        shell.openExternal('https://github.com/FaisalUmair/udemy-downloader-gui/releases')
                    }
                }
            ]
        },
        {
            label: 'Donate',
            click: () => {
                shell.openExternal(urlDonateWithMsg(vars.urlDonate))
            }
        }
    ];

    //if (process.platform === "darwin") {
    // template.unshift({
    //   label: app.name,
    //   submenu: [
    //     { role: "about" },
    //     { type: "separator" },
    //     { role: "services", submenu: [] },
    //     { type: "separator" },
    //     { role: "hide" },
    //     { role: "hideothers" },
    //     { role: "unhide" },
    //     { type: "separator" },
    //     { role: "quit" }
    //   ]
    // });

    // template[1].submenu.push(
    //   { type: "separator" },
    //   {
    //     label: "Speech",
    //     submenu: [{ role: "startspeaking" }, { role: "stopspeaking" }]
    //   }
    // );
    //}
    if (!isDebug) {
        Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    }

    function saveOnClose(event = null) {
        if (!downloadsSaved) {
            downloadsSaved = true;
            if (event != null) { event.preventDefault(); }

            win.webContents.send("saveDownloads");
            console.log("saveOnClose", downloadsSaved)
        }
    }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
// app.on("ready", createWindow);

// app.on("activate", () => {
//   // On macOS it's common to re-create a window in the app when the
//   // dock icon is clicked and there are no other windows open.
//   if (win === null) {
//     createWindow();
//   }
// });

app.whenReady().then(() => {
    createWindow()

    app.on('activate', () => {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
})

// Quit when all windows are closed.
app.on("window-all-closed", () => {
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.on("quitApp", function () {
    app.quit();
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1: IPC HANDLERS — Replacements for the deprecated `remote` module
//
// Previously, the renderer process used `remote.dialog`, `remote.BrowserWindow`,
// and `remote.session` to directly access main-process APIs. This is a critical
// security vulnerability because it gives the renderer synchronous, unrestricted
// access to the entire main process.
//
// These IPC handlers provide the same functionality through a controlled,
// asynchronous message-passing interface.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * IPC Handler: Show native OS folder picker dialog.
 * Replaces: remote.dialog.showOpenDialogSync() in app.js selectDownloadPath()
 * Renderer calls: ipcRenderer.invoke("show-open-dialog", { properties: ["openDirectory"] })
 * Returns: Array of selected file paths (or empty array if cancelled)
 */
ipcMain.handle("show-open-dialog", async (event, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, options);
    return result.filePaths;
});

/**
 * IPC Listener: Show native OS error dialog box.
 * Replaces: remote.dialog.showErrorBox() in app.js showAlertError()
 * Renderer calls: ipcRenderer.send("show-error-box", { title, message })
 * Note: Uses .on() not .handle() because no return value is needed.
 */
ipcMain.on("show-error-box", (_event, { title, message }) => {
    dialog.showErrorBox(title, message);
});

/**
 * IPC Handler: Open Udemy login popup window and capture auth token.
 * Replaces: remote.BrowserWindow + remote.session in app.js loginWithUdemy()
 *
 * This handler performs the entire login flow in the main process:
 * 1. Creates a modal BrowserWindow pointing to Udemy's login page
 * 2. Intercepts all HTTP requests to *.udemy.com via session.webRequest
 * 3. Extracts the access token from the Authorization header or cookie
 * 4. Destroys the login window and clears session storage
 * 5. Returns { token, subdomain } to the renderer process
 *
 * If the user closes the window without logging in, returns null.
 *
 * Renderer calls: ipcRenderer.invoke("open-login-window", { subdomain })
 * Returns: { token: string, subdomain: string } | null
 */
ipcMain.handle("open-login-window", async (event, { subdomain }) => {
    const cookie = require("cookie");
    const parentWin = BrowserWindow.fromWebContents(event.sender);
    const parentSize = parentWin.getSize();

    return new Promise((resolve) => {
        const loginWindow = new BrowserWindow({
            width: parentSize[0] - 100,
            height: parentSize[1] - 100,
            parent: parentWin,
            modal: true,
        });

        // Intercept all requests to udemy.com to capture the auth token
        session.defaultSession.webRequest.onBeforeSendHeaders(
            { urls: ["*://*.udemy.com/*"] },
            (request, callback) => {
                // Token can be in the Authorization header or in a cookie
                const token = request.requestHeaders.Authorization
                    ? request.requestHeaders.Authorization.split(" ")[1]
                    : cookie.parse(request.requestHeaders.Cookie || "").access_token;

                if (token) {
                    const detectedSubdomain = new URL(request.url).hostname.split(".")[0];

                    // Clean up: destroy window, clear storage, reset interceptor
                    loginWindow.destroy();
                    session.defaultSession.clearStorageData();
                    session.defaultSession.webRequest.onBeforeSendHeaders(
                        { urls: ["*://*.udemy.com/*"] },
                        (req, cb) => cb({ requestHeaders: req.requestHeaders })
                    );

                    resolve({ token, subdomain: detectedSubdomain });
                }
                callback({ requestHeaders: request.requestHeaders });
            }
        );

        // Load the appropriate Udemy login URL
        const loginUrl = subdomain && subdomain !== "www"
            ? `https://${subdomain}.udemy.com`
            : "https://www.udemy.com/join/login-popup";
        loginWindow.loadURL(loginUrl);

        // Handle user closing the window without logging in
        loginWindow.on("closed", () => {
            resolve(null);
        });
    });
});


function urlDonateWithMsg(baseUrl) {
    return `${baseUrl}&item_name=${("Udeler is free and without any ads. If you appreciate that, please consider donating to the Developer.").replace(" ", "+")}`
}