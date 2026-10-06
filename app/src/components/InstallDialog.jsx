import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    LinearProgress,
    Typography,
} from "@mui/material"
import CheckCircleIcon from "@mui/icons-material/CheckCircle"
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked"
import { formatBytes } from "../lib/format.js"
import { useLastValue } from "../lib/useLastValue.js"
import { useApp } from "../state/context.js"
import ErrorAlert from "./ErrorAlert.jsx"

const CHANGE_COLORS = {
    install: "primary",
    upgrade: "success",
    downgrade: "warning",
    reinstall: "default",
}

function StepRow({ step, status, progress }) {
    const received = progress?.received ?? 0
    const total = progress?.total || step.size || 0
    return (
        <Box
            sx={{ py: 1.25, borderBottom: "1px solid #333", "&:last-of-type": { borderBottom: 0 } }}
        >
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
                {status === "done" ? (
                    <CheckCircleIcon sx={{ fontSize: 20, color: "#1db34f" }} />
                ) : status === "current" ? (
                    <CircularProgress size={18} />
                ) : (
                    <RadioButtonUncheckedIcon sx={{ fontSize: 20, color: "#555" }} />
                )}
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography noWrap sx={{ color: "#fff", fontWeight: 500 }}>
                        {step.displayName || step.name}
                    </Typography>
                    <Typography
                        noWrap
                        sx={{ fontSize: 12, color: "#888", fontFamily: "monospace" }}
                    >
                        {step.name}
                    </Typography>
                </Box>
                <Typography sx={{ fontSize: 13, color: "#ccc", whiteSpace: "nowrap" }}>
                    {step.from && step.from !== step.to ? `${step.from} → ${step.to}` : step.to}
                </Typography>
                <Chip
                    size="small"
                    label={step.change}
                    color={CHANGE_COLORS[step.change] ?? "default"}
                    variant="outlined"
                    sx={{ height: 22 }}
                />
                {!step.explicit && <Chip size="small" label="dependency" sx={{ height: 22 }} />}
                <Typography sx={{ fontSize: 12, color: "#777", width: 64, textAlign: "right" }}>
                    {formatBytes(step.size)}
                </Typography>
            </Box>
            {status === "current" && (
                <Box sx={{ pl: 4.5, pt: 1 }}>
                    <LinearProgress
                        variant={total ? "determinate" : "indeterminate"}
                        value={total ? Math.min(100, (received / total) * 100) : 0}
                        sx={{ height: 6, borderRadius: 3, backgroundColor: "#3a3a3a" }}
                    />
                    <Typography sx={{ fontSize: 12, color: "#888", mt: 0.5 }}>
                        {formatBytes(received)} of {formatBytes(total)}
                    </Typography>
                </Box>
            )}
        </Box>
    )
}

/** Install and update flow: planning, the plan to confirm, download progress, or the error. */
export default function InstallDialog() {
    const { job, confirmJob, closeJob } = useApp()
    const shown = useLastValue(job)
    const phase = shown?.phase
    const steps = shown?.plan?.steps ?? []
    const progress = shown?.progress
    const statusOf = (index) => {
        if (phase !== "applying") return "pending"
        const current = progress?.index ?? 0
        const finished =
            progress &&
            progress.index === index &&
            progress.total &&
            progress.received >= progress.total
        return index < current || finished ? "done" : index === current ? "current" : "pending"
    }

    return (
        <Dialog
            open={Boolean(job)}
            onClose={(_event, reason) => reason !== "backdropClick" && closeJob()}
            maxWidth="sm"
            fullWidth
        >
            <DialogTitle>{shown?.title}</DialogTitle>
            <DialogContent>
                {phase === "planning" && (
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 1 }}>
                        <CircularProgress size={20} />
                        <Typography sx={{ color: "#aaa" }}>Working out what to install…</Typography>
                    </Box>
                )}

                {(phase === "confirm" || phase === "applying") && (
                    <>
                        <Typography sx={{ color: "#aaa", mb: 1 }}>
                            {phase === "confirm"
                                ? `${steps.length} package${steps.length === 1 ? "" : "s"} will be installed:`
                                : progress
                                  ? `Downloading ${progress.index + 1} of ${progress.count}…`
                                  : "Starting…"}
                        </Typography>
                        <Box>
                            {steps.map((step, index) => (
                                <StepRow
                                    key={step.name}
                                    step={step}
                                    status={statusOf(index)}
                                    progress={progress?.index === index ? progress : null}
                                />
                            ))}
                        </Box>
                        {phase === "confirm" &&
                            steps.some((step) => step.change === "downgrade") && (
                                <Alert severity="warning" sx={{ mt: 2 }}>
                                    Some packages will be downgraded to an older version.
                                </Alert>
                            )}
                        {shown.plan.warnings.length > 0 && (
                            <ErrorAlert
                                severity="warning"
                                problems={shown.plan.warnings}
                                sx={{ mt: 2 }}
                            />
                        )}
                    </>
                )}

                {phase === "error" && <ErrorAlert error={shown.error} problems={shown.problems} />}
            </DialogContent>
            {(phase === "confirm" || phase === "error") && (
                <DialogActions>
                    {phase === "confirm" ? (
                        <>
                            <Button onClick={closeJob}>Cancel</Button>
                            <Button variant="contained" onClick={confirmJob}>
                                Install
                            </Button>
                        </>
                    ) : (
                        <Button variant="contained" onClick={closeJob}>
                            Close
                        </Button>
                    )}
                </DialogActions>
            )}
        </Dialog>
    )
}
