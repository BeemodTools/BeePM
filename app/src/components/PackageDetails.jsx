import { useCallback, useEffect, useState } from "react"
import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    Dialog,
    DialogContent,
    DialogTitle,
    Divider,
    IconButton,
    ListItemText,
    Menu,
    MenuItem,
    TextField,
    Tooltip,
    Typography,
} from "@mui/material"
import CheckCircleIcon from "@mui/icons-material/CheckCircle"
import CloseIcon from "@mui/icons-material/Close"
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline"
import DownloadIcon from "@mui/icons-material/Download"
import GitHubIcon from "@mui/icons-material/GitHub"
import MoreVertIcon from "@mui/icons-material/MoreVert"
import UpgradeIcon from "@mui/icons-material/Upgrade"
import { api } from "../api.js"
import {
    allowedByRange,
    bestVersion,
    formatDate,
    formatNumber,
    isCompatible,
    isNewer,
    versionsNewestFirst,
} from "../lib/format.js"
import { useLastValue } from "../lib/useLastValue.js"
import { useApp } from "../state/context.js"
import { ContentsLink } from "./Contents.jsx"
import ErrorAlert from "./ErrorAlert.jsx"

const smallChip = { height: 20, fontSize: 11 }
const count = (n, word) => `${formatNumber(n)} ${word}${n === 1 ? "" : "s"}`

function Info({ label, children }) {
    return (
        <Box sx={{ minWidth: 0 }}>
            <Typography
                sx={{ fontSize: 11, color: "#777", textTransform: "uppercase", letterSpacing: 0.5 }}
            >
                {label}
            </Typography>
            <Box sx={{ color: "#ddd", fontSize: 14, overflowWrap: "anywhere" }}>{children}</Box>
        </Box>
    )
}

/** Who owns the package. Owners and admins (canManage) add and remove owners here. */
function Owners({ name, owners, me, canManage, onChanged }) {
    const { askConfirm, notify } = useApp()
    const [handle, setHandle] = useState("")
    const [state, setState] = useState({ busy: false, error: null })

    async function add() {
        const value = handle.trim().replace(/^@/, "")
        if (!value) return
        setState({ busy: true, error: null })
        const res = await api.manage.addOwner({ name, handle: value })
        setState({ busy: false, error: res.ok ? null : res.error })
        if (res.ok) {
            setHandle("")
            notify(`@${value} can now publish and manage ${name}.`, "success")
            onChanged()
        }
    }

    const remove = (owner) =>
        askConfirm({
            title: `Remove @${owner} as an owner?`,
            message:
                owner === me
                    ? `You won't be able to publish or manage ${name} anymore.`
                    : `@${owner} won't be able to publish or manage ${name} anymore.`,
            confirmLabel: "Remove",
            danger: true,
            onConfirm: async () => {
                const res = await api.manage.removeOwner({ name, handle: owner })
                if (res.ok) {
                    notify(`Removed @${owner} as an owner of ${name}.`, "success")
                    onChanged()
                }
                return res
            },
        })

    return (
        <>
            <Typography variant="subtitle2" sx={{ mt: 3, mb: 0.5 }}>
                {owners.length === 1 ? "Owner" : "Owners"}
            </Typography>
            {owners.map((owner) => (
                <Box
                    key={owner}
                    sx={{ display: "flex", alignItems: "center", minHeight: 34, gap: 1 }}
                >
                    <Typography sx={{ flex: 1, color: "#ddd" }}>
                        @{owner}
                        {owner === me && (
                            <Box component="span" sx={{ color: "#888" }}>
                                {" "}
                                (you)
                            </Box>
                        )}
                    </Typography>
                    {canManage && (
                        <Tooltip
                            title={
                                owners.length === 1
                                    ? "A package needs at least one owner"
                                    : `Remove @${owner}`
                            }
                        >
                            <span>
                                <IconButton
                                    size="small"
                                    aria-label={`Remove @${owner}`}
                                    disabled={owners.length === 1}
                                    onClick={() => remove(owner)}
                                >
                                    <DeleteOutlineIcon fontSize="small" />
                                </IconButton>
                            </span>
                        </Tooltip>
                    )}
                </Box>
            ))}
            {canManage && (
                <>
                    <Box sx={{ display: "flex", gap: 1, mt: 1 }}>
                        <TextField
                            size="small"
                            placeholder="BeePM handle"
                            value={handle}
                            onChange={(event) => setHandle(event.target.value)}
                            onKeyDown={(event) => event.key === "Enter" && add()}
                            sx={{ flex: 1 }}
                        />
                        <Button
                            variant="outlined"
                            onClick={add}
                            disabled={state.busy || !handle.trim()}
                        >
                            Add owner
                        </Button>
                    </Box>
                    <Typography sx={{ fontSize: 12, color: "#888", mt: 0.75 }}>
                        Owners can publish, yank, deprecate and unpublish versions, and add or
                        remove owners.
                    </Typography>
                    {state.error && <ErrorAlert error={state.error} sx={{ mt: 1.5 }} />}
                </>
            )}
        </>
    )
}

