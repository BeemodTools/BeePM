import { Box, Button, Card, Chip, CircularProgress, Tooltip, Typography } from "@mui/material"
import CheckCircleIcon from "@mui/icons-material/CheckCircle"
import DownloadIcon from "@mui/icons-material/Download"
import UpgradeIcon from "@mui/icons-material/Upgrade"
import { formatNumber, isCompatible } from "../lib/format.js"
import { useApp } from "../state/context.js"
import { ContentCounts, FoundChips } from "./Contents.jsx"

/** One search result: click it for the package details. */
export default function PackageCard({ pkg }) {
    const { installed, bee2Version, busy, job, install, uninstall, updateFor, openPackage } =
        useApp()
    const entry = installed[pkg.name]
    const compatible = isCompatible(pkg.compatibleWith, bee2Version)
    // Removed packages are only listed for admins, who can open them to restore them
    const removed = Boolean(pkg.removed)
    const update = removed ? null : updateFor(pkg.name, pkg)
    const working = Boolean(busy[pkg.name])
    const stop = (action) => (event) => {
        event.stopPropagation()
        action()
    }

    return (
        <Card
            variant="outlined"
            role="button"
            tabIndex={0}
            onClick={() => openPackage(pkg.name)}
            onKeyDown={(event) => {
                if (event.key === "Enter" && event.target === event.currentTarget)
                    openPackage(pkg.name)
            }}
            sx={{
                backgroundColor: "#262829",
                border: "1px solid #3a3a3a",
                cursor: "pointer",
                "&:hover": { borderColor: "#555", backgroundColor: "#2a2d30" },
                transition: "all 0.15s",
                px: 2,
                py: 1.5,
                display: "flex",
                alignItems: "center",
                gap: 2,
            }}
        >
            <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 600, color: "#fff" }}>
                        {pkg.displayName || pkg.name}
                    </Typography>
                    {entry && (
                        <Chip
                            icon={<CheckCircleIcon sx={{ fontSize: 14 }} />}
                            label={`v${entry.version}`}
                            size="small"
                            color="success"
                            sx={{ height: 20, fontSize: 11 }}
                        />
                    )}
                    {!compatible && (
                        <Tooltip
                            title={`The latest version needs BEE2 ${pkg.compatibleWith}; you have ${bee2Version}. An older version may still work.`}
                        >
                            <Chip
                                label="Incompatible"
                                size="small"
                                sx={{ height: 20, fontSize: 11, color: "#f9a825" }}
                            />
                        </Tooltip>
                    )}
                    {removed && (
                        <Tooltip title={pkg.removed.reason ?? ""}>
                            <Chip
                                label="Removed"
                                size="small"
                                color="error"
                                variant="outlined"
                                sx={{ height: 20, fontSize: 11 }}
                            />
                        </Tooltip>
                    )}
                    {pkg.deprecated && (
                        <Tooltip title={pkg.deprecated}>
                            <Chip
                                label="Deprecated"
                                size="small"
                                color="warning"
                                variant="outlined"
                                sx={{ height: 20, fontSize: 11 }}
                            />
                        </Tooltip>
                    )}
                </Box>
                <Box
                    sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1.5,
                        color: "#888",
                        fontSize: 13,
                        mt: 0.25,
                    }}
                >
                    <Box component="span" sx={{ fontFamily: "monospace" }}>
                        {pkg.name}
                    </Box>
                    {pkg.latest && <span>v{pkg.latest}</span>}
                    <Box component="span" sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                        <DownloadIcon sx={{ fontSize: 14 }} />
                        {formatNumber(pkg.downloads)}
                    </Box>
                    <ContentCounts counts={pkg.contents} />
                </Box>
                {pkg.description && (
                    <Typography
                        variant="body2"
                        sx={{
                            color: "#aaa",
                            mt: 0.5,
                            overflow: "hidden",
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                        }}
                    >
                        {pkg.description}
                    </Typography>
                )}
                <FoundChips found={pkg.found} />
            </Box>

            <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
                {entry ? (
                    <>
                        {update && (
                            <Button
                                size="small"
                                variant="contained"
                                startIcon={<UpgradeIcon />}
                                disabled={Boolean(job) || working}
                                onClick={stop(() => install([pkg.name], { update: true }))}
                            >
                                Update to {update}
                            </Button>
                        )}
                        <Button
                            size="small"
                            variant="outlined"
                            color="error"
                            disabled={Boolean(job) || working}
                            onClick={stop(() => uninstall([pkg.name]))}
                            sx={{ minWidth: 96 }}
                        >
                            {working ? <CircularProgress size={18} color="inherit" /> : "Uninstall"}
                        </Button>
                    </>
                ) : removed ? null : (
                    <Button
                        size="small"
                        variant={compatible ? "contained" : "outlined"}
                        startIcon={<DownloadIcon />}
                        disabled={Boolean(job) || !pkg.latest}
                        onClick={stop(() => install([pkg.name]))}
                        sx={{ minWidth: 96 }}
                    >
                        Install
                    </Button>
                )}
            </Box>
        </Card>
    )
}
