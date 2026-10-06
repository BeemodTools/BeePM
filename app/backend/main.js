/**
 * BeePM desktop app: the Electron main process.
 * The window talks to it through backend/preload.cjs; the work itself is in backend.js.
 */
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createBackend } from "./backend.js"
import { isWebUrl } from "./util.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const PROTOCOL = "beepm"
const DEV_URL = "http://localhost:5167"
const isDev = !app.isPackaged

// Events that wait for the window if it isn't listening yet (progress events are just dropped)
const QUEUED_EVENTS = new Set([
    "app:protocol",
    "app:notice",
    "auth:changed",
    "auth:login-result",
    "packages:changed",
])

// Electron's own files (caches, local storage) go in their own folder, not in BeePM's
// %APPDATA%/beepm (which holds the packages and config)
app.setName("BeePM")
app.setPath("userData", path.join(app.getPath("appData"), "BeePM Desktop"))

let mainWindow = null
let backend = null
let rendererReady = false
const queued = []

function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
        mainWindow.webContents.send(channel, payload)
    } else if (QUEUED_EVENTS.has(channel) && queued.length < 50) {
        queued.push([channel, payload])
    }
}

function openExternal(url) {
    if (isWebUrl(url)) shell.openExternal(url).catch(() => {})
}

function focusWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
}

/**
 * beepm://focus                         brings the window to the front (the login "done" page links here)
 * beepm://publish?file=<.bee_pack path> opens Publish with that file
 */
function handleProtocolUrl(url) {
    let parsed
    try {
        parsed = new URL(url)
    } catch {
        return
    }
    if (parsed.protocol !== `${PROTOCOL}:`) return
    const action = (parsed.hostname || parsed.pathname.replace(/^\/+/, ""))
        .replace(/\/+$/, "")
        .toLowerCase()
    focusWindow()
    if (action === "publish") {
        const file = parsed.searchParams.get("file")
        // Only .bee_pack files: any web page can open a beepm:// link
        if (file && path.isAbsolute(file) && /\.bee_pack$/i.test(file)) {
            send("app:protocol", { action: "publish", file })
        }
    }
}

function registerProtocol() {
    // For tests and previews: leave the system's beepm:// handler alone
    if (process.env.BEEPM_NO_PROTOCOL) return
    if (process.defaultApp) {
        // Running from source (`electron .`): register Electron plus this app's folder
        if (process.argv.length >= 2) {
            app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
                path.resolve(process.argv[1]),
            ])
        }
    } else {
        app.setAsDefaultProtocolClient(PROTOCOL)
    }
}

function createWindow() {
    const win = new BrowserWindow({
        title: "BeePM",
        width: 1100,
        height: 850,
        minWidth: 800,
        minHeight: 600,
        show: false,
        backgroundColor: "#1d1e1f",
        webPreferences: {
            preload: path.join(here, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    })
    mainWindow = win
    rendererReady = false

    win.once("ready-to-show", () => win.show())
    // Don't stay invisible if the first load fails
    setTimeout(() => !win.isDestroyed() && !win.isVisible() && win.show(), 5000)
    win.on("closed", () => {
        if (mainWindow === win) mainWindow = null
        rendererReady = false
    })
    win.webContents.on("did-start-loading", () => {
        rendererReady = false
    })

    // Links never open Electron windows or replace the app: they go to the system browser
    win.webContents.setWindowOpenHandler(({ url }) => {
        openExternal(url)
        return { action: "deny" }
    })
    win.webContents.on("will-navigate", (event, url) => {
        if (url.startsWith(isDev ? DEV_URL : "file://")) return
        event.preventDefault()
        openExternal(url)
    })

    if (isDev) {
        // `npm run dev` starts Vite and Electron together: retry until Vite is up
        let attempts = 0
        win.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
            if (!isMainFrame || code === -3 || attempts++ >= 40) return
            setTimeout(() => !win.isDestroyed() && win.loadURL(DEV_URL).catch(() => {}), 500)
        })
        win.loadURL(DEV_URL).catch(() => {})
    } else {
        win.loadFile(path.join(app.getAppPath(), "dist", "index.html")).catch(() => {})
    }
    return win
}

function registerIpc() {
    for (const channel of Object.keys(backend.handlers)) {
        ipcMain.handle(channel, (_event, ...args) => backend.invoke(channel, ...args))
    }
    // The window calls this once it listens for events; anything that arrived earlier is sent now
    ipcMain.handle("app:ready", (event) => {
        if (event.sender !== mainWindow?.webContents) return { ok: true }
        rendererReady = true
        for (const [channel, payload] of queued.splice(0)) event.sender.send(channel, payload)
        return { ok: true }
    })
}

if (!app.requestSingleInstanceLock()) {
    app.quit()
} else {
    registerProtocol()

    // Windows and Linux: a beepm:// link starts a second instance, which hands its URL over
    app.on("second-instance", (_event, argv) => {
        const url = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`))
        if (url) handleProtocolUrl(url)
        else focusWindow()
    })
    // macOS
    app.on("open-url", (event, url) => {
        event.preventDefault()
        handleProtocolUrl(url)
    })

    app.whenReady().then(async () => {
        backend = await createBackend({
            env: process.env,
            appVersion: app.getVersion(),
            safeStorage,
            openExternal: (url) => shell.openExternal(url),
            openPath: (dir) => shell.openPath(dir),
            showOpenDialog: (options) =>
                mainWindow
                    ? dialog.showOpenDialog(mainWindow, options)
                    : dialog.showOpenDialog(options),
            send,
        })
        registerIpc()
        createWindow()

        const launchUrl = process.argv.find((arg) => arg.startsWith(`${PROTOCOL}://`))
        if (launchUrl) handleProtocolUrl(launchUrl)
        backend.startup()

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow()
        })
    })

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") app.quit()
    })

    // Remove temporary files (prepared packages) before quitting
    let disposed = false
    app.on("will-quit", (event) => {
        if (disposed || !backend) return
        disposed = true
        event.preventDefault()
        backend.dispose().finally(() => app.quit())
    })
}
