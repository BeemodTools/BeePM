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
    TextField,
    Tooltip,
    Typography,
} from "@mui/material"
import CheckIcon from "@mui/icons-material/Check"
import DownloadIcon from "@mui/icons-material/Download"
import EditIcon from "@mui/icons-material/Edit"
import FolderOpenIcon from "@mui/icons-material/FolderOpen"
import GitHubIcon from "@mui/icons-material/GitHub"
import LinkIcon from "@mui/icons-material/Link"
import LoginIcon from "@mui/icons-material/Login"
import LogoutIcon from "@mui/icons-material/Logout"
import { api } from "../api.js"
import Bee2SetupDialog from "../components/Bee2SetupDialog.jsx"
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

function Bee2Section() {
    const app = useApp()
    const { bee2 } = app
    const [setupOpen, setSetupOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const setup = bee2?.bee2
    const hooked = Boolean(bee2?.hooked)
    const setUp = Boolean(setup?.version && setup.basePackageCount)

    const hookText = !bee2
        ? "Checking…"
        : bee2.error
          ? bee2.error
          : hooked
            ? "BEE2 loads packages from BeePM."
            : bee2.configFound === false
              ? "BEE2's settings weren't found. Install BEE2 and open it once."
              : "BEE2 doesn't load packages from BeePM yet."

    async function run(action) {
        setBusy(true)
        const res = await action()
        setBusy(false)
        await app.refreshBee2()
        return res
    }

    const closedNote = (res) => (res.closedBee2 ? " BEE2 was open, so BeePM closed it." : "")

    async function hook() {
        const res = await run(() => api.bee2.hook())
        if (!res.ok) return app.notify(res.error, "error")
        app.notify(
            (res.changed ? "BEE2 now loads packages from BeePM." : "BEE2 was already hooked.") +
                closedNote(res),
            "success",
        )
    }

    async function unhook() {
        const res = await run(() => api.bee2.unhook())
        if (!res.ok) return app.notify(res.error, "error")
        app.notify(
            (res.changed
                ? "BEE2 uses its own packages folder again."
                : "BEE2 wasn't hooked to BeePM.") + closedNote(res),
            "success",
        )
    }

    async function openFolder() {
        const res = await api.app.openPackagesFolder()
        if (!res.ok) app.notify(res.error, "error")
    }

    return (
        <>
            <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                <Box sx={{ flex: 1 }}>
                    <Typography sx={{ color: "#fff", fontWeight: 500 }}>Hook</Typography>
                    <Typography variant="body2" sx={{ color: "#888", overflowWrap: "anywhere" }}>
                        {hookText}
                    </Typography>
                </Box>
                <Chip
                    label={hooked ? "Hooked" : "Not hooked"}
                    size="small"
                    sx={{
                        fontWeight: 500,
                        backgroundColor: hooked ? "#1db34f" : "#d32f2f",
                        color: "#fff",
                    }}
                />
            </Box>
            <Divider sx={{ my: 2 }} />
            <Typography sx={{ color: "#fff", fontWeight: 500 }}>
                {setup?.version ? setup.name || `BEE2 ${setup.version}` : "BEE2 isn't set up"}
            </Typography>
            <Typography variant="body2" sx={{ color: "#888" }}>
                {setup?.version
                    ? [
                          `BEE2 ${setup.version}`,
                          setup.itemsTag && `BEE2-items ${setup.itemsTag}`,
                          setup.basePackageCount && `${setup.basePackageCount} of BEE2's packages`,
                      ]
                          .filter(Boolean)
                          .join(" · ")
                    : null}
            </Typography>
            {setup?.fromLegacy && (
                <Alert severity="info" sx={{ mt: 1.5 }}>
                    This BEE2 version comes from an earlier BeePM version. Set up BEE2 again to get
                    BEE2's packages into BeePM's folder.
                </Alert>
            )}
            <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center", mt: 2 }}>
                <Button
                    variant="contained"
                    startIcon={<DownloadIcon />}
                    onClick={() => setSetupOpen(true)}
                >
                    {setup?.version ? "Change BEE2 version" : "Set up BEE2"}
                </Button>
                {hooked ? (
                    <Button variant="outlined" color="error" onClick={unhook} disabled={busy}>
                        Unhook
                    </Button>
                ) : (
                    <Tooltip
                        title={
                            setUp
                                ? ""
                                : "Set up BEE2 first: BEE2 needs its own packages in BeePM's folder."
                        }
                    >
                        <span>
                            <Button
                                variant="outlined"
                                onClick={hook}
                                disabled={busy || !bee2 || bee2.configFound === false || !setUp}
                            >
                                Hook
                            </Button>
                        </span>
                    </Tooltip>
                )}
                <Button startIcon={<FolderOpenIcon />} onClick={openFolder} sx={{ ml: "auto" }}>
                    Open packages folder
                </Button>
            </Box>
            <Bee2SetupDialog open={setupOpen} onClose={() => setSetupOpen(false)} />
        </>
    )
}

function AboutSection() {
    const { appInfo, notify } = useApp()

    async function openLogs() {
        const res = await api.app.openLogsFolder()
        if (!res.ok) notify(res.error, "error")
    }

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
            </Box>
            <Button startIcon={<FolderOpenIcon />} onClick={openLogs} sx={{ flexShrink: 0 }}>
                Open logs folder
            </Button>
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
