import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

/** Reads a JSON file, or returns `fallback` if it's missing or unreadable. */
export async function readJson(filePath, fallback = null) {
    try {
        return JSON.parse((await readFile(filePath, "utf8")).replace(/^﻿/, ""))
    } catch (err) {
        if (err.code === "ENOENT" || err instanceof SyntaxError) return fallback
        throw err
    }
}

/** Writes JSON through a temp file and a rename, so a crash never leaves half a file. */
export async function writeJson(filePath, data) {
    await mkdir(path.dirname(filePath), { recursive: true })
    const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, JSON.stringify(data, null, 2) + "\n")
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
