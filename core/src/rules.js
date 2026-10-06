/**
 * What publishers agree to. The app shows these in the Terms step before publishing, and
 * `beepm publish` asks about them (or takes --yes). Change `version` whenever the rules change.
 */
export const PUBLISH_RULES = Object.freeze({
    version: "2026-10-07",
    intro: "By publishing, you agree that:",
    items: Object.freeze([
        "You authored this package, or you have permission to share the package.",
        "It's public under your @handle: anyone can download and install it.",
        "It has no malware, and nothing illegal, and follows the BEEmod Tools server rules.",
        "A published version can't be changed. To fix one, publish a new version.",
        "You can unpublish a version within 72 hours if nothing depends on it. After that, it can only be yanked or deprecated.",
        "Moderators can remove packages and ban accounts that break these rules.",
    ]),
})
