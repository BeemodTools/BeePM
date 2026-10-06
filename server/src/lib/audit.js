const listeners = new WeakMap() // db -> [listener]

/** Calls listener({ actorId, action, target, details }) after each audit entry (Discord logs). */
export function onAudit(db, listener) {
    listeners.set(db, [...(listeners.get(db) ?? []), listener])
}

/** Records who did what (publishes, yanks, owner changes, admin actions, new accounts). */
export async function audit(db, actorId, action, target = null, details = null) {
    await db.query(
        "INSERT INTO audit_log (actor_id, action, target, details) VALUES ($1, $2, $3, $4)",
        [actorId ?? null, action, target, details ? JSON.stringify(details) : null],
    )
    for (const listener of listeners.get(db) ?? []) {
        try {
            listener({ actorId: actorId ?? null, action, target, details })
        } catch {
            // A listener is never allowed to fail the action that was audited
        }
    }
}
