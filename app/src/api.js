/**
 * The window's side of the bridge: window.beepm comes from backend/preload.cjs in Electron, or
 * from src/devBridge.js in a normal browser. Every call resolves to { ok: true, ...data } or
 * { ok: false, error, code?, problems? }; even a failed IPC call comes back that way, so callers
 * only ever check `ok`.
 *
 *   const res = await api.packages.plan(["@areng14/arengitems"])
 */
const bridge = () => window.beepm

function group(name) {
    return new Proxy(
        {},
        {
            get:
                (_target, method) =>
                async (...args) => {
                    try {
                        return await bridge()[name][method](...args)
                    } catch (err) {
                        return { ok: false, error: err?.message || String(err) }
                    }
                },
        },
    )
}

export const api = {
    app: group("app"),
    auth: group("auth"),
    registry: group("registry"),
    packages: group("packages"),
    bee2: group("bee2"),
    publish: group("publish"),
    manage: group("manage"),
    admin: group("admin"),
}

/** Listens for an event from the main process. Returns a function that stops listening. */
export const onEvent = (event, callback) => bridge().on(event, callback)
