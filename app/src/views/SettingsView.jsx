import { useEffect, useState } from "react"
import {
    Alert,
    Avatar,
    Box,
    Button,
    ButtonBase,
    Card,
    CardContent,
    Chip,
    CircularProgress,
    Divider,
    ListItemIcon,
    ListItemText,
    Menu,
    MenuItem,
    Skeleton,
    Switch,
    TextField,
    Tooltip,
    Typography,
} from "@mui/material"
import CheckIcon from "@mui/icons-material/Check"
import DownloadIcon from "@mui/icons-material/Download"
import EditIcon from "@mui/icons-material/Edit"
import FactCheckIcon from "@mui/icons-material/FactCheck"
import FolderOpenIcon from "@mui/icons-material/FolderOpen"
import GitHubIcon from "@mui/icons-material/GitHub"
import LinkIcon from "@mui/icons-material/Link"
import LoginIcon from "@mui/icons-material/Login"
import LogoutIcon from "@mui/icons-material/Logout"
import { api, onEvent } from "../api.js"
import Brand from "../components/Brand.jsx"
import DiscordIcon from "../components/DiscordIcon.jsx"
import { formatDate, providerLabel } from "../lib/format.js"
import { useApp } from "../state/context.js"

const PROVIDERS = [
    { id: "discord", icon: DiscordIcon },
    { id: "github", icon: GitHubIcon },
]
const NICKNAME_MAX = 50
const cardSx = { mb: 3, backgroundColor: "#262829", border: "1px solid #3a3a3a" }
const rowSx = {
    display: "flex",
    alignItems: "center",
    gap: 1.5,
    py: 1.25,
    borderTop: "1px solid #333",
}

function Section({ title, children }) {
    return (
        <>
            <Typography variant="subtitle2" sx={{ mb: 1.5, color: "#888" }}>
                {title}
            </Typography>
            <Card variant="outlined" sx={cardSx}>
                <CardContent sx={{ p: 2.5, "&:last-child": { pb: 2.5 } }}>{children}</CardContent>
            </Card>
        </>
    )
}

const SubTitle = ({ children }) => (
    <Typography variant="subtitle2" sx={{ mt: 4, mb: 2 }}>
        {children}
    </Typography>
)

function IdentityRow({ provider, icon: Icon, identity, canUnlink, onLink, onUnlink }) {
    return (
        <Box sx={rowSx}>
            <Icon sx={{ color: identity ? "#ddd" : "#666" }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ color: "#fff" }}>{providerLabel(provider)}</Typography>
                <Typography variant="body2" noWrap sx={{ color: "#888" }}>
                    {identity
                        ? `${identity.username} · linked ${formatDate(identity.linkedAt)}`
                        : "Not linked"}
                </Typography>
            </Box>
            {identity ? (
                <Tooltip
                    title={
                        canUnlink
                            ? ""
                            : "You can't unlink your only login. Link another account first."
                    }
                >
                    <span>
                        <Button
                            size="small"
                            variant="outlined"
                            color="error"
                            disabled={!canUnlink}
                            onClick={onUnlink}
                        >
                            Unlink
                        </Button>
                    </span>
                </Tooltip>
            ) : (
                <Button size="small" variant="outlined" startIcon={<LinkIcon />} onClick={onLink}>
                    Link
                </Button>
            )}
        </Box>
    )
}

/** The nickname shown with your @handle (the handle itself can't change). */
function NicknameEditor() {
    const app = useApp()
    const { auth } = app
    const saved = auth.user.displayName ?? ""
    const [name, setName] = useState(saved)
    const [saving, setSaving] = useState(false)
    useEffect(() => setName(saved), [saved])

    const trimmed = name.trim()
    const valid = trimmed.length >= 1 && trimmed.length <= NICKNAME_MAX
    const canSave = trimmed !== saved && valid && !saving

    async function save() {
        if (!canSave) return
        setSaving(true)
        const res = await api.auth.updateProfile({ displayName: trimmed })
        setSaving(false)
        if (!res.ok) return app.notify(res.error, "error")
        app.notify("Nickname saved.", "success")
        await app.refreshAuth()
    }

    return (
        <Box sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
            <TextField
                fullWidth
                size="small"
                label="Nickname"
                value={name}
                error={!valid && name.length > 0}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && save()}
                helperText={`Shown with your handle, @${auth.user.handle}, which can't be changed.`}
                slotProps={{ htmlInput: { maxLength: NICKNAME_MAX } }}
            />
            <Button variant="contained" disabled={!canSave} onClick={save} sx={{ height: 40 }}>
                Save
            </Button>
        </Box>
    )
}

