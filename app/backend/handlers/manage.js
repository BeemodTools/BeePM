import { optionalText, requireText } from "../util.js"

const packageName = (value) => requireText(value, "Say which package.")
const versionOf = (value) => requireText(value, "Say which version.")
const handleOf = (value) => requireText(value, "Enter a BeePM handle.").replace(/^@/, "")

/** Owner actions (the registry checks ownership and the unpublish window) and admin moderation. */
export function manageHandlers({ ctx, step }) {
    const api = ctx.api
    return {
        "manage:yank": async ({ name, version, reason } = {}) => {
            const [pkg, v] = [packageName(name), versionOf(version)]
            await step(`Yanking ${pkg}@${v}`, () => api.yank(pkg, v, optionalText(reason)))
            return {}
        },

        "manage:unyank": async ({ name, version } = {}) => {
            const [pkg, v] = [packageName(name), versionOf(version)]
            await step(`Unyanking ${pkg}@${v}`, () => api.unyank(pkg, v))
            return {}
        },

        // A version or the whole package; an empty message removes the deprecation
        "manage:deprecate": async ({ name, version, message } = {}) => {
            const pkg = packageName(name)
            const options = {
                message: optionalText(message) ?? null,
                version: optionalText(version),
            }
            const target = options.version ? `${pkg}@${options.version}` : pkg
            const title = options.message
                ? `Deprecating ${target}`
                : `Removing the deprecation of ${target}`
            await step(title, () => api.deprecate(pkg, options))
            return {}
        },

        "manage:unpublish": async ({ name, version } = {}) => {
            const [pkg, v] = [packageName(name), versionOf(version)]
            await step(`Unpublishing ${pkg}@${v}`, () => api.unpublish(pkg, v))
            return {}
        },

        "manage:owners": async (name) => ({ owners: (await api.owners(packageName(name))).owners }),

        // Publishing new GitHub releases automatically: { repo, release, error, ... } or null
        "manage:github-watch": async (name) => ({
            watch: (await api.githubWatch(packageName(name))).watch,
        }),

        "manage:stop-github-watch": async (name) => {
            const pkg = packageName(name)
            await step(`Stopping automatic GitHub releases of ${pkg}`, () =>
                api.stopGithubWatch(pkg),
            )
            return {}
        },

        "manage:add-owner": async ({ name, handle } = {}) => {
            const [pkg, h] = [packageName(name), handleOf(handle)]
            const { owners } = await step(`Adding @${h} as an owner of ${pkg}`, () =>
                api.addOwner(pkg, h),
            )
            return { owners }
        },

        "manage:remove-owner": async ({ name, handle } = {}) => {
            const [pkg, h] = [packageName(name), handleOf(handle)]
            const { owners } = await step(`Removing @${h} as an owner of ${pkg}`, () =>
                api.removeOwner(pkg, h),
            )
            return { owners }
        },

        "admin:remove-package": async ({ name, reason } = {}) => {
            const pkg = packageName(name)
            await step(`Removing ${pkg} from the registry`, () =>
                api.admin.removePackage(pkg, optionalText(reason)),
            )
            return {}
        },

        "admin:restore-package": async (name) => {
            const pkg = packageName(name)
            await step(`Restoring ${pkg}`, () => api.admin.restorePackage(pkg))
            return {}
        },

        // A removed package keeps its BEE2 ID: this lets another package use it
        "admin:release-bee-id": async (name) => {
            const pkg = packageName(name)
            await step(`Letting go of ${pkg}'s BEE2 ID`, () => api.admin.releaseBeeId(pkg))
            return {}
        },
    }
}
