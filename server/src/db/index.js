import { mkdir } from "node:fs/promises"
import pg from "pg"

// BIGINT columns (sizes, download counts) fit comfortably in a JS number
const INT8_OID = 20
pg.types.setTypeParser(INT8_OID, (value) => Number(value))

/**
 * The database handle used everywhere in the server:
 *   query(text, params) -> { rows, rowCount }
 *   exec(sql)           -> runs a multi-statement script (migrations)
 *   tx(fn)              -> runs fn({ query, exec }) inside a transaction
 *   close()
 * It is backed by node-postgres in production and by PGlite (Postgres in WASM)
 * for local development and tests, so both run the same SQL.
 */
export async function createDb(config) {
    if (config.databaseUrl) return createPgDb(config.databaseUrl)
    await mkdir(config.pgliteDir, { recursive: true })
    return createPgliteDb(config.pgliteDir)
}

export function createPgDb(connectionString) {
    const ssl =
        /sslmode=(require|verify)/.test(connectionString) || process.env.PGSSL === "true"
            ? { rejectUnauthorized: false }
            : undefined
    const pool = new pg.Pool({ connectionString, ssl, max: 10 })

    return {
        kind: "pg",
        query: (text, params) => pool.query(text, params),
        exec: (sql) => pool.query(sql),
        async tx(fn) {
            const client = await pool.connect()
            try {
                await client.query("BEGIN")
                const result = await fn({
                    query: (text, params) => client.query(text, params),
                    exec: (sql) => client.query(sql),
                })
                await client.query("COMMIT")
                return result
            } catch (err) {
                await client.query("ROLLBACK").catch(() => {})
                throw err
            } finally {
                client.release()
            }
        },
        // Serializes migrations when several replicas start at once
        async withLock(key, fn) {
            const client = await pool.connect()
            try {
                await client.query("SELECT pg_advisory_lock($1)", [key])
                return await fn()
            } finally {
                await client.query("SELECT pg_advisory_unlock($1)", [key]).catch(() => {})
                client.release()
            }
        },
        close: () => pool.end(),
    }
}

/**
 * PGlite is a devDependency, so it is only imported when there is no DATABASE_URL.
 * Pass dataDir = null (or "memory://") for a throwaway in-memory database.
 */
export async function createPgliteDb(dataDir = null) {
    const { PGlite } = await import("@electric-sql/pglite")
    const db = new PGlite(dataDir || "memory://", {
        parsers: { [INT8_OID]: (value) => Number(value) },
    })
    await db.waitReady

    const adapt = (result) => ({
        rows: result.rows,
        rowCount: result.affectedRows ?? result.rows.length,
    })
    // PGlite runs one statement at a time; queue transactions so they don't interleave
    let queue = Promise.resolve()

    const handle = {
        kind: "pglite",
        query: async (text, params) => adapt(await db.query(text, params)),
        exec: (sql) => db.exec(sql),
        tx(fn) {
            const run = queue.then(() =>
                db.transaction((tx) =>
                    fn({
                        query: async (text, params) => adapt(await tx.query(text, params)),
                        exec: (sql) => tx.exec(sql),
                    }),
                ),
            )
            queue = run.catch(() => {})
            return run
        },
        withLock: (key, fn) => fn(),
        close: () => db.close(),
    }
    return handle
}
