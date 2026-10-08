import { open, readdir, stat } from "node:fs/promises"
import path from "node:path"

/**
 * What broke BEE2, from its log (in <BEE2>/logs). BEE2 stops when a package can't be loaded: it
 * crashes (any error: a package's objects that can't be parsed, "Error occured parsing
 * TEMP23:VERSION item!" after the cause, an item that refers to something wrong...), or shows
 * "An error occurred when loading packages:" and closes. What BEE2 only warns about ("Loading
 * packages was partially successful", deprecated TemplateBrushes...) doesn't count, and neither
 * do duplicate packages (the BEE2 check offers to fix those).
 * Each run of BEE2 writes its own log: bee2.log, after moving the one before to bee2.1.log, and
 * so on. Not always: a log that's still open (in a BEE2 that crashed and was left running) can't
 * be moved, and then the run goes in bee2.1.log, bee2.2.log... So a run's log is found by when
 * it was written to.
 */

// The end of a log is enough: BEE2 writes what stopped it last
const MAX_LOG_BYTES = 1024 * 1024
// A run's end is closer to it: "Trio exited ...", then at most a traceback
const END_BYTES = 256 * 1024
const LOG_NAME = /^bee2(?:\.\d+)?\.log$/i
const PARSE_ERROR = /Error occur+ed parsing ([^\s:"]+):(\S+?) ([\w ]+?)!/i
const EXCEPTION = /^[\s|]*(?:[\w.]+\.)?(\w*(?:Error|Exception)):\s*(?:AppError:\s*)?(.+?)\s*$/
// The errors BEE2 closes after ("Loading packages was partially successful:" is only warnings)
const DIALOG_START =
    /^\s*\|\s*desc=(?:An error|Multiple errors) occurred when loading packages:\s*$/
const DIALOG_LINE = /^\s*\|\s?(.*)$/
const PACKAGE_IN_MESSAGE = /\bpackage "([^"]+)"/i
// BEE2 4.46's warnings, which its "BEEmod Error" window lists along with the errors
const WARNINGS = [
    /^Potential package file has no info\.txt/i,
    /no longer needs to be defined in info\.txt/i,
    /has incomplete grouping icon definition/i,
    /could not be enabled/i,
    /^Unknown object type/i,
]
// A duplicate package, over several lines
const DUPLICATE_LINES = /^(?:Duplicate package|If you just updated the mod|Package \d+:)/i
// A crash: its traceback follows (an error in BEE2's window code ends BEE2 too)
const CRASH_START = /Trio exited with exception|Uncaught Tk Exception/
const LOG_RECORD = /^\[(?:DEBUG|INFO|WARNING|ERROR|CRITICAL)\]/
// BEE2's main loop ended, crashed or not
const RUN_ENDED = /Trio exited (?:normally|with exception)/
// IDs as BEE2 writes them in its errors
const ID_TOKEN = /[A-Z0-9][A-Z0-9_]{2,}/g

/**
 * What BEE2 stopped on in a log: [{ message, packageId? }], what BEE2 said for each error (for a
 * parse error, its cause: 'Invalid Item ID "VERSION"...'). packageId when BEE2 names the package;
 * otherwise the message names something in one (see bee2ErrorPackage).
 */
export function bee2LogProblems(logText) {
    const lines = String(logText).split(/\r?\n/)
    const problems = []
    const used = new Set() // lines a parse error was made of
    const add = (message, packageId = null) => {
        const same = packageId
            ? (p) => p.packageId === packageId
            : (p) => !p.packageId && p.message === message
        if (!problems.some(same)) problems.push(packageId ? { packageId, message } : { message })
    }

    lines.forEach((line, index) => {
        const parsed = PARSE_ERROR.exec(line)
        if (parsed) {
            used.add(index)
            // The cause comes just before: the nearest other exception in the traceback
            let message = `${parsed[3]} ${parsed[2]} can't be read`
            for (let i = index - 1; i >= Math.max(0, index - 60); i--) {
                const cause = EXCEPTION.exec(lines[i])
                if (cause && !PARSE_ERROR.test(lines[i]) && !/ExceptionGroup/.test(cause[1])) {
                    message = cause[2]
                    used.add(i)
                    break
                }
            }
            add(message, parsed[1].toUpperCase())
            return
        }
        if (DIALOG_START.test(line)) {
            // "An error occurred when loading packages:", then one message per line until "|___"
            for (let i = index + 1; i < lines.length && i < index + 500; i++) {
                const text = DIALOG_LINE.exec(lines[i])?.[1]?.trim()
                if (text === undefined || text.startsWith("___")) break
                if (!text || DUPLICATE_LINES.test(text) || WARNINGS.some((w) => w.test(text))) {
                    continue
                }
                add(text, PACKAGE_IN_MESSAGE.exec(text)?.[1]?.toUpperCase() ?? null)
            }
        }
    })
    // A crash's errors: in its traceback, apart from BEE2's warnings (AppError) and the groups.
    // BEE2's own ValueErrors say what's wrong; others ("KeyError: 'palette'") need their kind.
    lines.forEach((line, index) => {
        if (!CRASH_START.test(line)) return
        for (let i = index + 1; i < lines.length && !LOG_RECORD.test(lines[i]); i++) {
            const error = EXCEPTION.exec(lines[i])
            if (!error || used.has(i) || /ExceptionGroup|^AppError$/.test(error[1])) continue
            add(error[1] === "ValueError" ? error[2] : `${error[1]}: ${error[2]}`)
        }
    })
    return problems
}

