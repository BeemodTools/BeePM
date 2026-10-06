import { createReadStream, createWriteStream } from "node:fs"
import { copyFile, mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { randomId } from "../lib/ids.js"

/**
 * Object storage in a local folder, for development and tests.
 * It mimics presigned URLs with one-time tokens served by the API itself under /_storage.
 */
export function createLocalStorage({ dir, publicUrl }) {
    const root = path.resolve(dir)
    const grants = new Map() // token -> { key, op, size, expires }

    function filePath(key) {
        const resolved = path.resolve(root, key)
        if (!resolved.startsWith(root + path.sep)) throw new Error(`Invalid storage key: ${key}`)
        return resolved
    }

    function grant(key, op, expiresIn, extra = {}) {
        if (grants.size > 1000) {
            for (const [token, entry] of grants)
                if (entry.expires < Date.now()) grants.delete(token)
        }
        const token = randomId(24)
        grants.set(token, { key, op, expires: Date.now() + expiresIn * 1000, ...extra })
        return `${publicUrl}/_storage/${token}`
    }

    function takeGrant(token, op) {
        const entry = grants.get(token)
        if (!entry || entry.op !== op || entry.expires < Date.now()) return null
        if (op === "put") grants.delete(token)
        return entry
    }

    return {
        kind: "local",

        async uploadTarget(key, { size, expiresIn = 3600 }) {
            const url = grant(key, "put", expiresIn, { size })
            return { method: "PUT", url, headers: { "Content-Type": "application/octet-stream" } }
        },

        async downloadUrl(key, { filename, expiresIn = 600 } = {}) {
            return grant(key, "get", expiresIn, { filename })
        },

        async head(key) {
            try {
                const info = await stat(filePath(key))
                return { size: info.size }
            } catch (err) {
                if (err.code === "ENOENT") return null
                throw err
            }
        },

        async downloadTo(key, destination) {
            await copyFile(filePath(key), destination)
        },

        async putFile(key, source) {
            const target = filePath(key)
            await mkdir(path.dirname(target), { recursive: true })
            await copyFile(source, target)
        },

        async copy(fromKey, toKey) {
            const target = filePath(toKey)
            await mkdir(path.dirname(target), { recursive: true })
            await copyFile(filePath(fromKey), target)
        },

        async remove(key) {
            await rm(filePath(key), { force: true })
        },

        /** Serves the fake presigned URLs. Registered only when this storage is in use. */
        async routes(app) {
            app.addContentTypeParser("*", (request, payload, done) => done(null, payload))

            app.put("/_storage/:token", async (request, reply) => {
                const entry = takeGrant(request.params.token, "put")
                if (!entry) return reply.code(403).send("Upload link expired or already used")

                const declared = Number(request.headers["content-length"])
                if (declared !== entry.size) {
                    return reply.code(403).send("Content-Length doesn't match the signed size")
                }
                const target = filePath(entry.key)
                await mkdir(path.dirname(target), { recursive: true })
                let received = 0
                const counter = new Transform({
                    transform(chunk, _encoding, callback) {
                        received += chunk.length
                        if (received > entry.size) callback(new Error("Body larger than declared"))
                        else callback(null, chunk)
                    },
                })
                try {
                    await pipeline(request.body, counter, createWriteStream(target))
                } catch (err) {
                    await rm(target, { force: true })
                    return reply.code(400).send(err.message)
                }
                return reply.code(200).send("")
            })

            app.get("/_storage/:token", async (request, reply) => {
                const entry = takeGrant(request.params.token, "get")
                if (!entry) return reply.code(403).send("Download link expired")
                const source = filePath(entry.key)
                const info = await stat(source).catch(() => null)
                if (!info) return reply.code(404).send("Not found")
                reply.header("Content-Type", "application/octet-stream")
                reply.header("Content-Length", info.size)
                if (entry.filename) {
                    reply.header("Content-Disposition", `attachment; filename="${entry.filename}"`)
                }
                return reply.send(createReadStream(source))
            })
        },
    }
}
