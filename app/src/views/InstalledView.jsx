import {
    Alert,
    Box,
    Button,
    Card,
    Chip,
    CircularProgress,
    Tooltip,
    Typography,
} from "@mui/material"
import InventoryIcon from "@mui/icons-material/Inventory"
import RefreshIcon from "@mui/icons-material/Refresh"
import UpgradeIcon from "@mui/icons-material/Upgrade"
import EmptyState from "../components/EmptyState.jsx"
import { formatDate, isCompatible } from "../lib/format.js"
import { useApp } from "../state/context.js"

const smallChip = { height: 20, fontSize: 11 }

function InstalledRow({ name, entry }) {
    const { bee2Version, outdatedByName, busy, job, install, uninstall, updateFor, openPackage } =
        useApp()
    const row = outdatedByName[name]
    const update = updateFor(name)
    const compatible = isCompatible(entry.compatibleWith, bee2Version)
    const working = Boolean(job) || Boolean(busy[name])
    const deps = Object.keys(entry.dependencies ?? {})

    return (
        <Card
            variant="outlined"
            sx={{
                backgroundColor: "#262829",
                border: "1px solid #3a3a3a",
                px: 2,
                py: 1.5,
                display: "flex",
                alignItems: "center",
                gap: 2,
            }}
        >
            <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                    <Typography
                        component="button"
                        onClick={() => openPackage(name)}
                        sx={{
                            all: "unset",
                            cursor: "pointer",
                            fontWeight: 600,
                            color: "#fff",
                            fontFamily: "monospace",
                            "&:hover": { textDecoration: "underline" },
                        }}
                    >
                        {name}
                    </Typography>
                    <Typography sx={{ color: "#2eff7b", fontSize: 14 }}>
                        v{entry.version}
                    </Typography>
                    {!entry.explicit && <Chip label="dependency" size="small" sx={smallChip} />}
                    {update && (
                        <Chip
                            label={`${update} available`}
                            size="small"
                            color="primary"
                            variant="outlined"
                            sx={smallChip}
                        />
                    )}
                    {row?.removed && (
                        <Chip
                            label="Removed from the registry"
                            size="small"
                            color="error"
                            variant="outlined"
                            sx={smallChip}
                        />
                    )}
                    {row?.yanked && (
                        <Chip
                            label="This version was yanked"
                            size="small"
                            color="error"
                            variant="outlined"
                            sx={smallChip}
                        />
                    )}
                    {row?.deprecated && (
                        <Tooltip title={row.deprecated}>
                            <Chip
                                label="Deprecated"
                                size="small"
                                color="warning"
                                variant="outlined"
                                sx={smallChip}
                            />
                        </Tooltip>
                    )}
                    {!compatible && (
                        <Tooltip
                            title={`Needs BEE2 ${entry.compatibleWith}; you have ${bee2Version}`}
                        >
                            <Chip
                                label="Not for your BEE2"
                                size="small"
                                color="warning"
                                variant="outlined"
                                sx={smallChip}
                            />
                        </Tooltip>
                    )}
                </Box>
                <Typography variant="body2" sx={{ color: "#888", mt: 0.25 }}>
                    Installed {formatDate(entry.installedAt)}
                    {entry.range && entry.range !== "*" ? ` · range ${entry.range}` : ""}
                    {deps.length ? ` · needs ${deps.join(", ")}` : ""}
                </Typography>
            </Box>
            <Box sx={{ display: "flex", gap: 1, flexShrink: 0 }}>
                {update && (
                    <Button
                        size="small"
                        variant="contained"
                        startIcon={<UpgradeIcon />}
                        disabled={working}
                        onClick={() => install([name], { update: true })}
                    >
                        Update
                    </Button>
                )}
                <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    disabled={working}
                    onClick={() => uninstall([name])}
                    sx={{ minWidth: 96 }}
                >
                    {busy[name] ? <CircularProgress size={18} color="inherit" /> : "Uninstall"}
                </Button>
            </Box>
        </Card>
    )
}

/** What's installed (by you or as dependencies), with updates. */
export default function InstalledView({ query, onNavigate }) {
    const { installed, outdated, bee2, job, install, refreshInstalled, updateFor } = useApp()
    const all = Object.entries(installed).sort(([a], [b]) => a.localeCompare(b))
    const q = query.trim().toLowerCase()
    const shown = q
        ? all.filter(([name, entry]) => name.includes(q) || entry.beeId?.toLowerCase().includes(q))
        : all
    const updates = all.filter(([name]) => updateFor(name)).length

    return (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {bee2 && !bee2.error && !bee2.hooked && (
                <Alert
                    severity="warning"
                    action={
                        <Button color="inherit" size="small" onClick={() => onNavigate("settings")}>
                            Settings
                        </Button>
                    }
                >
                    BEE2 isn't hooked to BeePM, so it won't load these packages.
                </Alert>
            )}
            {bee2 && !bee2.error && !bee2.bee2?.version && (
                <Alert severity="info">
                    BeePM doesn't know your BEE2 version, so compatibility isn't checked. Set up
                    BEE2 in Settings.
                </Alert>
            )}

            {!all.length ? (
                <EmptyState
                    icon={InventoryIcon}
                    title="No packages installed"
                    text="Find packages to install in Browse."
                    action={
                        <Button variant="outlined" onClick={() => onNavigate("browse")}>
                            Browse packages
                        </Button>
                    }
                />
            ) : (
                <>
                    <Box
                        sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 1,
                            mb: 0.5,
                            flexWrap: "wrap",
                        }}
                    >
                        <Typography variant="subtitle2" sx={{ color: "#888", flex: 1 }}>
                            {all.length} installed
                        </Typography>
                        <Button
                            size="small"
                            startIcon={
                                outdated.loading ? <CircularProgress size={14} /> : <RefreshIcon />
                            }
                            disabled={outdated.loading}
                            onClick={() => refreshInstalled()}
                        >
                            Check for updates
                        </Button>
                        <Button
                            size="small"
                            variant="contained"
                            startIcon={<UpgradeIcon />}
                            disabled={!updates || Boolean(job)}
                            onClick={() => install([], { update: true })}
                        >
                            Update all{updates ? ` (${updates})` : ""}
                        </Button>
                    </Box>
                    {outdated.error && (
                        <Alert severity="warning">
                            Couldn't check for updates: {outdated.error}
                        </Alert>
                    )}
                    {shown.map(([name, entry]) => (
                        <InstalledRow key={name} name={name} entry={entry} />
                    ))}
                    {!shown.length && (
                        <Typography sx={{ color: "#888", textAlign: "center", py: 4 }}>
                            No installed package matches "{query.trim()}".
                        </Typography>
                    )}
                </>
            )}
        </Box>
    )
}
