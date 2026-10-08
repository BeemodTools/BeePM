/**
 * BeePM in the background (backend/updateWatcher.js): when BEE2 opens it asks about each
 * update; if BEE2 is open, it asks before closing it, and otherwise waits for the user to close
 * it. BEE2, the questions and the installs are stand-ins here.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { createUpdateWatcher } from "../backend/updateWatcher.js"

const quiet = { info() {}, warn() {} }
const BEE2_EXE = "C:\\BEE2\\BEE2.exe"

/**
 * A watcher with stand-ins. `answers` are what the user picks, by package; `close` is the
 * answer to "Close BEE2 to update?". BEE2 closes when asked, unless `bee2.stays` (the user
 * cancels its prompt) or `bee2.busy` (a dialog is open in it, so it can't be asked).
 */
function setup({ updates, answers = {}, close = "now", running = false }) {
    const seen = {
        asked: [],
        askedClose: [],
        ignored: [],
        updated: [],
        closed: 0,
        opened: [],
        notes: [],
    }
    const bee2 = { running, stays: false, busy: false }
    const watcher = createUpdateWatcher(
        {
            log: quiet,
            sleep: async () => {},
            isBee2Running: async () => bee2.running,
            findBee2: async () => BEE2_EXE,
            askBee2ToClose: async () => {
                if (!bee2.running || bee2.busy) return false
                if (!bee2.stays) {
                    bee2.running = false
                    seen.closed++
                }
                return true
            },
            openBee2: (file) => {
                seen.opened.push(file)
                bee2.running = true
            },
            findUpdates: async () => updates.filter((u) => !seen.updated.includes(u.name)),
            ask: async (question) => {
                seen.asked.push(question)
                return answers[question.name] ?? "later"
            },
            askClose: async (names) => {
                seen.askedClose.push(names)
                return typeof close === "function" ? close() : close
            },
            ignore: async (name) => {
                seen.ignored.push(name)
            },
            notify: (text) => seen.notes.push(text),
            update: async (names) => {
                assert.equal(bee2.running, false, "updating while BEE2 is open")
                seen.updated.push(...names)
            },
        },
        { graceMs: 0 },
    )
    return { watcher, seen, bee2 }
}

const updates = [
    { name: "@a/items", from: "1.0.0", to: "1.1.0" },
    { name: "@b/sounds", from: "2.0.0", to: "2.1.0" },
    { name: "@c/style", from: "0.9.0", to: "1.0.0" },
]

test("when BEE2 opens: asks about each update, then asks to close BEE2 and opens it again", async () => {
    const { watcher, seen, bee2 } = setup({
        updates,
        answers: { "@a/items": "update", "@b/sounds": "never" },
    })
    await watcher.check() // BEE2 isn't open: nothing happens
    assert.equal(seen.asked.length, 0)

    bee2.running = true
    await watcher.check()
    assert.deepEqual(
        seen.asked.map((q) => q.name),
        ["@a/items", "@b/sounds", "@c/style"],
    )
    assert.deepEqual(seen.ignored, ["@b/sounds"])
    assert.deepEqual(seen.askedClose, [["@a/items"]])
    assert.equal(seen.closed, 1)
    assert.deepEqual(seen.updated, ["@a/items"])
    assert.deepEqual(seen.opened, [BEE2_EXE])
    assert.deepEqual(seen.notes, [])

    // BEE2 opened again by the update: not asked again; it isn't asked while it stays open
    await watcher.check()
    await watcher.check()
    assert.equal(seen.asked.length, 3)

    // The next time the user opens BEE2, what's left is asked about again
    bee2.running = false
    await watcher.check()
    bee2.running = true
    await watcher.check()
    assert.deepEqual(
        seen.asked.slice(3).map((q) => q.name),
        ["@b/sounds", "@c/style"], // the stand-in doesn't filter ignored ones; the backend does
    )
})

test('"When I close it": BEE2 stays open, and the update installs once the user closes it', async () => {
    const { watcher, seen, bee2 } = setup({
        updates,
        answers: { "@a/items": "update" },
        close: "later",
    })
    bee2.running = true
    await watcher.check()
    assert.deepEqual(seen.askedClose, [["@a/items"]])
    assert.equal(seen.closed, 0)
    assert.deepEqual(seen.updated, [])

    await watcher.check() // Still open
    assert.deepEqual(seen.updated, [])

    bee2.running = false // The user closes it
    await watcher.check()
    assert.deepEqual(seen.updated, ["@a/items"])
    assert.deepEqual(seen.opened, []) // and it's left closed
    assert.deepEqual(seen.notes, [])
})

test("BEE2 that doesn't close isn't forced: the update waits until the user closes it", async () => {
    for (const why of ["stays", "busy"]) {
        const { watcher, seen, bee2 } = setup({ updates, answers: { "@c/style": "update" } })
        bee2.running = true
        bee2[why] = true
        await watcher.check()
        assert.equal(seen.closed, 0, why)
        assert.deepEqual(seen.updated, [], why)
        assert.equal(seen.notes.length, 1, why) // "BEE2 didn't close. BeePM updates once ..."

        bee2.running = false
        await watcher.check()
        assert.deepEqual(seen.updated, ["@c/style"], why)
        assert.deepEqual(seen.opened, [], why)
    }
})

test('"Close BEE2" after the user closed it already: updates without a notice', async () => {
    const { watcher, seen, bee2 } = setup({
        updates,
        answers: { "@a/items": "update" },
        close: () => {
            bee2.running = false // closed while the question was up
            return "now"
        },
    })
    bee2.running = true
    await watcher.check()
    assert.equal(seen.closed, 0)
    assert.deepEqual(seen.updated, ["@a/items"])
    assert.deepEqual(seen.notes, [])
})

test("checking from the tray: no updates, and updating while BEE2 is closed", async () => {
    const none = setup({ updates: [] })
    assert.equal(await none.watcher.offer(), null)
    assert.equal(none.seen.asked.length, 0)

    const closed = setup({ updates, answers: { "@c/style": "update" } })
    assert.deepEqual(await closed.watcher.offer(), ["@c/style"])
    assert.deepEqual(closed.seen.askedClose, []) // BEE2 wasn't open: nothing to ask
    assert.equal(closed.seen.closed, 0)
    assert.deepEqual(closed.seen.opened, []) // and it isn't opened either
})
