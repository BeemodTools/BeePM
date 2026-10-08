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
import { existsSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { beepmPaths } from "@beepm/core/client"
import { createAppUpdater } from "./appUpdater.js"
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
// %APPDATA%/beepm (which holds the packages and config). BEEPM_USER_DATA puts them elsewhere:
// a test copy of BeePM that runs alongside the installed one (it's one BeePM per folder).
app.setName("BeePM")
app.setPath(
    "userData",
    process.env.BEEPM_USER_DATA || path.join(app.getPath("appData"), "BeePM Desktop"),
)
// The installer's app ID (electron-builder.js): Windows shows notifications as from BeePM
if (process.platform === "win32") app.setAppUserModelId("com.beepm.app")

// Bugs in the main process go in the log, and BeePM keeps running
process.on("uncaughtException", (error) => logger.error("Uncaught exception:", error))
process.on("unhandledRejection", (reason) => logger.error("Unhandled promise rejection:", reason))

let mainWindow = null
let backend = null
let rendererReady = false
const queued = []
let tray = null
let appUpdater = null // BeePM's own updates (appUpdater.js), in the installed app only
let background = false // running in the background: see applyBackground
// Question windows (showToast): webContents id -> { finish(answer), answers }
const toastAnswers = new Map()
let reviewWindow = null // see showReview
const contentsWindows = new Map() // "View contents" windows, by package@version (showContents)

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
    // Only the installed app registers itself, not `electron .` from source, nor a test copy
    // (BEEPM_NO_LOGIN_ITEM: it would replace the installed app's entry)
    if (app.isPackaged && !process.env.BEEPM_NO_LOGIN_ITEM) {
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

/**
 * The background's questions (updateWatcher.js), each in a corner window; closing one, or
 * leaving it, is "later":
 *   update      "Update <package>?": "update" or "never"
 *   duplicates  "Duplicate packages in BEE2": "delete" (keeps the newest) or "choose"
 *   adopt       "Use BeePM's <package>?": "use", "keep" or (several) "choose"
 *   close       "Close BEE2 to finish?": "now" ("later": once the user closes it)
 *   broken      "BEE2 couldn't load <package>" (its log says why): "remove"
 *   crashed     "BEE2 crashed" (its log says why, but names no package): "log" opens the log
 *   use-bee2    "Use this BEE2 with BeePM?" (a BEE2 from another folder): "use" or "never"
 */
function ask(question) {
    const minutes = (n) => n * 60 * 1000
    switch (question.kind) {
        case "update": {
            const { name, from, to } = question
            return showToast({ toast: "update", name, from, to }, ["update", "never"], minutes(1))
        }
        case "duplicates":
            return showToast(
                { toast: "duplicates", count: question.count },
                ["delete", "choose"],
                minutes(2),
            )
        case "adopt": {
            const several = question.packages.length > 1
            return showToast(
                {
                    toast: "adopt",
                    count: question.packages.length,
                    name: question.packages[0].name,
                },
                several ? ["use", "keep", "choose"] : ["use", "keep"],
                minutes(2),
            )
        }
        case "close":
            return showToast({ toast: "close" }, ["now"], minutes(2))
        case "broken":
            return showToast(
                { toast: "broken", name: question.name, text: question.message },
                ["remove"],
                minutes(2),
            )
        case "crashed":
            return showToast({ toast: "crashed", text: question.message }, ["log"], minutes(2))
        case "use-bee2":
            return showToast(
                {
                    toast: "use-bee2",
                    folder: question.folder,
                    switching: question.current ? "1" : "",
                },
                ["use", "never"],
                minutes(2),
            )
        default:
            return Promise.resolve("later")
    }
}

/**
 * BeePM's own updates, from its GitHub releases (installed app only; BEEPM_NO_UPDATE=1 turns
 * them off). A downloaded update asks in the corner whether to restart now.
 */
async function startAppUpdates() {
    if (!app.isPackaged || process.env.BEEPM_NO_UPDATE) return
    // Loaded once the window is open: starting BeePM doesn't wait for it
    const { default: electronUpdater } = await import("electron-updater")
    appUpdater = createAppUpdater({
        updater: electronUpdater.autoUpdater,
        log: logger,
        ask: (version) => showToast({ toast: "app-update", version }, ["restart"], 30 * 60 * 1000),
        onStatus: (status) => send("app:update-status", status),
        // Only the tray was open: BeePM comes back in the tray
        beforeRestart: () => {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) return
            try {
                writeFileSync(trayAfterUpdate(), "")
            } catch {
                // It comes back with its window
            }
        },
    })
    appUpdater.start()
}

// After "Restart to update", the installer starts BeePM again with --updated; this file says it
// was only in the tray
const trayAfterUpdate = () => path.join(app.getPath("userData"), "start-in-tray")

/** Whether BeePM is back from an update it restarted for while only in the tray (asked once). */
function backFromUpdateInTray() {
    const marker = trayAfterUpdate()
    if (!existsSync(marker)) return false
    rmSync(marker, { force: true })
    return process.argv.includes("--updated")
}

/** The window's preferences: it only talks to BeePM through preload.cjs. */
const webPreferences = () => ({
    preload: path.join(here, "preload.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
})

/** Loads BeePM's page with a query (the dev server, or dist/index.html). */
function loadPage(win, query) {
    const loading = isDev
        ? win.loadURL(`${DEV_URL}/?${new URLSearchParams(query)}`)
        : win.loadFile(path.join(app.getAppPath(), "dist", "index.html"), { query })
    loading.catch(() => {})
}

/**
 * The corner window's "Choose": a window of its own with just the choices, for the BEE2 check
 * the question came from (src/components/ReviewDialog.jsx, ReviewWindow). A newer one replaces
 * it; it closes itself once the choices are applied.
 */
function showReview(reviewId) {
    if (reviewWindow && !reviewWindow.isDestroyed()) reviewWindow.destroy()
    const win = new BrowserWindow({
        title: "BEE2's packages",
        width: 580,
        height: 620,
        minWidth: 420,
        minHeight: 360,
        show: false,
        backgroundColor: "#262829",
        webPreferences: webPreferences(),
    })
    reviewWindow = win
    win.removeMenu()
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    win.webContents.on("will-navigate", (event) => event.preventDefault())
    // The page's own title would replace this one
    win.on("page-title-updated", (event) => event.preventDefault())
    win.on("closed", () => {
        if (reviewWindow === win) reviewWindow = null
    })
    win.once("ready-to-show", () => {
        win.show()
        win.focus()
    })
    loadPage(win, { review: reviewId ?? "" })
}

/**
 * Package details' "View contents": what a version contains in a window of its own
 * (src/components/Contents.jsx, ContentsWindow). One per version: opening it again brings it up.
 */
function showContents(name, version, title) {
    const key = `${name}@${version}`
    const open = contentsWindows.get(key)
    if (open && !open.isDestroyed()) {
        if (open.isMinimized()) open.restore()
        open.focus()
        return
    }
    const win = new BrowserWindow({
        title: `${title || name} ${version}`,
        width: 760,
        height: 660,
        minWidth: 420,
        minHeight: 360,
        show: false,
        backgroundColor: "#1d1e1f",
        webPreferences: webPreferences(),
    })
    contentsWindows.set(key, win)
    win.removeMenu()
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    win.webContents.on("will-navigate", (event) => event.preventDefault())
    win.on("page-title-updated", (event) => event.preventDefault())
    win.on("closed", () => contentsWindows.delete(key))
    win.once("ready-to-show", () => win.show())
    loadPage(win, { contents: name, version, title: title ?? "" })
}

/**
 * A question in a small window in the bottom-right corner, on top of BEE2 without taking its
 * focus, with a chime so it's noticed (src/components/UpdateToast.jsx, answering through
 * "toast:answer"). Resolves to one of `answers`, or "later" when it's closed or left for
 * `timeoutMs`.
 */
function showToast(query, answers, timeoutMs) {
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
        // It chimes when it appears, which nobody clicked to start
        webPreferences: { ...webPreferences(), autoplayPolicy: "no-user-gesture-required" },
    })
    toast.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    toast.webContents.on("will-navigate", (event) => event.preventDefault())
    loadPage(toast, query)
    toast.once("ready-to-show", () => toast.showInactive())

    const id = toast.webContents.id
    return new Promise((resolve) => {
        const timer = setTimeout(() => finish("later"), timeoutMs)
        function finish(answer) {
            if (!toastAnswers.has(id)) return
            toastAnswers.delete(id)
            clearTimeout(timer)
            if (!toast.isDestroyed()) toast.destroy()
            resolve(answer)
        }
        toastAnswers.set(id, { finish, answers: ["later", ...answers] })
        toast.on("closed", () => finish("later"))
    })
}

