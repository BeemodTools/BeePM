import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { parseKeyValues } from "../infotxt.js"
import { inspectBee2Zip } from "./bee2zip.js"
import { exists, readJson, writeJson } from "./files.js"

/**
 * The packages in a folder, found the way BEE2 finds them: .bee_pack and .zip files and folders
 * with an info.txt, also in folders inside it that aren't packages themselves. Used on BEE2's
 * packages folder (what's in it besides BeePM's packages, and duplicates BEE2 refuses to load).
 */

const MAX_DEPTH = 4 // folders inside folders... inside the folder scanned
const READS_AT_ONCE = 4
// BEE2's own packages can have a bigger info.txt than BeePM accepts for publishing
const MAX_INFO_BYTES = 16 * 1024 * 1024
const isPackFile = (name) => /\.(bee_pack|zip)$/i.test(name)
// Bumped when what's read from a package changes, so older cache files are read again
const CACHE_VERSION = 2
const key = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p))

/** Runs fn over every item, `limit` at a time. The results keep the items' order. */
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length)
    let next = 0
    async function worker() {
        while (next < items.length) {
            const index = next++
            results[index] = await fn(items[index], index)
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return results
}

const textValue = (pairs, key) =>
    pairs.find((p) => p.key.toLowerCase() === key && typeof p.value === "string")?.value.trim() ||
    null

/**
 * What a package's info.txt says: { id, name, items }. IDs are uppercased (BEE2 ignores case)
 * and taken as they are: BEE2 loads IDs BeePM wouldn't accept for publishing.
 */
export function readPackageInfo(infoText) {
    const text = String(infoText).replace(/^﻿/, "")
    let pairs
    try {
        pairs = parseKeyValues(text)
    } catch {
        // A slightly broken file: the ID line still tells which package it is
        const match = /^[ \t]*"ID"[ \t]+"([^"\r\n]+)"/im.exec(text)
        if (!match?.[1].trim()) throw new Error("info.txt couldn't be read")
        return { id: match[1].trim().toUpperCase(), name: null, items: [] }
    }
    const id = textValue(pairs, "id")
    if (!id) throw new Error('info.txt has no "ID"')
    const items = new Set()
    for (const pair of pairs) {
        if (pair.key.toLowerCase() !== "item" || !Array.isArray(pair.value)) continue
        const item = textValue(pair.value, "id")
        if (item) items.add(item.toUpperCase())
    }
    return { id: id.toUpperCase(), name: textValue(pairs, "name"), items: [...items] }
}

/** What's read from a package (see scanPackages); `checked`: a zip's files were all checked. */
async function readPackage(target, isFolder, deep) {
    let text
    if (isFolder) {
        text = await readFile(path.join(target, "info.txt"), "utf8").catch(() => null)
        if (text === null) {
            return { problem: { kind: "unreadable", message: "Its info.txt can't be read" } }
        }
    } else {
        const zip = await inspectBee2Zip(target, { deep, maxInfoBytes: MAX_INFO_BYTES })
        if (zip.problem) return { problem: zip.problem, checked: deep }
        text = zip.infoText
    }
    try {
        return { ...readPackageInfo(text), checked: deep || isFolder }
    } catch (err) {
        return { problem: { kind: "bad-info", message: `Its ${err.message}` }, checked: deep }
    }
}

/**
 * Every package in `folder`: [{ path, isFolder, id, name, items, modified }], or { path,
 * isFolder, problem: { kind, message, folders? } } for one BEE2 can't load (see bee2zip.js).
 * `modified` is when the file (a folder's info.txt) last changed. Folders in `skip` aren't
 * looked into. deep: every file in the zips is checked too (slower). cacheFile remembers what
 * was read, by path, size and time, so a second scan only reads what changed (and, deep, what
 * wasn't checked before).
 * onProgress({ done, total })
 */
export async function scanPackages(
    folder,
    { skip = [], cacheFile = null, deep = false, onProgress } = {},
) {
    const skipped = new Set(skip.filter(Boolean).map(key))
    const candidates = [] // [path, isFolder]
    async function walk(dir, depth) {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
        entries.sort((a, b) => a.name.localeCompare(b.name))
        for (const entry of entries) {
            if (entry.name.startsWith(".")) continue
            const full = path.join(dir, entry.name)
            if (entry.isFile() && isPackFile(entry.name)) candidates.push([full, false])
            else if (entry.isDirectory() && !skipped.has(key(full))) {
                if (await exists(path.join(full, "info.txt"))) candidates.push([full, true])
                else if (depth < MAX_DEPTH) await walk(full, depth + 1)
            }
        }
    }
    await walk(folder, 1)

    const saved = cacheFile ? await readJson(cacheFile, null) : null
    const cached = saved?.version === CACHE_VERSION ? (saved.packages ?? {}) : {}
    const fresh = {}
    let done = 0
    onProgress?.({ done, total: candidates.length })
    const found = await mapLimit(candidates, READS_AT_ONCE, async ([full, isFolder]) => {
        const info = await stat(isFolder ? path.join(full, "info.txt") : full).catch(() => null)
        let entry = cached[full]
        if (!info) entry = { problem: { kind: "unreadable", message: "It can't be read" } }
        else if (
            entry?.size !== info.size ||
            entry?.modified !== info.mtimeMs ||
            (deep && !entry.checked)
        ) {
            entry = {
                size: info.size,
                modified: info.mtimeMs,
                ...(await readPackage(full, isFolder, deep)),
            }
        }
        fresh[full] = entry
        onProgress?.({ done: ++done, total: candidates.length })
        return { path: full, isFolder, ...entry }
    })

    if (cacheFile) {
        // What's cached for other folders stays; what's gone from this one is forgotten
        const inside = key(folder) + path.sep
        const others = Object.fromEntries(
            Object.entries(cached).filter(([file]) => !key(file).startsWith(inside)),
        )
        await writeJson(cacheFile, {
            version: CACHE_VERSION,
            packages: { ...others, ...fresh },
        }).catch(() => {})
    }
    return found
}