/**
 * Your picture at the top of Settings. Clicking it picks which linked account's picture to
 * use (or none). Offline it's just the picture.
 */
function AvatarPicker() {
    const app = useApp()
    const { auth } = app
    const [anchor, setAnchor] = useState(null)
    const [saving, setSaving] = useState(false)
    const user = auth.user
    const identities = auth.identities
    const letter = (user.displayName || user.handle)[0]?.toUpperCase()
    const avatar = (
        <Avatar
            src={user.avatarUrl || undefined}
            alt=""
            sx={{ width: 52, height: 52, bgcolor: "#3a3a3a" }}
        >
            {letter}
        </Avatar>
    )
    if (!identities) return avatar

    const current =
        auth.avatarSource ??
        identities.find((i) => i.avatarUrl && i.avatarUrl === user.avatarUrl)?.provider ??
        (user.avatarUrl ? null : "none")
    const choices = [
        ...identities.map((identity) => ({
            value: identity.provider,
            label: `${providerLabel(identity.provider)} picture`,
            src: identity.avatarUrl,
            // Accounts linked before BeePM kept pictures get theirs at the next login
            note: identity.avatarUrl
                ? null
                : `Log in with ${providerLabel(identity.provider)} once to get it`,
        })),
        { value: "none", label: "No picture", src: null, note: null },
    ]

    async function pick(value) {
        setAnchor(null)
        if (value === current) return
        setSaving(true)
        const res = await api.auth.updateProfile({ avatar: value })
        setSaving(false)
        if (!res.ok) return app.notify(res.error, "error")
        app.notify(
            value === "none"
                ? "Profile picture removed."
                : `Using your ${providerLabel(value)} picture.`,
            "success",
        )
        await app.refreshAuth()
    }

    return (
        <>
            <Tooltip title="Change profile picture">
                <ButtonBase
                    aria-label="Change profile picture"
                    onClick={(event) => !saving && setAnchor(event.currentTarget)}
                    sx={{
                        borderRadius: "50%",
                        position: "relative",
                        "&:hover .edit, &.Mui-focusVisible .edit": { opacity: 1 },
                    }}
                >
                    {avatar}
                    <Box
                        className="edit"
                        sx={{
                            position: "absolute",
                            inset: 0,
                            borderRadius: "50%",
                            backgroundColor: "rgba(0, 0, 0, 0.55)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            opacity: saving ? 1 : 0,
                            transition: "opacity 120ms",
                        }}
                    >
                        {saving ? (
                            <CircularProgress size={20} />
                        ) : (
                            <EditIcon sx={{ fontSize: 20, color: "#fff" }} />
                        )}
                    </Box>
                </ButtonBase>
            </Tooltip>
            <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
                {choices.map((choice) => (
                    <MenuItem
                        key={choice.value}
                        selected={choice.value === current}
                        disabled={Boolean(choice.note)}
                        onClick={() => pick(choice.value)}
                    >
                        <ListItemIcon>
                            <Avatar
                                src={choice.src || undefined}
                                alt=""
                                sx={{ width: 28, height: 28, bgcolor: "#3a3a3a", fontSize: 14 }}
                            >
                                {choice.value === "none" ? letter : undefined}
                            </Avatar>
                        </ListItemIcon>
                        <ListItemText primary={choice.label} secondary={choice.note} />
                        {choice.value === current && (
                            <CheckIcon sx={{ ml: 2, fontSize: 18, color: "#2eff7b" }} />
                        )}
                    </MenuItem>
                ))}
            </Menu>
        </>
    )
}

