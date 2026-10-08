import {
    Avatar,
    Badge,
    Box,
    Button,
    ButtonBase,
    Chip,
    List,
    ListItemButton,
    ListItemIcon,
    ListItemText,
    Skeleton,
    Tooltip,
    Typography,
} from "@mui/material"
import CloudOffIcon from "@mui/icons-material/CloudOff"
import ExploreIcon from "@mui/icons-material/Explore"
import InventoryIcon from "@mui/icons-material/Inventory"
import LoginIcon from "@mui/icons-material/Login"
import OpenInNewIcon from "@mui/icons-material/OpenInNew"
import PublishIcon from "@mui/icons-material/Publish"
import SettingsIcon from "@mui/icons-material/Settings"
import { api } from "../api.js"
import { useApp } from "../state/context.js"
import Brand from "./Brand.jsx"
import DiscordIcon from "./DiscordIcon.jsx"

export const SIDEBAR_WIDTH = 220
const DISCORD_INVITE = "https://discord.gg/jNr7DUsRTC"

/** A view of the app, or (external) a link that opens in the browser. */
function NavItem({ icon: Icon, label, selected, badge, external, onClick }) {
    const icon = <Icon sx={{ color: selected ? "#2eff7b" : "#888" }} />
    return (
        <ListItemButton
            selected={selected}
            onClick={onClick}
            sx={{
                mx: 1,
                borderRadius: 1,
                mb: 0.5,
                "&.Mui-selected": {
                    backgroundColor: "rgba(46, 255, 123, 0.1)",
                    "&:hover": { backgroundColor: "rgba(46, 255, 123, 0.15)" },
                },
            }}
        >
            <ListItemIcon sx={{ minWidth: 40 }}>
                {badge ? (
                    <Badge badgeContent={badge} color="primary" max={99}>
                        {icon}
                    </Badge>
                ) : (
                    icon
                )}
            </ListItemIcon>
            <ListItemText
                primary={label}
                slotProps={{
                    primary: {
                        sx: { fontWeight: selected ? 600 : 400, color: selected ? "#fff" : "#ccc" },
                    },
                }}
            />
            {external && <OpenInNewIcon sx={{ fontSize: 16, color: "#666" }} />}
        </ListItemButton>
    )
}

function AccountChip({ onOpenSettings }) {
    const { auth, startLogin } = useApp()
    if (auth.loading) return <Skeleton variant="rounded" height={44} />
    if (!auth.loggedIn) {
        return (
            <Button
                fullWidth
                variant="outlined"
                startIcon={<LoginIcon />}
                onClick={() => startLogin("login")}
            >
                Log in
            </Button>
        )
    }
    const user = auth.user
    return (
        <ButtonBase
            onClick={onOpenSettings}
            sx={{
                width: "100%",
                justifyContent: "flex-start",
                gap: 1,
                px: 2,
                py: 0.5,
                minHeight: 48, // the height of the Settings item above it
                borderRadius: 1,
                "&:hover": { backgroundColor: "rgba(255, 255, 255, 0.05)" },
            }}
        >
            <Avatar
                src={user.avatarUrl || undefined}
                alt=""
                sx={{ width: 32, height: 32, bgcolor: "#3a3a3a", fontSize: 14 }}
            >
                {(user.displayName || user.handle)[0]?.toUpperCase()}
            </Avatar>
            <Box sx={{ minWidth: 0, flex: 1, textAlign: "left" }}>
                <Typography noWrap sx={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>
                    {user.displayName || `@${user.handle}`}
                </Typography>
                <Typography noWrap sx={{ fontSize: 12, color: "#888" }}>
                    {auth.banned ? "Banned · " : auth.offline ? "Offline · " : ""}@{user.handle}
                </Typography>
            </Box>
            {auth.offline && (
                <Tooltip title="Can't reach the registry. Showing your saved login.">
                    <CloudOffIcon sx={{ fontSize: 18, color: "#f9a825" }} />
                </Tooltip>
            )}
        </ButtonBase>
    )
}

/** BEE2: its version once BeePM knows where it is, else a reminder to choose its folder. */
function Bee2Chip({ onOpenSettings }) {
    const { bee2 } = useApp()
    const ready = Boolean(bee2?.dir && bee2.found !== false)
    const label = !bee2
        ? "Checking BEE2…"
        : ready
          ? `BEE2${bee2.version ? ` ${bee2.version}` : ""}`
          : bee2.dir
            ? "BEE2 not found"
            : "Choose BEE2"
    const tooltip = !bee2
        ? ""
        : ready
          ? bee2.dir
          : (bee2.error ?? "BeePM doesn't know where BEE2 is. Choose its folder in Settings.")
    return (
        <Tooltip title={tooltip} placement="right">
            <Chip
                label={label}
                size="small"
                onClick={onOpenSettings}
                sx={{
                    width: "100%",
                    fontWeight: 500,
                    backgroundColor: !bee2 ? "#3a3a3a" : ready ? "#1db34f" : "#d32f2f",
                    color: "#fff",
                    "&:hover": { backgroundColor: !bee2 ? "#444" : ready ? "#22c55a" : "#e53935" },
                }}
            />
        </Tooltip>
    )
}

export default function Sidebar({ view, onNavigate }) {
    const { installed, notify } = useApp()
    const installedCount = Object.keys(installed).length
    const openSettings = () => onNavigate("settings")
    const openDiscord = async () => {
        const res = await api.app.openExternal(DISCORD_INVITE)
        if (!res.ok) notify(res.error, "error")
    }
    return (
        <Box
            component="nav"
            sx={{
                width: SIDEBAR_WIDTH,
                flexShrink: 0,
                borderRight: "1px solid #3a3a3a",
                backgroundColor: "#232526",
                display: "flex",
                flexDirection: "column",
            }}
        >
            <Box
                sx={{
                    px: 2.5,
                    height: 56,
                    borderBottom: "1px solid #3a3a3a",
                    display: "flex",
                    alignItems: "center",
                    boxSizing: "border-box",
                }}
            >
                <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1 }}>
                    <Brand />
                </Typography>
            </Box>

            <List sx={{ flex: 1, py: 1 }}>
                <NavItem
                    icon={ExploreIcon}
                    label="Browse"
                    selected={view === "browse"}
                    onClick={() => onNavigate("browse")}
                />
                <NavItem
                    icon={InventoryIcon}
                    label="Installed"
                    badge={installedCount}
                    selected={view === "installed"}
                    onClick={() => onNavigate("installed")}
                />
                <NavItem
                    icon={PublishIcon}
                    label="Publish"
                    selected={view === "publish"}
                    onClick={() => onNavigate("publish")}
                />
            </List>

            <Box sx={{ borderTop: "1px solid #3a3a3a", pt: 1 }}>
                <NavItem icon={DiscordIcon} label="Discord" external onClick={openDiscord} />
                <NavItem
                    icon={SettingsIcon}
                    label="Settings"
                    selected={view === "settings"}
                    onClick={openSettings}
                />
                <Box sx={{ px: 1, pb: 2, display: "flex", flexDirection: "column", gap: 1.25 }}>
                    <AccountChip onOpenSettings={openSettings} />
                    <Bee2Chip onOpenSettings={openSettings} />
                </Box>
            </Box>
        </Box>
    )
}