/** Opens BEE2 (its program file): again after changing its packages, or from the window. */
function openProgram(file) {
    const child = spawn(file, [], { cwd: path.dirname(file), detached: true, stdio: "ignore" })
    child.on("error", (err) => logger.warn(`Couldn't open BEE2: ${err.message}`))
    child.unref()
    logger.info(`Opened ${path.basename(file)}`)
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
        // Shown right away, in the page's background color, rather than once the page has
        // drawn: BeePM is seen to start sooner
        backgroundColor: "#1d1e1f",
        webPreferences: webPreferences(),
    })
    mainWindow = win
    rendererReady = false

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
    // A question's answer (showToast)
    // BeePM's own updates (Settings > About): its status, after "check" or "restart" if given
    ipcMain.handle("app:update", (event, action) => {
        if (event.sender !== mainWindow?.webContents) return { ok: true, status: null }
        if (!appUpdater) return { ok: true, status: { phase: "off" } }
        if (action === "check") appUpdater.check()
        if (action === "restart" && appUpdater.status().phase === "ready") appUpdater.restart()
        return { ok: true, status: appUpdater.status() }
    })
    ipcMain.handle("toast:answer", (event, answer) => {
        const question = toastAnswers.get(event.sender.id)
        if (question?.answers.includes(answer)) question.finish(answer)
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
            ask,
            showReview,
            showContents,
            notify: (text) => balloon(text),
            trash: (file) => shell.trashItem(file),
            openProgram,
            backgroundDefault: app.isPackaged,
            onSettingsChanged: applyBackground,
        })
        registerIpc()
        const settings = await backend.appSettings()
        // Started with Windows (or by the installer, see build/installer.nsh), or back from an
        // update while only in the tray: only the tray, until BeePM is opened
        const afterUpdate = backFromUpdateInTray()
        const inTray = process.argv.includes("--background") || afterUpdate
        if (!(inTray && settings.background)) createWindow()
        applyBackground(settings)

        const launchUrl = process.argv.find((arg) => arg.startsWith(`${PROTOCOL}://`))
        if (launchUrl) handleProtocolUrl(launchUrl)
        backend.startup()
        startAppUpdates().catch((err) => logger.warn(`Couldn't look for updates: ${err.message}`))

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow()
        })
    })

    // In the background BeePM stays in the tray; "Quit BeePM" there quits
    app.on("window-all-closed", () => {
        if (!background && process.platform !== "darwin") app.quit()
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
