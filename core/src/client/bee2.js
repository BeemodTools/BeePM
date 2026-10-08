import { execFile } from "node:child_process"
import { open, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { hashFile } from "../pack.js"
import { bee2RunEnd } from "./bee2log.js"
import { exists, freePath, moveFile } from "./files.js"
import { bee2PackagesDir, beepmPackagesDir, useBee2Folder } from "./paths.js"
import { scanPackages } from "./scan.js"
import { loadConfig, loadInstalled, saveConfig, saveInstalled } from "./state.js"

/** A problem with the user's BEE2 setup, with a message meant for them. */
export class Bee2Error extends Error {}

const normalize = (p) => {
    const resolved = path.resolve(String(p).trim())
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
}
const samePath = (a, b) => Boolean(a) && Boolean(b) && normalize(a) === normalize(b)
const isInside = (file, folder) => normalize(file).startsWith(normalize(folder) + path.sep)

/** Runs a PowerShell script (with extra environment variables); null if it failed. */
function powershell(script, env = {}) {
    return new Promise((resolve) => {
        execFile(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-Command", script],
            { windowsHide: true, env: { ...process.env, ...env } },
            (err, stdout) => resolve(err ? null : String(stdout ?? "")),
        )
    })
}

// The BEE2 processes from one folder ($env:BEEPM_BEE2_DIR; all of them when it's empty). One
// whose program can't be seen (BEE2 run as administrator) might be that BEE2, so it counts.
const BEE2_PROCESSES =
    "Get-Process -Name BEE2 -ErrorAction SilentlyContinue | Where-Object { -not $env:BEEPM_BEE2_DIR -or -not $_.Path -or $_.Path.StartsWith($env:BEEPM_BEE2_DIR.TrimEnd('\\') + '\\', [StringComparison]::OrdinalIgnoreCase) }"

/**
 * Asks BEE2 (the one in `folder`, else any) to close the way its close button does, so it exits
 * normally and saves. Resolves to whether BEE2 was asked: not when it isn't running, or a dialog
 * is open in it. Windows only: elsewhere the user closes BEE2.
 * BEEPM_NO_CLOSE_BEE2=1 turns this off (tests).
 */
export async function askBee2ToClose(folder = null) {
    if (process.env.BEEPM_NO_CLOSE_BEE2 || process.platform !== "win32") return false
    // CloseMainWindow() is false if there's no window to close, or it's disabled by a dialog
    const count = await powershell(
        `@(${BEE2_PROCESSES} | Where-Object { $_.CloseMainWindow() }).Count`,
        { BEEPM_BEE2_DIR: folder ?? "" },
    )
    return Number(count?.trim()) > 0
}

// Each BEE2 process: its ID, main window (0: none), start (ms) and program file. The last two
// are empty when they can't be seen (BEE2 run as administrator).
const DESCRIBE_BEE2 = String.raw`Get-Process -Name BEE2 -ErrorAction SilentlyContinue | ForEach-Object {
    $started = try { ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } catch { '' }
    "$($_.Id)|$([int64]$_.MainWindowHandle)|$started|$($_.Path)"
}`

/**
 * How BEE2's processes are looked at (Windows; tests swap these):
 *   ids()       the IDs of the BEE2.exe processes (tasklist, which is quick), or null
 *   describe()  [{ pid, windowed, started, program }] for each (PowerShell), or null
 */
export const bee2System = {
    ids: () =>
        new Promise((resolve) => {
            execFile(
                "tasklist",
                ["/FI", "IMAGENAME eq BEE2.exe", "/FO", "CSV", "/NH"],
                { windowsHide: true },
                (err, stdout) => {
                    if (err) return resolve(null)
                    const rows = String(stdout).matchAll(/^"BEE2\.exe","(\d+)"/gim)
                    resolve([...rows].map((row) => Number(row[1])))
                },
            )
        }),
    async describe() {
        const out = await powershell(DESCRIBE_BEE2)
        if (out === null) return null
        return out.split(/\r?\n/).flatMap((line) => {
            const match = /^(\d+)\|(-?\d+)\|(\d*)\|(.*)$/.exec(line.trim())
            if (!match) return []
            const [, pid, window, started, program] = match
            return [
                {
                    pid: Number(pid),
                    windowed: window !== "0",
                    started: started ? Number(started) : null,
                    program: program.trim() || null,
                },
            ]
        })
    },
}

// What's known of each BEE2 process, by ID, while it runs: its program and start (they don't
// change), and leftover once it's seen to be one
const known = new Map()
// The latest look, which questions asked together share: { at, processes (a promise) }
let latest = null
const SHARED_MS = 1000

/**
 * The BEE2 processes running (Windows; elsewhere none are listed):
 * [{ pid, program, started (ms), leftover }]. program and started are null when they can't be
 * seen (BEE2 run as administrator).
 * leftover (when its run ended, else null) marks what's left of a BEE2 that's over: BEE2 can
 * crash and leave its process running without a window. It holds BEE2's log and package files
 * open, but it isn't BEE2 running: the log of its run says the run ended.
 * A look shortly before is used again (fresh: not).
 */
export function listBee2Processes({ fresh = false } = {}) {
    if (fresh || !latest || Date.now() - latest.at >= SHARED_MS) {
        latest = { at: Date.now(), processes: lookAtBee2() }
    }
    return latest.processes
}

async function lookAtBee2() {
    if (process.platform !== "win32") return []
    const ids = (await bee2System.ids()) ?? []
    for (const pid of known.keys()) if (!ids.includes(pid)) known.delete(pid)
    // PowerShell is slower: only when there's a process it hasn't described, or to see that
    // one whose run is over has no window
    let described = null
    const describe = async () => (described ??= (await bee2System.describe()) ?? [])
    if (ids.some((pid) => !known.has(pid))) {
        for (const proc of await describe()) {
            if (ids.includes(proc.pid) && !known.has(proc.pid)) {
                known.set(proc.pid, {
                    program: proc.program,
                    started: proc.started,
                    leftover: null,
                })
            }
        }
    }
    const processes = []
    for (const pid of ids) {
        const info = known.get(pid) ?? { program: null, started: null, leftover: null }
        if (info.leftover === null && info.program && info.started !== null) {
            const ended = await bee2RunEnd(path.dirname(info.program), info.started)
            if (ended !== null) {
                const now = (await describe()).find((proc) => proc.pid === pid)
                if (now && !now.windowed && now.started === info.started) info.leftover = ended
            }
        }
        processes.push({ pid, ...info })
    }
    return processes
}

const fromFolder = (proc, folder) => !folder || !proc.program || isInside(proc.program, folder)

/**
 * Whether BEE2 is running: the one in `folder` (its program is in there), or any BEE2 without
 * one (BEE2.exe on Windows, a BEE2 process elsewhere, where the folder can't be told). One whose
 * program can't be seen (BEE2 run as administrator) might be that BEE2, so it counts. What's
 * left of a BEE2 that crashed doesn't (see listBee2Processes).
 */
export async function isBee2Running(folder = null) {
    if (process.platform !== "win32") {
        return new Promise((resolve) => {
            execFile("pgrep", ["-x", "BEE2"], (err) => resolve(!err))
        })
    }
    return (await listBee2Processes()).some((p) => p.leftover === null && fromFolder(p, folder))
}

/** The program files of the running BEE2s, one per BEE2 (Windows only). */
export async function findBee2Programs() {
    const programs = (await listBee2Processes())
        .filter((p) => p.leftover === null && p.program)
        .map((p) => p.program)
    return [...new Map(programs.map((p) => [normalize(p), p])).values()]
}

/** What's left of BEE2s that crashed (see listBee2Processes): the ones from `folder`, else any. */
export async function findLeftoverBee2(folder = null) {
    return (await listBee2Processes()).filter((p) => p.leftover !== null && fromFolder(p, folder))
}

// Ends the processes in $env:BEEPM_LEFTOVERS ("<ID>:<start ms>,..."), each only while it's still
// that process (by its start) and has no window
const END_LEFTOVERS = String.raw`$ended = 0
foreach ($target in $env:BEEPM_LEFTOVERS.Split(',')) {
    $id, $started = $target.Split(':')
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $proc -or [int64]$proc.MainWindowHandle -ne 0) { continue }
    try {
        if (([DateTimeOffset]$proc.StartTime).ToUnixTimeMilliseconds() -ne [int64]$started) { continue }
        $proc.Kill()
        [void]$proc.WaitForExit(5000)
        $ended++
    } catch {}
}
$ended`

/**
 * Ends what's left of BEE2s that crashed (see listBee2Processes), the ones from `folder` (else
 * any): it holds BEE2's package files open. Resolves to how many were ended.
 * BEEPM_NO_CLOSE_BEE2=1 turns this off (tests).
 */
export async function endLeftoverBee2(folder = null) {
    if (process.env.BEEPM_NO_CLOSE_BEE2 || process.platform !== "win32") return 0
    const left = await findLeftoverBee2(folder)
    if (!left.length) return 0
    const out = await powershell(END_LEFTOVERS, {
        BEEPM_LEFTOVERS: left.map((p) => `${p.pid}:${p.started}`).join(","),
    })
    latest = null // they're gone
    return Number(out?.trim()) || 0
}

/** The program file of the running BEE2 (the one in `folder`, else any), or null. */
export async function findBee2Program(folder = null) {
    return (await findBee2Programs()).find((p) => !folder || isInside(p, folder)) ?? null
}

// ---------- BEE2's folder ----------

async function isBee2Folder(dir) {
    for (const program of ["BEE2.exe", "BEE2"]) {
        if ((await stat(path.join(dir, program)).catch(() => null))?.isFile()) return true
    }
    return false
}

/**
 * BEE2's folder (the one with BEE2.exe) from what the user picked: that folder, or one inside
 * it like its packages folder. Throws Bee2Error if BEE2 isn't there.
 */
export async function findBee2Folder(picked) {
    const start = path.resolve(String(picked ?? "").trim() || ".")
    let dir = start
    for (let up = 0; up <= 2; up++) {
        if (await isBee2Folder(dir)) return dir
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
    }
    throw new Bee2Error(`BEE2 isn't in ${start}. Choose the folder BEE2.exe is in.`)
}

// BEE2's log starts with: Running "bee2", version 2.4.46.1 64-bit
const VERSION_RE = /Running "?bee2"?,? version (\d+(?:\.\d+)+)/i

/** BEE2's version from its log (logs/bee2.log), or null if BEE2 hasn't run yet. */
export async function readBee2Version(dir) {
    for (const name of ["bee2.log", "bee2.1.log", "bee2.2.log"]) {
        let handle = null
        try {
            handle = await open(path.join(dir, "logs", name), "r")
            const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, 0)
            const match = VERSION_RE.exec(buffer.subarray(0, bytesRead).toString("utf8"))
            if (match) return match[1]
        } catch {
            // Not there (yet)
        } finally {
            await handle?.close()
        }
    }
    return null
}