function VersionRow({ version: v, latest, installedVersion, bee2Version, onMenu }) {
    const compatible = isCompatible(v.compatibleWith, bee2Version)
    const deps = Object.entries(v.dependencies ?? {})
    const facts = [
        formatDate(v.publishedAt),
        v.publishedBy && `by @${v.publishedBy}`,
        count(v.downloads, "download"),
        `BEE2 ${v.compatibleWith || "any version"}`,
        v.source?.type === "github" && `from GitHub ${v.source.repo} ${v.source.tag}`,
    ]
    return (
        <Box
            sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.5,
                py: 1.25,
                borderTop: "1px solid #333",
            }}
        >
            <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
                    <Typography
                        sx={{
                            fontFamily: "monospace",
                            fontWeight: 600,
                            color: v.yanked ? "#888" : "#fff",
                            textDecoration: v.yanked ? "line-through" : "none",
                            mr: 0.5,
                        }}
                    >
                        {v.version}
                    </Typography>
                    {v.version === latest && (
                        <Chip
                            label="latest"
                            size="small"
                            color="primary"
                            variant="outlined"
                            sx={smallChip}
                        />
                    )}
                    {v.version === installedVersion && (
                        <Chip label="installed" size="small" color="success" sx={smallChip} />
                    )}
                    {!compatible && (
                        <Chip
                            label="Not for your BEE2"
                            size="small"
                            color="warning"
                            variant="outlined"
                            sx={smallChip}
                        />
                    )}
                    {v.yanked && (
                        <Tooltip title={v.yankReason || "No reason given"}>
                            <Chip
                                label="Yanked"
                                size="small"
                                color="error"
                                variant="outlined"
                                sx={smallChip}
                            />
                        </Tooltip>
                    )}
                    {v.deprecated && (
                        <Tooltip title={v.deprecated}>
                            <Chip
                                label="Deprecated"
                                size="small"
                                color="warning"
                                variant="outlined"
                                sx={smallChip}
                            />
                        </Tooltip>
                    )}
                </Box>
                <Typography sx={{ fontSize: 13, color: "#999", mt: 0.25 }}>
                    {facts.filter(Boolean).join(" · ")}
                </Typography>
                {deps.length > 0 && (
                    <Box
                        sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 0.5,
                            flexWrap: "wrap",
                            mt: 0.75,
                        }}
                    >
                        <Typography sx={{ fontSize: 12, color: "#888", mr: 0.5 }}>Needs</Typography>
                        {deps.map(([dep, range]) => (
                            <Chip
                                key={dep}
                                size="small"
                                variant="outlined"
                                label={range === "*" ? dep : `${dep} ${range}`}
                                sx={{ ...smallChip, fontFamily: "monospace" }}
                            />
                        ))}
                    </Box>
                )}
            </Box>
            <IconButton
                size="small"
                aria-label={`Actions for ${v.version}`}
                onClick={(event) => onMenu(event.currentTarget, v)}
            >
                <MoreVertIcon fontSize="small" />
            </IconButton>
        </Box>
    )
}

