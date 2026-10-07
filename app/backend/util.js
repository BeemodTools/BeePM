import { ManifestError, PackError } from "@beepm/core"
import { Bee2Error, InstallError, LoginError, RegistryError } from "@beepm/core/client"

/** A problem with a message meant for the user, plus extra fields for the window. */
export class AppError extends Error {
    constructor(message, extra = {}) {
        super(message)
        this.extra = extra
    }
}

/** Whether an error has a message meant for the user (anything else is a bug or a system error). */
export const isExpected = (err) =>
    [AppError, RegistryError, PackError, ManifestError, LoginError, InstallError, Bee2Error].some(
        (type) => err instanceof type,
    )

/**
 * Turns an error into the { ok: false, error, code?, problems?, ... } that handlers return.
 * Registry errors keep their code and status (0 = the registry couldn't be reached).
 */
export function toFailure(err) {
    const failure = { ok: false, error: err?.message || String(err) }
    if (err instanceof AppError) {
        Object.assign(failure, err.extra)
    } else if (err instanceof RegistryError) {
        failure.code = err.code
        failure.status = err.status
        if (err.status === 0) failure.offline = true
        if (Array.isArray(err.details?.problems)) failure.problems = err.details.problems
        if (Array.isArray(err.details?.assets)) failure.assets = err.details.assets
    } else if (err instanceof PackError || err instanceof ManifestError) {
        failure.code = "invalid_package"
        failure.problems = err.problems
    } else if (err instanceof LoginError) {
        failure.code = err.reason
    } else if (err instanceof InstallError) {
        failure.code = "install"
    } else if (err instanceof Bee2Error) {
        failure.code = "bee2"
    } else if (err?.code) {
        failure.code = err.code
    }
    // "Can't be published:\n- a\n- b" plus problems [a, b]: keep just the first line
    if (failure.problems?.length) failure.error = failure.error.split("\n")[0].replace(/:$/, ".")
    return failure
}

/**
 * Wraps a progress callback so it runs at most every `ms`. The latest update is never lost:
 * it's sent when the interval is up, or right away by flush(). With `key`, the last update of
 * each step (e.g. each file) is sent before the next step's first one.
 */
export function throttle(fn, { ms = 100, key = null } = {}) {
    let last = 0
    let timer = null
    let latest
    const send = () => {
        timer = null
        last = Date.now()
        fn(latest)
    }
    const throttled = (payload) => {
        if (timer && key && key(payload) !== key(latest)) {
            clearTimeout(timer)
            send()
        }
        latest = payload
        const wait = ms - (Date.now() - last)
        if (wait <= 0) {
            clearTimeout(timer)
            send()
        } else if (!timer) {
            timer = setTimeout(send, wait)
        }
    }
    throttled.flush = () => {
        if (timer) {
            clearTimeout(timer)
            send()
        }
    }
    return throttled
}

/** Runs jobs one at a time: installs, uninstalls and BEE2 setup rewrite the same files. */
export function createLock() {
    let tail = Promise.resolve()
    return (job) => {
        const run = tail.then(job, job)
        tail = run.catch(() => {})
        return run
    }
}

export function isWebUrl(url) {
    try {
        return ["http:", "https:"].includes(new URL(String(url)).protocol)
    } catch {
        return false
    }
}

/** A file size for the log: "512 KB" or "3.4 MB". */
export function fileSize(bytes) {
    const size = Number(bytes) || 0
    if (size < 1048576) return `${Math.ceil(size / 1024)} KB`
    return `${(size / 1048576).toFixed(1)} MB`
}

/** Up to three names, or how many there are: "@a/b, @c/d" or "5 packages". */
export const listOf = (names, noun) =>
    names.length <= 3 ? names.join(", ") : `${names.length} ${noun}`

/** A trimmed string, or undefined if it's empty or not a string. */
export const optionalText = (value) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined

export function requireText(value, message) {
    const text = optionalText(value)
    if (!text) throw new AppError(message)
    return text
}