/**
 * Uses BEE2 from `picked` (see findBee2Folder): saved in config.json with its version (from its
 * log), and ctx.paths points at it. BeePM's packages come along from the BEE2 it used before.
 * Returns { dir, version, moved } (moved: how many of BeePM's packages came along).
 */
export async function setBee2Folder(ctx, picked) {
    const dir = await findBee2Folder(picked)
    const config = await loadConfig(ctx.paths)
    const before = config.bee2?.dir ?? null
    const switching = Boolean(before) && !samePath(before, dir)
    // Another BEE2's version doesn't carry over (one from before the folder was known does)
    const version =
        (await readBee2Version(dir)) ?? (switching ? null : (config.bee2?.version ?? null))
    config.bee2 = { ...config.bee2, dir, version }
    await saveConfig(ctx.paths, config)
    useBee2Folder(ctx.paths, dir)

    let moved = 0
    if (switching) {
        const from = beepmPackagesDir(before)
        for (const entry of Object.values((await loadInstalled(ctx.paths)).packages)) {
            const source = path.join(from, entry.file)
            const target = path.join(ctx.paths.packages, entry.file)
            if ((await exists(source)) && !(await exists(target))) {
                await moveFile(source, target)
                moved++
            }
        }
        await removeEmptyFolders(from)
    }
    return { dir, version, moved }
}

