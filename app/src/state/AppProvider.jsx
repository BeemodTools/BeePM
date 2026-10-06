import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api, onEvent } from "../api.js"
import { allowedByRange, isCompatible, isNewer, providerLabel } from "../lib/format.js"
import { AppContext } from "./context.js"

const LOGIN_ERRORS = {
    denied: "The login was cancelled in the browser.",
    expired: "The login link expired. Try again.",
}

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

/**
 * Everything the views share: the login, BEE2's status, installed packages and updates, the
 * install flow, toasts, the confirmation dialog and the package details dialog.
 */
export default function AppProvider({ children }) {
    const [appInfo, setAppInfo] = useState(null)
    const [auth, setAuth] = useState({ loading: true, loggedIn: false })
    const [bee2, setBee2] = useState(null)
    const [installed, setInstalled] = useState({})
    const [outdated, setOutdated] = useState({ rows: null, loading: false, error: null })
    const [toasts, setToasts] = useState([])
    const [login, setLoginState] = useState(null)
    const [job, setJob] = useState(null)
    const [confirm, setConfirm] = useState(null)
    const [details, setDetails] = useState(null)
    const [busy, setBusy] = useState({})
    const [registryVersion, setRegistryVersion] = useState(0)
    const [publishRequest, setPublishRequest] = useState(null)
    const loginRef = useRef(null)
    const jobRef = useRef(null)
    const installedRequest = useRef(0)
    const outdatedRequest = useRef(0)

    // ---------- toasts and dialogs ----------

    const notify = useCallback((message, severity = "info") => {
        if (message) setToasts((list) => [...list, { id: newId(), message, severity }])
    }, [])
    const dismissToast = useCallback(
        (id) => setToasts((list) => list.filter((toast) => toast.id !== id)),
        [],
    )

    /**
     * Asks before doing something: { title, message, confirmLabel, danger, input, onConfirm }.
     * input: { label, required, multiline, helperText } adds a text field whose value is passed to
     * onConfirm. If onConfirm resolves to { ok: false, error }, the dialog stays open and shows it.
     */
    const askConfirm = useCallback((options) => setConfirm({ id: newId(), ...options }), [])
    const closeConfirm = useCallback(() => setConfirm(null), [])

    const openPackage = useCallback((name) => setDetails(name), [])
    const closeDetails = useCallback(() => setDetails(null), [])

    // ---------- loading state ----------

    const refreshAuth = useCallback(async () => {
        const res = await api.auth.status()
        if (res.ok) setAuth({ loading: false, ...res })
        else setAuth((current) => ({ ...current, loading: false, error: res.error }))
        return res
    }, [])

    const refreshBee2 = useCallback(async () => {
        const res = await api.bee2.status()
        setBee2(res.ok ? res : { error: res.error })
        return res
    }, [])

    /** Checks installed packages for updates (one registry request per package). */
    const checkUpdates = useCallback(async () => {
        const request = ++outdatedRequest.current
        setOutdated((current) => ({ ...current, loading: true }))
        const res = await api.packages.outdated()
        if (request !== outdatedRequest.current) return // a newer check started meanwhile
        setOutdated(
            res.ok
                ? { rows: res.rows, loading: false, error: null }
                : { rows: null, loading: false, error: res.error },
        )
    }, [])

    /** Reloads the installed list, then checks for updates in the background. */
    const refreshInstalled = useCallback(async () => {
        const request = ++installedRequest.current
        const res = await api.packages.installed()
        if (request === installedRequest.current && res.ok) setInstalled(res.packages)
        checkUpdates()
    }, [checkUpdates])

    // Search results and package details reload when this changes (after publishing, yanking...)
    const bumpRegistry = useCallback(() => setRegistryVersion((v) => v + 1), [])

    // ---------- login ----------

    const setLogin = useCallback((value) => {
        loginRef.current = value
        setLoginState(value)
    }, [])

    /** Starts a browser login ("login") or links another account ("link"). */
    const startLogin = useCallback(
        async (kind = "login") => {
            const starting = { kind, phase: "starting" }
            setLogin(starting)
            const res = await (kind === "link" ? api.auth.link() : api.auth.login())
            if (loginRef.current !== starting) {
                if (res.ok) api.auth.cancel(res.id) // Cancelled while it was starting
                return
            }
            setLogin(
                res.ok
                    ? {
                          kind,
                          phase: "waiting",
                          id: res.id,
                          confirmCode: res.confirmCode,
                          url: res.url,
                      }
                    : { kind, phase: "error", error: res.error },
            )
        },
        [setLogin],
    )

    const cancelLogin = useCallback(() => {
        const current = loginRef.current
        setLogin(null)
        if (current?.id) api.auth.cancel(current.id)
    }, [setLogin])

    const reopenLoginPage = useCallback(async () => {
        const url = loginRef.current?.url
        if (!url) return
        const res = await api.app.openExternal(url)
        if (!res.ok) notify(res.error, "error")
    }, [notify])

    const logout = useCallback(async () => {
        const res = await api.auth.logout()
        await refreshAuth()
        if (!res.ok) notify(res.error, "error")
        else if (res.revoked) notify("Logged out.", "success")
        else {
            notify(
                "Logged out on this computer. The registry couldn't be reached, so the login stays valid there until it expires.",
                "warning",
            )
        }
    }, [notify, refreshAuth])

    // ---------- install, update, uninstall ----------

    const setJobState = useCallback((value) => {
        jobRef.current = value
        setJob(value)
    }, [])

    const runPlan = useCallback(
        async (plan, title, { showWarnings = false } = {}) => {
            setJobState({ phase: "applying", title, plan, progress: null })
            const res = await api.packages.apply(plan.planId)
            await refreshInstalled()
            if (!res.ok) {
                setJobState({ phase: "error", title, error: res.error, problems: res.problems })
                return
            }
            setJobState(null)
            const names = res.installed.map((step) => `${step.name}@${step.to}`)
            if (names.length) {
                notify(
                    `Installed ${names.join(", ")}. Restart BEE2 to load the changes.`,
                    "success",
                )
            } else {
                notify(plan.warnings[0] ?? "Done.", "info")
            }
            if (res.removed.length) {
                notify(`Removed ${res.removed.join(", ")} (no longer needed).`, "info")
            }
            if (showWarnings && names.length && res.warnings.length) {
                notify(res.warnings.join(" "), "warning")
            }
        },
        [notify, refreshInstalled, setJobState],
    )

    /**
     * Installs or updates packages (no specs with update = everything). The plan is shown first
     * when it does more than install the one package asked for, or downgrades something.
     */
    const install = useCallback(
        async (specs, { update = false, force = false, title } = {}) => {
            if (jobRef.current) return
            const label =
                title ??
                (update
                    ? specs.length
                        ? `Update ${specs.join(", ")}`
                        : "Update all packages"
                    : `Install ${specs.join(", ")}`)
            setJobState({ phase: "planning", title: label })
            const plan = await api.packages.plan(specs, { update, force })
            if (!plan.ok) {
                setJobState({
                    phase: "error",
                    title: label,
                    error: plan.error,
                    problems: plan.problems,
                })
                return
            }
            if (!plan.steps.length && !plan.markExplicit.length) {
                api.packages.discardPlan(plan.planId)
                setJobState(null)
                notify(plan.warnings[0] ?? "Everything is up to date.", "info")
                return
            }
            const review =
                plan.steps.length > 1 || plan.steps.some((step) => step.change === "downgrade")
            if (review) setJobState({ phase: "confirm", title: label, plan })
            else await runPlan(plan, label, { showWarnings: true })
        },
        [notify, runPlan, setJobState],
    )

    const confirmJob = useCallback(() => {
        const current = jobRef.current
        if (current?.phase === "confirm") runPlan(current.plan, current.title)
    }, [runPlan])

    const closeJob = useCallback(() => {
        const current = jobRef.current
        if (!current || current.phase === "planning" || current.phase === "applying") return
        if (current.phase === "confirm") api.packages.discardPlan(current.plan.planId)
        setJobState(null)
    }, [setJobState])

    const uninstall = useCallback(
        async function run(names, { force = false } = {}) {
            setBusy((current) => ({
                ...current,
                ...Object.fromEntries(names.map((n) => [n, true])),
            }))
            const res = await api.packages.uninstall(names, { force })
            setBusy((current) => {
                const next = { ...current }
                for (const name of names) delete next[name]
                return next
            })
            if (res.ok) {
                notify(`Uninstalled ${res.removed.join(", ")}.`, "success")
            } else if (res.code === "has_dependents") {
                askConfirm({
                    title: "Uninstall anyway?",
                    message: `${res.error} Packages that need it may stop working.`,
                    confirmLabel: "Uninstall anyway",
                    danger: true,
                    onConfirm: () => run(names, { force: true }),
                })
            } else {
                notify(res.error, "error")
            }
            await refreshInstalled()
            return res
        },
        [askConfirm, notify, refreshInstalled],
    )

    // ---------- events from the main process, and the first load ----------

    useEffect(() => {
        const offs = [
            onEvent("auth:login-result", (result) => {
                const current = loginRef.current
                if (!current || current.id !== result.id) return
                if (result.ok) {
                    setLogin(null)
                    notify(
                        result.kind === "link"
                            ? `Linked your ${providerLabel(result.identity?.provider)} account ${result.identity?.username ?? ""}.`
                            : `Logged in as @${result.user.handle}`,
                        "success",
                    )
                    refreshAuth()
                } else if (result.reason !== "aborted") {
                    setLogin({
                        ...current,
                        phase: "error",
                        error: LOGIN_ERRORS[result.reason] ?? result.error,
                    })
                }
            }),
            onEvent("auth:changed", () => {
                refreshAuth()
                notify("Your login expired or was revoked. Log in again.", "warning")
            }),
            onEvent("packages:progress", (progress) => {
                setJob((current) =>
                    current?.phase === "applying" && current.plan.planId === progress.planId
                        ? { ...current, progress }
                        : current,
                )
            }),
            onEvent("packages:changed", () => refreshInstalled()),
            onEvent("app:notice", (notice) => notify(notice.message, notice.severity ?? "info")),
            onEvent("app:protocol", (action) => {
                if (action?.action === "publish" && action.file) {
                    setPublishRequest({ file: action.file, id: newId() })
                }
            }),
        ]
        // Events that arrived before the window was listening are sent now
        api.app.ready()
        api.app.info().then((res) => res.ok && setAppInfo(res))
        refreshAuth().then((res) => {
            if (res.ok && res.expired) notify("Your login expired. Log in again.", "warning")
        })
        refreshBee2()
        refreshInstalled()
        return () => offs.forEach((off) => off())
    }, [notify, refreshAuth, refreshBee2, refreshInstalled, setLogin])

    // Changes made outside the app (the CLI, BEE2 rewriting its config) show when you come back
    useEffect(() => {
        const onFocus = () => {
            refreshInstalled()
            refreshBee2()
        }
        window.addEventListener("focus", onFocus)
        return () => window.removeEventListener("focus", onFocus)
    }, [refreshInstalled, refreshBee2])

    // ---------- derived ----------

    const bee2Version = bee2?.bee2?.version ?? null
    const outdatedByName = useMemo(
        () => Object.fromEntries((outdated.rows ?? []).map((row) => [row.name, row])),
        [outdated.rows],
    )

    /** The version "Update" would install for an installed package (within its range), or null. */
    const updateFor = useCallback(
        (name, summary = null) => {
            const entry = installed[name]
            if (!entry) return null
            if (outdated.rows) {
                const row = outdatedByName[name]
                return row?.wanted && isNewer(row.wanted, entry.version) ? row.wanted : null
            }
            // Updates couldn't be checked (offline?): go by the search result
            const latest = summary?.latest
            return latest &&
                isNewer(latest, entry.version) &&
                isCompatible(summary.compatibleWith, bee2Version) &&
                allowedByRange(latest, entry.range)
                ? latest
                : null
        },
        [installed, outdated.rows, outdatedByName, bee2Version],
    )

    const value = {
        appInfo,
        auth,
        bee2,
        bee2Version,
        installed,
        outdated,
        outdatedByName,
        toasts,
        login,
        job,
        confirm,
        details,
        busy,
        registryVersion,
        publishRequest,
        notify,
        dismissToast,
        askConfirm,
        closeConfirm,
        openPackage,
        closeDetails,
        refreshAuth,
        refreshBee2,
        refreshInstalled,
        bumpRegistry,
        startLogin,
        cancelLogin,
        reopenLoginPage,
        logout,
        install,
        confirmJob,
        closeJob,
        uninstall,
        updateFor,
    }
    return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
