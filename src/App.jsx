import { useState, useEffect } from "react"
import {
    Box,
    Typography,
    TextField,
    InputAdornment,
    Chip,
    CircularProgress,
    Alert,
    IconButton,
    Tooltip,
    List,
    ListItemButton,
    ListItemIcon,
    ListItemText,
    Badge,
    Snackbar,
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Collapse,
    Button,
} from "@mui/material"
import SearchIcon from "@mui/icons-material/Search"
import RefreshIcon from "@mui/icons-material/Refresh"
import ExploreIcon from "@mui/icons-material/Explore"
import InventoryIcon from "@mui/icons-material/Inventory"
import PublishIcon from "@mui/icons-material/Publish"
import SettingsIcon from "@mui/icons-material/Settings"
import TerminalIcon from "@mui/icons-material/Terminal"
import ExpandMoreIcon from "@mui/icons-material/ExpandMore"
import ExpandLessIcon from "@mui/icons-material/ExpandLess"

import {
    PackageCard,
    EmptyState,
    NotInitializedView,
    ConsoleView,
    SettingsView,
    PublishView,
} from "./components"

const SIDEBAR_WIDTH = 220

function App() {
    const [view, setView] = useState("browse")
    const [search, setSearch] = useState("")
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [registry, setRegistry] = useState(null)
    const [installed, setInstalled] = useState({})
    const [initialized, setInitialized] = useState(false)
    const [beemodVersion, setBeemodVersion] = useState(null)
    const [snackbar, setSnackbar] = useState({ open: false, message: "", severity: "info" })
    const [consoleLog, setConsoleLog] = useState([])
    const [processingPackage, setProcessingPackage] = useState(null)
    const [installedExpanded, setInstalledExpanded] = useState(true)
    const [availableExpanded, setAvailableExpanded] = useState(true)
    const [protocolFilePath, setProtocolFilePath] = useState(null)
    const [isAdmin, setIsAdmin] = useState(false)
    const [removeDialog, setRemoveDialog] = useState({ open: false, pkg: null })

    // Listen for protocol actions (beepm://publish?file=path)
    useEffect(() => {
        const handleProtocol = (event, data) => {
            console.log("Protocol action received:", data)
            if (data.action === "publish" && data.params?.file) {
                setView("publish")
                setProtocolFilePath(data.params.file)
            }
        }

        const subscription = window.api?.on("protocol-action", handleProtocol)

        return () => {
            if (subscription) {
                window.api?.off("protocol-action", subscription)
            }
        }
    }, [])

    const showNotification = (message, severity = "info") => {
        setSnackbar({ open: true, message, severity })
    }

    // Parse version string to array of numbers for comparison
    const parseVersion = (v) => {
        if (!v) return null
        const parts = v.trim().split(".").map((p) => parseInt(p, 10))
        return parts.some(isNaN) ? null : parts
    }

    // Compare two version arrays: returns -1 if a<b, 0 if a==b, 1 if a>b
    const compareVersions = (a, b) => {
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            const aPart = a[i] || 0
            const bPart = b[i] || 0
            if (aPart < bPart) return -1
            if (aPart > bPart) return 1
        }
        return 0
    }

    // Check if user version satisfies a semver range like ">=2.4.41" or ">=2.4.41 <2.4.46"
    const satisfiesRange = (userVer, rangeStr) => {
        if (!rangeStr || !userVer) return true

        const userParsed = parseVersion(userVer)
        if (!userParsed) return true

        const conditions = rangeStr.split(/\s+/)

        for (const cond of conditions) {
            if (cond.startsWith(">=")) {
                const minVer = parseVersion(cond.slice(2))
                if (minVer && compareVersions(userParsed, minVer) < 0) return false
            } else if (cond.startsWith(">")) {
                const minVer = parseVersion(cond.slice(1))
                if (minVer && compareVersions(userParsed, minVer) <= 0) return false
            } else if (cond.startsWith("<=")) {
                const maxVer = parseVersion(cond.slice(2))
                if (maxVer && compareVersions(userParsed, maxVer) > 0) return false
            } else if (cond.startsWith("<")) {
                const maxVer = parseVersion(cond.slice(1))
                if (maxVer && compareVersions(userParsed, maxVer) >= 0) return false
            } else if (cond.startsWith("=")) {
                const exactVer = parseVersion(cond.slice(1))
                if (exactVer && compareVersions(userParsed, exactVer) !== 0) return false
            }
        }

        return true
    }

    // Check if a package has any version compatible with the user's BEE2 version
    const isPackageCompatible = (pkg) => {
        if (!beemodVersion || !pkg.versions) return true

        for (const [, versionData] of Object.entries(pkg.versions)) {
            if (versionData.yanked) continue

            const compatibleWith = versionData.compatibleWith
            if (!compatibleWith) return true

            if (Array.isArray(compatibleWith)) {
                if (compatibleWith.includes(beemodVersion)) return true
            } else if (typeof compatibleWith === "string") {
                if (satisfiesRange(beemodVersion, compatibleWith)) return true
            }
        }

        return false
    }

    const addLog = (command, output, success) => {
        const timestamp = new Date().toLocaleTimeString()
        setConsoleLog((prev) => [...prev, { timestamp, command, output, success }])
    }

    const closeSnackbar = () => {
        setSnackbar((prev) => ({ ...prev, open: false }))
    }

    const handleInstall = async (pkg) => {
        const packageSpec = `${pkg.author.toLowerCase()}@${pkg.name}`
        setProcessingPackage(pkg.id)
        const command = `beepm install ${packageSpec}`

        try {
            const result = await window.beepm.installPackage(packageSpec)
            addLog(command, result.output || result.message || result.error, result.success)

            if (result.success) {
                showNotification(`Installed ${pkg.display_name || pkg.name}`, "success")
                loadData()
            } else {
                showNotification(result.message || result.error || "Install failed", "error")
            }
        } catch (err) {
            addLog(command, err.message, false)
            showNotification(err.message, "error")
        } finally {
            setProcessingPackage(null)
        }
    }

    const handleUninstall = async (pkg) => {
        const packageSpec = `${pkg.author.toLowerCase()}@${pkg.name}`
        setProcessingPackage(pkg.id)
        const command = `beepm uninstall ${packageSpec} --yes`

        try {
            const result = await window.beepm.uninstallPackage(packageSpec)
            addLog(command, result.output || result.message || result.error, result.success)

            if (result.success) {
                showNotification(`Uninstalled ${pkg.display_name || pkg.name}`, "success")
                loadData()
            } else {
                showNotification(result.message || result.error || "Uninstall failed", "error")
            }
        } catch (err) {
            addLog(command, err.message, false)
            showNotification(err.message, "error")
        } finally {
            setProcessingPackage(null)
        }
    }

    const handleRemovePackage = async () => {
        if (!removeDialog.pkg) return

        const pkg = removeDialog.pkg
        setRemoveDialog({ open: false, pkg: null })
        setProcessingPackage(pkg.id)

        try {
            const registryType = pkg.isGithub ? "github" : "main"
            const result = await window.beepm.removePackage(pkg.id, registryType)

            if (result.success) {
                showNotification(`Removed ${pkg.display_name || pkg.name} from registry`, "success")
                addLog(`admin remove ${pkg.id}`, result.message, true)
                loadData()
            } else {
                showNotification(result.error || "Failed to remove package", "error")
                addLog(`admin remove ${pkg.id}`, result.error, false)
            }
        } catch (err) {
            showNotification(err.message, "error")
            addLog(`admin remove ${pkg.id}`, err.message, false)
        } finally {
            setProcessingPackage(null)
        }
    }

    useEffect(() => {
        loadData()
    }, [])

    const loadData = async () => {
        setLoading(true)
        setError(null)

        try {
            const initStatus = await window.beepm.isInitialized()
            setInitialized(initStatus.initialized)
            if (initStatus.config?.beemod_version) {
                setBeemodVersion(initStatus.config.beemod_version)
            }

            const registryResult = await window.beepm.fetchRegistry()
            if (registryResult.success) {
                setRegistry(registryResult.data)
            } else {
                setError(registryResult.error)
            }

            const installedResult = await window.beepm.getInstalledPackages()
            if (installedResult.success) {
                setInstalled(installedResult.data.packages || {})
            }

            try {
                const adminResult = await window.beepm.checkAdmin()
                setIsAdmin(adminResult.isAdmin)
            } catch {
                setIsAdmin(false)
            }
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }

    const getPackages = () => {
        if (!registry?.packages?.by_id) return []

        const packages = Object.entries(registry.packages.by_id).map(([id, data]) => ({
            id,
            ...data,
        }))

        if (search) {
            const searchLower = search.toLowerCase()
            return packages.filter(
                (pkg) =>
                    pkg.display_name?.toLowerCase().includes(searchLower) ||
                    pkg.name?.toLowerCase().includes(searchLower) ||
                    pkg.author?.toLowerCase().includes(searchLower) ||
                    pkg.id.toLowerCase().includes(searchLower)
            )
        }

        return packages
    }

    const getInstalledPackages = () => {
        const packages = Object.entries(installed).map(([id, data]) => ({
            id,
            display_name: data.display_name || data.name || id,
            name: data.name,
            author: data.author,
            version: data.version,
            versions: { [data.version]: {} },
        }))

        if (search) {
            const searchLower = search.toLowerCase()
            return packages.filter(
                (pkg) =>
                    pkg.display_name?.toLowerCase().includes(searchLower) ||
                    pkg.name?.toLowerCase().includes(searchLower) ||
                    pkg.author?.toLowerCase().includes(searchLower) ||
                    pkg.id.toLowerCase().includes(searchLower)
            )
        }

        return packages
    }

    const getFilteredPackages = () => {
        if (view === "installed") {
            return getInstalledPackages()
        }
        return getPackages()
    }

    const allPackages = getPackages()
    const installedPackages = allPackages.filter((pkg) => !!installed[pkg.id])
    const availablePackages = allPackages.filter((pkg) => !installed[pkg.id])

    const packages = getFilteredPackages()
    const installedCount = Object.keys(installed).length

    return (
        <Box sx={{ display: "flex", height: "100vh" }}>
            {/* Sidebar */}
            <Box
                sx={{
                    width: SIDEBAR_WIDTH,
                    flexShrink: 0,
                    borderRight: "1px solid #3a3a3a",
                    backgroundColor: "#232526",
                    display: "flex",
                    flexDirection: "column",
                }}
            >
                {/* Logo */}
                <Box sx={{ px: 2.5, height: 56, borderBottom: "1px solid #3a3a3a", display: "flex", alignItems: "center", boxSizing: "border-box" }}>
                    <Typography variant="h5" sx={{ fontWeight: 700, color: "#2eff7b", lineHeight: 1 }}>
                        BeePM
                    </Typography>
                </Box>

                {/* Navigation */}
                <List sx={{ flex: 1, py: 1 }}>
                    <ListItemButton
                        selected={view === "browse"}
                        onClick={() => setView("browse")}
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
                            <ExploreIcon sx={{ color: view === "browse" ? "#2eff7b" : "#888" }} />
                        </ListItemIcon>
                        <ListItemText
                            primary="Browse"
                            primaryTypographyProps={{
                                fontWeight: view === "browse" ? 600 : 400,
                                color: view === "browse" ? "#fff" : "#ccc",
                            }}
                        />
                    </ListItemButton>

                    <ListItemButton
                        selected={view === "installed"}
                        onClick={() => setView("installed")}
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
                            <Badge badgeContent={installedCount} color="primary" max={99}>
                                <InventoryIcon sx={{ color: view === "installed" ? "#2eff7b" : "#888" }} />
                            </Badge>
                        </ListItemIcon>
                        <ListItemText
                            primary="Installed"
                            primaryTypographyProps={{
                                fontWeight: view === "installed" ? 600 : 400,
                                color: view === "installed" ? "#fff" : "#ccc",
                            }}
                        />
                    </ListItemButton>

                    <ListItemButton
                        selected={view === "publish"}
                        onClick={() => setView("publish")}
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
                            <PublishIcon sx={{ color: view === "publish" ? "#2eff7b" : "#888" }} />
                        </ListItemIcon>
                        <ListItemText
                            primary="Publish"
                            primaryTypographyProps={{
                                fontWeight: view === "publish" ? 600 : 400,
                                color: view === "publish" ? "#fff" : "#ccc",
                            }}
                        />
                    </ListItemButton>
                </List>

                {/* Bottom section */}
                <Box sx={{ borderTop: "1px solid #3a3a3a" }}>
                    <ListItemButton
                        selected={view === "console"}
                        onClick={() => setView("console")}
                        sx={{
                            mx: 1,
                            mt: 1,
                            borderRadius: 1,
                            "&.Mui-selected": {
                                backgroundColor: "rgba(46, 255, 123, 0.1)",
                                "&:hover": { backgroundColor: "rgba(46, 255, 123, 0.15)" },
                            },
                        }}
                    >
                        <ListItemIcon sx={{ minWidth: 40 }}>
                            <TerminalIcon sx={{ color: view === "console" ? "#2eff7b" : "#888" }} />
                        </ListItemIcon>
                        <ListItemText
                            primary="Console"
                            primaryTypographyProps={{
                                fontWeight: view === "console" ? 600 : 400,
                                color: view === "console" ? "#fff" : "#ccc",
                            }}
                        />
                    </ListItemButton>

                    <ListItemButton
                        selected={view === "settings"}
                        onClick={() => setView("settings")}
                        sx={{
                            mx: 1,
                            mb: 1,
                            borderRadius: 1,
                            "&.Mui-selected": {
                                backgroundColor: "rgba(46, 255, 123, 0.1)",
                                "&:hover": { backgroundColor: "rgba(46, 255, 123, 0.15)" },
                            },
                        }}
                    >
                        <ListItemIcon sx={{ minWidth: 40 }}>
                            <SettingsIcon sx={{ color: view === "settings" ? "#2eff7b" : "#888" }} />
                        </ListItemIcon>
                        <ListItemText
                            primary="Settings"
                            primaryTypographyProps={{
                                fontWeight: view === "settings" ? 600 : 400,
                                color: view === "settings" ? "#fff" : "#ccc",
                            }}
                        />
                    </ListItemButton>

                    {/* Status */}
                    <Box sx={{ px: 2, pb: 2 }}>
                        <Chip
                            label={initialized ? "Hooked" : "Not Hooked"}
                            size="small"
                            sx={{
                                width: "100%",
                                fontWeight: 500,
                                backgroundColor: initialized ? "#1db34f" : "#d32f2f",
                                color: "#fff",
                            }}
                        />
                    </Box>
                </Box>
            </Box>

            {/* Main Content */}
            <Box sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                {/* Header */}
                <Box
                    sx={{
                        px: 2.5,
                        height: 56,
                        borderBottom: "1px solid #3a3a3a",
                        display: "flex",
                        alignItems: "center",
                        gap: 2,
                    }}
                >
                    <Typography variant="h6" sx={{ fontWeight: 600 }}>
                        {view === "browse" && "Browse Packages"}
                        {view === "installed" && "Installed Packages"}
                        {view === "publish" && "Publish Package"}
                        {view === "console" && "Console"}
                        {view === "settings" && "Settings"}
                    </Typography>

                    <Box sx={{ flex: 1 }} />

                    {(view === "browse" || view === "installed") && (
                        <TextField
                            size="small"
                            placeholder="Search..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            sx={{ width: 250 }}
                            InputProps={{
                                startAdornment: (
                                    <InputAdornment position="start">
                                        <SearchIcon sx={{ color: "#666", fontSize: 20 }} />
                                    </InputAdornment>
                                ),
                            }}
                        />
                    )}

                    <Tooltip title="Refresh">
                        <IconButton onClick={loadData} disabled={loading} size="small">
                            <RefreshIcon />
                        </IconButton>
                    </Tooltip>
                </Box>

                {/* Content */}
                <Box sx={{ flex: 1, overflow: "auto", p: 2 }}>
                    {!initialized && view === "installed" ? (
                        <NotInitializedView />
                    ) : view === "publish" ? (
                        <PublishView showNotification={showNotification} addLog={addLog} protocolFilePath={protocolFilePath} onProtocolFileHandled={() => setProtocolFilePath(null)} onRefresh={loadData} />
                    ) : view === "console" ? (
                        <ConsoleView consoleLog={consoleLog} setConsoleLog={setConsoleLog} />
                    ) : view === "settings" ? (
                        <SettingsView initialized={initialized} onRefresh={loadData} showNotification={showNotification} addLog={addLog} />
                    ) : loading ? (
                        <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100%" }}>
                            <CircularProgress color="primary" />
                        </Box>
                    ) : error ? (
                        <Alert severity="error">{error}</Alert>
                    ) : view === "browse" ? (
                        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            {/* Installed Section */}
                            {installedPackages.length > 0 && (
                                <Box>
                                    <Box
                                        onClick={() => setInstalledExpanded(!installedExpanded)}
                                        sx={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 1,
                                            cursor: "pointer",
                                            mb: 1,
                                            userSelect: "none",
                                            "&:hover": { opacity: 0.8 },
                                        }}
                                    >
                                        <IconButton size="small" sx={{ p: 0 }}>
                                            {installedExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                                        </IconButton>
                                        <Typography variant="subtitle2" sx={{ color: "#888", fontWeight: 600 }}>
                                            INSTALLED
                                        </Typography>
                                        <Chip label={installedPackages.length} size="small" sx={{ height: 20, fontSize: 11 }} />
                                    </Box>
                                    <Collapse in={installedExpanded}>
                                        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                                            {installedPackages.map((pkg) => (
                                                <PackageCard
                                                    key={pkg.id}
                                                    pkg={pkg}
                                                    isInstalled={true}
                                                    installedVersion={installed[pkg.id]?.version}
                                                    onInstall={() => handleInstall(pkg)}
                                                    onUninstall={() => handleUninstall(pkg)}
                                                    isProcessing={processingPackage === pkg.id}
                                                    disabled={!!processingPackage}
                                                    isCompatible={isPackageCompatible(pkg)}
                                                    isAdmin={isAdmin}
                                                    onRemove={() => setRemoveDialog({ open: true, pkg })}
                                                />
                                            ))}
                                        </Box>
                                    </Collapse>
                                </Box>
                            )}

                            {/* Available Section */}
                            {availablePackages.length > 0 && (
                                <Box>
                                    <Box
                                        onClick={() => setAvailableExpanded(!availableExpanded)}
                                        sx={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 1,
                                            cursor: "pointer",
                                            mb: 1,
                                            userSelect: "none",
                                            "&:hover": { opacity: 0.8 },
                                        }}
                                    >
                                        <IconButton size="small" sx={{ p: 0 }}>
                                            {availableExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                                        </IconButton>
                                        <Typography variant="subtitle2" sx={{ color: "#888", fontWeight: 600 }}>
                                            AVAILABLE
                                        </Typography>
                                        <Chip label={availablePackages.length} size="small" sx={{ height: 20, fontSize: 11 }} />
                                    </Box>
                                    <Collapse in={availableExpanded}>
                                        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                                            {availablePackages.map((pkg) => (
                                                <PackageCard
                                                    key={pkg.id}
                                                    pkg={pkg}
                                                    isInstalled={false}
                                                    installedVersion={null}
                                                    onInstall={() => handleInstall(pkg)}
                                                    onUninstall={() => handleUninstall(pkg)}
                                                    isProcessing={processingPackage === pkg.id}
                                                    disabled={!!processingPackage}
                                                    isCompatible={isPackageCompatible(pkg)}
                                                    isAdmin={isAdmin}
                                                    onRemove={() => setRemoveDialog({ open: true, pkg })}
                                                />
                                            ))}
                                        </Box>
                                    </Collapse>
                                </Box>
                            )}

                            {installedPackages.length === 0 && availablePackages.length === 0 && (
                                <EmptyState view={view} search={search} />
                            )}
                        </Box>
                    ) : packages.length === 0 ? (
                        <EmptyState view={view} search={search} />
                    ) : (
                        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                            {packages.map((pkg) => (
                                <PackageCard
                                    key={pkg.id}
                                    pkg={pkg}
                                    isInstalled={!!installed[pkg.id]}
                                    installedVersion={installed[pkg.id]?.version}
                                    onInstall={() => handleInstall(pkg)}
                                    onUninstall={() => handleUninstall(pkg)}
                                    isProcessing={processingPackage === pkg.id}
                                    disabled={!!processingPackage}
                                    isCompatible={isPackageCompatible(pkg)}
                                    isAdmin={isAdmin}
                                    onRemove={() => setRemoveDialog({ open: true, pkg })}
                                />
                            ))}
                        </Box>
                    )}
                </Box>
            </Box>

            {/* Toast Notifications */}
            <Snackbar
                open={snackbar.open}
                autoHideDuration={4000}
                onClose={closeSnackbar}
                anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            >
                <Alert
                    onClose={closeSnackbar}
                    severity={snackbar.severity}
                    variant="filled"
                    sx={{ minWidth: 300 }}
                >
                    {snackbar.message}
                </Alert>
            </Snackbar>

            {/* Admin Remove Confirmation Dialog */}
            <Dialog
                open={removeDialog.open}
                onClose={() => setRemoveDialog({ open: false, pkg: null })}
                PaperProps={{
                    sx: {
                        backgroundColor: "#2a2d30",
                        border: "1px solid #3a3a3a",
                        minWidth: 400,
                    },
                }}
            >
                <DialogTitle sx={{ color: "#fff" }}>Remove Package from Registry</DialogTitle>
                <DialogContent>
                    <Typography sx={{ color: "#ccc", mb: 2 }}>
                        Are you sure you want to remove{" "}
                        <strong style={{ color: "#fff" }}>{removeDialog.pkg?.display_name || removeDialog.pkg?.name}</strong> from the registry?
                    </Typography>
                    <Alert severity="warning" sx={{ backgroundColor: "rgba(237, 108, 2, 0.1)" }}>
                        This action will remove the package from the public registry. Users who have already installed it will keep their local copy.
                    </Alert>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setRemoveDialog({ open: false, pkg: null })} sx={{ color: "#888" }}>
                        Cancel
                    </Button>
                    <Button onClick={handleRemovePackage} variant="contained" color="error">
                        Remove
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    )
}

export default App
