import { createWriteStream } from "node:fs"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import yauzl from "yauzl"
import { readInfoTxt } from "../infotxt.js"
import { readPack } from "../pack.js"
import { downloadFile } from "./download.js"

/** A problem with the user's BEE2 setup, with a message meant for them. */
export class Bee2Error extends Error {}

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
 * Close BEE2 first: it rewrites config.cfg when it exits.
 */
export async function hookBee2(paths, bee2, config) {
    let text = await readBee2Config(bee2)
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
    if (samePath(current, paths.packages)) return { changed: false }

    if (!config.hook)
        config.hook = { originalPackageDir: current, hookedAt: new Date().toISOString() }
    await writeFile(bee2.configFile, setIniValue(text, "Directories", "package", paths.packages))
    return { changed: true, previous: current }
}

/** Puts BEE2's package folder back to what it was before BeePM hooked it. */
export async function unhookBee2(paths, bee2, config) {
    const text = await readBee2Config(bee2)
    const current = text === null ? null : getIniValue(text, "Directories", "package")
    if (!samePath(current, paths.packages)) {
        delete config.hook
        return { changed: false }
    }

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
    return { changed: true, restored: original ?? null }
}

// ---------- BEE2 versions and base packages ----------

const GITHUB = "https://api.github.com/repos/BEEmod"

async function githubJson(fetch, url) {
    const res = await fetch(url, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "BeePM" },
    })
    if (res.status === 403 || res.status === 429) {
        throw new Bee2Error("GitHub's rate limit was hit. Wait a few minutes and try again.")
    }
    if (!res.ok) throw new Bee2Error(`GitHub returned HTTP ${res.status}.`)
    return res.json()
}

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

/** Extracts a zip into a folder. Returns the top-level names it created. */
async function extractZip(zipPath, destination, onEntry) {
    const zipfile = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: false })
    const top = new Set()
    try {
        for await (const entry of zipfile.eachEntry()) {
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
 * Downloads BEE2's own packages (BEE2-items) for a BEE2 version into the packages folder,
 * replacing the ones from a previous setup. Records them in config.bee2. Mutates `config`.
 * onProgress({ step: "download" | "extract", asset, received, total })
 */
export async function installBasePackages(
    paths,
    config,
    { version, name = null, includeMusic = true, fetch = globalThis.fetch, onProgress } = {},
) {
    const release = await findItemsRelease({ fetch }, version)
    const assets = release.assets.filter(
        (a) => a.name.toLowerCase().endsWith(".zip") && (includeMusic || !/music/i.test(a.name)),
    )
    if (!assets.length)
        throw new Bee2Error(`BEE2-items ${release.tag_name} has no package downloads.`)

    await mkdir(paths.packages, { recursive: true })
    for (const file of config.bee2?.baseFiles ?? []) {
        await rm(path.join(paths.packages, file), { recursive: true, force: true })
    }

    const files = new Set()
    for (const asset of assets) {
        const zipPath = path.join(paths.cache, asset.name)
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
