/**
 * BeePM's own updates (backend/appUpdater.js): downloaded in the background, then asked about;
 * "Later" leaves the install for when BeePM quits. electron-updater is a stand-in here.
 */
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import { createAppUpdater } from "../backend/appUpdater.js"

const quiet = { info() {}, warn() {} }
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** electron-updater's autoUpdater, as far as BeePM uses it. */
function fakeUpdater() {
    const updater = new EventEmitter()
    updater.looks = 0
    updater.installed = null
    updater.checkForUpdates = async () => {
        updater.looks++
    }
    updater.quitAndInstall = (silent, runAfter) => {
        updater.installed = { silent, runAfter }
    }
    return updater
}

function setup(answer = "later") {
    const updater = fakeUpdater()
    const seen = { asked: [], phases: [] }
    const appUpdater = createAppUpdater({
        updater,
        log: quiet,
        ask: async (version) => {
            seen.asked.push(version)
            return seen.answer ?? answer
        },
        onStatus: (status) => seen.phases.push(status.phase),
    })
    return { updater, appUpdater, seen }
}

test("a new BeePM is downloaded quietly, then asked about; Restart installs it now", async () => {
    const { updater, appUpdater, seen } = setup()
    assert.equal(updater.autoDownload, true)
    assert.equal(updater.autoInstallOnAppQuit, true) // "Later": installed when BeePM quits

    await appUpdater.check()
    assert.equal(updater.looks, 1)
    updater.emit("checking-for-update")
    updater.emit("update-available", { version: "1.0.2" })
    updater.emit("download-progress", { percent: 41.6 })
    assert.deepEqual(appUpdater.status(), { phase: "downloading", version: "1.0.2", percent: 42 })

    updater.emit("update-downloaded", { version: "1.0.2" })
    await settle()
    assert.deepEqual(seen.asked, ["1.0.2"])
    assert.equal(updater.installed, null)

    // Asked again at the next look; Restart installs it silently and starts BeePM again
    seen.answer = "restart"
    updater.emit("update-downloaded", { version: "1.0.2" })
    await settle()
    assert.deepEqual(updater.installed, { silent: true, runAfter: true })
    assert.deepEqual(seen.phases, ["checking", "downloading", "downloading", "ready", "ready"])
})

test("nothing new, or no way to look: only the status says so", async () => {
    const { updater, appUpdater, seen } = setup()
    updater.emit("update-not-available", { version: "1.0.1" })
    assert.deepEqual(appUpdater.status(), { phase: "current" })
    updater.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"))
    assert.deepEqual(appUpdater.status(), {
        phase: "error",
        error: "net::ERR_INTERNET_DISCONNECTED",
    })
    assert.deepEqual(seen.asked, [])
})
