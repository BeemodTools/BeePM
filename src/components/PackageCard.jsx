import { Box, Card, CardContent, Typography, Chip, Button, CircularProgress, Tooltip, IconButton } from "@mui/material"
import CheckCircleIcon from "@mui/icons-material/CheckCircle"
import PersonIcon from "@mui/icons-material/Person"
import DownloadIcon from "@mui/icons-material/Download"
import DeleteIcon from "@mui/icons-material/Delete"

function PackageCard({ pkg, isInstalled, installedVersion, onInstall, onUninstall, isProcessing, disabled, isCompatible = true, isAdmin = false, onRemove }) {
    const versions = Object.keys(pkg.versions || {})
    const latestVersion = versions.length > 0 ? versions[versions.length - 1] : "N/A"

    return (
        <Card
            variant="outlined"
            sx={{
                backgroundColor: "#262829",
                border: "1px solid #3a3a3a",
                "&:hover": { borderColor: "#555", backgroundColor: "#2a2d30" },
                transition: "all 0.15s",
                opacity: !isCompatible && !isInstalled ? 0.6 : 1,
            }}
        >
            <CardContent sx={{ py: 1.5, px: 2, "&:last-child": { pb: 1.5 } }}>
                <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <Box sx={{ flex: 1 }}>
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.25 }}>
                            <Typography variant="subtitle1" sx={{ fontWeight: 600, color: "#fff" }}>
                                {pkg.display_name || pkg.name}
                            </Typography>
                            {isInstalled && (
                                <Chip
                                    icon={<CheckCircleIcon sx={{ fontSize: 12 }} />}
                                    label={`v${installedVersion}`}
                                    size="small"
                                    color="success"
                                    sx={{ height: 20, fontSize: 11 }}
                                />
                            )}
                            {!isCompatible && !isInstalled && (
                                <Chip
                                    label="Incompatible"
                                    size="small"
                                    sx={{ height: 20, fontSize: 11, backgroundColor: "#555", color: "#aaa" }}
                                />
                            )}
                        </Box>
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, color: "#888" }}>
                            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                                <PersonIcon sx={{ fontSize: 14 }} />
                                <Typography variant="body2" sx={{ fontSize: 13 }}>
                                    {pkg.author}
                                </Typography>
                            </Box>
                            <Typography variant="body2" sx={{ fontSize: 13, color: "#666" }}>
                                v{latestVersion}
                            </Typography>
                        </Box>
                    </Box>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                        {isAdmin && (
                            <Tooltip title="Remove from registry (Admin)">
                                <IconButton
                                    size="small"
                                    onClick={onRemove}
                                    disabled={disabled}
                                    sx={{
                                        color: "#888",
                                        "&:hover": { color: "#d32f2f", backgroundColor: "rgba(211, 47, 47, 0.1)" },
                                    }}
                                >
                                    <DeleteIcon sx={{ fontSize: 18 }} />
                                </IconButton>
                            </Tooltip>
                        )}
                        {isInstalled ? (
                            <Button
                                size="small"
                                variant="contained"
                                color="error"
                                onClick={onUninstall}
                                disabled={disabled}
                                sx={{ minWidth: 90 }}
                            >
                                {isProcessing ? <CircularProgress size={20} color="inherit" /> : "Uninstall"}
                            </Button>
                        ) : !isCompatible ? (
                            <Tooltip title="Not compatible with your BEE2 version">
                                <span>
                                    <Button
                                        size="small"
                                        variant="outlined"
                                        disabled
                                        sx={{ minWidth: 90, color: "#666", borderColor: "#444" }}
                                    >
                                        Install
                                    </Button>
                                </span>
                            </Tooltip>
                        ) : (
                            <Button
                                size="small"
                                variant="contained"
                                startIcon={!isProcessing && <DownloadIcon sx={{ fontSize: 16 }} />}
                                onClick={onInstall}
                                disabled={disabled}
                                sx={{ minWidth: 90 }}
                            >
                                {isProcessing ? <CircularProgress size={20} color="inherit" /> : "Install"}
                            </Button>
                        )}
                    </Box>
                </Box>
            </CardContent>
        </Card>
    )
}

export default PackageCard
