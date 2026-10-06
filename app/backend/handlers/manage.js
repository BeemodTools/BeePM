import { optionalText, requireText } from "../util.js"

const packageName = (value) => requireText(value, "Say which package.")
const versionOf = (value) => requireText(value, "Say which version.")
const handleOf = (value) => requireText(value, "Enter a BeePM handle.").replace(/^@/, "")

/** Owner actions (the registry checks ownership and the unpublish window) and admin moderation. */
export function manageHandlers({ ctx }) {
    const api = ctx.api
    return {
        "manage:yank": async ({ name, version, reason } = {}) => {
            await api.yank(packageName(name), versionOf(version), optionalText(reason))
            return {}
        },

        "manage:unyank": async ({ name, version } = {}) => {
            await api.unyank(packageName(name), versionOf(version))
            return {}
        },

        // A version or the whole package; an empty message removes the deprecation
        "manage:deprecate": async ({ name, version, message } = {}) => {
            await api.deprecate(packageName(name), {
                message: optionalText(message) ?? null,
                version: optionalText(version),
            })
            return {}
        },

        "manage:unpublish": async ({ name, version } = {}) => {
            await api.unpublish(packageName(name), versionOf(version))
            return {}
        },

        "manage:owners": async (name) => ({ owners: (await api.owners(packageName(name))).owners }),

        // Publishing new GitHub releases automatically: { repo, release, error, ... } or null
        "manage:github-watch": async (name) => ({
            watch: (await api.githubWatch(packageName(name))).watch,
        }),

        "manage:stop-github-watch": async (name) => {
            await api.stopGithubWatch(packageName(name))
            return {}
        },

        "manage:add-owner": async ({ name, handle } = {}) => ({
            owners: (await api.addOwner(packageName(name), handleOf(handle))).owners,
        }),

        "manage:remove-owner": async ({ name, handle } = {}) => ({
            owners: (await api.removeOwner(packageName(name), handleOf(handle))).owners,
        }),

        "admin:remove-package": async ({ name, reason } = {}) => {
            await api.admin.removePackage(packageName(name), optionalText(reason))
            return {}
        },

        "admin:restore-package": async (name) => {
            await api.admin.restorePackage(packageName(name))
            return {}
        },
    }
}
