import { useEffect, useState } from "react"
import {
    Alert,
    Box,
    Button,
    Checkbox,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    LinearProgress,
    MenuItem,
    TextField,
    Typography,
} from "@mui/material"
import CheckCircleIcon from "@mui/icons-material/CheckCircle"
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked"
import { api, onEvent } from "../api.js"
import { formatBytes, formatDate } from "../lib/format.js"
import { useApp } from "../state/context.js"
import ErrorAlert from "./ErrorAlert.jsx"

function StatusIcon({ status }) {
    if (status === "done") return <CheckCircleIcon sx={{ fontSize: 20, color: "#1db34f" }} />
    if (status === "active") return <CircularProgress size={18} />
    return <RadioButtonUncheckedIcon sx={{ fontSize: 20, color: "#555" }} />
}

function AssetRow({ asset, status, step }) {
    const downloading = status === "active" && step === "download"
    return (
        <Box sx={{ py: 1 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
                <StatusIcon status={status} />
                <Typography sx={{ flex: 1, color: "#ddd", fontFamily: "monospace", fontSize: 13 }}>
                    {asset.name}
                </Typography>
                <Typography sx={{ fontSize: 12, color: "#888" }}>
                    {status !== "active"
                        ? asset.total
                            ? formatBytes(asset.total)
                            : ""
                        : downloading
                          ? `${formatBytes(asset.received)} of ${formatBytes(asset.total)}`
                          : `Extracting: ${asset.extracted} files`}
                </Typography>
            </Box>
            {downloading && (
                <LinearProgress
                    variant={asset.total ? "determinate" : "indeterminate"}
                    value={asset.total ? Math.min(100, (asset.received / asset.total) * 100) : 0}
                    sx={{ ml: 4.5, mt: 1, height: 6, borderRadius: 3, backgroundColor: "#3a3a3a" }}
                />
            )}
        </Box>
    )
}

function SetupBody({ onClose, onRunningChange }) {
    const { bee2, refreshBee2, refreshInstalled, notify, goTo } = useApp()
    const [current] = useState(bee2?.bee2 ?? null)
    const [releases, setReleases] = useState({ loading: true, list: [], error: null })
    const [version, setVersion] = useState("")
    const [includeMusic, setIncludeMusic] = useState(true)
    const [phase, setPhase] = useState("pick") // pick | running | done | error
    const [assets, setAssets] = useState([]) // every download, in order, known up front
    const [activeAsset, setActiveAsset] = useState(null)
    const [step, setStep] = useState(null) // download | extract | hook
    const [closedBee2, setClosedBee2] = useState(false)
    const [result, setResult] = useState(null)

    useEffect(() => {
        let cancelled = false
        api.bee2.releases().then((res) => {
            if (cancelled) return
            if (!res.ok) {
                setReleases({ loading: false, list: [], error: res.error })
                setVersion(current?.version ?? "")
                return
            }
            setReleases({ loading: false, list: res.releases, error: null })
            const known = res.releases.some((r) => r.version === current?.version)
            setVersion(known ? current.version : (res.releases[0]?.version ?? ""))
        })
        return () => {
            cancelled = true
        }
    }, [current])

    useEffect(
        () =>
            onEvent("bee2:progress", (progress) => {
                if (progress.step === "plan") {
                    setAssets(
                        progress.assets.map((asset) => ({
                            name: asset.name,
                            received: 0,
                            total: asset.size,
                            extracted: 0,
                        })),
                    )
                    return
                }
                if (progress.step === "closed-bee2") {
                    setClosedBee2(true)
                    return
                }
                setStep(progress.step)
                if (!progress.asset) return
                setActiveAsset(progress.asset)
                setAssets((list) => {
                    const index = list.findIndex((asset) => asset.name === progress.asset)
                    const base =
                        index >= 0
                            ? list[index]
                            : { name: progress.asset, received: 0, total: 0, extracted: 0 }
                    const next =
                        progress.step === "download"
                            ? { ...base, received: progress.received, total: progress.total }
                            : { ...base, extracted: progress.received }
                    return index >= 0
                        ? list.map((asset, i) => (i === index ? next : asset))
                        : [...list, next]
                })
            }),
        [],
    )

    useEffect(() => {
        onRunningChange(phase === "running")
        return () => onRunningChange(false)
    }, [phase, onRunningChange])

    async function start() {
        setPhase("running")
        setAssets([])
        setActiveAsset(null)
        setClosedBee2(false)
        setStep(null)
        setResult(null)
        const release = releases.list.find((r) => r.version === version)
        const res = await api.bee2.setup({ version, name: release?.name ?? null, includeMusic })
        await Promise.all([refreshBee2(), refreshInstalled()])
        setResult(res)
        setPhase(res.ok ? "done" : "error")
        if (res.ok) notify(`BEE2 ${res.bee2.version} is set up.`, "success")
    }

    const running = phase === "running"
    const finished = phase === "done"
    const activeIndex = assets.findIndex((asset) => asset.name === activeAsset)
    const assetStatus = (index) =>
        finished || step === "hook" || (activeIndex >= 0 && index < activeIndex)
            ? "done"
            : running && index === activeIndex
              ? "active"
              : "pending"

    return (
        <>
            <DialogTitle>{current?.version ? "Change BEE2 version" : "Set up BEE2"}</DialogTitle>
            <DialogContent>
                {phase === "pick" && (
                    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        {releases.loading ? (
                            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
                                <CircularProgress size={18} />
                                <Typography sx={{ color: "#aaa" }}>
                                    Loading BEE2 releases…
                                </Typography>
                            </Box>
                        ) : releases.error ? (
                            <>
                                <ErrorAlert
                                    severity="warning"
                                    error={`The list of BEE2 releases couldn't be loaded: ${releases.error}`}
                                />
                                <TextField
                                    size="small"
                                    label="BEE2 version"
                                    placeholder="2.4.46.1"
                                    value={version}
                                    onChange={(event) => setVersion(event.target.value.trim())}
                                />
                            </>
                        ) : (
                            <TextField
                                select
                                size="small"
                                label="BEE2 version"
                                value={version}
                                onChange={(event) => setVersion(event.target.value)}
                            >
                                {releases.list.map((release) => (
                                    <MenuItem key={release.version} value={release.version}>
                                        {release.name} ({release.version})
                                        <Box
                                            component="span"
                                            sx={{ ml: 1, color: "#888", fontSize: 12 }}
                                        >
                                            {formatDate(release.publishedAt)}
                                        </Box>
                                    </MenuItem>
                                ))}
                            </TextField>
                        )}
                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={includeMusic}
                                    onChange={(event) => setIncludeMusic(event.target.checked)}
                                />
                            }
                            label="Include BEE2's music packages"
                        />
                        {current?.version && version && version !== current.version && (
                            <Alert severity="info">
                                You're switching from BEE2 {current.version}. Installed packages are
                                kept: check the Installed page for any that don't support the new
                                version.
                            </Alert>
                        )}
                    </Box>
                )}

                {phase !== "pick" && (
                    <Box>
                        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                            BEE2's packages
                        </Typography>
                        {!assets.length && running && (
                            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 1 }}>
                                <CircularProgress size={18} />
                                <Typography sx={{ color: "#aaa" }}>
                                    Finding the BEE2-items release…
                                </Typography>
                            </Box>
                        )}
                        {assets.map((asset, index) => (
                            <AssetRow
                                key={asset.name}
                                asset={asset}
                                status={assetStatus(index)}
                                step={step}
                            />
                        ))}
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mt: 1.5 }}>
                            <StatusIcon
                                status={
                                    finished
                                        ? "done"
                                        : running && step === "hook"
                                          ? "active"
                                          : "pending"
                                }
                            />
                            <Typography sx={{ color: "#ddd" }}>
                                Hook BEE2 to BeePM's packages folder
                            </Typography>
                        </Box>
                        {closedBee2 && (
                            <Typography variant="body2" sx={{ color: "#aaa", mt: 2 }}>
                                BEE2 was open, so BeePM closed it to replace its packages.
                            </Typography>
                        )}
                        {running && (
                            <Typography variant="body2" sx={{ color: "#777", mt: 2 }}>
                                This can take a few minutes.
                            </Typography>
                        )}
                        {finished && (
                            <Alert severity="success" sx={{ mt: 2 }}>
                                BEE2 {result.bee2.version} is ready: {result.bee2.basePackageCount}{" "}
                                of BEE2's packages from BEE2-items {result.bee2.itemsTag}. BEE2 now
                                loads packages from BeePM: start it to use them.
                            </Alert>
                        )}
                        {finished && result.hookChanged && (
                            <Alert severity="info" sx={{ mt: 1.5 }}>
                                Your own packages aren't gone: import them to load them in BEE2.
                            </Alert>
                        )}
                        {phase === "error" && (
                            <ErrorAlert
                                error={result.error}
                                problems={result.problems}
                                sx={{ mt: 2 }}
                            />
                        )}
                    </Box>
                )}
            </DialogContent>
            <DialogActions>
                {phase === "pick" && (
                    <>
                        <Button onClick={onClose}>Cancel</Button>
                        <Button variant="contained" onClick={start} disabled={!version}>
                            {current?.version ? "Change version" : "Set up"}
                        </Button>
                    </>
                )}
                {finished && result.hookChanged && (
                    <Button
                        onClick={() => {
                            onClose()
                            goTo("import")
                        }}
                    >
                        Import them
                    </Button>
                )}
                {finished && (
                    <Button variant="contained" onClick={onClose}>
                        Close
                    </Button>
                )}
                {phase === "error" && (
                    <>
                        <Button onClick={onClose}>Close</Button>
                        <Button variant="contained" onClick={() => setPhase("pick")}>
                            Try again
                        </Button>
                    </>
                )}
            </DialogActions>
        </>
    )
}

/** Picks a BEE2 version, downloads BEE2's own packages for it and hooks BEE2 (with real progress). */
export default function Bee2SetupDialog({ open, onClose }) {
    const [running, setRunning] = useState(false)
    return (
        <Dialog
            open={open}
            onClose={(_event, reason) => !running && reason !== "backdropClick" && onClose()}
            maxWidth="sm"
            fullWidth
        >
            <SetupBody onClose={onClose} onRunningChange={setRunning} />
        </Dialog>
    )
}
