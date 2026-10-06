/** Records who did what (publishes, yanks, owner changes, admin actions, new accounts). */
export async function audit(db, actorId, action, target = null, details = null) {
    await db.query(
        "INSERT INTO audit_log (actor_id, action, target, details) VALUES ($1, $2, $3, $4)",
        [actorId ?? null, action, target, details ? JSON.stringify(details) : null],
    )
}
