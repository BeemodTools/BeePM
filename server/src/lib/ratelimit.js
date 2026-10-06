/**
 * A fixed-window counter kept in memory. Good enough for one server instance;
 * used for unauthenticated endpoints like starting a login.
 */
export function createRateLimiter({ limit, windowMs }) {
    const hits = new Map()
    return function allow(key) {
        const now = Date.now()
        if (hits.size > 10000) {
            for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k)
        }
        let entry = hits.get(key)
        if (!entry || entry.resetAt < now) {
            entry = { count: 0, resetAt: now + windowMs }
            hits.set(key, entry)
        }
        entry.count++
        return entry.count <= limit
    }
}
