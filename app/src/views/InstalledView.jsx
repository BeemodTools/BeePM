import { useState } from "react"
import {
    Alert,
    Box,
    Button,
    Card,
    Chip,
    CircularProgress,
    Menu,
    MenuItem,
    Tooltip,
    Typography,
} from "@mui/material"
import FileUploadIcon from "@mui/icons-material/FileUpload"
import InventoryIcon from "@mui/icons-material/Inventory"
import RefreshIcon from "@mui/icons-material/Refresh"
import UpgradeIcon from "@mui/icons-material/Upgrade"
import { api } from "../api.js"
import EmptyState from "../components/EmptyState.jsx"
import ImportDialog from "../components/ImportDialog.jsx"
import { formatDate, isCompatible } from "../lib/format.js"
import { useApp } from "../state/context.js"

const smallChip = { height: 20, fontSize: 11 }
const cardSx = {
    backgroundColor: "#262829",
    border: "1px solid #3a3a3a",
    px: 2,
    py: 1.5,
    display: "flex",
    alignItems: "center",
    gap: 2,
}
const baseName = (file) =>
    String(file ?? "")
        .split(/[\\/]/)
        .pop()

function InstalledRow({ name, entry }) {
    const { bee2Version, outdatedByName, busy, job, install, uninstall, updateFor, openPackage } =
        useApp()
    const row = outdatedByName[name]
    const update = updateFor(name)
    const compatible = isCompatible(entry.compatibleWith, bee2Version)
    const working = Boolean(job) || Boolean(busy[name])
    const deps = Object.keys(entry.dependencies ?? {})

    return (
        <Card variant="outlined" sx={cardSx}>
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

/** A package imported from this PC: not from the registry, so it never updates. */
function LocalRow({ beeId, entry }) {
    const { job, notify, refreshInstalled } = useApp()
    const [removing, setRemoving] = useState(false)
    const name = entry.name ?? baseName(entry.from)

    async function remove() {
        setRemoving(true)
        const res = await api.packages.removeLocal(beeId)
        setRemoving(false)
        notify(res.ok ? `Removed ${name}.` : res.error, res.ok ? "success" : "error")
        refreshInstalled()
    }

    return (
        <Card variant="outlined" sx={cardSx}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                    <Typography sx={{ fontWeight: 600, color: "#fff" }}>{name}</Typography>
                    <Tooltip title={entry.from ?? ""}>
                        <Chip label="Local" size="small" variant="outlined" sx={smallChip} />
                    </Tooltip>
                </Box>
                <Typography variant="body2" sx={{ color: "#888", mt: 0.25 }}>
                    Imported {formatDate(entry.importedAt)}
                </Typography>
            </Box>
            <Button
                size="small"
                variant="outlined"
                color="error"
                disabled={removing || Boolean(job)}
                onClick={remove}
                sx={{ minWidth: 96, flexShrink: 0 }}
            >
                {removing ? <CircularProgress size={18} color="inherit" /> : "Remove"}
            </Button>
        </Card>
    )
}

/**
 * Imports packages from this PC: a .bee_pack, a package folder or a folder of packages. Shows
 * what will happen first (ImportDialog).
 */
function useImport() {
    const { notify, refreshInstalled } = useApp()
    const [menu, setMenu] = useState(null)
    const [scan, setScan] = useState(null) // { importId, items, offline }
    const [scanning, setScanning] = useState(false)
    const [working, setWorking] = useState(false)

    async function pick(kind) {
        setMenu(null)
        const picked = await api.packages.pickImport(kind)
        if (!picked.ok) return notify(picked.error, "error")
        if (picked.canceled) return
        setScanning(true)
        const res = await api.packages.importScan(picked.path)
        setScanning(false)
        if (res.ok) setScan(res)
        else notify(res.error, "error")
    }

    async function run() {
        setWorking(true)
        const res = await api.packages.importApply(scan.importId)
        setWorking(false)
        setScan(null)
        await refreshInstalled()
        if (!res.ok) return notify(res.error, "error")
        const count = res.imported.length + res.installed.length
        notify(`Imported ${count}. Restart BEE2 to load ${count === 1 ? "it" : "them"}.`, "success")
    }

    const button = (
        <>
            <Button
                size="small"
                startIcon={scanning ? <CircularProgress size={14} /> : <FileUploadIcon />}
                disabled={scanning}
                onClick={(event) => setMenu(event.currentTarget)}
            >
                Import
            </Button>
            <Menu anchorEl={menu} open={Boolean(menu)} onClose={() => setMenu(null)}>
                <MenuItem onClick={() => pick("file")}>A .bee_pack file</MenuItem>
                <MenuItem onClick={() => pick("folder")}>A folder</MenuItem>
            </Menu>
            {scan && (
                <ImportDialog
                    scan={scan}
                    working={working}
                    onImport={run}
                    onClose={() => setScan(null)}
                />
            )}
        </>
    )
    return button
}

/** What's installed (by you or as dependencies), with updates, and packages imported from this PC. */
export default function InstalledView({ query, onNavigate }) {
    const { installed, local, outdated, bee2, job, install, refreshInstalled, updateFor } = useApp()
    const importButton = useImport()
    const all = Object.entries(installed).sort(([a], [b]) => a.localeCompare(b))
    const locals = Object.entries(local).sort(([, a], [, b]) =>
        String(a.name ?? "").localeCompare(String(b.name ?? "")),
    )
    const q = query.trim().toLowerCase()
    const shown = q
        ? all.filter(([name, entry]) => name.includes(q) || entry.beeId?.toLowerCase().includes(q))
        : all
    const shownLocal = q
        ? locals.filter(([, entry]) =>
              String(entry.name ?? "")
                  .toLowerCase()
                  .includes(q),
          )
        : locals
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

            {!all.length && !locals.length ? (
                <EmptyState
                    icon={InventoryIcon}
                    title="No packages installed"
                    text="Find packages to install in Browse."
                    action={
                        <Box sx={{ display: "flex", gap: 1, justifyContent: "center" }}>
                            <Button variant="outlined" onClick={() => onNavigate("browse")}>
                                Browse packages
                            </Button>
                            {importButton}
                        </Box>
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
                            {all.length ? `${all.length} installed` : ""}
                        </Typography>
                        {importButton}
                        {all.length > 0 && (
                            <>
                                <Button
                                    size="small"
                                    startIcon={
                                        outdated.loading ? (
                                            <CircularProgress size={14} />
                                        ) : (
                                            <RefreshIcon />
                                        )
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
                            </>
                        )}
                    </Box>
                    {outdated.error && (
                        <Alert severity="warning">
                            Couldn't check for updates: {outdated.error}
                        </Alert>
                    )}
                    {shown.map(([name, entry]) => (
                        <InstalledRow key={name} name={name} entry={entry} />
                    ))}
                    {!shown.length && !shownLocal.length && (
                        <Typography sx={{ color: "#888", textAlign: "center", py: 4 }}>
                            No installed package matches "{query.trim()}".
                        </Typography>
                    )}
                    {shownLocal.length > 0 && (
                        <>
                            <Typography variant="subtitle2" sx={{ color: "#888", mt: 2, mb: 0.5 }}>
                                {shownLocal.length} local
                            </Typography>
                            {shownLocal.map(([beeId, entry]) => (
                                <LocalRow key={beeId} beeId={beeId} entry={entry} />
                            ))}
                        </>
                    )}
                </>
            )}
        </Box>
    )
}
