import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import http from "node:http"
import https from "node:https"
import path from "node:path"
import { once } from "node:events"
import { finished } from "node:stream/promises"
import { replaceFile } from "./files.js"

/** A download of another size than expected (error.code "size_mismatch"). */
const sizeMismatch = (message) => Object.assign(new Error(message), { code: "size_mismatch" })

/**
 * Downloads a URL (following redirects) to a file. The file only appears at
 * `destination` once it's complete and matches expectedSha256/expectedSize.
 * onProgress(receivedBytes, totalBytes) is called as data arrives.
 */
export async function downloadFile(
    url,
    destination,
    { fetch = globalThis.fetch, expectedSha256, expectedSize, onProgress, signal } = {},
) {
    const res = await fetch(url, { headers: { "User-Agent": "BeePM" }, redirect: "follow", signal })
    if (!res.ok || !res.body) {
        throw new Error(`Download failed: HTTP ${res.status} from ${new URL(res.url || url).host}`)
    }
    const total = expectedSize || Number(res.headers.get("content-length")) || 0
    const hash = createHash("sha256")
    let received = 0

    await mkdir(path.dirname(destination), { recursive: true })
    const temp = `${destination}.${process.pid}.part`
    const out = createWriteStream(temp)
    try {
        for await (const chunk of res.body) {
            received += chunk.length
            if (expectedSize && received > expectedSize)
                throw sizeMismatch("The download is larger than expected.")
            hash.update(chunk)
            if (!out.write(chunk)) await once(out, "drain")
            onProgress?.(received, total)
        }
        out.end()
        await finished(out)
        const sha256 = hash.digest("hex")
        if (expectedSize && received !== expectedSize) {
            throw sizeMismatch(`The download was cut short (${received} of ${expectedSize} bytes).`)
        }
        if (expectedSha256 && sha256 !== expectedSha256) {
            throw new Error(
                "The downloaded file doesn't match its checksum, so it wasn't installed.",
            )
        }
        await replaceFile(temp, destination)
        return { sha256, size: received }
    } catch (err) {
        out.destroy()
        await rm(temp, { force: true })
        throw err
    }
}

/**
 * Sends a file to a presigned upload URL ({ method, url, headers } from the registry)
 * with an exact Content-Length, reporting progress as it goes.
 */
export async function uploadFile(target, filePath, size, { onProgress } = {}) {
    const url = new URL(target.url)
    const transport = url.protocol === "https:" ? https : http
    await new Promise((resolve, reject) => {
        const req = transport.request(
            url,
            {
                method: target.method || "PUT",
                headers: { ...target.headers, "Content-Length": size },
            },
            (res) => {
                let body = ""
                res.setEncoding("utf8")
                res.on("data", (chunk) => {
                    if (body.length < 4000) body += chunk
                })
                res.on("end", () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve()
                    else
                        reject(
                            new Error(
                                `Upload failed with HTTP ${res.statusCode}${body ? `: ${body.slice(0, 300)}` : ""}`,
                            ),
                        )
                })
            },
        )
        req.on("error", reject)
        let sent = 0
        const stream = createReadStream(filePath)
        stream.on("data", (chunk) => {
            sent += chunk.length
            onProgress?.(sent, size)
        })
        stream.on("error", reject)
        stream.pipe(req)
    })
}
