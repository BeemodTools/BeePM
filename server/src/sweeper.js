/**
 * Periodic cleanup: old login sessions, and uploads that were never finalized
 * (their staging files are deleted from the bucket).
 */
export function startSweeper({ db, storage, log }, intervalMs = 10 * 60 * 1000) {
    async function sweep() {
        try {
            await db.query("DELETE FROM auth_sessions WHERE expires_at < now() - interval '1 day'")
            const { rows } = await db.query(
                `UPDATE uploads SET status = 'failed', error = 'Expired before it was finalized'
                  WHERE status = 'pending' AND expires_at < now() - interval '10 minutes'
                  RETURNING storage_key`,
            )
            for (const row of rows) await storage.remove(row.storage_key).catch(() => {})
            // Uploads stuck in "processing" (e.g. the server restarted mid-publish)
            await db.query(
                `UPDATE uploads SET status = 'failed', error = 'Interrupted'
                  WHERE status = 'processing' AND created_at < now() - interval '2 hours'`,
            )
        } catch (err) {
            log.warn({ err }, "cleanup failed")
        }
    }
    const timer = setInterval(sweep, intervalMs)
    timer.unref()
    sweep()
    return () => clearInterval(timer)
}
