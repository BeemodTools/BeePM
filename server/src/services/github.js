import { createWriteStream } from "node:fs"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

/** Minimal GitHub REST client used for release imports and the BeePM 1 import. */
export function createGithubApi(fetchImpl, token = null) {
    const headers = {
        Accept: "application/vnd.github+json",
        "User-Agent": "BeePM-Registry",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }

    return {
        /** Parsed JSON, or null on 404. */
        async json(pathname) {
            const res = await fetchImpl(`https://api.github.com${pathname}`, { headers })
            if (res.status === 404) return null
            if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status} for ${pathname}`)
            return res.json()
        },

        async status(pathname) {
            const res = await fetchImpl(`https://api.github.com${pathname}`, { headers })
            await res.body?.cancel?.()
            return res.status
        },

        /** Downloads a URL (following redirects) to a file, refusing anything over maxBytes. */
        async download(url, destination, maxBytes) {
            const res = await fetchImpl(url, {
                headers: { "User-Agent": "BeePM-Registry", Accept: "application/octet-stream" },
                redirect: "follow",
            })
            if (!res.ok || !res.body) throw new Error(`Download failed with HTTP ${res.status}`)
            let received = 0
            const limit = new Transform({
                transform(chunk, _encoding, callback) {
                    received += chunk.length
                    if (received > maxBytes)
                        callback(new Error("The file is larger than the size limit"))
                    else callback(null, chunk)
                },
            })
            await pipeline(Readable.fromWeb(res.body), limit, createWriteStream(destination))
            return received
        },
    }
}
