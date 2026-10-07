/**
 * The log file (backend/logger.js, BeePEE's logger): steps drawn as trees, repeated lines
 * written once, the window's lines, console output, and old files cleaned up.
 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { Logger } from "../backend/logger.js"

let dir
before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "beepm-logger-test-"))
})
after(() => rm(dir, { recursive: true, force: true }))

/** A logger writing to its own folder, leaving the console alone. */
function startLogger(name, options = {}) {
    const logger = new Logger()
    logger.initialize({
        dir: path.join(dir, name),
        version: "1.0.0-test",
        captureConsole: false,
        echo: false,
        ...options,
    })
    return logger
}

/** The log file's lines after closing it, without their times and with "in 3 ms" -> "in T". */
async function linesOf(logger) {
    await logger.close()
    const text = await readFile(logger.getLogFilePath(), "utf8")
    return text
        .trimEnd()
        .split("\n")
        .map((line) =>
            line.slice("00:00:00.000  ".length).replace(/(in|after) \d+(\.\d+)? (ms|s)\b/, "$1 T"),
        )
}

test("steps are drawn as trees, and repeated lines are written once", async () => {
    const logger = startLogger("steps")
    assert.match(path.basename(logger.getLogFilePath()), /^beepm-[\dT-]+Z\.log$/)

    await logger.section("Installing @a/b@1.0.0", async () => {
        logger.info("@a/b@1.0.0, 12 KB")
        logger.warn("@a/b is deprecated: use @a/c")
    })
    await logger.section("Hooking BEE2", async () => {})
    await assert.rejects(
        logger.section("Publishing @a/b@1.0.0", async () => {
            throw new Error("Version 1.0.0 already exists.")
        }),
    )
    await logger.section("Setting up BEE2 4.46.0", async () => {
        await logger.section("Downloading", async () => logger.info("Packages.zip (3.4 MB)"))
        logger.info("Closed BEE2")
    })
    for (let i = 0; i < 3; i++) logger.info("Window focused")
    logger.debug("Not logged: debug lines are off")
    logger.info("Done")

    const lines = await linesOf(logger)
    assert.match(lines[0], /^BeePM 1\.0\.0-test, log file: .+\.log$/)
    assert.deepEqual(lines.slice(1), [
        "Installing @a/b@1.0.0",
        "├─ @a/b@1.0.0, 12 KB",
        "├─ Warning: @a/b is deprecated: use @a/c",
        "└─ [✓] Done in T",
        "",
        "[✓] Hooking BEE2 in T",
        "[✗] Publishing @a/b@1.0.0 failed after T: Version 1.0.0 already exists.",
        "Setting up BEE2 4.46.0",
        "├─ Downloading",
        "│  ├─ Packages.zip (3.4 MB)",
        "│  └─ [✓] Done in T",
        "│",
        "├─ Closed BEE2",
        "└─ [✓] Done in T",
        "",
        "Window focused",
        "(repeated 2 more times)",
        "Done",
        "Log closed",
    ])
})

test("a step that goes on after other lines says so", async () => {
    const logger = startLogger("parallel")
    let resume
    const waiting = new Promise((resolve) => (resume = resolve))
    const install = logger.section("Installing @a/b@1.0.0", async () => {
        logger.info("first")
        await waiting
        logger.info("second")
    })
    logger.info("Something else")
    resume()
    await install

    assert.deepEqual((await linesOf(logger)).slice(1), [
        "Installing @a/b@1.0.0",
        "├─ first",
        "Something else",
        "Installing @a/b@1.0.0 (continued)",
        "├─ second",
        "└─ [✓] Done in T",
        "",
        "Log closed",
    ])
})

test("the window's lines and console output go in the log", async () => {
    const logger = startLogger("window", { captureConsole: true, debug: true })
    try {
        console.log("Registry: %s", "https://beepm.beemodtools.org")
        console.warn("careful")
        logger.fromWindow("Window", "error", "Uncaught TypeError: x is undefined")
        logger.fromWindow("Window", "debug", "rendered")
    } finally {
        logger.restoreConsole()
    }
    assert.deepEqual((await linesOf(logger)).slice(1), [
        "Registry: https://beepm.beemodtools.org",
        "Warning: careful",
        "Error: [Window] Uncaught TypeError: x is undefined",
        "[Window] rendered",
        "Log closed",
    ])
})

test("only the 10 most recent log files are kept", async () => {
    const logs = path.join(dir, "old")
    await mkdir(logs)
    for (let day = 1; day <= 12; day++) {
        const file = path.join(logs, `beepm-2026-01-${String(day).padStart(2, "0")}.log`)
        await writeFile(file, "old\n")
        const time = new Date(Date.UTC(2026, 0, day))
        await utimes(file, time, time)
    }
    await writeFile(path.join(logs, "notes.txt"), "not a log")

    const logger = new Logger()
    logger.initialize({ dir: logs, captureConsole: false, echo: false })
    await logger.close()

    const files = await readdir(logs)
    assert.equal(files.filter((name) => name.startsWith("beepm-")).length, 10)
    assert.ok(files.includes(path.basename(logger.getLogFilePath())))
    for (const day of ["01", "02", "03"]) assert.ok(!files.includes(`beepm-2026-01-${day}.log`))
    assert.ok(files.includes("beepm-2026-01-04.log"))
    assert.ok(files.includes("notes.txt"))
})
