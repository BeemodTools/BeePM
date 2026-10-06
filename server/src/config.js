import path from "node:path"
import { fileURLToPath } from "node:url"

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function num(value, fallback) {
    if (value === undefined || value === "") return fallback
    const n = Number(value)
    if (!Number.isFinite(n)) throw new Error(`Expected a number, got "${value}"`)
    return n
}

function list(value) {
    return (value || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
}

/**
 * Reads the server configuration from environment variables.
 * Every variable is documented in server/.env.example.
 */
export function loadConfig(env = process.env) {
    const production = env.NODE_ENV === "production"
    const port = num(env.PORT, 8787)

    const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN
    const publicUrl = (
        env.PUBLIC_URL || (railwayDomain ? `https://${railwayDomain}` : `http://localhost:${port}`)
    ).replace(/\/+$/, "")

    const bucket = env.BUCKET || env.S3_BUCKET
    const storage = bucket
        ? {
              kind: "s3",
              bucket,
              endpoint: env.ENDPOINT || env.S3_ENDPOINT,
              region: env.REGION || env.S3_REGION || "auto",
              accessKeyId: env.ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID,
              secretAccessKey: env.SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY,
              forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
          }
        : { kind: "local", dir: env.LOCAL_STORAGE_DIR || path.join(serverRoot, ".data", "storage") }

    const config = {
        production,
        port,
        // Railway routes to 0.0.0.0; locally, stay off the network
        host: env.HOST || (production ? "0.0.0.0" : "127.0.0.1"),
        publicUrl,
        databaseUrl: env.DATABASE_URL || null,
        pgliteDir: env.PGLITE_DIR || path.join(serverRoot, ".data", "db"),
        storage,
        providers: {
            github: env.GITHUB_CLIENT_ID
                ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
                : null,
            discord: env.DISCORD_CLIENT_ID
                ? { clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET }
                : null,
        },
        // Optional token for server-side GitHub API calls (release imports, legacy import)
        githubApiToken: env.GITHUB_API_TOKEN || null,
        // Discord channel webhooks: the moderators' activity log, and new versions (optional)
        discordLogWebhook: env.DISCORD_LOG_WEBHOOK || null,
        discordReleasesWebhook: env.DISCORD_RELEASES_WEBHOOK || null,
        // How often watched GitHub repos are checked for new releases; 0 turns it off
        githubWatchMinutes: num(env.GITHUB_WATCH_MINUTES, 15),
        // "Continue with a test account" on the login page; never in production.
        // On by default locally when no Discord/GitHub app is configured.
        devLogin:
            !production &&
            (env.DEV_LOGIN === "true" ||
                (env.DEV_LOGIN !== "false" && !env.GITHUB_CLIENT_ID && !env.DISCORD_CLIENT_ID)),
        bootstrapAdmins: list(env.BOOTSTRAP_ADMINS),
        maxUploadBytes: num(env.MAX_UPLOAD_MB, 512) * 1024 * 1024,
        minAccountAgeDays: num(env.MIN_ACCOUNT_AGE_DAYS, 30),
        publishesPerHour: num(env.PUBLISHES_PER_HOUR, 10),
        publishesPerDay: num(env.PUBLISHES_PER_DAY, 30),
        authSessionMinutes: num(env.AUTH_SESSION_MINUTES, 15),
        tokenDays: num(env.TOKEN_DAYS, 365),
        unpublishHours: num(env.UNPUBLISH_HOURS, 72),
        legacyRegistryUrl:
            env.LEGACY_REGISTRY_URL ||
            "https://pub-adc08815222c4c608465419f2d5751a5.r2.dev/registry.json",
        logLevel: env.LOG_LEVEL || (production ? "info" : "warn"),
    }

    if (production) {
        const missing = []
        if (!config.databaseUrl) missing.push("DATABASE_URL")
        if (storage.kind !== "s3") missing.push("BUCKET")
        if (storage.kind === "s3" && !storage.endpoint) missing.push("ENDPOINT")
        if (!config.providers.github && !config.providers.discord) {
            missing.push("GITHUB_CLIENT_ID or DISCORD_CLIENT_ID")
        }
        if (missing.length) {
            throw new Error(`Missing required environment variables: ${missing.join(", ")}`)
        }
    }
    for (const [name, provider] of Object.entries(config.providers)) {
        if (provider && !provider.clientSecret) {
            throw new Error(
                `${name.toUpperCase()}_CLIENT_SECRET is required when the client ID is set`,
            )
        }
    }

    return config
}
