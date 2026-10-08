import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export const exists = (file) =>
    access(file).then(
        () => true,
        () => false,
    )

/**
 * Moves a file or folder, also to another drive (BEE2 and BeePM's own folder can be on
 * different drives).
 */
export async function moveFile(source, destination) {
    await mkdir(path.dirname(destination), { recursive: true })
    try {
        await rename(source, destination)
    } catch (err) {
        if (err.code !== "EXDEV") throw err
        await cp(source, destination, { recursive: true, errorOnExist: true, force: false })
        await rm(source, { recursive: true, force: true })
    }
}

/** `file` in `folder`, or "name (2).ext", "name (3).ext"... if that's taken. */
export async function freePath(folder, file) {
    const ext = path.extname(file)
    const base = file.slice(0, file.length - ext.length)
    for (let n = 1; ; n++) {
        const candidate = path.join(folder, n === 1 ? file : `${base} (${n})${ext}`)
        if (!(await exists(candidate))) return candidate
    }
}

/** Reads a JSON file, or returns `fallback` if it's missing or unreadable. */
export async function readJson(filePath, fallback = null) {
    try {
        return JSON.parse((await readFile(filePath, "utf8")).replace(/^﻿/, ""))
    } catch (err) {
        if (err.code === "ENOENT" || err instanceof SyntaxError) return fallback
        throw err
    }
}

/**
 * Writes JSON through a temp file and a rename, so a crash never leaves half a file. mode
 * (e.g. 0o600 for tokens) applies from the moment the file exists.
 */
export async function writeJson(filePath, data, { mode } = {}) {
    await mkdir(path.dirname(filePath), { recursive: true })
    const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, JSON.stringify(data, null, 2) + "\n", mode ? { mode } : undefined)
    try {
        await rename(temp, filePath)
    } catch (err) {
        await rm(temp, { force: true })
        throw err
    }
}

/** Moves a file into place, replacing what's there (retries briefly: Windows locks files BEE2 has open). */
export async function replaceFile(source, destination) {
    await mkdir(path.dirname(destination), { recursive: true })
    for (let attempt = 0; ; attempt++) {
        try {
            await rename(source, destination)
            return
        } catch (err) {
            if (attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) {
                if (["EPERM", "EBUSY", "EACCES"].includes(err.code)) {
                    throw new Error(`${destination} is in use. Close BEE2 and try again.`)
                }
                throw err
            }
            await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
        }
    }
}