function AccountSection() {
    const app = useApp()
    const { auth } = app

    const unlink = (identity) =>
        app.askConfirm({
            title: `Unlink your ${providerLabel(identity.provider)} account?`,
            message: `You won't be able to log in with ${identity.username} anymore. You can link it again later.`,
            confirmLabel: "Unlink",
            danger: true,
            onConfirm: async () => {
                const res = await api.auth.unlink(identity.provider)
                if (res.ok) {
                    app.notify(`Unlinked ${providerLabel(identity.provider)}.`, "success")
                    app.refreshAuth()
                }
                return res
            },
        })

    if (auth.loading) return <Skeleton variant="rounded" height={72} />

    if (!auth.loggedIn) {
        return (
            <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                <Box sx={{ flex: 1 }}>
                    <Typography sx={{ color: "#fff", fontWeight: 500 }}>Not logged in</Typography>
                </Box>
                <Button
                    variant="contained"
                    startIcon={<LoginIcon />}
                    onClick={() => app.startLogin("login")}
                >
                    Log in
                </Button>
            </Box>
        )
    }

    const user = auth.user
    const identities = auth.identities
    return (
        <>
            <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                <AvatarPicker />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                        <Typography noWrap sx={{ color: "#fff", fontWeight: 600, fontSize: 18 }}>
                            {user.displayName || `@${user.handle}`}
                        </Typography>
                        {user.role === "admin" && (
                            <Chip label="Admin" size="small" color="primary" variant="outlined" />
                        )}
                    </Box>
                    <Typography variant="body2" noWrap sx={{ color: "#888" }}>
                        @{user.handle} ·{" "}
                        {auth.canPublish
                            ? "Can publish packages"
                            : auth.offline
                              ? "Offline"
                              : "Can't publish yet"}
                    </Typography>
                </Box>
                <Button
                    variant="outlined"
                    color="error"
                    startIcon={<LogoutIcon />}
                    onClick={app.logout}
                >
                    Log out
                </Button>
            </Box>

            {auth.offline && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                    Can't reach the registry right now, so this is the account saved on this
                    computer.
                </Alert>
            )}
            {!auth.offline && auth.canPublish === false && (
                <Alert severity={auth.banned ? "error" : "warning"} sx={{ mt: 2 }}>
                    {auth.publishBlockedReason || "This account can't publish packages."}
                </Alert>
            )}

            {identities ? (
                <>
                    <SubTitle>Profile</SubTitle>
                    <NicknameEditor />

                    <SubTitle>Linked accounts</SubTitle>
                    {PROVIDERS.map(({ id, icon }) => {
                        const identity = identities.find((i) => i.provider === id)
                        return (
                            <IdentityRow
                                key={id}
                                provider={id}
                                icon={icon}
                                identity={identity}
                                canUnlink={identities.length > 1}
                                onLink={() => app.startLogin("link")}
                                onUnlink={() => unlink(identity)}
                            />
                        )
                    })}
                </>
            ) : (
                <Typography variant="body2" sx={{ color: "#888", mt: 2 }}>
                    Account settings can't be shown while the registry can't be reached.
                </Typography>
            )}
        </>
    )
}

