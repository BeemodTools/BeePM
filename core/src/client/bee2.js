import { execFile } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import yauzl from "yauzl"
import { readInfoTxt } from "../infotxt.js"
import { readPack } from "../pack.js"
import { downloadFile } from "./download.js"
import { getGithubJson } from "./github.js"

/** A problem with the user's BEE2 setup, with a message meant for them. */
export class Bee2Error extends Error {}

/**
 * Force-closes BEE2 (BEE2.exe and its child processes) if it's running. BEE2 saves its
 * settings when it exits normally, which would undo a hook; a forced close doesn't save,
 * and it also lets go of the package files. Resolves to true if BEE2 was running.
 * BEEPM_NO_CLOSE_BEE2=1 turns this off (tests).
 */
export function closeBee2() {
    if (process.env.BEEPM_NO_CLOSE_BEE2) return Promise.resolve(false)
    const [command, args] =
        process.platform === "win32"
            ? ["taskkill", ["/F", "/T", "/IM", "BEE2.exe"]]
            : ["pkill", ["-x", "BEE2"]]
    return new Promise((resolve) => {
        execFile(command, args, { windowsHide: true }, (err) => {
            if (err) return resolve(false) // Not running
            // Give Windows a moment to release BEE2's file handles
            setTimeout(() => resolve(true), 500)
        })
    })
}

/** Whether BEE2 is running (BEE2.exe on Windows, a BEE2 process elsewhere). */
export function isBee2Running() {
    const [command, args] =
        process.platform === "win32"
            ? ["tasklist", ["/FI", "IMAGENAME eq BEE2.exe", "/FO", "CSV", "/NH"]]
            : ["pgrep", ["-x", "BEE2"]]
    return new Promise((resolve) => {
        execFile(command, args, { windowsHide: true }, (err, stdout) => {
            if (process.platform !== "win32") return resolve(!err)
            resolve(!err && /"BEE2\.exe"/i.test(String(stdout)))
        })
    })
}