/**
 * BEE2's folder and version: { dir, version, found } (found: BEE2 is still there). The version
 * is read from BEE2's log again, since it changes when BEE2 is updated.
 */
export async function bee2Info(ctx) {
    const config = await loadConfig(ctx.paths)
    const dir = config.bee2?.dir ?? null
    if (!dir) return { dir: null, version: config.bee2?.version ?? null, found: false }
    const found = await isBee2Folder(dir)
    const version = found ? await readBee2Version(dir) : null
    if (version && version !== config.bee2.version) {
        config.bee2.version = version
        await saveConfig(ctx.paths, config)
    }
    return { dir, version: config.bee2.version ?? null, found }
}

// ---------- config.cfg editing ----------
// BEE2's config.cfg is a Python configparser file. These edit one line and keep
// everything else (comments, order, other settings) exactly as it was.

const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/
const KEY_RE = /^\s*([^=:\s;#[][^=:]*?)\s*[=:]\s?(.*)$/

function scan(text, section, key) {
    const lines = text.length ? text.split(/\r?\n/) : []
    const wantSection = section.toLowerCase()
    const wantKey = key.toLowerCase()
    let current = null
    let start = -1
    let end = -1
    let keyLine = -1
    lines.forEach((line, i) => {
        const header = SECTION_RE.exec(line)
        if (header) {
            if (current === wantSection && end < 0) end = i
            current = header[1].trim().toLowerCase()
            if (current === wantSection && start < 0) start = i
            return
        }
        if (current === wantSection && keyLine < 0) {
            const match = KEY_RE.exec(line)
            if (match && match[1].trim().toLowerCase() === wantKey) keyLine = i
        }
    })
    if (start >= 0 && end < 0) end = lines.length
    return { lines, start, end, keyLine, eol: text.includes("\r\n") ? "\r\n" : "\n" }
}

export function getIniValue(text, section, key) {
    const { lines, keyLine } = scan(text, section, key)
    return keyLine >= 0 ? KEY_RE.exec(lines[keyLine])[2].trim() : null
}

export function setIniValue(text, section, key, value) {
    const { lines, start, end, keyLine, eol } = scan(text, section, key)
    const line = `${key} = ${value}`
    if (keyLine >= 0) lines[keyLine] = line
    else if (start >= 0) {
        let at = end
        while (at > start + 1 && lines[at - 1].trim() === "") at--
        lines.splice(at, 0, line)
    } else {
        if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("")
        lines.push(`[${section}]`, line, "")
    }
    return lines.join(eol)
}

export function removeIniKey(text, section, key) {
    const { lines, keyLine, eol } = scan(text, section, key)
    if (keyLine >= 0) lines.splice(keyLine, 1)
    return lines.join(eol)
}

async function readBee2Config(bee2) {
    try {
        return (await readFile(bee2.configFile, "utf8")).replace(/^﻿/, "")
    } catch (err) {
        if (err.code === "ENOENT") return null
        throw err
    }
}

/** Removes the empty folders in `dir`, and `dir` itself if that leaves it empty. */
async function removeEmptyFolders(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
    if (!entries) return
    for (const entry of entries) {
        if (entry.isDirectory()) await removeEmptyFolders(path.join(dir, entry.name))
    }
    await rmdir(dir).catch(() => {}) // only empty ones go
}

// ---------- leaving the hook (earlier 1.0 builds) ----------

/**
 * What's left of the hook: { config, text: BEE2's config.cfg, hooked: BEE2 still loads BeePM's
 * old folder, leftover: that folder is still there }.
 */
async function readHook(ctx) {
    const { paths } = ctx
    const config = await loadConfig(paths)
    const text = await readBee2Config(ctx.bee2)
    const setting = text === null ? null : getIniValue(text, "Directories", "package")
    return {
        config,
        text,
        hooked: samePath(setting, paths.hookedPackages),
        leftover: await exists(paths.hookedPackages),
    }
}

/**
 * Whether anything of the hook is left for leaveHook to undo: BEE2's setting, BeePM's note of
 * it, or its folder. Cheap, so callers can skip looking for BEE2's process.
 */
export async function hasHook(ctx) {
    const { config, hooked, leftover } = await readHook(ctx)
    return hooked || leftover || Boolean(config.hook)
}

/**
 * Earlier 1.0 builds pointed BEE2's config.cfg at BeePM's own packages folder ("hooking") and
 * kept every package BEE2 loaded there. This puts BEE2's setting back and moves the packages
 * into BEE2's packages folder: BeePM's into its folder there, and the rest (BEE2's own packages
 * BeePM downloaded, imported ones) into the packages folder if BEE2 doesn't have them already,
 * so BEE2 loads the same packages as before. Copies of what BEE2 has go to BeePM's backups,
 * except exact ones: BEE2's own packages BeePM downloaded, and imported copies whose original
 * file is unchanged. Those are deleted.
 * BEE2's setting goes back as soon as BEE2 is closed (it writes its config.cfg back when it
 * exits), even before BeePM knows where BEE2 is. Moving the packages needs BEE2's folder (found
 * from the hook's old setting or `program`, the running BEE2.exe, if it isn't chosen yet).
 * Returns null if there's nothing to do, else { done, waitingFor?: "folder" | "bee2", restored?,
 * moved? }: restored is the setting put back by this call (null: BEE2's default), moved how many
 * of BeePM's packages moved.
 */
export async function leaveHook(ctx, { program = null, running = false } = {}) {
    const { paths } = ctx
    const { config, text, hooked, leftover } = await readHook(ctx)
    if (!hooked && !config.hook && !leftover) return null

    const result = { done: false }
    if (hooked && !running) {
        let original = config.hook ? config.hook.originalPackageDir : undefined
        if (original === undefined) {
            // The earliest builds kept a whole copy of config.cfg instead
            const backup = await readFile(`${ctx.bee2.configFile}.backup`, "utf8").catch(() => null)
            const value = backup ? getIniValue(backup, "Directories", "package") : null
            original = samePath(value, paths.hookedPackages) ? null : value
        }
        // A folder that's gone (an old setup) would leave BEE2 without packages
        if (original && path.isAbsolute(original) && !(await exists(original))) original = null
        await writeFile(
            ctx.bee2.configFile,
            original
                ? setIniValue(text, "Directories", "package", original)
                : removeIniKey(text, "Directories", "package"), // BEE2 falls back to its default
        )
        result.restored = original ?? null
    }
    // BEE2 has the hooked packages open, and would write the hooked setting back when it closes
    const waitForBee2 = { done: false, waitingFor: "bee2" }
    // Only the setting was left (BeePM's packages moved already)
    if (!config.hook && !leftover)
        return hooked && running ? waitForBee2 : { ...result, done: true, moved: 0 }

    if (!paths.bee2Dir) {
        const original = config.hook?.originalPackageDir
        const guesses = [
            original && path.isAbsolute(original) ? original : null,
            program ? path.dirname(program) : null,
        ]
        for (const guess of guesses.filter(Boolean)) {
            const dir = await findBee2Folder(guess).catch(() => null)
            if (dir) {
                await setBee2Folder(ctx, dir)
                break
            }
        }
    }
    if (hooked && running) return waitForBee2
    // The hook's old setting stays in config.json to find BEE2's folder with later
    if (!paths.bee2Dir) return { ...result, waitingFor: "folder" }

    const installed = await loadInstalled(paths)
    let moved = 0
    if (leftover) {
        for (const entry of Object.values(installed.packages)) {
            const from = path.join(paths.hookedPackages, entry.file)
            const to = path.join(paths.packages, entry.file)
            if ((await exists(from)) && !(await exists(to))) {
                await moveFile(from, to)
                moved++
            }
        }
        const bee2Packages = bee2PackagesDir(paths.bee2Dir)
        const inBee2 = new Set(
            (await scanPackages(bee2Packages, { skip: [paths.packages] }))
                .map((p) => p.id)
                .filter(Boolean),
        )
        const downloaded = new Set((config.bee2?.baseFiles ?? []).map((f) => f.toLowerCase()))
        // Imported copies, by file: one is spare if the file it came from is still the same
        const imported = new Map(
            Object.values(installed.local).map((entry) => [
                String(entry.file).toLowerCase(),
                entry,
            ]),
        )
        const unchanged = async (entry) =>
            Boolean(entry?.from && entry.sha256) &&
            (await stat(entry.from).catch(() => null))?.isFile() === true &&
            (await hashFile(entry.from)) === entry.sha256
        for (const pkg of await scanPackages(paths.hookedPackages)) {
            if (!pkg.id) continue
            const top = path.relative(paths.hookedPackages, pkg.path).split(path.sep)[0]
            if (!inBee2.has(pkg.id)) {
                await moveFile(pkg.path, await freePath(bee2Packages, path.basename(pkg.path)))
                inBee2.add(pkg.id)
            } else if (
                downloaded.has(top.toLowerCase()) ||
                (await unchanged(imported.get(top.toLowerCase())))
            ) {
                await rm(pkg.path, { recursive: true, force: true }) // BEE2 has the very same
            } else {
                await moveFile(pkg.path, await freePath(paths.replaced, path.basename(pkg.path)))
            }
        }
        await removeEmptyFolders(paths.hookedPackages)
    }

    // What the hook and BEE2's downloaded packages needed is gone (setBee2Folder may have saved)
    const latest = await loadConfig(paths)
    delete latest.hook
    latest.bee2 = { dir: paths.bee2Dir, version: latest.bee2?.version ?? null }
    await saveConfig(paths, latest)
    if (Object.keys(installed.local).length) {
        installed.local = {}
        await saveInstalled(paths, installed)
    }
    return { ...result, done: true, moved }
}