/**
 * The package an error from BEE2's log is about: the first ID in it that findPackage(id) knows
 * (a package's own ID, or an item's: its package's ID), else null. 'Item ITEM_X's AXO style
 * referenced invalid style "BEE2_PORTAL_1"' is about ITEM_X's package, not the style's.
 */
export function bee2ErrorPackage(message, findPackage) {
    for (const [id] of String(message).matchAll(ID_TOKEN)) {
        const found = findPackage(id)
        if (found) return found
    }
    return null
}

/** Whether a run's log says it's over: BEE2's main loop ended, crashed or not. */
export const bee2RunEnded = (logText) => RUN_ENDED.test(logText)

/** BEE2's logs (in `dir`): [{ file, modified (ms), size }], oldest first. */
async function listLogs(dir) {
    const folder = path.join(dir, "logs")
    const names = (await readdir(folder).catch(() => [])).filter((name) => LOG_NAME.test(name))
    const logs = []
    for (const name of names) {
        const file = path.join(folder, name)
        const info = await stat(file).catch(() => null)
        if (info?.isFile()) logs.push({ file, modified: info.mtimeMs, size: info.size })
    }
    return logs.sort((a, b) => a.modified - b.modified)
}

/** The last `bytes` of a file `size` long, or null if it can't be read. */
async function readEnd(file, size, bytes) {
    let handle = null
    try {
        handle = await open(file, "r")
        const length = Math.min(size, bytes)
        const { buffer, bytesRead } = await handle.read(
            Buffer.alloc(length),
            0,
            length,
            size - length,
        )
        return buffer.subarray(0, bytesRead).toString("utf8")
    } catch {
        return null
    } finally {
        await handle?.close()
    }
}

/**
 * A log of BEE2's (in `dir`): { file, modified (ms), text (its end) }, or null without one.
 * since (ms): the log of the run that was running then, the first one written to after it (a run
 * writes its log until it ends); else the latest log.
 */
export async function readBee2Log(dir, { since = null } = {}) {
    const logs = await listLogs(dir)
    const log = since === null ? logs.at(-1) : logs.find((l) => l.modified >= since)
    if (!log) return null
    const text = await readEnd(log.file, log.size, MAX_LOG_BYTES)
    return text === null ? null : { file: log.file, modified: log.modified, text }
}

/**
 * What broke BEE2 (in `dir`), from the log of a run: see bee2LogProblems. since (ms): the run
 * that was running then (see readBee2Log), else the latest one.
 */
export async function readBee2Problems(dir, { since = null } = {}) {
    const log = await readBee2Log(dir, { since })
    return log ? bee2LogProblems(log.text) : []
}

// Whether a log says its run ended, by file, time and size: what's left of a BEE2 that crashed
// is looked at again every few seconds
const endings = new Map()

/**
 * When BEE2's run that started at `started` (ms) ended, by its log (in `dir`): when the log was
 * last written to, or null if the run hasn't ended (or written its log yet).
 */
export async function bee2RunEnd(dir, started) {
    const log = (await listLogs(dir)).find((l) => l.modified >= started)
    if (!log) return null
    const key = `${log.file}|${log.modified}|${log.size}`
    if (!endings.has(key)) {
        const text = await readEnd(log.file, log.size, END_BYTES)
        if (text === null) return null
        if (endings.size >= 100) endings.clear()
        endings.set(key, bee2RunEnded(text))
    }
    return endings.get(key) ? log.modified : null
}