/** The program file of the running BEE2 (to open it again after updating), or null. */
export function findBee2Program() {
    if (process.platform !== "win32") return Promise.resolve(null)
    const script =
        "(Get-Process -Name BEE2 -ErrorAction SilentlyContinue | Select-Object -First 1).Path"
    return new Promise((resolve) => {
        execFile(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-Command", script],
            { windowsHide: true },
            (err, stdout) => {
                const file = String(stdout ?? "").trim()
                resolve(!err && file ? file : null)
            },
        )
    })
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

const normalize = (p) => {
    const resolved = path.resolve(String(p).trim())
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
}
const samePath = (a, b) => Boolean(a) && Boolean(b) && normalize(a) === normalize(b)

async function readBee2Config(bee2) {
    try {
        return (await readFile(bee2.configFile, "utf8")).replace(/^﻿/, "")
    } catch (err) {
        if (err.code === "ENOENT") return null
        throw err
    }
}

/** Whether BEE2 currently loads packages from BeePM's folder. */
export async function bee2Status(paths, bee2) {
    const text = await readBee2Config(bee2)
    const packageDir = text === null ? null : getIniValue(text, "Directories", "package")
    return {
        configFound: text !== null,
        packageDir,
        hooked: samePath(packageDir, paths.packages),
    }
}

/**
 * Points BEE2's package folder at BeePM's. The previous value is stored in
 * config.hook so unhook can put it back. Mutates `config`; the caller saves it.
 * BEE2 is closed first if it's running (closedBee2 in the result says so).
 */
export async function hookBee2(paths, bee2, config, { close = closeBee2 } = {}) {
    let text = await readBee2Config(bee2)
    if (text !== null && samePath(getIniValue(text, "Directories", "package"), paths.packages)) {
        await mkdir(paths.packages, { recursive: true })
        return { changed: false, closedBee2: false }
    }
    const closedBee2 = await close()
    text = await readBee2Config(bee2)
    if (text === null) {
        const dir = await stat(bee2.configDir).catch(() => null)
        if (!dir) {
            throw new Bee2Error(
                "BEE2's settings weren't found. Install BEE2 and open it once, then try again.",
            )
        }
        text = ""
    }
    const current = getIniValue(text, "Directories", "package")
    await mkdir(paths.packages, { recursive: true })
    if (samePath(current, paths.packages)) return { changed: false, closedBee2 }

    if (!config.hook)
        config.hook = { originalPackageDir: current, hookedAt: new Date().toISOString() }
    await writeFile(bee2.configFile, setIniValue(text, "Directories", "package", paths.packages))
    return { changed: true, previous: current, closedBee2 }
}

/**
 * Puts BEE2's package folder back to what it was before BeePM hooked it.
 * BEE2 is closed first if it's running (closedBee2 in the result says so).
 */
export async function unhookBee2(paths, bee2, config, { close = closeBee2 } = {}) {
    let text = await readBee2Config(bee2)
    let current = text === null ? null : getIniValue(text, "Directories", "package")
    if (!samePath(current, paths.packages)) {
        delete config.hook
        return { changed: false, closedBee2: false }
    }
    const closedBee2 = await close()
    text = (await readBee2Config(bee2)) ?? ""
    current = getIniValue(text, "Directories", "package")

    let original = config.hook ? config.hook.originalPackageDir : undefined
    if (original === undefined) {
        // Earlier BeePM versions kept a whole copy of config.cfg instead
        const backup = await readFile(`${bee2.configFile}.backup`, "utf8").catch(() => null)
        const value = backup ? getIniValue(backup, "Directories", "package") : null
        original = samePath(value, paths.packages) ? null : value
    }
    const next = original
        ? setIniValue(text, "Directories", "package", original)
        : removeIniKey(text, "Directories", "package") // BEE2 falls back to its default folder
    await writeFile(bee2.configFile, next)
    delete config.hook
    return { changed: true, restored: original ?? null, closedBee2 }
}

// ---------- BEE2 versions and base packages ----------

const GITHUB = "https://api.github.com/repos/BEEmod"

// BEE2's releases rarely change: asked for at most every half hour (see getGithubJson)
const githubJson = (fetch, url) =>
    getGithubJson(fetch, url, { maxAge: 30 * 60 * 1000, ErrorType: Bee2Error })

/** Recent BEE2 releases: [{ version: "2.4.46.1", name: "Version 4.46.1", publishedAt }]. */
export async function listBee2Releases({ fetch = globalThis.fetch } = {}) {
    const releases = await githubJson(fetch, `${GITHUB}/BEE2.4/releases?per_page=30`)
    return releases
        .filter((r) => !r.draft && !r.prerelease)
        .map((r) => ({
            version: r.tag_name.replace(/^v/i, ""),
            name: r.name || r.tag_name,
            publishedAt: r.published_at,
        }))
}

/** BEE2 2.4.<minor>.x uses BEE2-items v4.<minor>.*: picks the newest of those. */
export async function findItemsRelease({ fetch = globalThis.fetch } = {}, bee2Version) {
    const minor = Number(String(bee2Version).replace(/^v/i, "").split(".")[2])
    if (!Number.isInteger(minor))
        throw new Bee2Error(`"${bee2Version}" isn't a BEE2 version like 2.4.46.1.`)
    const releases = await githubJson(fetch, `${GITHUB}/BEE2-items/releases?per_page=100`)
    const matching = releases
        .filter((r) => !r.draft && !r.prerelease)
        .map((r) => ({ release: r, match: /^v?4\.(\d+)\.(\d+)$/.exec(r.tag_name) }))
        .filter(({ match }) => match && Number(match[1]) === minor)
        .sort((a, b) => Number(b.match[2]) - Number(a.match[2]))
    if (!matching.length)
        throw new Bee2Error(`There's no BEE2-items release for BEE2 ${bee2Version}.`)
    return matching[0].release
}

// No real BEE2-items zip comes close to these
const MAX_ZIP_ENTRIES = 100000
const MAX_EXTRACTED_BYTES = 8 * 1024 ** 3

/**
 * Extracts a zip into a folder. Returns the top-level names it created. yauzl refuses entry
 * names that leave the folder, and checks each entry's size against what the zip says.
 */
async function extractZip(zipPath, destination, onEntry) {
    const zipfile = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: false })
    const top = new Set()
    let entries = 0
    let bytes = 0
    try {
        for await (const entry of zipfile.eachEntry()) {
            entries++
            bytes += entry.uncompressedSize
            if (entries > MAX_ZIP_ENTRIES || bytes > MAX_EXTRACTED_BYTES) {
                throw new Bee2Error(`${path.basename(zipPath)} is too large to be BEE2's packages.`)
            }
            const target = path.join(destination, entry.fileName)
            top.add(entry.fileName.split("/")[0])
            if (entry.fileName.endsWith("/")) {
                await mkdir(target, { recursive: true })
                continue
            }
            await mkdir(path.dirname(target), { recursive: true })
            await pipeline(await zipfile.openReadStreamPromise(entry), createWriteStream(target))
            onEntry?.(entry.fileName)
        }
    } finally {
        zipfile.close()
    }
    return [...top]
}

