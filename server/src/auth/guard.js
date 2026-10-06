import { forbidden, unauthorized } from "../lib/errors.js"
import { authenticate } from "./tokens.js"

/** The logged-in user for this request, or null if there's no Authorization header. */
export async function currentUser(request) {
    if (request.user) return request.user
    request.user = await authenticate(request.server.deps.db, request.headers.authorization)
    return request.user
}

/**
 * The logged-in user, or a 401/403.
 *   session: the request must use a login token (not a publish token)
 *   admin: the user must be an admin
 */
export async function requireUser(request, { session = false, admin = false } = {}) {
    const user = await currentUser(request)
    if (!user) throw unauthorized()
    if (session && user.tokenKind !== "session") {
        throw forbidden(
            "Publish tokens can't do this. Log in with BeePM instead.",
            "session_required",
        )
    }
    if (admin && user.role !== "admin")
        throw forbidden("Only admins can do this.", "admin_required")
    return user
}
