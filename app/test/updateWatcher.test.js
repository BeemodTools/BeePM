/**
 * BeePM in the background (backend/updateWatcher.js): when BEE2 opens it asks about each
 * update, and updating closes BEE2, installs the updates and opens BEE2 again. BEE2, the
 * question dialog and the installs are stand-ins here.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { createUpdateWatcher } from "../backend/updateWatcher.js"

const quiet = { info() {}, warn() {} }

/** A watcher with stand-ins; `answers` are what the user picks, by package. */
function setup({ updates, answers = {}, running = false }) {
    const seen = { asked: [], ignored: [], updated: [], closed: 0, opened: [] }
    const bee2 = { running }
    const watcher = createUpdateWatcher(
        {
            log: quiet,
            isBee2Running: async () => bee2.running,
            findBee2: async () => "C:\\BEE2\\BEE2.exe",
            closeBee2: async () => {
                const was = bee2.running
                bee2.running = false
                if (was) seen.closed++
                return was
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
            ignore: async (name) => {
                seen.ignored.push(name)
            },
            update: async (names) => {
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

test("when BEE2 opens: asks about each update, then closes BEE2, updates and opens it again", async () => {
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
    assert.deepEqual(seen.updated, ["@a/items"])
    assert.equal(seen.closed, 1)
    assert.deepEqual(seen.opened, ["C:\\BEE2\\BEE2.exe"])

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

test("checking from the tray: no updates, and updating while BEE2 is closed", async () => {
    const none = setup({ updates: [] })
    assert.equal(await none.watcher.offer(), null)
    assert.equal(none.seen.asked.length, 0)

    const closed = setup({ updates, answers: { "@c/style": "update" } })
    assert.deepEqual(await closed.watcher.offer(), ["@c/style"])
    assert.equal(closed.seen.closed, 0)
    assert.deepEqual(closed.seen.opened, []) // BEE2 wasn't open, so it isn't opened either
})
