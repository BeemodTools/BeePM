import { useEffect, useState } from "react"
import { Alert, Box, Button, Card, Chip, Collapse, LinearProgress, Typography } from "@mui/material"
import ExpandMoreIcon from "@mui/icons-material/ExpandMore"
import FolderOpenIcon from "@mui/icons-material/FolderOpen"
import InsertDriveFileIcon from "@mui/icons-material/InsertDriveFile"
import MoveToInboxIcon from "@mui/icons-material/MoveToInbox"
import { api, onEvent } from "../api.js"
import { useApp } from "../state/context.js"

const smallChip = { height: 20, fontSize: 11 }
const cardSx = { backgroundColor: "#262829", border: "1px solid #3a3a3a", p: 2 }

function ActionChip({ item }) {
    if (item.action === "beepm") {
        return <Chip label="From BeePM" size="small" color="success" sx={smallChip} />
    }
    if (item.action === "local") {
        return (
            <Chip
                label={item.replaces ? "Local, replaces yours" : "Local"}
                size="small"
                variant="outlined"
                sx={smallChip}
            />
        )
    }
    return <Chip label="Skipped" size="small" sx={{ ...smallChip, color: "#999" }} />
}

function ItemRow({ item, first }) {
    return (
        <Box
            sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.5,
                py: 1,
                borderTop: first ? "none" : "1px solid #333",
            }}
        >
            <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography noWrap sx={{ color: "#fff" }}>
                    {item.name}
                </Typography>
                <Typography variant="body2" noWrap sx={{ color: "#888" }}>
                    {item.action === "beepm"
                        ? item.package
                        : item.action === "skip"
                          ? item.reason
                          : item.file}
                </Typography>
            </Box>
            <ActionChip item={item} />
        </Box>
    )
}

/** What's being done, with a bar: "Copying Old Signage (2 of 5)". */
function ImportProgress({ progress, starting }) {
    if (!progress) {
        return (
            <>
                <Typography variant="body2" sx={{ color: "#aaa", mb: 1 }}>
                    {starting}
                </Typography>
                <LinearProgress />
            </>
        )
    }
    const { phase, done, total, name, received, size } = progress
    const step = Math.min(done + 1, total)
    const label = {
        read: `Reading packages (${done} of ${total})`,
        check: `Checking BeePM (${done} of ${total})`,
        copy: `Copying ${name} (${step} of ${total})`,
        download: `Downloading ${name} (${step} of ${total})`,
    }[phase]
    const part = phase === "download" && size ? received / size : 0
    const value = total ? ((done + part) / total) * 100 : 0
    return (
        <>
            <Typography variant="body2" noWrap sx={{ color: "#aaa", mb: 1 }}>
                {label}
            </Typography>
            {phase === "copy" ? (
                // Copies don't say how far along they are: the one being copied is the buffer
                <LinearProgress variant="buffer" value={value} valueBuffer={(step / total) * 100} />
            ) : (
                <LinearProgress variant="determinate" value={value} />
            )}
        </>
    )
}

/**
 * Imports packages from this PC: a .bee_pack, a package folder, or a folder of packages like
 * BEE2's own. Shows what will happen first; packages on BeePM come from there, and the rest show
 * in Installed as local packages. While BEE2 is hooked, the folder it used before is offered.
 */
