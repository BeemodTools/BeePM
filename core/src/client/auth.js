import { chmod, rm } from "node:fs/promises"
import os from "node:os"
import { readJson, writeJson } from "./files.js"

/** Why a login didn't finish: "denied" (cancelled in the browser), "expired" or "aborted". */
export class LoginError extends Error {
    constructor(reason, message) {
        super(message)
        this.reason = reason
    }
}

/** e.g. "BeePM Desktop on DESKTOP-1234" — shown on the login page and in the token list. */
export const defaultClientName = (client) =>
    `BeePM ${client === "app" ? "Desktop" : "CLI"} on ${os.hostname()}`

const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer)
                reject(new LoginError("aborted", "Login cancelled."))
            },
            { once: true },
        )
    })

/**
 * Starts a browser login (or, with link: true, linking another Discord/GitHub account
 * to the logged-in user). Show `confirmCode`, open `url` in the browser, then
 *   await wait({ signal }) -> { token, user } (login) or { identity } (link)
 */
export async function beginLogin(
    api,
    { client = "cli", clientName = defaultClientName(client), link = false } = {},
) {
    const session = link
        ? await api.startLink({ clientName, client })
        : await api.startLogin({ clientName, client })

    return {
        confirmCode: session.confirmCode,
        url: session.url,
        expiresAt: session.expiresAt,
        async wait({ signal } = {}) {
            const interval = Math.max(1, session.interval || 2) * 1000
            const deadline = new Date(session.expiresAt).getTime() + 60 * 1000
            for (;;) {
                if (signal?.aborted) throw new LoginError("aborted", "Login cancelled.")
                await sleep(interval, signal)
                let result
                try {
                    result = await api.pollLogin(session.id, session.secret)
                } catch (err) {
                    if (err.status === 0 && Date.now() < deadline) continue // Network blip: keep trying
                    throw err
                }
                if (result.status === "done") return result
                if (result.status === "denied") {
                    throw new LoginError("denied", "The login was cancelled in the browser.")
                }
                if (result.status === "expired" || Date.now() > deadline) {
                    throw new LoginError("expired", "The login link expired. Try again.")
                }
            }
        },
    }
}

/**
 * Where a login is kept: { registry, token, user, savedAt }. The CLI uses this plain
 * file (like npm's .npmrc); the desktop app supplies its own encrypted store with the
 * same load/save/clear shape.
 */
export function createFileTokenStore(filePath) {
    return {
        load: () => readJson(filePath, null),
        async save(data) {
            await writeJson(
                filePath,
                { ...data, savedAt: new Date().toISOString() },
                { mode: 0o600 },
            )
            await chmod(filePath, 0o600).catch(() => {})
        },
        clear: () => rm(filePath, { force: true }),
    }
}
