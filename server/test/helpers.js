import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import yazl from "yazl"
import { buildApp } from "../src/app.js"
import { loadConfig } from "../src/config.js"
import { createPgliteDb } from "../src/db/index.js"
import { migrate } from "../src/db/migrate.js"
import { createLocalStorage } from "../src/storage/local.js"

export const PUBLIC_URL = "http://registry.test"
const DAY = 24 * 3600 * 1000

/** A fake OAuth provider: the "code" picks which profile logs in. */
function fakeProvider(id, label, profiles) {
    return {
        id,
        label,
        authorizeUrl: ({ state, redirectUri }) =>
            `https://${id}.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
        async fetchProfile({ code }) {
            const profile = profiles.get(code)
            if (!profile) throw new Error("bad code")
            return profile
        },
    }
}

/**
 * A complete server on PGlite + local storage, with fake Discord/GitHub logins.
 * `fetch` handles server-side HTTP (GitHub API, legacy registry) via t.routes.
 */
export async function setup(env = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "beepm-server-test-"))
    const config = loadConfig({
        PUBLIC_URL,
        LOCAL_STORAGE_DIR: path.join(dir, "storage"),
        BOOTSTRAP_ADMINS: "boss",
        ...env,
    })
    const db = await createPgliteDb(null)
    await migrate(db)
    const storage = createLocalStorage({ dir: config.storage.dir, publicUrl: PUBLIC_URL })
    const profiles = new Map()
    const providers = {
        discord: fakeProvider("discord", "Discord", profiles),
        github: fakeProvider("github", "GitHub", profiles),
    }
    const routes = new Map() // url -> (init, url) => Response
    const fakeFetch = async (url, init = {}) => {
        const handler = routes.get(String(url))
        if (!handler) return new Response("not found", { status: 404 })
        return handler(init, String(url))
    }
    const app = await buildApp({ config, db, storage, providers, fetch: fakeFetch, logger: false })

    let nextId = 1000
    const t = {
        app,
        db,
        config,
        storage,
        dir,
        routes,
        /** Registers a provider account and returns its fake OAuth code. */
        profile({
            provider = "github",
            username,
            displayName = username,
            ageDays = 365,
            id = String(nextId++),
            avatarUrl = null,
        }) {
            const code = `${provider}-${username}-${id}`
            profiles.set(code, {
                provider,
                providerId: id,
                username,
                displayName,
                avatarUrl,
                accountCreatedAt: new Date(Date.now() - ageDays * DAY).toISOString(),
            })
            return code
        },
        cleanup: async () => {
            await app.close()
            await db.close()
            await rm(dir, { recursive: true, force: true })
        },
    }
    return t
}

/** Browser cookie jar for app.inject. */
export function browser() {
    const jar = new Map()
    return {
        jar,
        headers: () => ({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }),
        take(res) {
            for (const c of [res.headers["set-cookie"] ?? []].flat()) {
                const [pair] = c.split(";")
                const [k, v] = pair.split("=")
                jar.set(k, v)
            }
            return res
        },
    }
}

export const csrfOf = (body) => /name="csrf" value="([^"]+)"/.exec(body)?.[1]

/** Runs the browser half of a login/link flow up to the provider callback. Returns the callback response. */
export async function browserToCallback(t, url, code, provider = "github", b = browser()) {
    const { pathname } = new URL(url)
    const first = b.take(await t.app.inject({ method: "GET", url: pathname, headers: b.headers() }))
    assert.equal(first.statusCode, 200, first.body)
    const start = await t.app.inject({
        method: "GET",
        url: `${pathname}/start/${provider}`,
        headers: b.headers(),
    })
    assert.equal(start.statusCode, 302, start.body)
    const state = new URL(start.headers.location).searchParams.get("state")
    const callback = await t.app.inject({
        method: "GET",
        url: `/oauth/${provider}/callback?code=${encodeURIComponent(code)}&state=${state}`,
        headers: b.headers(),
    })
    return { callback, browser: b, pathname }
}

export async function postForm(t, b, url, fields) {
    return t.app.inject({
        method: "POST",
        url,
        headers: { ...b.headers(), "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams(fields).toString(),
    })
}

export async function startLogin(t, clientName = "BeePM Test") {
    const res = await t.app.inject({
        method: "POST",
        url: "/v1/auth/sessions",
        payload: { clientName, client: "cli" },
    })
    assert.equal(res.statusCode, 200, res.body)
    return res.json()
}

export async function poll(t, session) {
    const res = await t.app.inject({
        method: "POST",
        url: `/v1/auth/sessions/${session.id}/poll`,
        payload: { secret: session.secret },
    })
    return res.json()
}

/** Full login: creates the account (with `handle`) on first use. Returns { token, user }. */
export async function login(t, code, { provider = "github", handle } = {}) {
    const session = await startLogin(t)
    const { callback, browser: b } = await browserToCallback(t, session.url, code, provider)
    assert.equal(callback.statusCode, 200, callback.body)
    const csrf = csrfOf(callback.body)
    const prefilled = /name="handle" type="text" value="([^"]*)"/.exec(callback.body)?.[1]
    const res = callback.body.includes("/claim")
        ? await postForm(t, b, `/login/${session.id}/claim`, { csrf, handle: handle ?? prefilled })
        : await postForm(t, b, `/login/${session.id}/approve`, { csrf })
    assert.equal(res.statusCode, 200, res.body)
    const result = await poll(t, session)
    assert.equal(result.status, "done")
    return result
}

export async function api(t, token, method, url, payload) {
    const res = await t.app.inject({
        method,
        url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        payload,
    })
    return {
        status: res.statusCode,
        body: res.body ? safeJson(res.body) : null,
        headers: res.headers,
    }
}

const safeJson = (text) => {
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

/** Builds a .bee_pack in memory. */
export async function makePack(dir, { id = "TEST_PACK", manifest = {}, extra = {}, info } = {}) {
    const file = path.join(dir, `pack-${Math.random().toString(36).slice(2)}.bee_pack`)
    const zip = new yazl.ZipFile()
    const written = pipeline(zip.outputStream, createWriteStream(file))
    const files = {
        "info.txt": info ?? `"ID" "${id}"\n"Name" "Test"\n`,
        "bee-package.json": JSON.stringify({ name: "test-pack", version: "1.0.0", ...manifest }),
        "items/test/editoritems.txt": '"Item" {}',
        ...extra,
    }
    for (const [name, content] of Object.entries(files)) {
        if (content !== null) zip.addBuffer(Buffer.from(content), name)
    }
    zip.end()
    await written
    return file
}

/** Upload + finalize through the API, the way clients do. Returns the finalize response. */
export async function publish(t, token, file) {
    const { readFile } = await import("node:fs/promises")
    const bytes = await readFile(file)
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const start = await api(t, token, "POST", "/v1/uploads", { size: bytes.length, sha256 })
    if (start.status !== 200) return start
    const put = await t.app.inject({
        method: "PUT",
        url: new URL(start.body.upload.url).pathname,
        headers: start.body.upload.headers,
        payload: bytes,
    })
    assert.equal(put.statusCode, 200, put.body)
    return api(t, token, "POST", `/v1/uploads/${start.body.id}/finalize`)
}
