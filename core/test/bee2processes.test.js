/**
 * BEE2's processes (client/bee2.js): what's left of a BEE2 that crashed (no window, the log of
 * its run says it ended) isn't BEE2 running. tasklist and PowerShell are stand-ins here; the
 * logs are real files.
 */
import assert from "node:assert/strict"
import { mkdir, utimes, writeFile } from "node:fs/promises"
import path from "node:path"
import { after, before, test } from "node:test"
import {
    bee2System,
    endLeftoverBee2,
    findBee2Programs,
    findLeftoverBee2,
    isBee2Running,
    listBee2Processes,
} from "../src/client/bee2.js"
import { tempDir } from "./helpers.js"

// Ending processes is off in tests: nothing real is ended
process.env.BEEPM_NO_CLOSE_BEE2 = "1"

let tmp
const real = { ...bee2System }
before(async () => {
    tmp = await tempDir()
})
after(() => {
    Object.assign(bee2System, real)
    return tmp.cleanup()
})

/**
 * Stand-in processes: `running` is what tasklist shows ({ pid, windowed, started, program });
 * seen.described counts the (slower) PowerShell looks.
 */
function standIn() {
    const running = []
    const seen = { described: 0 }
    bee2System.ids = async () => running.map((p) => p.pid)
    bee2System.describe = async () => {
        seen.described++
        return running.map((p) => ({ ...p }))
    }
    return { running, seen }
}

test(
    "a BEE2 left running after it crashed isn't BEE2 running, and doesn't hide the next one",
    { skip: process.platform !== "win32" && "Windows only" },
    async () => {
        const dir = path.join(tmp.dir, "BEE2")
        const logs = path.join(dir, "logs")
        await mkdir(logs, { recursive: true })
        const program = path.join(dir, "BEE2.exe")
        const log = async (file, text, ms) => {
            await writeFile(path.join(logs, file), text)
            await utimes(path.join(logs, file), new Date(ms), new Date(ms))
        }
        const look = () => listBee2Processes({ fresh: true })
        const start = Date.now() - 60 * 60 * 1000
        const { running, seen } = standIn()

        // BEE2 starts and writes its log
        running.push({ pid: 9001, windowed: false, started: start, program })
        await log("bee2.log", "[INFO] packages.find_packages(): Reading...\n", start + 2000)
        assert.deepEqual(
            (await look()).map((p) => [p.pid, p.leftover]),
            [[9001, null]],
        )
        assert.equal(await isBee2Running(dir), true)
        assert.deepEqual(await findBee2Programs(), [program])

        // It crashes: its log says the run ended, and the process stays, without a window
        await log(
            "bee2.log",
            "[ERROR] core.done_callback(): Trio exited with exception\n",
            start + 5000,
        )
        assert.deepEqual(
            (await look()).map((p) => [p.pid, p.leftover]),
            [[9001, start + 5000]],
        )
        assert.equal(await isBee2Running(dir), false)
        assert.equal(await isBee2Running(), false)
        assert.deepEqual(await findBee2Programs(), [])
        assert.deepEqual(
            (await findLeftoverBee2(dir)).map((p) => p.pid),
            [9001],
        )
        assert.deepEqual(await findLeftoverBee2(path.join(tmp.dir, "Other BEE2")), [])
        assert.equal(await endLeftoverBee2(dir), 0) // off in tests

        // BEE2 opened again: it's running, before and after it writes its own log (bee2.log is
        // still open in the one left running, so it writes bee2.1.log)
        running.push({ pid: 9002, windowed: true, started: start + 60_000, program })
        assert.equal((await look()).find((p) => p.pid === 9002).leftover, null)
        assert.equal(await isBee2Running(dir), true)
        await log("bee2.1.log", "[INFO] Everything loaded.\n", start + 65_000)
        assert.equal(await isBee2Running(dir), true)
        // Closed the usual way: its log doesn't say so, but its process is gone
        running.splice(1, 1)
        assert.equal((await look()).find((p) => p.pid === 9001).leftover, start + 5000)
        assert.equal(await isBee2Running(dir), false)

        // PowerShell only looked when there was a process it didn't know, and when one's run
        // ended (to see it had no window)
        assert.equal(seen.described, 3)
        running.length = 0
        assert.deepEqual(await look(), [])
    },
)

test(
    "a BEE2 whose run ended still counts while it has a window",
    { skip: process.platform !== "win32" && "Windows only" },
    async () => {
        const dir = path.join(tmp.dir, "BEE2-window")
        await mkdir(path.join(dir, "logs"), { recursive: true })
        const started = Date.now() - 10_000
        const { running } = standIn()
        running.push({ pid: 9101, windowed: true, started, program: path.join(dir, "BEE2.exe") })
        await writeFile(
            path.join(dir, "logs", "bee2.log"),
            "[DEBUG] core.done_callback(): Trio exited normally.\n",
        )
        await listBee2Processes({ fresh: true })
        assert.equal(await isBee2Running(dir), true)
        running[0].windowed = false // it closed its window, and stays
        await listBee2Processes({ fresh: true })
        assert.equal(await isBee2Running(dir), false)

        // One whose program can't be seen (run as administrator) counts as any BEE2
        running.push({ pid: 9102, windowed: false, started: null, program: null })
        await listBee2Processes({ fresh: true })
        assert.equal(await isBee2Running(dir), true)
        running.length = 0
        await listBee2Processes({ fresh: true })
    },
)