/** Looking at BEE2's packages in the background, and what it doesn't ask about anymore. */
function BackgroundSetting() {
    const { notify } = useApp()
    const [settings, setSettings] = useState(null)

    useEffect(() => {
        api.app.settings().then((res) => res.ok && setSettings(res.settings))
    }, [])

    async function change(changes) {
        const res = await api.app.updateSettings(changes)
        if (res.ok) setSettings(res.settings)
        else notify(res.error, "error")
    }

    if (!settings) return null
    const ignored = settings.ignoredUpdates
    const kept = settings.keepOwn ?? []
    const otherBee2 = settings.ignoredBee2 ?? []
    return (
        <>
            <Divider sx={{ my: 2 }} />
            <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                <Box sx={{ flex: 1 }}>
                    <Typography sx={{ color: "#fff", fontWeight: 500 }}>
                        Check packages when BEE2 opens
                    </Typography>
                    <Typography variant="body2" sx={{ color: "#888" }}>
                        Updates and duplicates. BeePM starts with Windows and waits in the tray.
                    </Typography>
                </Box>
                <Switch
                    checked={settings.background}
                    onChange={(event) => change({ background: event.target.checked })}
                />
            </Box>
            {ignored.length > 0 && (
                <Box sx={{ display: "flex", alignItems: "center", gap: 2, mt: 1 }}>
                    <Typography variant="body2" sx={{ color: "#888", flex: 1 }}>
                        Not asking about updates of {ignored.join(", ")}
                    </Typography>
                    <Button size="small" onClick={() => change({ ignoredUpdates: [] })}>
                        Ask again
                    </Button>
                </Box>
            )}
            {kept.length > 0 && (
                <Box sx={{ display: "flex", alignItems: "center", gap: 2, mt: 1 }}>
                    <Typography variant="body2" sx={{ color: "#888", flex: 1 }}>
                        Keeping your own copy of {kept.length} package{kept.length === 1 ? "" : "s"}{" "}
                        that {kept.length === 1 ? "is" : "are"} on BeePM
                    </Typography>
                    <Button size="small" onClick={() => change({ keepOwn: [] })}>
                        Ask again
                    </Button>
                </Box>
            )}
            {otherBee2.length > 0 && (
                <Box sx={{ display: "flex", alignItems: "center", gap: 2, mt: 1 }}>
                    <Typography variant="body2" sx={{ color: "#888", flex: 1 }}>
                        Not asking about BEE2 from {otherBee2.join(", ")}
                    </Typography>
                    <Button size="small" onClick={() => change({ ignoredBee2: [] })}>
                        Ask again
                    </Button>
                </Box>
            )}
        </>
    )
}

/** Where BEE2 is: BeePM installs into its packages folder, in a "beepm" folder. */
function Bee2Section() {
    const app = useApp()
    const { bee2 } = app
    const [busy, setBusy] = useState(false)
    const ready = Boolean(bee2?.dir && bee2.found !== false)

    async function takeFolder(folder) {
        setBusy(true)
        const res = await api.bee2.setFolder(folder)
        setBusy(false)
        await Promise.all([app.refreshBee2(), app.refreshInstalled()])
        if (!res.ok) return app.notify(res.error, "error")
        const moved = res.moved ? ` Moved ${res.moved} of BeePM's packages there.` : ""
        app.notify(
            `Using BEE2${res.version ? ` ${res.version}` : ""} from ${res.dir}.${moved}`,
            "success",
        )
    }

    async function choose() {
        const picked = await api.bee2.pickFolder()
        if (!picked.ok) return app.notify(picked.error, "error")
        if (!picked.canceled) await takeFolder(picked.path)
    }

    async function openFolder() {
        const res = await api.app.openPackagesFolder()
        if (!res.ok) app.notify(res.error, "error")
    }

    return (
        <>
            <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ color: "#fff", fontWeight: 500 }}>
                        {ready ? `BEE2${bee2.version ? ` ${bee2.version}` : ""}` : "BEE2's folder"}
                    </Typography>
                    <Typography variant="body2" sx={{ color: "#888", overflowWrap: "anywhere" }}>
                        {!bee2
                            ? "Checking…"
                            : (bee2.error ?? bee2.dir ?? "Choose the folder BEE2.exe is in.")}
                    </Typography>
                </Box>
                <Button
                    variant={bee2?.dir ? "outlined" : "contained"}
                    startIcon={<FolderOpenIcon />}
                    onClick={choose}
                    disabled={busy || !bee2}
                    sx={{ flexShrink: 0 }}
                >
                    {bee2?.dir ? "Change" : "Choose"}
                </Button>
            </Box>
            {bee2?.suggestion && !bee2.dir && (
                <Alert
                    severity="info"
                    sx={{ mt: 1.5 }}
                    action={
                        <Button
                            color="inherit"
                            size="small"
                            disabled={busy}
                            onClick={() => takeFolder(bee2.suggestion)}
                        >
                            Use it
                        </Button>
                    }
                >
                    BEE2 is running from {bee2.suggestion}
                </Alert>
            )}
            {bee2?.dir && bee2.found === false && (
                <Alert severity="warning" sx={{ mt: 1.5 }}>
                    BEE2 isn't in this folder anymore. Choose where it is now.
                </Alert>
            )}
            {ready && !bee2.version && (
                <Alert severity="info" sx={{ mt: 1.5 }}>
                    Open BEE2 once so BeePM knows its version.
                </Alert>
            )}
            {bee2?.moving === "bee2" && (
                <Alert severity="info" sx={{ mt: 1.5 }}>
                    Close BEE2 so BeePM can set its packages folder back.
                </Alert>
            )}
            <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mt: 2 }}>
                <Button startIcon={<FactCheckIcon />} onClick={app.openReview} disabled={!ready}>
                    Check packages
                </Button>
                <Button
                    startIcon={<FolderOpenIcon />}
                    onClick={openFolder}
                    disabled={!ready}
                    sx={{ ml: "auto" }}
                >
                    Open packages folder
                </Button>
            </Box>
            <BackgroundSetting />
        </>
    )
}

