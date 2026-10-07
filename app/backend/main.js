/**
 * BeePM desktop app: the Electron main process.
 * The window talks to it through backend/preload.cjs; the work itself is in backend.js.
 */
import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    safeStorage,
    screen,
    shell,
    Tray,
} from "electron"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { beepmPaths } from "@beepm/core/client"
import { createBackend } from "./backend.js"
import { logger } from "./logger.js"
import { isLocalPath, isWebUrl } from "./util.js"

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

// The window's console output that goes in the log (see src/lib/logForwarding.js)
const WINDOW_LOG_LEVELS = new Set(["info", "warn", "error", "debug"])

// Electron's own files (caches, local storage) go in their own folder, not in BeePM's
// %APPDATA%/beepm (which holds the packages and config)
app.setName("BeePM")
app.setPath("userData", path.join(app.getPath("appData"), "BeePM Desktop"))

// Bugs in the main process go in the log, and BeePM keeps running
process.on("uncaughtException", (error) => logger.error("Uncaught exception:", error))
process.on("unhandledRejection", (reason) => logger.error("Unhandled promise rejection:", reason))

let mainWindow = null
let backend = null
let rendererReady = false
const queued = []
let tray = null
let background = false // running in the background: see applyBackground
const toastAnswers = new Map() // update question windows (askUpdate): webContents id -> finish

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

/** Shows the window, opening it again if it was closed (BeePM stays in the tray). */
function showWindow() {
    if (!backend) return // Still starting: the window opens by itself
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow()
        return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
}

/**
 * Running in the background (a setting, on by default in the installed app): BeePM starts with
 * Windows, stays in the tray when its window closes, and offers updates when BEE2 opens.
 */
function applyBackground(settings) {
    background = settings.background
    // Only the installed app registers itself, not `electron .` from source
    if (app.isPackaged) {
        app.setLoginItemSettings({ openAtLogin: background, args: ["--background"] })
    }
    if (background) {
        if (!tray) createTray()
        backend.watcher.start()
    } else {
        tray?.destroy()
        tray = null
        backend.watcher.stop()
    }
}

function createTray() {
    tray = new Tray(path.join(here, process.platform === "win32" ? "tray.ico" : "tray.png"))
    tray.setToolTip("BeePM")
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: "Open BeePM", click: showWindow },
            { label: "Check for updates", click: checkFromTray },
            { type: "separator" },
            { label: "Quit BeePM", click: () => app.quit() },
        ]),
    )
    tray.on("click", showWindow)
}

async function checkFromTray() {
    try {
        const result = await backend.watcher.offer()
        if (result === null) balloon("Everything is up to date.")
    } catch (err) {
        logger.warn(`Checking for updates failed: ${err.message}`)
        balloon(`Couldn't check for updates: ${err.message}`)
    }
}

function balloon(content, title = "BeePM") {
    if (tray && process.platform === "win32")
        tray.displayBalloon({ iconType: "info", title, content })
}

/** The first time the window closes in the background: where BeePM went. */
async function hintTray() {
    const settings = await backend.appSettings()
    if (settings.trayHintShown) return
    balloon("It offers updates when BEE2 opens. Quit it from here.", "BeePM is still running")
    await backend.invoke("app:update-settings", { trayHintShown: true })
}

/**
 * "Update <package>?" in a small window in the bottom-right corner, on top of BEE2 without
 * taking its focus (src/components/UpdateToast.jsx, answering through "toast:answer").
 * Resolves to "update", "later" or "never"; closing it, or leaving it for a minute, is "later".
 */
