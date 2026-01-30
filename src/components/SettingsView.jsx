import { useState, useEffect } from "react"
import {
    Box,
    Typography,
    Card,
    CardContent,
    Chip,
    Button,
    CircularProgress,
    Alert,
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    FormControl,
    InputLabel,
    Select,
    MenuItem,
    LinearProgress,
} from "@mui/material"
import CheckCircleIcon from "@mui/icons-material/CheckCircle"

function SettingsView({ initialized, onRefresh, showNotification, addLog }) {
    const [loading, setLoading] = useState(false)
    const [config, setConfig] = useState(null)
    const [versionDialogOpen, setVersionDialogOpen] = useState(false)
    const [versions, setVersions] = useState([])
    const [selectedVersion, setSelectedVersion] = useState("")
    const [loadingVersions, setLoadingVersions] = useState(false)
    const [changingVersion, setChangingVersion] = useState(false)
    const [installStep, setInstallStep] = useState(0)
    const [installError, setInstallError] = useState(null)

    const installSteps = [
        { label: "Preparing installation", description: "Setting up directories..." },
        { label: "Configuring BEE2", description: "Updating BEE2 configuration..." },
        { label: "Downloading packages", description: "Downloading base BEE2 packages..." },
        { label: "Installing packages", description: "Extracting and installing files..." },
        { label: "Finalizing", description: "Creating configuration files..." },
    ]

    useEffect(() => {
        // Load config to get BEE2 version
        window.beepm.getConfig().then((result) => {
            if (result.success && result.data) {
                setConfig(result.data)
            }
        })
    }, [initialized])

    const openVersionDialog = async () => {
        setVersionDialogOpen(true)
        setLoadingVersions(true)
        setInstallError(null)
        setInstallStep(0)
        try {
            const result = await window.beepm.fetchBee2Versions()
            if (result.success) {
                setVersions(result.versions)
                if (result.versions.length > 0) {
                    setSelectedVersion(result.versions[0].tag)
                }
            } else {
                showNotification("Failed to fetch versions: " + result.error, "error")
            }
        } catch (err) {
            showNotification("Failed to fetch versions: " + err.message, "error")
        } finally {
            setLoadingVersions(false)
        }
    }

    const handleChangeVersion = async () => {
        if (!selectedVersion) return
        setChangingVersion(true)
        setInstallError(null)
        setInstallStep(0)

        const command = `beepm init --version ${selectedVersion} --json`

        // Simulate progress steps - slower and stops at step 3 (downloading takes longest)
        let currentStep = 0
        const progressInterval = setInterval(() => {
            if (currentStep < 3) {
                currentStep++
                setInstallStep(currentStep)
            }
            // Stay at step 3 (downloading) until complete - this is where most time is spent
        }, 3000)

        try {
            const result = await window.beepm.runReinit(selectedVersion)
            clearInterval(progressInterval)

            // Only log the clean result message, not raw CLI output
            const logMessage = result.message || (result.success ? "Installation completed" : "Installation failed")
            addLog(command, logMessage, result.success)

            if (result.success) {
                // Quickly complete remaining steps
                setInstallStep(4)
                await new Promise((r) => setTimeout(r, 300))
                setInstallStep(5) // Complete

                // Clear installed packages if changing to a different version
                if (config?.bee2_version && selectedVersion !== config.bee2_version) {
                    await window.beepm.clearInstalledPackages()
                    showNotification("BEE2 version changed! All installed packages have been removed.", "success")
                } else {
                    showNotification(result.message || "Successfully changed BEE2 version!", "success")
                }

                // Small delay to show completion
                setTimeout(async () => {
                    setVersionDialogOpen(false)
                    setChangingVersion(false)
                    onRefresh()
                    // Reload config to show new version
                    const configResult = await window.beepm.getConfig()
                    if (configResult.success && configResult.data) {
                        setConfig(configResult.data)
                    }
                }, 800)
            } else {
                setInstallError(result.message || result.error || "Installation failed")
                setChangingVersion(false)
            }
        } catch (err) {
            clearInterval(progressInterval)
            addLog(command, err.message, false)
            setInstallError(err.message)
            setChangingVersion(false)
        }
    }

    const closeVersionDialog = () => {
        if (!changingVersion) {
            setVersionDialogOpen(false)
            setInstallError(null)
            setInstallStep(0)
        }
    }

    const handleHook = async () => {
        setLoading(true)
        const command = "beepm hook --json"
        try {
            const result = await window.beepm.runHook()
            addLog(command, result.message || result.output || result.error, result.success)
            if (result.success) {
                showNotification(result.message || "Successfully hooked to BEE2!", "success")
                onRefresh()
            } else {
                showNotification(result.message || result.error || "Failed to hook", "error")
            }
        } catch (err) {
            addLog(command, err.message, false)
            showNotification(err.message, "error")
        } finally {
            setLoading(false)
        }
    }

    const handleUnhook = async () => {
        setLoading(true)
        const command = "beepm unhook --json"
        try {
            const result = await window.beepm.runUnhook()
            addLog(command, result.message || result.output || result.error, result.success)
            if (result.success) {
                showNotification(result.message || "Successfully unhooked from BEE2!", "success")
                onRefresh()
            } else {
                showNotification(result.message || result.error || "Failed to unhook", "error")
            }
        } catch (err) {
            addLog(command, err.message, false)
            showNotification(err.message, "error")
        } finally {
            setLoading(false)
        }
    }

    return (
        <Box>
            <Typography variant="subtitle2" sx={{ mb: 2, color: "#888" }}>
                BEE2 CONNECTION
            </Typography>
            <Card variant="outlined" sx={{ mb: 3, backgroundColor: "#262829", border: "1px solid #3a3a3a" }}>
                <CardContent>
                    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 2 }}>
                        <Box>
                            <Typography variant="body1" sx={{ fontWeight: 500 }}>
                                Status
                            </Typography>
                            <Typography variant="body2" sx={{ color: "#888" }}>
                                {initialized ? "BeePM is hooked to BEE2" : "BeePM is not connected"}
                            </Typography>
                        </Box>
                        <Chip
                            label={initialized ? "Hooked" : "Unhooked"}
                            size="small"
                            sx={{
                                fontWeight: 500,
                                backgroundColor: initialized ? "#1db34f" : "#d32f2f",
                                color: "#fff",
                            }}
                        />
                    </Box>
                    <Box sx={{ display: "flex", gap: 1 }}>
                        {initialized ? (
                            <Button
                                variant="outlined"
                                color="error"
                                size="small"
                                fullWidth
                                onClick={handleUnhook}
                                disabled={loading}
                            >
                                {loading ? "Unhooking..." : "Unhook"}
                            </Button>
                        ) : (
                            <Button
                                variant="contained"
                                color="primary"
                                size="small"
                                fullWidth
                                onClick={handleHook}
                                disabled={loading}
                            >
                                {loading ? "Hooking..." : "Hook to BEE2"}
                            </Button>
                        )}
                    </Box>
                </CardContent>
            </Card>

            <Typography variant="subtitle2" sx={{ mb: 2, color: "#888" }}>
                BEE2 VERSION
            </Typography>
            <Card variant="outlined" sx={{ mb: 3, backgroundColor: "#262829", border: "1px solid #3a3a3a" }}>
                <CardContent>
                    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 2 }}>
                        <Box>
                            <Typography variant="body1" sx={{ fontWeight: 500 }}>
                                {config?.bee2_version_name || config?.bee2_version || "Not installed"}
                            </Typography>
                            <Typography variant="body2" sx={{ color: "#888" }}>
                                {config?.bee2_version ? `Tag: ${config.bee2_version}` : "No BEE2 version set"}
                            </Typography>
                        </Box>
                        {config?.beemod_version && (
                            <Chip label={config.beemod_version} size="small" color="primary" />
                        )}
                    </Box>
                    <Button
                        variant="outlined"
                        size="small"
                        fullWidth
                        onClick={openVersionDialog}
                    >
                        {config?.bee2_version ? "Change Version" : "Install BEE2"}
                    </Button>
                </CardContent>
            </Card>

            {/* Version Selection Dialog */}
            <Dialog
                open={versionDialogOpen}
                onClose={closeVersionDialog}
                maxWidth="sm"
                fullWidth
            >
                <DialogTitle>
                    {changingVersion
                        ? "Installing BEE2"
                        : config?.bee2_version
                          ? "Change BEE2 Version"
                          : "Install BEE2"}
                </DialogTitle>
                <DialogContent>
                    {changingVersion ? (
                        /* Progress View */
                        <Box sx={{ py: 2 }}>
                            <Box sx={{ mb: 3 }}>
                                <Box sx={{ display: "flex", justifyContent: "space-between", mb: 1 }}>
                                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                                        {installStep < installSteps.length
                                            ? installSteps[installStep].label
                                            : "Complete!"}
                                    </Typography>
                                    <Typography variant="body2" sx={{ color: "#888" }}>
                                        {Math.min(Math.round(((installStep + 1) / installSteps.length) * 100), 100)}%
                                    </Typography>
                                </Box>
                                <LinearProgress
                                    variant="determinate"
                                    value={Math.min(((installStep + 1) / installSteps.length) * 100, 100)}
                                    sx={{
                                        height: 8,
                                        borderRadius: 4,
                                        backgroundColor: "#3a3a3a",
                                        "& .MuiLinearProgress-bar": {
                                            borderRadius: 4,
                                            backgroundColor: installStep >= installSteps.length ? "#1db34f" : "#2eff7b",
                                        },
                                    }}
                                />
                            </Box>

                            <Typography variant="body2" sx={{ color: "#888", mb: 3 }}>
                                {installStep < installSteps.length
                                    ? installSteps[installStep].description
                                    : "Installation completed successfully!"}
                            </Typography>

                            {/* Step list */}
                            <Box sx={{ backgroundColor: "#1a1b1c", borderRadius: 1, p: 2 }}>
                                {installSteps.map((step, index) => (
                                    <Box
                                        key={index}
                                        sx={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 1.5,
                                            py: 0.75,
                                            opacity: index <= installStep ? 1 : 0.4,
                                        }}
                                    >
                                        {index < installStep || installStep >= installSteps.length ? (
                                            <CheckCircleIcon sx={{ fontSize: 18, color: "#1db34f" }} />
                                        ) : index === installStep ? (
                                            <CircularProgress size={18} sx={{ color: "#2eff7b" }} />
                                        ) : (
                                            <Box
                                                sx={{
                                                    width: 18,
                                                    height: 18,
                                                    borderRadius: "50%",
                                                    border: "2px solid #555",
                                                }}
                                            />
                                        )}
                                        <Typography
                                            variant="body2"
                                            sx={{
                                                color: index <= installStep ? "#fff" : "#666",
                                                fontWeight: index === installStep ? 500 : 400,
                                            }}
                                        >
                                            {step.label}
                                        </Typography>
                                    </Box>
                                ))}
                            </Box>

                            {installError && (
                                <Alert severity="error" sx={{ mt: 2 }}>
                                    {installError}
                                </Alert>
                            )}
                        </Box>
                    ) : loadingVersions ? (
                        <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                            <CircularProgress />
                        </Box>
                    ) : versions.length === 0 ? (
                        <Typography color="error">No versions available</Typography>
                    ) : (
                        <>
                            <Typography variant="body2" sx={{ mb: 2, color: "#888" }}>
                                Select a BEE2 version to {config?.bee2_version ? "reinstall" : "install"}. This will download and set up the selected version.
                            </Typography>
                            <Alert severity="warning" sx={{ mb: 2 }}>
                                Make sure this version matches your actual BEE2 installation. Packages are version-specific and may not work correctly with a different BEE2 version.
                            </Alert>
                            <FormControl fullWidth>
                                <InputLabel>Version</InputLabel>
                                <Select
                                    value={selectedVersion}
                                    label="Version"
                                    onChange={(e) => setSelectedVersion(e.target.value)}
                                >
                                    {versions.map((v) => (
                                        <MenuItem key={v.tag} value={v.tag}>
                                            {v.name || v.tag}
                                            <Typography
                                                component="span"
                                                sx={{ ml: 1, color: "#888", fontSize: 12 }}
                                            >
                                                ({new Date(v.published_at).toLocaleDateString()})
                                            </Typography>
                                        </MenuItem>
                                    ))}
                                </Select>
                            </FormControl>
                            {config?.bee2_version && selectedVersion === config.bee2_version && (
                                <Alert severity="info" sx={{ mt: 2 }}>
                                    This is your current version. Selecting it will reinstall BEE2's packages.
                                </Alert>
                            )}
                            {config?.bee2_version && selectedVersion !== config.bee2_version && (
                                <Alert severity="error" sx={{ mt: 2 }}>
                                    Changing versions will remove all your currently installed packages. You will need to reinstall them for the new version.
                                </Alert>
                            )}
                        </>
                    )}
                </DialogContent>
                {!changingVersion && (
                    <DialogActions>
                        <Button onClick={closeVersionDialog}>
                            Cancel
                        </Button>
                        <Button
                            variant="contained"
                            onClick={handleChangeVersion}
                            disabled={loadingVersions || !selectedVersion}
                        >
                            {config?.bee2_version ? "Reinstall" : "Install"}
                        </Button>
                    </DialogActions>
                )}
                {changingVersion && installError && (
                    <DialogActions>
                        <Button onClick={closeVersionDialog}>
                            Close
                        </Button>
                        <Button variant="contained" onClick={handleChangeVersion}>
                            Retry
                        </Button>
                    </DialogActions>
                )}
            </Dialog>

            <Typography variant="subtitle2" sx={{ mb: 2, color: "#888" }}>
                ABOUT
            </Typography>
            <Card variant="outlined" sx={{ backgroundColor: "#262829", border: "1px solid #3a3a3a" }}>
                <CardContent>
                    <Typography variant="body1" sx={{ fontWeight: 500, mb: 1 }}>
                        BeePM
                    </Typography>
                    <Typography variant="body2" sx={{ color: "#888" }}>
                        A package manager for BEE2 mod packages. Browse, install, and manage community-created content for Portal 2.
                    </Typography>
                </CardContent>
            </Card>
        </Box>
    )
}

export default SettingsView