/** BeePM's version and its own updates (backend/appUpdater.js), and the logs folder. */
function AboutSection() {
    const { appInfo, notify } = useApp()
    const [update, setUpdate] = useState(null)

    useEffect(() => {
        api.app.update().then((res) => res.ok && setUpdate(res.status))
        return onEvent("app:update-status", setUpdate)
    }, [])

    async function updateNow(action) {
        const res = await api.app.update(action)
        if (res.ok) setUpdate(res.status)
        else notify(res.error, "error")
    }

    async function openLogs() {
        const res = await api.app.openLogsFolder()
        if (!res.ok) notify(res.error, "error")
    }

    const phase = update?.phase
    const updateText = {
        checking: "Looking for updates…",
        downloading: `Downloading ${update?.version}${update?.percent ? ` (${update.percent}%)` : ""}…`,
        ready: `BeePM ${update?.version} is ready`,
        current: "Up to date",
        error: "Couldn't look for updates",
    }[phase]

    return (
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
            <Box sx={{ flex: 1 }}>
                <Typography sx={{ color: "#fff", fontWeight: 500 }}>
                    <Brand /> {appInfo?.version ?? ""}
                </Typography>
                <Typography variant="body2" sx={{ color: "#888" }}>
                    A package manager for BEEmod (BEE2) packages: browse, install and publish
                    community packages for Portal 2's Puzzle Maker.
                </Typography>
                {updateText && (
                    <Typography
                        variant="body2"
                        title={update?.error ?? ""}
                        sx={{ color: phase === "ready" ? "#2eff7b" : "#888", mt: 0.5 }}
                    >
                        {updateText}
                    </Typography>
                )}
            </Box>
            <Box
                sx={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-end",
                    gap: 0.5,
                    flexShrink: 0,
                }}
            >
                {phase === "ready" ? (
                    <Button variant="contained" onClick={() => updateNow("restart")}>
                        Restart to update
                    </Button>
                ) : phase && phase !== "off" ? (
                    <Button
                        onClick={() => updateNow("check")}
                        disabled={phase === "checking" || phase === "downloading"}
                    >
                        Check for updates
                    </Button>
                ) : null}
                <Button startIcon={<FolderOpenIcon />} onClick={openLogs}>
                    Open logs folder
                </Button>
            </Box>
        </Box>
    )
}

export default function SettingsView() {
    return (
        <Box>
            <Section title="ACCOUNT">
                <AccountSection />
            </Section>
            <Section title="BEE2">
                <Bee2Section />
            </Section>
            <Section title="ABOUT">
                <AboutSection />
            </Section>
        </Box>
    )
}