function askUpdate({ name, from, to }) {
    const width = 400
    const height = 150
    const { workArea } = screen.getPrimaryDisplay()
    const toast = new BrowserWindow({
        width,
        height,
        x: Math.round(workArea.x + workArea.width - width - 16),
        y: Math.round(workArea.y + workArea.height - height - 16),
        frame: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        backgroundColor: "#262829",
        webPreferences: {
            preload: path.join(here, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    })
    toast.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    toast.webContents.on("will-navigate", (event) => event.preventDefault())
    const query = { toast: "update", name, from, to }
    const loading = isDev
        ? toast.loadURL(`${DEV_URL}/?${new URLSearchParams(query)}`)
        : toast.loadFile(path.join(app.getAppPath(), "dist", "index.html"), { query })
    loading.catch(() => {})
    toast.once("ready-to-show", () => toast.showInactive())

    const id = toast.webContents.id
    return new Promise((resolve) => {
        const timer = setTimeout(() => finish("later"), 60 * 1000)
        function finish(answer) {
            if (!toastAnswers.has(id)) return
            toastAnswers.delete(id)
            clearTimeout(timer)
            if (!toast.isDestroyed()) toast.destroy()
            resolve(answer)
        }
        toastAnswers.set(id, finish)
        toast.on("closed", () => finish("later"))
    })
}

/** Opens BEE2 again after updating (the program file it ran from). */
function openProgram(file) {
    const child = spawn(file, [], { cwd: path.dirname(file), detached: true, stdio: "ignore" })
    child.on("error", (err) => logger.warn(`Couldn't open BEE2 again: ${err.message}`))
    child.unref()
    logger.info(`Opened ${path.basename(file)} again`)
}

/**
 * beepm://focus                         brings the window to the front (the login "done" page links here)
 * beepm://publish?file=<.bee_pack path> opens Publish with that file
 */
function handleProtocolUrl(url) {
    logger.info(`Opened by a link: ${url}`)
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
    showWindow()
    if (action === "publish") {
        const file = parsed.searchParams.get("file")
        // Only .bee_pack files on this PC: any web page can open a beepm:// link
        if (file && isLocalPath(file) && /\.bee_pack$/i.test(file)) {
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

/** Whether a URL is the app's own page (the Vite dev server, or dist/index.html). */
function isAppPage(url) {
    try {
        const target = new URL(url)
        if (isDev) return target.origin === DEV_URL
        const page = pathToFileURL(path.join(app.getAppPath(), "dist", "index.html"))
        const filePath = (u) => decodeURIComponent(u.pathname).toLowerCase()
        return target.protocol === "file:" && filePath(target) === filePath(page)
    } catch {
        return false
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
    win.webContents.on("render-process-gone", (_event, details) =>
        logger.error(`The window stopped: ${details.reason} (exit code ${details.exitCode})`),
    )
    win.on("unresponsive", () => logger.warn("The window stopped responding"))
    win.on("responsive", () => logger.info("The window responds again"))

    // Links never open Electron windows or replace the app: they go to the system browser
    win.webContents.setWindowOpenHandler(({ url }) => {
        openExternal(url)
        return { action: "deny" }
    })
    win.webContents.on("will-navigate", (event, url) => {
        if (isAppPage(url)) return
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
        win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
            if (isMainFrame)
                logger.error(`The window couldn't load ${url}: ${description} (${code})`)
        })
        win.loadFile(path.join(app.getAppPath(), "dist", "index.html")).catch(() => {})
    }
    return win
}

function registerIpc() {
    for (const channel of Object.keys(backend.handlers)) {
        ipcMain.handle(channel, (_event, ...args) => backend.invoke(channel, ...args))
    }
    ipcMain.on("app:log", (event, level, text) => {
        if (event.sender !== mainWindow?.webContents) return
        if (!WINDOW_LOG_LEVELS.has(level) || typeof text !== "string") return
        logger.fromWindow("Window", level, text)
    })
    // An update question's answer (askUpdate)
    ipcMain.handle("toast:answer", (event, answer) => {
        const finish = toastAnswers.get(event.sender.id)
        if (finish && ["update", "later", "never"].includes(answer)) finish(answer)
        return { ok: true }
    })
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
    logger.initialize({
        dir: path.join(beepmPaths(process.env).root, "logs"),
        version: app.getVersion(),
        debug: isDev,
    })
    logger.info(`${process.platform} ${os.release()}, Electron ${process.versions.electron}`)
    registerProtocol()

    // Windows and Linux: a beepm:// link starts a second instance, which hands its URL over
    app.on("second-instance", (_event, argv) => {
        const url = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`))
        if (url) handleProtocolUrl(url)
        else showWindow()
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
            log: logger,
            askUpdate,
            openProgram,
            backgroundDefault: app.isPackaged,
            onSettingsChanged: applyBackground,
        })
        registerIpc()
        const settings = await backend.appSettings()
        // Started with Windows: only the tray, until BeePM is opened
        if (!(process.argv.includes("--background") && settings.background)) createWindow()
        applyBackground(settings)

        const launchUrl = process.argv.find((arg) => arg.startsWith(`${PROTOCOL}://`))
        if (launchUrl) handleProtocolUrl(launchUrl)
        backend.startup()

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow()
        })
    })

    // In the background BeePM stays in the tray; "Quit BeePM" there quits
    app.on("window-all-closed", () => {
        if (background) hintTray().catch(() => {})
        else if (process.platform !== "darwin") app.quit()
    })

    // Remove temporary files (prepared packages) before quitting, then close the log
    let disposed = false
    app.on("will-quit", (event) => {
        if (disposed) return
        disposed = true
        event.preventDefault()
        Promise.resolve(backend?.dispose())
            .finally(() =>
                // The log's last lines reach the file, unless that takes over a second
                Promise.race([logger.close(), new Promise((done) => setTimeout(done, 1000))]),
            )
            .finally(() => app.quit())
    })
}
