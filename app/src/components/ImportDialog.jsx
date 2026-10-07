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
    Typography,
} from "@mui/material"

const smallChip = { height: 20, fontSize: 11 }

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

/**
 * Shows what an import from this PC will do before it happens: packages on BeePM come from
 * there, the rest are copied in as local packages, and some are skipped (with why).
 */
export default function ImportDialog({ scan, working, onImport, onClose }) {
    const count = scan.items.filter((item) => item.action !== "skip").length
    return (
        <Dialog open onClose={working ? undefined : onClose} maxWidth="sm" fullWidth>
            <DialogTitle>Import</DialogTitle>
            <DialogContent dividers>
                {scan.offline && (
                    <Alert severity="warning" sx={{ mb: 2 }}>
                        BeePM can't be reached, so these are imported as local packages.
                    </Alert>
                )}
                {scan.items.map((item, index) => (
                    <Box
                        key={`${item.file}-${index}`}
                        sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 1.5,
                            py: 1,
                            borderTop: index ? "1px solid #333" : "none",
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
                ))}
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose} disabled={working}>
                    Cancel
                </Button>
                <Button variant="contained" onClick={onImport} disabled={working || !count}>
                    {working ? <CircularProgress size={18} color="inherit" /> : `Import ${count}`}
                </Button>
            </DialogActions>
        </Dialog>
    )
}
