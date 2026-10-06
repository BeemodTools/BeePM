import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import yauzl from "yauzl"
import yazl from "yazl"
import { readInfoTxt } from "./infotxt.js"
import { MANIFEST_FILE, parseManifestText, validateManifest } from "./manifest.js"

/** The only file types a .bee_pack may contain (BeePM 1's list, plus model .ani files). */
export const ALLOWED_EXTENSIONS = new Set([
    ".txt",
    ".vtf",
    ".vmt",
    ".mdl",
    ".vvd",
    ".vtx",
    ".phy",
    ".ani",
    ".3ds",
    ".wav",
    ".mp3",
    ".vcd",
    ".pcf",
    ".vmf",
    ".vmx",
    ".cfg",
    ".json",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".tga",
    ".webp",
    ".nut",
])
export const MAX_ENTRIES = 50000
const MAX_INFO_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 256 * 1024

export const isAllowedFile = (fileName) =>
    ALLOWED_EXTENSIONS.has(path.posix.extname(fileName).toLowerCase())

/** Thrown when a .bee_pack can't be published; `problems` lists every reason. */
export class PackError extends Error {
    constructor(problems, details = {}) {
        super(`This package can't be published:\n- ${problems.join("\n- ")}`)
        this.problems = problems
        Object.assign(this, details)
    }
}

/** SHA-256 of a file, as hex. */
export async function hashFile(filePath) {
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(filePath)) hash.update(chunk)
    return hash.digest("hex")
}

async function readEntryText(zipfile, entry, maxBytes, label) {
    if (entry.uncompressedSize > maxBytes) {
        throw new PackError([`${label} is larger than ${Math.round(maxBytes / 1024)} KB`])
    }
    const stream = await zipfile.openReadStreamPromise(entry)
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    return Buffer.concat(chunks).toString("utf8")
}

/**
 * Lists a .bee_pack's files without extracting it, and reads info.txt and
 * bee-package.json from its root (matched case-insensitively).
 */
export async function readPack(filePath) {
    let zipfile
    try {
        zipfile = await yauzl.openPromise(filePath, { lazyEntries: true, autoClose: false })
    } catch (err) {
        throw new PackError([`it isn't a valid zip file (${err.message})`])
    }

    const files = []
    const disallowed = []
    let uncompressedSize = 0
    let infoEntry = null
    let manifestEntry = null
    try {
        for await (const entry of zipfile.eachEntry()) {
            if (entry.fileName.endsWith("/")) continue
            if (files.length >= MAX_ENTRIES) {
                throw new PackError([`it has more than ${MAX_ENTRIES} files`])
            }
            files.push(entry.fileName)
            uncompressedSize += entry.uncompressedSize
            const lower = entry.fileName.toLowerCase()
            if (lower === "info.txt") infoEntry = entry
            else if (lower === MANIFEST_FILE) manifestEntry = entry
            if (!isAllowedFile(entry.fileName)) disallowed.push(entry.fileName)
        }
        const infoText = infoEntry
            ? await readEntryText(zipfile, infoEntry, MAX_INFO_BYTES, "info.txt")
            : null
        const manifestText = manifestEntry
            ? await readEntryText(zipfile, manifestEntry, MAX_MANIFEST_BYTES, MANIFEST_FILE)
            : null
        return { files, disallowed, uncompressedSize, infoText, manifestText }
    } catch (err) {
        if (err instanceof PackError) throw err
        throw new PackError([`it couldn't be read (${err.message})`])
    } finally {
        zipfile.close()
    }
}

const listSome = (names, max = 10) =>
    names.slice(0, max).join(", ") + (names.length > max ? ` and ${names.length - max} more` : "")

/**
 * Runs every check the registry runs on publish. Returns
 *   { beeId, info, manifest, files, disallowed, uncompressedSize }
 * and throws a PackError listing every problem. Files of other types are a problem
 * unless allowDisallowed is set (clients strip them with stripPack first).
 */
export async function checkPack(filePath, { defaultScope = null, allowDisallowed = false } = {}) {
    const pack = await readPack(filePath)
    const problems = []

    let info = null
    if (pack.infoText === null) problems.push("info.txt is missing from the root of the package")
    else {
        try {
            info = readInfoTxt(pack.infoText)
        } catch (err) {
            problems.push(err.message)
        }
    }

    let manifest = null
    if (pack.manifestText === null) {
        problems.push(`${MANIFEST_FILE} is missing from the root of the package`)
    } else {
        try {
            manifest = validateManifest(parseManifestText(pack.manifestText), { defaultScope })
        } catch (err) {
            for (const p of err.problems ?? [err.message]) problems.push(`${MANIFEST_FILE}: ${p}`)
        }
    }

    if (!allowDisallowed && pack.disallowed.length) {
        problems.push(
            `it contains ${pack.disallowed.length} file(s) of types BEE2 packages can't include: ${listSome(pack.disallowed)}`,
        )
    }

    if (problems.length) throw new PackError(problems, { disallowed: pack.disallowed })
    return {
        beeId: info.id,
        info,
        manifest,
        files: pack.files,
        disallowed: pack.disallowed,
        uncompressedSize: pack.uncompressedSize,
    }
}

/** Writes a copy of a zip without the named entries. */
export async function stripPack(sourcePath, destinationPath, removeNames) {
    const remove = new Set(removeNames)
    const zipfile = await yauzl.openPromise(sourcePath, { lazyEntries: true, autoClose: false })
    try {
        const entries = []
        for await (const entry of zipfile.eachEntry()) entries.push(entry)

        const out = new yazl.ZipFile()
        const written = pipeline(out.outputStream, createWriteStream(destinationPath))
        for (const entry of entries) {
            if (remove.has(entry.fileName)) continue
            const options = { mtime: entry.getLastModDate() }
            if (entry.fileName.endsWith("/")) {
                out.addEmptyDirectory(entry.fileName, options)
            } else {
                out.addReadStreamLazy(entry.fileName, options, (callback) =>
                    zipfile.openReadStream(entry, callback),
                )
            }
        }
        out.end()
        await written
    } finally {
        zipfile.close()
    }
}

/**
 * Zips a package folder into a .bee_pack. Files of disallowed types and hidden files or
 * folders (like .git) are left out. Returns { added, skipped } as relative paths.
 */
export async function packFolder(folder, destinationPath) {
    const added = []
    const skipped = []
    const out = new yazl.ZipFile()
    const written = pipeline(out.outputStream, createWriteStream(destinationPath))

    async function walk(dir, prefix) {
        const entries = await readdir(dir, { withFileTypes: true })
        entries.sort((a, b) => a.name.localeCompare(b.name))
        for (const entry of entries) {
            const relative = prefix + entry.name
            if (entry.name.startsWith(".")) {
                skipped.push(relative + (entry.isDirectory() ? "/" : ""))
            } else if (entry.isDirectory()) {
                await walk(path.join(dir, entry.name), relative + "/")
            } else if (entry.isFile() && isAllowedFile(entry.name)) {
                const full = path.join(dir, entry.name)
                const info = await stat(full)
                out.addFile(full, relative, { mtime: info.mtime })
                added.push(relative)
            } else {
                skipped.push(relative)
            }
        }
    }

    try {
        await walk(folder, "")
    } finally {
        out.end()
    }
    await written
    return { added, skipped }
}
