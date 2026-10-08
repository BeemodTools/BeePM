import { createWriteStream } from "node:fs"
import { rm } from "node:fs/promises"
import { pipeline } from "node:stream/promises"
import zlib from "node:zlib"
import yauzl from "yauzl"
import yazl from "yazl"
import { readEntryBytes } from "../pack.js"
import { freePath } from "./files.js"

/**
 * Zips in BEE2's packages folder the way BEE2 sees them: BEE2 reads them with Python's zipfile,
 * so it can't use one that's cut short, password-protected, packed with compression Python
 * doesn't read, damaged inside, or without an info.txt at its top. A zip whose info.txt is in a
 * folder inside it (a GitHub "Download ZIP", a few packages zipped together) can be fixed: each
 * of those folders becomes a package of its own (repackFolders).
 */

// What Python's zipfile reads: stored, deflate, bzip2, LZMA
const BEE2_METHODS = new Set([0, 8, 12, 14])
const METHOD_NAMES = { 9: "Deflate64", 93: "Zstandard", 95: "XZ", 98: "PPMd", 99: "AES" }
const LZMA = 14

/** Why BEE2 can't use a zip: { kind, message, folders? }. */
const problems = {
    unreadable: () => ({
        kind: "unreadable",
        message: "It isn't a zip, or it's cut short (a download that didn't finish?)",
    }),
    encrypted: () => ({ kind: "encrypted", message: "It's password-protected" }),
    compression: (method) => ({
        kind: "compression",
        message: `It's packed with ${METHOD_NAMES[method] ?? `type ${method}`} compression, which BEE2 can't read`,
    }),
    damaged: (name) => ({
        kind: "damaged",
        message: name
            ? `"${name}" in it is damaged`
            : "It's damaged: its list of files can't be read",
    }),
    noInfo: () => ({ kind: "no-info", message: "It has no info.txt, so it isn't a package" }),
    nested: (folders) => ({
        kind: "nested",
        folders,
        message:
            folders.length === 1
                ? `Its info.txt is in the folder "${folders[0]}" inside it, where BEE2 doesn't look`
                : `It has ${folders.length} packages in folders inside it (${folders.map((f) => `"${f}"`).join(", ")}), where BEE2 doesn't look`,
    }),
}

/** The folders with an info.txt that aren't inside another one ("a/b/info.txt" -> "a/b"). */
function packageFolders(infoFiles) {
    const folders = infoFiles.map((name) => name.slice(0, -"/info.txt".length)).sort()
    return folders.filter(
        (folder, i) => !folders.slice(0, i).some((other) => folder.startsWith(`${other}/`)),
    )
}

/** Whether an entry unpacks to what its checksum says (an error unpacking it: no). */
async function intact(zip, entry) {
    const stream = await zip.openReadStreamPromise(entry)
    let crc = 0
    for await (const chunk of stream) crc = zlib.crc32(chunk, crc)
    return crc >>> 0 === entry.crc32 >>> 0
}

/**
 * How BEE2 would see a zip: { infoText (its info.txt, at the top), problem (see problems above,
 * or null) }. deep: every file is unpacked and checked against its checksum too (stored and
 * deflated ones; BEE2's own LZMA-packed files aren't); slower, so the scan remembers it.
 */
export async function inspectBee2Zip(file, { deep = false, maxInfoBytes = 16 * 1024 * 1024 } = {}) {
    let zip
    try {
        zip = await yauzl.openPromise(file, { lazyEntries: true, autoClose: false })
    } catch {
        return { infoText: null, problem: problems.unreadable() }
    }
    try {
        const entries = []
        try {
            for await (const entry of zip.eachEntry()) entries.push(entry)
        } catch {
            return { infoText: null, problem: problems.damaged(null) }
        }
        const files = entries.filter((entry) => !entry.fileName.endsWith("/"))
        if (files.some((entry) => entry.generalPurposeBitFlag & 1)) {
            return { infoText: null, problem: problems.encrypted() }
        }
        const unreadable = files.find((entry) => !BEE2_METHODS.has(entry.compressionMethod))
        if (unreadable) {
            return { infoText: null, problem: problems.compression(unreadable.compressionMethod) }
        }
        if (deep) {
            for (const entry of files) {
                if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) continue
                const fine = await intact(zip, entry).catch(() => false)
                if (!fine) return { infoText: null, problem: problems.damaged(entry.fileName) }
            }
        }
        const info = files.find((entry) => entry.fileName.toLowerCase() === "info.txt")
        if (info) {
            if (info.uncompressedSize > maxInfoBytes) return { infoText: "", problem: null }
            try {
                return {
                    infoText: (await readEntryBytes(zip, info)).toString("utf8"),
                    problem: null,
                }
            } catch {
                return { infoText: null, problem: problems.damaged(info.fileName) }
            }
        }
        const nested = packageFolders(
            files.map((entry) => entry.fileName).filter((name) => /\/info\.txt$/i.test(name)),
        )
        return {
            infoText: null,
            problem: nested.length ? problems.nested(nested) : problems.noInfo(),
        }
    } finally {
        zip.close()
    }
}

/**
 * Makes a package of each folder (as inspectBee2Zip found them) in a zip: a .bee_pack named
 * after the folder in `outDir`, with what's in the folder at its top. Returns their paths; if
 * one can't be made, none are left behind.
 */
export async function repackFolders(file, folders, outDir) {
    const created = []
    try {
        for (const folder of folders) {
            const name =
                folder
                    .split("/")
                    .pop()
                    .replace(/[<>:"/\\|?*]/g, "_")
                    .trim() || "package"
            const target = await freePath(outDir, `${name}.bee_pack`)
            created.push(target)
            await repackFolder(file, `${folder}/`, target)
        }
        return created
    } catch (err) {
        for (const target of created) await rm(target, { force: true }).catch(() => {})
        throw err
    }
}

async function repackFolder(file, prefix, target) {
    const zip = await yauzl.openPromise(file, { lazyEntries: true, autoClose: false })
    try {
        const out = new yazl.ZipFile()
        const written = pipeline(out.outputStream, createWriteStream(target))
        for await (const entry of zip.eachEntry()) {
            const name = entry.fileName
            if (!name.startsWith(prefix) || name.endsWith("/")) continue
            const options = {
                mtime: entry.getLastModDate(),
                compress: entry.compressionMethod !== 0,
            }
            // LZMA can't be streamed: those are unpacked in memory (they're small, BEE2's own)
            if (entry.compressionMethod === LZMA) {
                out.addBuffer(await readEntryBytes(zip, entry), name.slice(prefix.length), options)
            } else {
                out.addReadStream(
                    await zip.openReadStreamPromise(entry),
                    name.slice(prefix.length),
                    {
                        ...options,
                        size: entry.uncompressedSize,
                    },
                )
            }
        }
        out.end()
        await written
    } finally {
        zip.close()
    }
}
