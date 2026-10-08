import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { open, readdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import zlib from "node:zlib"
import { decompress as lzmaDecompress } from "lzma1"
import yauzl from "yauzl"
import yazl from "yazl"
import { readInfoTxt } from "./infotxt.js"
import { MANIFEST_FILE, parseManifestText, validateManifest } from "./manifest.js"

/** The only file types a .bee_pack may contain (the old BeePM CLI's list, plus model .ani files). */
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
/** A package that unpacks to more than this is refused: no real BEE2 package comes close. */
export const MAX_UNPACKED_BYTES = 2 * 1024 ** 3
const MAX_INFO_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 256 * 1024
// A big file that shrank more than this is a zip bomb, not a texture or a sound
const MAX_RATIO = 200
const RATIO_CHECK_BYTES = 16 * 1024 * 1024
const MAX_NAME_LENGTH = 400

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

const LZMA = 14
const READABLE_METHODS = new Set([0, 8, LZMA]) // stored, deflate, LZMA
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i
const S_IFMT = 0o170000
const S_IFLNK = 0o120000

const megabytes = (bytes) => `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`

/**
 * Why a zip entry makes a .bee_pack unsafe to accept, or null: zip bomb tricks, files BeePM
 * can't read, and names BEE2 couldn't unpack on Windows (it unpacks resources when exporting).
 * yauzl already refuses absolute paths and "..".
 */
function entryProblem(entry) {
    const name = entry.fileName
    if (name.length > MAX_NAME_LENGTH) {
        return `a file name is longer than ${MAX_NAME_LENGTH} characters`
    }
    if (
        /[<>:"|?*\\]/.test(name) ||
        [...name].some((char) => char.charCodeAt(0) < 32) ||
        name.split("/").some((part) => WINDOWS_RESERVED.test(part))
    ) {
        return `"${name}" isn't a file name Windows can use`
    }
    if (entry.generalPurposeBitFlag & 0x1) return `"${name}" is encrypted`
    if (((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK) {
        return `"${name}" is a symbolic link`
    }
    if (!READABLE_METHODS.has(entry.compressionMethod)) {
        return `"${name}" uses a kind of compression BeePM can't read (save the zip with Deflate)`
    }
    if (
        entry.uncompressedSize > RATIO_CHECK_BYTES &&
        entry.uncompressedSize > entry.compressedSize * MAX_RATIO
    ) {
        return `it looks like a zip bomb: "${name}" unpacks from ${megabytes(entry.compressedSize)} to ${megabytes(entry.uncompressedSize)}`
    }
    return null
}

/** True if two entries' data overlap: a zip bomb trick (many files sharing the same data). */
function overlaps(extents) {
    const sorted = extents.filter(([, size]) => size > 0).sort((a, b) => a[0] - b[0])
    for (let i = 1; i < sorted.length; i++) {
        const [offset, size] = sorted[i - 1]
        if (sorted[i][0] < offset + size) return true
    }
    return false
}

/**
 * Zip's LZMA entries: 2 bytes of version, 2 bytes of properties length, the properties, then
 * the LZMA stream. The decoder wants the classic .lzma header: properties + 8-byte size.
 */
function decodeZipLzma(raw, uncompressedSize) {
    const propsLength = raw.readUInt16LE(2)
    const size = Buffer.alloc(8)
    size.writeBigUInt64LE(BigInt(uncompressedSize))
    const out = lzmaDecompress(
        Buffer.concat([raw.subarray(4, 4 + propsLength), size, raw.subarray(4 + propsLength)]),
    )
    return typeof out === "string" ? Buffer.from(out, "utf8") : Buffer.from(out)
}

/**
 * The contents of a zip entry, in memory. Handles stored and deflated entries, and LZMA ones
 * (BEE2's own packages are LZMA-compressed, which yauzl can't decode by itself).
 */
async function readEntryBytes(zipfile, entry) {
    const lzma = entry.compressionMethod === LZMA
    const stream = await zipfile.openReadStreamPromise(
        entry,
        lzma ? { decodeFileData: false } : undefined,
    )
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const data = Buffer.concat(chunks)
    return lzma ? decodeZipLzma(data, entry.uncompressedSize) : data
}

async function readEntryText(zipfile, entry, maxBytes, label) {
    if (entry.uncompressedSize > maxBytes) {
        throw new PackError([`${label} is larger than ${Math.round(maxBytes / 1024)} KB`])
    }
    return (await readEntryBytes(zipfile, entry)).toString("utf8")
}

/**
 * Lists a .bee_pack's files without extracting it, and reads info.txt and
 * bee-package.json from its root (matched case-insensitively). Refuses zip bombs and other
 * unsafe zips (see entryProblem) before unpacking anything. maxInfoBytes: how big info.txt may
 * be (BEE2's own packages can have bigger ones than BeePM accepts for publishing).
 */
export async function readPack(
    filePath,
    { maxUnpackedBytes = MAX_UNPACKED_BYTES, maxInfoBytes = MAX_INFO_BYTES } = {},
) {
    let zipfile
    try {
        zipfile = await yauzl.openPromise(filePath, { lazyEntries: true, autoClose: false })
    } catch (err) {
        throw new PackError([`it isn't a valid zip file (${err.message})`])
    }

    const files = []
    const disallowed = []
    const names = new Set()
    const extents = [] // [offset, compressed size] of every entry, to spot overlapping data
    let uncompressedSize = 0
    let infoEntry = null
    let manifestEntry = null
    try {
        for await (const entry of zipfile.eachEntry()) {
            const problem = entryProblem(entry)
            if (problem) throw new PackError([problem])
            if (names.has(entry.fileName)) {
                throw new PackError([`"${entry.fileName}" is in it twice`])
            }
            names.add(entry.fileName)
            extents.push([entry.relativeOffsetOfLocalHeader, entry.compressedSize])
            if (entry.fileName.endsWith("/")) continue
            if (files.length >= MAX_ENTRIES) {
                throw new PackError([`it has more than ${MAX_ENTRIES} files`])
            }
            files.push(entry.fileName)
            uncompressedSize += entry.uncompressedSize
            if (uncompressedSize > maxUnpackedBytes) {
                throw new PackError([
                    `it unpacks to more than ${megabytes(maxUnpackedBytes)}, which is too big`,
                ])
            }
            const lower = entry.fileName.toLowerCase()
            // Two of them (e.g. info.txt and INFO.TXT) could mean BEE2 reads a different one
            if (lower === "info.txt") {
                if (infoEntry) throw new PackError(["it has more than one info.txt"])
                infoEntry = entry
            } else if (lower === MANIFEST_FILE) {
                if (manifestEntry) throw new PackError([`it has more than one ${MANIFEST_FILE}`])
                manifestEntry = entry
            }
            if (!isAllowedFile(entry.fileName)) disallowed.push(entry.fileName)
        }
        if (overlaps(extents)) throw new PackError(["it looks like a zip bomb: its files overlap"])
        const infoText = infoEntry
            ? await readEntryText(zipfile, infoEntry, maxInfoBytes, "info.txt")
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

/**
 * The files `wanted(name)` picks in a zip, without unpacking anything else: a Map of name ->
 * Buffer, or of what transform(name, bytes) makes of each one as it's read (null leaves it out).
 * Files bigger than maxBytes, or ones readPack would refuse, are left out. Meant for zips readPack
 * accepted (contents.js reads item files and icons with it).
 */
export async function readPackFiles(
    filePath,
    wanted,
    { maxBytes = 1024 * 1024, transform = null } = {},
) {
    const zipfile = await yauzl.openPromise(filePath, { lazyEntries: true, autoClose: false })
    const found = new Map()
    try {
        for await (const entry of zipfile.eachEntry()) {
            if (entry.fileName.endsWith("/") || !wanted(entry.fileName)) continue
            if (entryProblem(entry) || entry.uncompressedSize > maxBytes) continue
            const bytes = await readEntryBytes(zipfile, entry)
            const value = transform ? await transform(entry.fileName, bytes) : bytes
            if (value != null) found.set(entry.fileName, value)
        }
    } finally {
        zipfile.close()
    }
    return found
}

/** readPackFiles, as text. */
export async function readPackTexts(filePath, wanted, options) {
    const files = await readPackFiles(filePath, wanted, options)
    return new Map([...files].map(([name, bytes]) => [name, bytes.toString("utf8")]))
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
            } else if (entry.compressionMethod === LZMA) {
                out.addBuffer(await readEntryBytes(zipfile, entry), entry.fileName, options)
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
 * Zips a package folder into a .bee_pack. Files of disallowed types (unless allFiles: for
 * packages that stay on this PC) and hidden files or folders (like .git) are left out. Returns
 * { added, skipped } as relative paths.
 */
export async function packFolder(folder, destinationPath, { allFiles = false } = {}) {
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
            } else if (entry.isFile() && (allFiles || isAllowedFile(entry.name))) {
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

// ---------- adding a file to an existing zip ----------

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50

async function readAt(handle, position, length) {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    return buffer.subarray(0, bytesRead)
}

function dosDateTime(date) {
    return {
        time:
            (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    }
}

/** The zip's end record and its list of entries (the central directory). */
async function readCentralDirectory(zipPath) {
    const handle = await open(zipPath, "r")
    try {
        const { size } = await handle.stat()
        // The end record is in the last 22 bytes plus up to 64 KB of comment
        const tailLength = Math.min(size, 22 + 0xffff)
        const tail = await readAt(handle, size - tailLength, tailLength)
        let at = -1
        for (let i = tail.length - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
                at = i
                break
            }
        }
        if (at < 0) throw new PackError(["it isn't a valid zip file"])
        const end = {
            entries: tail.readUInt16LE(at + 10),
            centralSize: tail.readUInt32LE(at + 12),
            centralOffset: tail.readUInt32LE(at + 16),
            comment: tail.subarray(at + 22, at + 22 + tail.readUInt16LE(at + 20)),
        }
        if (end.entries === 0xffff || end.centralOffset === 0xffffffff) {
            throw new PackError([
                "it's a ZIP64 archive, which BeePM can't edit; re-zip it normally",
            ])
        }
        return { end, central: await readAt(handle, end.centralOffset, end.centralSize) }
    } finally {
        await handle.close()
    }
}

/**
 * Puts a file at the root of a zip, replacing any entry with the same name (matched
 * case-insensitively), without touching anything else: every other entry is copied byte for
 * byte, whatever its compression. The new zip is read back before it replaces the original.
 * Used to add bee-package.json to a .bee_pack.
 */
export async function putFileInZip(zipPath, fileName, content) {
    const { end, central } = await readCentralDirectory(zipPath)

    const kept = []
    for (let offset = 0; offset < central.length;) {
        if (central.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
            throw new PackError(["its list of files is damaged"])
        }
        const nameLength = central.readUInt16LE(offset + 28)
        const recordLength =
            46 + nameLength + central.readUInt16LE(offset + 30) + central.readUInt16LE(offset + 32)
        const name = central.toString("utf8", offset + 46, offset + 46 + nameLength)
        if (name.toLowerCase() !== fileName.toLowerCase()) {
            kept.push(central.subarray(offset, offset + recordLength))
        }
        offset += recordLength
    }

    const data = Buffer.from(content)
    const compressed = zlib.deflateRawSync(data)
    const crc = zlib.crc32(data)
    const name = Buffer.from(fileName, "utf8")
    const { time, day } = dosDateTime(new Date())

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 name
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    record.writeUInt16LE(20, 4) // version made by
    record.writeUInt16LE(20, 6) // version needed
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(8, 10)
    record.writeUInt16LE(time, 12)
    record.writeUInt16LE(day, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(compressed.length, 20)
    record.writeUInt32LE(data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(end.centralOffset, 42) // the new entry goes where the old list began

    const newCentral = Buffer.concat([...kept, record, name])
    const newCentralOffset = end.centralOffset + local.length + name.length + compressed.length
    if (kept.length + 1 >= 0xffff || newCentralOffset + newCentral.length >= 0xffffffff) {
        throw new PackError(["it's too big for BeePM to edit; add the file and re-zip it yourself"])
    }
    const endRecord = Buffer.alloc(22)
    endRecord.writeUInt32LE(EOCD_SIGNATURE, 0)
    endRecord.writeUInt16LE(kept.length + 1, 8)
    endRecord.writeUInt16LE(kept.length + 1, 10)
    endRecord.writeUInt32LE(newCentral.length, 12)
    endRecord.writeUInt32LE(newCentralOffset, 16)
    endRecord.writeUInt16LE(end.comment.length, 20)

    const temp = `${zipPath}.${process.pid}.tmp`
    try {
        const out = createWriteStream(temp)
        // Everything before the old list of files (all the existing entries), unchanged
        if (end.centralOffset > 0) {
            await pipeline(
                createReadStream(zipPath, { start: 0, end: end.centralOffset - 1 }),
                out,
                { end: false },
            )
        }
        for (const part of [local, name, compressed, newCentral, endRecord, end.comment]) {
            if (!out.write(part)) await new Promise((resolve) => out.once("drain", resolve))
        }
        await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))

        const check = await readPack(temp)
        const written = check.files.some((f) => f.toLowerCase() === fileName.toLowerCase())
        const manifestOk =
            fileName.toLowerCase() !== MANIFEST_FILE || check.manifestText === data.toString("utf8")
        if (!written || !manifestOk) {
            throw new PackError(["the edited package didn't read back correctly"])
        }
        await rename(temp, zipPath)
    } catch (err) {
        await rm(temp, { force: true })
        throw err
    }
}
