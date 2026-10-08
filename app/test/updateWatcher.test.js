/**
 * BeePM in the background (backend/updateWatcher.js): when BEE2 opens it looks at BEE2's
 * packages (duplicates, the user's own packages that are on BeePM, updates) and asks about them;
 * changing files waits for BEE2 to close, which only happens when the user says so. BEE2, the
 * questions, the check and the changes are stand-ins here.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { createUpdateWatcher } from "../backend/updateWatcher.js"

const quiet = { info() {}, warn() {} }
const BEE2_EXE = "C:\\BEE2\\BEE2.exe"
const nothing = { duplicates: null, onBeepm: [], updates: [] }

/**
 * A watcher with stand-ins. `found` is what the check finds (updates already applied drop out);
 * `answers` are what the user picks, by question kind (a function gets the question).
 * `bee2.running` is BeePM's BEE2, and `bee2.other` the folder of another BEE2 that's open. BEE2
 * closes when asked, unless `bee2.stays` (the user cancels its prompt) or `bee2.busy` (a dialog is
 * open in it, so it can't be asked).
 */
function setup({ found = {}, answers = {}, running = false, options = {} }) {
    const seen = {
        asked: [],
        applied: [],
        ignored: [],
        kept: [],
        chose: [], // the checks a window to choose in was opened for
        closed: 0,
        opened: [],
        notes: [],
        closedEvents: 0,
        reviewed: 0,
        switched: [],
        ignoredBee2: [],
    }
    const bee2 = { running, stays: false, busy: false, other: null, ignored: false }
    const updated = () => seen.applied.flatMap((work) => work.update)
    const watcher = createUpdateWatcher(
        {
            log: quiet,
            sleep: async () => {},
            isBee2Running: async () => bee2.running || Boolean(bee2.other),
            isLocked: async () => bee2.running,
            whichBee2: async () =>
                bee2.running || !bee2.other
                    ? { other: null }
                    : { other: bee2.other, current: "C:\\BEE2", ignored: bee2.ignored },
            useBee2: async (folder) => {
                seen.switched.push(folder)
                bee2.running = true // it's BeePM's BEE2 now
                bee2.other = null
            },
            ignoreBee2: async (folder) => {
                seen.ignoredBee2.push(folder)
                bee2.ignored = true
            },
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
            review: async () => ({
                ...(seen.reviewed++, nothing),
                reviewId: `check-${seen.reviewed}`,
                ...found,
                updates: (found.updates ?? []).filter((u) => !updated().includes(u.name)),
            }),
            ask: async (question) => {
                seen.asked.push(question)
                const answer = answers[question.kind]
                return (typeof answer === "function" ? answer(question) : answer) ?? "later"
            },
            choose: (found) => seen.chose.push(found.reviewId),
            keepOwn: async (ids) => seen.kept.push(...ids),
            ignore: async (name) => seen.ignored.push(name),
            apply: async (work) => {
                assert.equal(bee2.running, false, "changing files while BeePM's BEE2 is open")
                seen.applied.push(work)
            },
            notify: (text) => seen.notes.push(text),
            whenClosed: async () => seen.closedEvents++,
        },
        { graceMs: 0, ...options },
    )
    return { watcher, seen, bee2 }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

const updates = [
    { name: "@a/items", from: "1.0.0", to: "1.1.0" },
    { name: "@b/sounds", from: "2.0.0", to: "2.1.0" },
    { name: "@c/style", from: "0.9.0", to: "1.0.0" },
]
const byName = (map) => (question) => map[question.name]
const work = (changes) => ({ remove: [], adopt: [], update: [], ...changes })

test("a poke (BEE2 wrote its log) looks right away, not at the next look", async () => {
    const { watcher, seen, bee2 } = setup({
        found: { updates: updates.slice(0, 1) },
        options: { everyMs: 60 * 60 * 1000 },
    })
    watcher.poke() // not started: nothing
    watcher.start() // looks now: BEE2 isn't open
    bee2.running = true
    watcher.poke() // during that look: looks again after it
    await settle()
    assert.deepEqual(
        seen.asked.map((q) => q.name),
        ["@a/items"],
    )
    watcher.poke() // BEE2 is known to be open (it keeps writing its log): nothing
    await settle()
    assert.equal(seen.reviewed, 1)
    watcher.stop()
})

test("when BEE2 opens: asks about each update, then asks to close BEE2 and opens it again", async () => {
    const { watcher, seen, bee2 } = setup({
        found: { updates },
        answers: { update: byName({ "@a/items": "update", "@b/sounds": "never" }), close: "now" },
    })
    await watcher.check() // BEE2 isn't open: nothing happens
    assert.equal(seen.asked.length, 0)

    bee2.running = true
    await watcher.check()
    assert.deepEqual(
        seen.asked.map((q) => q.name ?? q.kind),
        ["@a/items", "@b/sounds", "@c/style", "close"],
    )
    assert.deepEqual(seen.ignored, ["@b/sounds"])
    assert.equal(seen.closed, 1)
    assert.deepEqual(seen.applied, [work({ update: ["@a/items"] })])
    assert.deepEqual(seen.opened, [BEE2_EXE])
    assert.deepEqual(seen.notes, [])

    // BEE2 opened again by BeePM: not asked again; it isn't asked while it stays open
    await watcher.check()
    await watcher.check()
    assert.equal(seen.asked.length, 4)

    // The next time the user opens BEE2, what's left is asked about again
    bee2.running = false
    await watcher.check()
    bee2.running = true
    await watcher.check()
    assert.deepEqual(
        seen.asked.slice(4).map((q) => q.name),
        ["@b/sounds", "@c/style"], // the stand-in doesn't filter ignored ones; the backend does
    )
})

test('"When I close it": BEE2 stays open, and the changes are made once the user closes it', async () => {
    const { watcher, seen, bee2 } = setup({
        found: { updates },
        answers: { update: byName({ "@a/items": "update" }), close: "later" },
    })
    bee2.running = true
    await watcher.check()
    assert.equal(seen.asked.at(-1).kind, "close")
    assert.equal(seen.closed, 0)
    assert.deepEqual(seen.applied, [])

    await watcher.check() // Still open
    assert.deepEqual(seen.applied, [])

    bee2.running = false // The user closes it
    await watcher.check()
    assert.deepEqual(seen.applied, [work({ update: ["@a/items"] })])
    assert.deepEqual(seen.opened, []) // and it's left closed
    assert.equal(seen.closedEvents, 1)
})

test("BEE2 that doesn't close isn't forced: the changes wait until the user closes it", async () => {
    for (const why of ["stays", "busy"]) {
        const { watcher, seen, bee2 } = setup({
            found: { updates },
            answers: { update: byName({ "@c/style": "update" }), close: "now" },
        })
        bee2.running = true
        bee2[why] = true
        await watcher.check()
        assert.equal(seen.closed, 0, why)
        assert.deepEqual(seen.applied, [], why)
        assert.equal(seen.notes.length, 1, why) // "BEE2 didn't close. BeePM finishes once ..."

        bee2.running = false
        await watcher.check()
        assert.deepEqual(seen.applied, [work({ update: ["@c/style"] })], why)
        assert.deepEqual(seen.opened, [], why)
    }
})

test('"Close BEE2" after the user closed it already: done without a notice', async () => {
    const { watcher, seen, bee2 } = setup({
        found: { updates },
        answers: {
            update: byName({ "@a/items": "update" }),
            close: () => {
                bee2.running = false // closed while the question was up
                return "now"
            },
        },
    })
    bee2.running = true
    await watcher.check()
    assert.equal(seen.closed, 0)
    assert.deepEqual(seen.applied, [work({ update: ["@a/items"] })])
    assert.deepEqual(seen.notes, [])
})

test("duplicates and packages on BeePM: deleted and switched along with the updates", async () => {
    const { watcher, seen } = setup({
        found: {
            duplicates: { count: 2, remove: ["C:\\BEE2\\packages\\old.bee_pack"] },
            onBeepm: [{ id: "MINE", name: "Mine", package: "@me/mine" }],
            updates,
        },
        answers: { duplicates: "delete", adopt: "use", update: byName({ "@a/items": "update" }) },
    })
    // From the tray, with BEE2 closed: no question about closing it
    const result = await watcher.offer()
    assert.deepEqual(
        seen.asked.slice(0, 2).map((q) => [q.kind, q.count ?? q.packages?.length]),
        [
            ["duplicates", 2],
            ["adopt", 1],
        ],
    )
    const expected = work({
        remove: ["C:\\BEE2\\packages\\old.bee_pack"],
        adopt: ["@me/mine"],
        update: ["@a/items"],
    })
    assert.deepEqual(result, expected)
    assert.deepEqual(seen.applied, [expected])
    assert.equal(
        seen.asked.some((q) => q.kind === "close"),
        false,
    )
})

test('"Keep mine" isn\'t asked again, and "Choose" opens BeePM\'s window instead', async () => {
    const onBeepm = [
        { id: "MINE", name: "Mine", package: "@me/mine" },
        { id: "OURS", name: "Ours", package: "@us/ours" },
    ]
    const keep = setup({ found: { onBeepm }, answers: { adopt: "keep" } })
    assert.deepEqual(await keep.watcher.offer(), work({}))
    assert.deepEqual(keep.seen.kept, ["MINE", "OURS"])
    assert.deepEqual(keep.seen.applied, [])

    // Choosing duplicates in the window covers the packages on BeePM there too
    const choose = setup({
        found: { duplicates: { count: 1, remove: ["x"] }, onBeepm },
        answers: { duplicates: "choose" },
    })
    await choose.watcher.offer()
    assert.deepEqual(choose.seen.chose, ["check-1"]) // the check the question came from
    assert.deepEqual(
        choose.seen.asked.map((q) => q.kind),
        ["duplicates"],
    )
})

test("checking from the tray: nothing found, and updating while BEE2 is closed", async () => {
    const none = setup({})
    assert.equal(await none.watcher.offer(), null)
    assert.equal(none.seen.asked.length, 0)

    const closed = setup({
        found: { updates },
        answers: { update: byName({ "@c/style": "update" }) },
    })
    assert.deepEqual(await closed.watcher.offer(), work({ update: ["@c/style"] }))
    assert.equal(
        closed.seen.asked.some((q) => q.kind === "close"),
        false,
    ) // BEE2 wasn't open
    assert.equal(closed.seen.closed, 0)
    assert.deepEqual(closed.seen.opened, []) // and it isn't opened either
})

test("a BEE2 from another folder: asked to switch to it, otherwise left alone", async () => {
    const other = "D:\\Games\\BEE2"
    // Not now: it isn't checked, and nothing is closed
    const later = setup({ found: { updates }, answers: { update: "update", close: "now" } })
    later.bee2.other = other
    await later.watcher.check()
    assert.deepEqual(
        later.seen.asked.map((q) => [q.kind, q.folder]),
        [["use-bee2", other]],
    )
    assert.equal(later.seen.reviewed, 0)
    assert.equal(later.seen.closed, 0)

    // Don't ask again: launching it again is left alone without asking
    const never = setup({ answers: { "use-bee2": "never" } })
    never.bee2.other = other
    await never.watcher.check()
    assert.deepEqual(never.seen.ignoredBee2, [other])
    never.bee2.other = null
    await never.watcher.check()
    never.bee2.other = other
    await never.watcher.check()
    assert.equal(never.seen.asked.length, 1)

    // Use it: BeePM switches to it, then looks at its packages as usual
    const use = setup({
        found: { updates },
        answers: { "use-bee2": "use", update: byName({ "@a/items": "update" }), close: "now" },
    })
    use.bee2.other = other
    await use.watcher.check()
    assert.deepEqual(use.seen.switched, [other])
    assert.deepEqual(
        use.seen.asked.map((q) => q.kind),
        ["use-bee2", "update", "update", "update", "close"],
    )
    assert.deepEqual(use.seen.applied, [work({ update: ["@a/items"] })])
})

test("what waits for BeePM's BEE2 is done once it closes, even with another BEE2 open", async () => {
    const { watcher, seen, bee2 } = setup({
        found: { updates },
        answers: { update: byName({ "@a/items": "update" }), close: "later" },
    })
    bee2.running = true
    await watcher.check()
    bee2.other = "D:\\Games\\BEE2" // another BEE2 opens...
    bee2.running = false // ...and BeePM's closes
    await watcher.check()
    assert.deepEqual(seen.applied, [work({ update: ["@a/items"] })])
})