function DetailsBody({ name, onClose }) {
    const app = useApp()
    const { auth, installed, bee2Version, job, busy, registryVersion } = app
    const [state, setState] = useState({ loading: true, doc: null, error: null })
    const [menu, setMenu] = useState(null) // a version's actions: { anchor, version }
    const [manageAnchor, setManageAnchor] = useState(null) // the package's owner/admin actions
    const [watch, setWatch] = useState(null) // automatic GitHub releases (owners see it)

    const load = useCallback(async () => {
        const res = await api.registry.package(name)
        setState(
            res.ok
                ? { loading: false, doc: res.package, error: null }
                : { loading: false, doc: null, error: res.error },
        )
    }, [name])

    useEffect(() => {
        load()
    }, [load, registryVersion])

    const doc = state.doc
    const user = auth.loggedIn ? auth.user : null
    const isAdmin = user?.role === "admin"
    // A removed package (only admins see it) can only be restored
    const removed = Boolean(doc?.removed)
    const canManage = Boolean(
        doc && user && !removed && (isAdmin || doc.owners.includes(user.handle)),
    )
    const entry = installed[name]
    const best = doc ? bestVersion(doc, bee2Version) : null

    const loadWatch = useCallback(async () => {
        const res = await api.manage.githubWatch(name)
        setWatch(res.ok ? res.watch : null)
    }, [name])
    useEffect(() => {
        if (canManage) loadWatch()
    }, [canManage, loadWatch, registryVersion])
    const working = Boolean(job) || Boolean(busy[name])

    /** Runs an owner or admin action; the confirm dialog shows a failure, otherwise reload. */
    const act = async (request, success) => {
        const res = await request
        if (res.ok) {
            app.notify(success, "success")
            app.bumpRegistry()
        }
        return res
    }
    const actNow = async (request, success) => {
        const res = await act(request, success)
        if (!res.ok) app.notify(res.error, "error")
    }

    const yank = (v) =>
        app.askConfirm({
            title: `Yank ${name}@${v.version}?`,
            message:
                "Yanked versions aren't picked for new installs or updates. Anyone who asks for exactly this version can still install it.",
            input: { label: "Reason (optional, shown to users)" },
            confirmLabel: "Yank",
            danger: true,
            onConfirm: (reason) =>
                act(
                    api.manage.yank({ name, version: v.version, reason }),
                    `Yanked ${name}@${v.version}.`,
                ),
        })
    const unyank = (v) =>
        actNow(
            api.manage.unyank({ name, version: v.version }),
            `${name}@${v.version} can be installed again.`,
        )
    const deprecate = (version) =>
        app.askConfirm({
            title: version ? `Deprecate ${name}@${version}?` : `Deprecate ${name}?`,
            message: "People see this message when they install it. It still installs.",
            input: {
                label: "Message",
                required: true,
                multiline: true,
                helperText: 'For example "Use @me/new-items instead"',
            },
            confirmLabel: "Deprecate",
            onConfirm: (message) =>
                act(
                    api.manage.deprecate({ name, version, message }),
                    `Deprecated ${version ? `${name}@${version}` : name}.`,
                ),
        })
    const undeprecate = (version) =>
        actNow(api.manage.deprecate({ name, version, message: "" }), "Removed the deprecation.")
    const unpublish = (v) =>
        app.askConfirm({
            title: `Unpublish ${name}@${v.version}?`,
            message: `This deletes ${v.version} for good, and the number can never be used again. It only works within 72 hours of publishing, and only if no other package depends on it. Otherwise, yank or deprecate it.`,
            confirmLabel: "Unpublish",
            danger: true,
            onConfirm: () =>
                act(
                    api.manage.unpublish({ name, version: v.version }),
                    `Unpublished ${name}@${v.version}.`,
                ),
        })
    const removePackage = () =>
        app.askConfirm({
            title: `Remove ${name} from the registry?`,
            message:
                "It disappears from search and can't be installed. Its files are kept, so it can be restored.",
            input: { label: "Reason (optional)" },
            confirmLabel: "Remove",
            danger: true,
            onConfirm: (reason) =>
                act(
                    api.admin.removePackage({ name, reason }),
                    `Removed ${name} from the registry.`,
                ),
        })
    const restorePackage = () => actNow(api.admin.restorePackage(name), `Restored ${name}.`)
    const stopWatch = () =>
        app.askConfirm({
            title: `Stop publishing new releases of ${watch.repo}?`,
            message: "New GitHub releases won't be published by themselves anymore.",
            confirmLabel: "Stop",
            onConfirm: async () => {
                const res = await api.manage.stopGithubWatch(name)
                if (res.ok) {
                    app.notify("Stopped publishing new GitHub releases.", "success")
                    loadWatch()
                }
                return res
            },
        })

    const update = () => {
        const title = `Update ${name} to ${best}`
        // Within its range: a normal update. Pinned to another version: allow any version again
        if (allowedByRange(best, entry.range)) app.install([name], { update: true, title })
        else app.install([`${name}@*`], { title })
    }
    const installVersion = (v) =>
        app.install([`${name}@${v.version}`], { title: `Install ${name}@${v.version}` })

    // Closes the menu the item is in, then does it
    const pick = (action) => () => {
        const version = menu.version
        setMenu(null)
        action(version)
    }
    const manage = (action) => () => {
        setManageAnchor(null)
        action()
    }

    return (
        <>
            <DialogTitle component="div" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Box sx={{ flex: 1, minWidth: 0, mr: 1 }}>
                    <Typography
                        component="div"
                        variant="h6"
                        noWrap
                        sx={{ color: "#fff", fontWeight: 600, lineHeight: 1.3 }}
                    >
                        {doc?.displayName || name}
                    </Typography>
                    <Box
                        sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 1,
                            flexWrap: "wrap",
                            mt: 0.25,
                        }}
                    >
                        <Typography
                            component="span"
                            sx={{ fontFamily: "monospace", fontSize: 13, color: "#888" }}
                        >
                            {name}
                        </Typography>
                        {entry && (
                            <Chip
                                icon={<CheckCircleIcon sx={{ fontSize: 14 }} />}
                                label={`Installed ${entry.version}${entry.explicit ? "" : " as a dependency"}`}
                                size="small"
                                color="success"
                                sx={smallChip}
                            />
                        )}
                        {entry?.range && entry.range !== "*" && (
                            <Tooltip title="Updates stay within this range">
                                <Chip label={entry.range} size="small" sx={smallChip} />
                            </Tooltip>
                        )}
                    </Box>
                </Box>

                {doc && !entry && !removed && (
                    <Tooltip title={best ? "" : "No version works with your BEE2 version"}>
                        <span>
                            <Button
                                variant="contained"
                                startIcon={<DownloadIcon />}
                                disabled={working || !best}
                                onClick={() => app.install([name])}
                            >
                                Install{best ? ` ${best}` : ""}
                            </Button>
                        </span>
                    </Tooltip>
                )}
                {doc && entry && !removed && best && isNewer(best, entry.version) && (
                    <Button
                        variant="contained"
                        startIcon={<UpgradeIcon />}
                        disabled={working}
                        onClick={update}
                    >
                        Update to {best}
                    </Button>
                )}
                {doc && entry && (
                    <Button
                        variant="outlined"
                        color="error"
                        disabled={working}
                        onClick={() => app.uninstall([name])}
                    >
                        Uninstall
                    </Button>
                )}
                {doc && (canManage || isAdmin) && (
                    <Tooltip title="Manage this package">
                        <IconButton
                            aria-label="Manage this package"
                            onClick={(event) => setManageAnchor(event.currentTarget)}
                        >
                            <MoreVertIcon />
                        </IconButton>
                    </Tooltip>
                )}
                <IconButton aria-label="Close" onClick={onClose}>
                    <CloseIcon />
                </IconButton>
            </DialogTitle>

            <DialogContent dividers sx={{ minHeight: 240 }}>
                {state.loading && (
                    <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
                        <CircularProgress />
                    </Box>
                )}
                {state.error && (
                    <ErrorAlert
                        error={state.error}
                        action={
                            <Button color="inherit" size="small" onClick={load}>
                                Retry
                            </Button>
                        }
                    />
                )}
                {doc && (
                    <>
                        {doc.removed && (
                            <Alert severity="error" sx={{ mb: 2 }}>
                                Removed from the registry on {formatDate(doc.removed.at)}
                                {doc.removed.reason ? `: ${doc.removed.reason}` : ""}. Only admins
                                can see it.
                            </Alert>
                        )}
                        {doc.deprecated && (
                            <Alert severity="warning" sx={{ mb: 2 }}>
                                Deprecated: {doc.deprecated}
                            </Alert>
                        )}
                        {doc.description && (
                            <Typography sx={{ color: "#ccc", whiteSpace: "pre-line", mb: 2 }}>
                                {doc.description}
                            </Typography>
                        )}

                        <Box
                            sx={{
                                display: "grid",
                                gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                                gap: 2,
                                p: 2,
                                borderRadius: 1,
                                backgroundColor: "#1f2122",
                                border: "1px solid #333",
                            }}
                        >
                            <Info label="Latest version">{doc.latest ?? "None"}</Info>
                            <Info label="Downloads">{formatNumber(doc.downloads)}</Info>
                            <Info label="Updated">{formatDate(doc.updatedAt)}</Info>
                        </Box>
                        {doc.latest && (
                            <ContentsLink
                                name={name}
                                version={doc.latest}
                                title={doc.displayName}
                                counts={doc.contents}
                            />
                        )}

                        {watch && (
                            <Box
                                sx={{
                                    display: "flex",
                                    alignItems: "flex-start",
                                    gap: 1,
                                    mt: 1.5,
                                    color: "#aaa",
                                    fontSize: 13,
                                }}
                            >
                                <GitHubIcon sx={{ fontSize: 18, mt: 0.1 }} />
                                <Box>
                                    New releases of {watch.repo} are published automatically.
                                    {watch.error && (
                                        <Box sx={{ color: "error.light", mt: 0.25 }}>
                                            {watch.error}
                                        </Box>
                                    )}
                                </Box>
                            </Box>
                        )}

                        <Owners
                            name={name}
                            owners={doc.owners}
                            me={user?.handle ?? null}
                            canManage={canManage}
                            onChanged={app.bumpRegistry}
                        />

                        <Typography variant="subtitle2" sx={{ mt: 3, mb: 1 }}>
                            Versions
                        </Typography>
                        {versionsNewestFirst(doc).map((v) => (
                            <VersionRow
                                key={v.version}
                                version={v}
                                latest={doc.latest}
                                installedVersion={entry?.version}
                                bee2Version={bee2Version}
                                onMenu={(anchor, version) => setMenu({ anchor, version })}
                            />
                        ))}
                        {!Object.keys(doc.versions).length && (
                            <Typography sx={{ color: "#888" }}>
                                No versions are published.
                            </Typography>
                        )}
                    </>
                )}
            </DialogContent>

            <Menu
                anchorEl={manageAnchor}
                open={Boolean(manageAnchor)}
                onClose={() => setManageAnchor(null)}
            >
                {canManage && watch && (
                    <MenuItem onClick={manage(stopWatch)}>Stop publishing GitHub releases</MenuItem>
                )}
                {canManage &&
                    (doc?.deprecated ? (
                        <MenuItem onClick={manage(() => undeprecate())}>
                            Remove deprecation
                        </MenuItem>
                    ) : (
                        <MenuItem onClick={manage(() => deprecate())}>Deprecate…</MenuItem>
                    ))}
                {isAdmin &&
                    (doc?.removed ? (
                        <MenuItem onClick={manage(restorePackage)} sx={{ color: "warning.main" }}>
                            Restore
                        </MenuItem>
                    ) : (
                        <MenuItem onClick={manage(removePackage)} sx={{ color: "error.main" }}>
                            Remove from registry…
                        </MenuItem>
                    ))}
            </Menu>

            <Menu anchorEl={menu?.anchor} open={Boolean(menu)} onClose={() => setMenu(null)}>
                {menu && [
                    <MenuItem
                        key="install"
                        disabled={working || removed || menu.version.version === entry?.version}
                        onClick={pick(installVersion)}
                    >
                        <ListItemText
                            primary={
                                menu.version.version === entry?.version
                                    ? "Installed"
                                    : `Install ${menu.version.version}`
                            }
                            secondary={
                                menu.version.version === entry?.version
                                    ? null
                                    : "Updates leave it at this version"
                            }
                        />
                    </MenuItem>,
                    ...(canManage
                        ? [
                              <Divider key="divider" />,
                              menu.version.yanked ? (
                                  <MenuItem key="unyank" onClick={pick(unyank)}>
                                      Unyank
                                  </MenuItem>
                              ) : (
                                  <MenuItem key="yank" onClick={pick(yank)}>
                                      Yank…
                                  </MenuItem>
                              ),
                              menu.version.deprecated ? (
                                  <MenuItem
                                      key="undeprecate"
                                      onClick={pick((v) => undeprecate(v.version))}
                                  >
                                      Remove deprecation
                                  </MenuItem>
                              ) : (
                                  <MenuItem
                                      key="deprecate"
                                      onClick={pick((v) => deprecate(v.version))}
                                  >
                                      Deprecate…
                                  </MenuItem>
                              ),
                              <MenuItem
                                  key="unpublish"
                                  onClick={pick(unpublish)}
                                  sx={{ color: "error.main" }}
                              >
                                  Unpublish…
                              </MenuItem>,
                          ]
                        : []),
                ]}
            </Menu>
        </>
    )
}

/** A package's details and versions, with owner and admin tools. Opened by openPackage(name). */
export default function PackageDetails() {
    const { details, closeDetails } = useApp()
    const name = useLastValue(details)
    return (
        <Dialog
            open={Boolean(details)}
            onClose={closeDetails}
            maxWidth="md"
            fullWidth
            scroll="paper"
        >
            {name && <DetailsBody key={name} name={name} onClose={closeDetails} />}
        </Dialog>
    )
}