/** The BEE2 IDs of package files in a folder: Map(id -> file name). */
export async function scanPackageIds(folder, fileNames = null) {
    const ids = new Map()
    const names = fileNames ?? (await readdir(folder).catch(() => []))
    for (const name of names) {
        if (!/\.(bee_pack|zip)$/i.test(name)) continue
        try {
            const { infoText } = await readPack(path.join(folder, name))
            if (infoText) ids.set(readInfoTxt(infoText).id, name)
        } catch {
            // Not a readable package: ignore it
        }
    }
    return ids
}

/**
 * Fills in config.bee2.basePackages from the base package files when it's empty (setups made
 * before BeePM could read BEE2's LZMA-compressed packages). Returns true if it changed config.
 */
export async function refreshBaseIds(paths, config) {
    const bee2 = config.bee2
    if (!bee2?.baseFiles?.length || bee2.basePackages?.length) return false
    const ids = await scanPackageIds(paths.packages, bee2.baseFiles)
    if (!ids.size) return false
    bee2.basePackages = [...ids.keys()].sort()
    return true
}

/**
 * Downloads BEE2's own packages (BEE2-items) for a BEE2 version into the packages folder,
 * replacing the ones from a previous setup. Records them in config.bee2. Mutates `config`.
 * BEE2 is closed first if it's running, since it keeps its package files open.
 * onProgress gets, in order:
 *   { step: "plan", assets: [{ name, size }] }   every download, before the first one starts
 *   { step: "closed-bee2" }                      only if BEE2 had to be closed
 *   { step: "download" | "extract", asset, received, total }
 */
export async function installBasePackages(
    paths,
    config,
    {
        version,
        name = null,
        includeMusic = true,
        fetch = globalThis.fetch,
        onProgress,
        close = closeBee2,
    } = {},
) {
    const release = await findItemsRelease({ fetch }, version)
    const isMusic = (asset) => /music/i.test(asset.name)
    const assets = release.assets
        .filter((a) => a.name.toLowerCase().endsWith(".zip") && (includeMusic || !isMusic(a)))
        // The packages first, the optional music last
        .sort((a, b) => Number(isMusic(a)) - Number(isMusic(b)))
    if (!assets.length)
        throw new Bee2Error(`BEE2-items ${release.tag_name} has no package downloads.`)
    onProgress?.({ step: "plan", assets: assets.map((a) => ({ name: a.name, size: a.size })) })

    if (await close()) onProgress?.({ step: "closed-bee2" })
    await mkdir(paths.packages, { recursive: true })
    for (const file of config.bee2?.baseFiles ?? []) {
        await rm(path.join(paths.packages, file), { recursive: true, force: true })
    }

    const files = new Set()
    for (const asset of assets) {
        const zipPath = path.join(paths.cache, path.basename(asset.name))
        await downloadFile(asset.browser_download_url, zipPath, {
            fetch,
            expectedSize: asset.size,
            onProgress: (received, total) =>
                onProgress?.({ step: "download", asset: asset.name, received, total }),
        })
        let done = 0
        for (const top of await extractZip(zipPath, paths.packages, () =>
            onProgress?.({ step: "extract", asset: asset.name, received: ++done, total: 0 }),
        )) {
            files.add(top)
        }
        await rm(zipPath, { force: true })
    }

    const ids = await scanPackageIds(paths.packages, [...files])
    config.bee2 = {
        version: String(version).replace(/^v/i, ""),
        name,
        itemsTag: release.tag_name,
        basePackages: [...ids.keys()].sort(),
        baseFiles: [...files].sort(),
        installedAt: new Date().toISOString(),
    }
    return config.bee2
}