export default function ImportView({ onNavigate }) {
    const { bee2, notify, refreshInstalled } = useApp()
    const [sources, setSources] = useState({ hooked: false, folders: [] })
    const [stage, setStage] = useState("pick") // pick | scanning | review | importing | done
    const [scan, setScan] = useState(null) // { importId, items, offline, target }
    const [progress, setProgress] = useState(null)
    const [result, setResult] = useState(null)
    const [showSkipped, setShowSkipped] = useState(false)

    const hooked = Boolean(bee2?.hooked)
    useEffect(() => {
        let cancelled = false
        api.packages.importSources().then((res) => !cancelled && res.ok && setSources(res))
        return () => {
            cancelled = true
        }
    }, [hooked])

    useEffect(() => onEvent("packages:import-progress", setProgress), [])

    async function scanTarget(target) {
        setStage("scanning")
        setProgress(null)
        const res = await api.packages.importScan(target)
        if (!res.ok) {
            setStage("pick")
            return notify(res.error, "error")
        }
        setScan({ ...res, target })
        setShowSkipped(false)
        setStage("review")
    }

    async function pick(kind) {
        const picked = await api.packages.pickImport(kind)
        if (!picked.ok) return notify(picked.error, "error")
        if (!picked.canceled) await scanTarget(picked.path)
    }

    async function run() {
        setStage("importing")
        setProgress(null)
        const res = await api.packages.importApply(scan.importId)
        await refreshInstalled()
        setScan(null)
        if (!res.ok) {
            setStage("pick")
            return notify(res.error, "error")
        }
        setResult(res)
        setStage("done")
    }

    const busy = stage === "scanning" || stage === "importing"
    const items = scan?.items ?? []
    const toImport = items.filter((item) => item.action !== "skip")
    const skipped = items.filter((item) => item.action === "skip")
    const imported = result ? result.imported.length + result.installed.length : 0

    return (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {sources.folders.map((folder) => (
                <Card key={folder} variant="outlined" sx={{ ...cardSx, display: "flex", gap: 2 }}>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography sx={{ color: "#fff", fontWeight: 600 }}>
                            Your packages from before BeePM
                        </Typography>
                        <Typography variant="body2" noWrap title={folder} sx={{ color: "#888" }}>
                            {folder}
                        </Typography>
                    </Box>
                    <Button
                        variant="contained"
                        disabled={busy}
                        onClick={() => scanTarget(folder)}
                        sx={{ alignSelf: "center", flexShrink: 0 }}
                    >
                        Import these
                    </Button>
                </Card>
            ))}
            {sources.hooked && !sources.folders.length && (
                <Alert severity="info">
                    Your packages from before BeePM are in the packages folder where BEE2 is
                    installed.
                </Alert>
            )}

            <Card variant="outlined" sx={{ ...cardSx, textAlign: "center", py: 4 }}>
                <MoveToInboxIcon sx={{ fontSize: 40, color: "#666", mb: 1 }} />
                <Typography sx={{ color: "#fff", fontWeight: 600, mb: 2 }}>
                    Import a folder or a .bee_pack
                </Typography>
                <Box sx={{ display: "flex", gap: 1, justifyContent: "center", flexWrap: "wrap" }}>
                    <Button
                        variant="outlined"
                        startIcon={<FolderOpenIcon />}
                        disabled={busy}
                        onClick={() => pick("folder")}
                    >
                        Choose a folder
                    </Button>
                    <Button
                        variant="outlined"
                        startIcon={<InsertDriveFileIcon />}
                        disabled={busy}
                        onClick={() => pick("file")}
                    >
                        Choose a file
                    </Button>
                </Box>
            </Card>

            {busy && (
                <Card variant="outlined" sx={cardSx}>
                    <ImportProgress
                        progress={progress}
                        starting={stage === "scanning" ? "Looking for packages…" : "Importing…"}
                    />
                </Card>
            )}

            {stage === "review" && scan && (
                <Card variant="outlined" sx={cardSx}>
                    <Typography sx={{ color: "#fff", fontWeight: 600 }}>
                        {toImport.length ? `${toImport.length} to import` : "Nothing to import"}
                    </Typography>
                    <Typography variant="body2" noWrap title={scan.target} sx={{ color: "#888" }}>
                        {scan.target}
                    </Typography>
                    {scan.offline && (
                        <Alert severity="warning" sx={{ mt: 1.5 }}>
                            BeePM can't be reached, so these are imported as local packages.
                        </Alert>
                    )}
                    {toImport.length > 0 && (
                        <Box sx={{ mt: 1 }}>
                            {toImport.map((item, index) => (
                                <ItemRow key={item.file} item={item} first={!index} />
                            ))}
                        </Box>
                    )}
                    {skipped.length > 0 && (
                        <>
                            <Button
                                size="small"
                                onClick={() => setShowSkipped((shown) => !shown)}
                                endIcon={
                                    <ExpandMoreIcon
                                        sx={{
                                            transform: showSkipped ? "rotate(180deg)" : "none",
                                            transition: "transform 0.2s",
                                        }}
                                    />
                                }
                                sx={{ mt: 1, ml: -0.5, color: "#888" }}
                            >
                                {skipped.length} skipped
                            </Button>
                            <Collapse in={showSkipped}>
                                {skipped.map((item, index) => (
                                    <ItemRow key={item.file} item={item} first={!index} />
                                ))}
                            </Collapse>
                        </>
                    )}
                    <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1, mt: 2 }}>
                        <Button onClick={() => setStage("pick")}>Cancel</Button>
                        <Button variant="contained" onClick={run} disabled={!toImport.length}>
                            Import {toImport.length}
                        </Button>
                    </Box>
                </Card>
            )}

            {stage === "done" && (
                <Alert
                    severity="success"
                    action={
                        <Button
                            color="inherit"
                            size="small"
                            onClick={() => onNavigate("installed")}
                        >
                            Installed
                        </Button>
                    }
                >
                    Imported {imported}. Restart BEE2 to load {imported === 1 ? "it" : "them"}.
                </Alert>
            )}
        </Box>
    )
}
