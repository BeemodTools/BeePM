import { useState, useEffect } from "react"
import {
    Box,
    Typography,
    TextField,
    InputAdornment,
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
    Autocomplete,
} from "@mui/material"
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh"
import CheckIcon from "@mui/icons-material/Check"
import CheckCircleIcon from "@mui/icons-material/CheckCircle"
import GitHubIcon from "@mui/icons-material/GitHub"
import CloudUploadIcon from "@mui/icons-material/CloudUpload"
import PublishIcon from "@mui/icons-material/Publish"
import VerifiedIcon from "@mui/icons-material/Verified"
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline"
import ContentCopyIcon from "@mui/icons-material/ContentCopy"

function PublishView({ showNotification, addLog, protocolFilePath, onProtocolFileHandled, onRefresh }) {
    const [authState, setAuthState] = useState({ loading: true, authenticated: false, username: null })
    const [loginLoading, setLoginLoading] = useState(false)
    const [step, setStep] = useState(0) // 0: select, 1: review, 2: publishing, 3: done
    const [selectedPath, setSelectedPath] = useState(null)
    const [packageInfo, setPackageInfo] = useState(null)
    const [validationError, setValidationError] = useState(null)
    const [publishing, setPublishing] = useState(false)
    const [publishResult, setPublishResult] = useState(null)
    const [githubUrl, setGithubUrl] = useState("")
    const [fetchingGithub, setFetchingGithub] = useState(false)
    const [githubError, setGithubError] = useState(null)
    const [missingBeePackage, setMissingBeePackage] = useState(false)
    const [showGenerator, setShowGenerator] = useState(false)
    const [generatorForm, setGeneratorForm] = useState({
        display_name: "",
        version: "1.0.0",
        description: "",
        compatibleWith: ">=2.4.46",
        dependencies: [],
    })
    const [generatedJson, setGeneratedJson] = useState(null)
    const [generatorCopied, setGeneratorCopied] = useState(false)
    const [availablePackages, setAvailablePackages] = useState([])

    const steps = ["Select Package", "Review", "Publish"]

    // Check auth on mount
    useEffect(() => {
        checkAuthStatus()
    }, [])

    // Handle protocol file path (beepm://publish?file=path)
    useEffect(() => {
        if (protocolFilePath) {
            console.log("Protocol file path received:", protocolFilePath)
            // Auto-validate the file from protocol
            validateProtocolFile(protocolFilePath)
            // Clear the protocol file path
            onProtocolFileHandled && onProtocolFileHandled()
        }
    }, [protocolFilePath])

    const validateProtocolFile = async (filePath) => {
        setSelectedPath(filePath)
        setPackageInfo(null)
        setValidationError(null)
        setPublishResult(null)
        setMissingBeePackage(false)

        try {
            const result = await window.beepm.validatePackage(filePath)
            if (result.valid) {
                setPackageInfo(result)
                setStep(1) // Move to review step
                showNotification && showNotification("File loaded from protocol", "info")
            } else {
                // Move to review step to show the error there
                setStep(1)
                if (result.missingBeePackage) {
                    setMissingBeePackage(true)
                    showNotification && showNotification("Missing bee-package.json", "warning")
                } else {
                    setValidationError(result.error)
                    showNotification && showNotification(result.error, "error")
                }
            }
        } catch (err) {
            setValidationError(err.message)
            showNotification && showNotification(err.message, "error")
        }
    }

    const checkAuthStatus = async () => {
        setAuthState({ loading: true, authenticated: false, username: null })
        try {
            const result = await window.beepm.checkAuth()
            setAuthState({
                loading: false,
                authenticated: result.authenticated,
                username: result.username,
            })
            if (result.expired) {
                showNotification && showNotification("Session expired. Please login again.", "warning")
            }
        } catch {
            setAuthState({ loading: false, authenticated: false, username: null })
        }
    }

    const handleLogin = async () => {
        setLoginLoading(true)
        const command = "beepm login"
        try {
            const result = await window.beepm.runLogin()
            if (addLog) addLog(command, result.output || result.message || result.error, result.success)

            if (result.success) {
                showNotification && showNotification(`Logged in as ${result.username}`, "success")
                checkAuthStatus()
            } else {
                showNotification && showNotification(result.message || result.error || "Login failed", "error")
            }
        } catch (err) {
            if (addLog) addLog(command, err.message, false)
            showNotification && showNotification(err.message, "error")
        } finally {
            setLoginLoading(false)
        }
    }

    const handleSelectFile = async () => {
        try {
            const result = await window.beepm.showOpenDialog({
                directory: false,
                title: "Select .bee_pack file",
                filters: [{ name: "BEE Pack", extensions: ["bee_pack"] }],
            })
            if (!result.canceled && result.filePaths.length > 0) {
                await validatePath(result.filePaths[0])
            }
        } catch (err) {
            showNotification && showNotification(err.message, "error")
        }
    }

    const handleFetchGithub = async () => {
        if (!githubUrl.trim()) return

        setFetchingGithub(true)
        setGithubError(null)
        setValidationError(null)
        setMissingBeePackage(false)

        try {
            // Parse GitHub URL to extract owner/repo
            const match = githubUrl.match(/github\.com\/([^/]+)\/([^/]+)/i)
            if (!match) {
                setGithubError("Invalid GitHub URL. Use format: https://github.com/owner/repo")
                return
            }

            const [, owner, repo] = match
            const repoName = repo.replace(/\.git$/, "") // Remove .git if present

            // Fetch from GitHub releases
            const result = await window.beepm.fetchGithubPackage(owner, repoName)

            if (result.success) {
                setSelectedPath(result.packagePath)
                setPackageInfo(result)
                setStep(1) // Move to review step
            } else {
                // Move to review step to show the error there
                setStep(1)
                if (result.missingBeePackage) {
                    setMissingBeePackage(true)
                    showNotification && showNotification("Missing bee-package.json", "warning")
                } else {
                    setGithubError(result.error)
                    showNotification && showNotification(result.error, "error")
                }
            }
        } catch (err) {
            setGithubError(err.message)
        } finally {
            setFetchingGithub(false)
        }
    }

    const validatePath = async (packagePath) => {
        setSelectedPath(packagePath)
        setPackageInfo(null)
        setValidationError(null)
        setPublishResult(null)
        setMissingBeePackage(false)

        try {
            const result = await window.beepm.validatePackage(packagePath)
            if (result.valid) {
                setPackageInfo(result)
                setStep(1) // Move to review step
            } else {
                // Move to review step to show the error there
                setStep(1)
                if (result.missingBeePackage) {
                    setMissingBeePackage(true)
                    showNotification && showNotification("Missing bee-package.json", "warning")
                } else {
                    setValidationError(result.error)
                    showNotification && showNotification(result.error, "error")
                }
            }
        } catch (err) {
            setValidationError(err.message)
        }
    }

    const handlePublish = async () => {
        if (!packageInfo) return

        setStep(2) // Move to publishing step
        setPublishing(true)
        setPublishResult(null)

        try {
            let result

            // Use different publish method based on source
            if (packageInfo.githubRelease) {
                // GitHub publish - add to github_packages.json in R2
                const command = `publish github:${packageInfo.githubRelease.owner}/${packageInfo.githubRelease.repo}`
                result = await window.beepm.publishGithubPackage(packageInfo.packageData, packageInfo.githubRelease, packageInfo.contentHash)
                if (addLog) addLog(command, result.message || result.error, result.success)
            } else {
                // Local file publish - use CLI
                const command = `beepm publish "${selectedPath}"`
                result = await window.beepm.publishPackage(selectedPath)
                if (addLog) addLog(command, result.output || result.message || result.error, result.success)

                // Check for token expiration
                if (!result.success && (result.output?.includes("Token expired") || result.error?.includes("Token expired"))) {
                    setAuthState({ loading: false, authenticated: false, username: null })
                    showNotification && showNotification("Session expired. Please login again.", "warning")
                    setStep(0)
                    setPublishing(false)
                    return
                }
            }

            setPublishResult(result)
            if (result.success) {
                setStep(3) // Move to done step
                showNotification && showNotification(result.message || "Package published!", "success")
                // Refresh the browse tab to show the new package
                onRefresh && onRefresh()
            } else {
                showNotification && showNotification(result.message || result.error || "Publish failed", "error")
            }
        } catch (err) {
            if (addLog) addLog("publish", err.message, false)
            setPublishResult({ success: false, error: err.message })
            showNotification && showNotification(err.message, "error")
        } finally {
            setPublishing(false)
        }
    }

    const resetWizard = () => {
        setStep(0)
        setSelectedPath(null)
        setPackageInfo(null)
        setValidationError(null)
        setPublishResult(null)
        setGithubUrl("")
        setGithubError(null)
        setMissingBeePackage(false)
    }

    const goBack = () => {
        if (step === 1) {
            setStep(0)
            setSelectedPath(null)
            setPackageInfo(null)
            setValidationError(null)
            setGithubError(null)
            setMissingBeePackage(false)
        }
    }

    // Generator functions
    const handleGeneratorChange = (field, value) => {
        setGeneratorForm(prev => ({ ...prev, [field]: value }))
        setGeneratedJson(null)
    }

    const generateBeePackageJson = () => {
        // Auto-generate name from display_name (sanitized)
        const sanitizedName = generatorForm.display_name
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")

        // Build dependencies object from selected packages
        let dependencies = {}
        if (generatorForm.dependencies.length > 0) {
            generatorForm.dependencies.forEach(dep => {
                dependencies[dep] = "*"
            })
        }

        const json = {
            name: sanitizedName,
            display_name: generatorForm.display_name,
            author: authState.username || "YourGithubUsername",
            version: generatorForm.version || "1.0.0",
            description: generatorForm.description,
            compatibleWith: generatorForm.compatibleWith || ">=2.4.46",
            ...(Object.keys(dependencies).length > 0 && { dependencies }),
        }
        setGeneratedJson(JSON.stringify(json, null, 2))
    }

    const copyGeneratedJson = () => {
        if (generatedJson) {
            navigator.clipboard.writeText(generatedJson)
            setGeneratorCopied(true)
            setTimeout(() => setGeneratorCopied(false), 2000)
            showNotification && showNotification("Copied to clipboard!", "success")
        }
    }

    const openGenerator = async () => {
        setGeneratorForm({
            display_name: "",
            version: "1.0.0",
            description: "",
            compatibleWith: ">=2.4.46",
            dependencies: [],
        })
        setGeneratedJson(null)
        setShowGenerator(true)

        // Fetch available packages from registry
        try {
            const result = await window.beepm.fetchRegistry()
            if (result.success && result.data?.packages?.by_id) {
                const packages = Object.entries(result.data.packages.by_id).map(([id, pkg]) => ({
                    id,
                    label: `${pkg.author}@${pkg.name}`,
                    displayName: pkg.display_name || pkg.name,
                }))
                setAvailablePackages(packages)
            }
        } catch (err) {
            console.error("Failed to fetch packages for dependencies:", err)
        }
    }

    // Check if this is a GitHub-based publish (no auth needed)
    const isGithubPublish = packageInfo?.githubRelease != null

    // Not authenticated - only block if trying to upload a local file (not GitHub) and past step 0
    if (!authState.authenticated && !isGithubPublish && step > 0) {
        return (
            <Box
                sx={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "100%",
                    textAlign: "center",
                    color: "#888",
                }}
            >
                <Box
                    sx={{
                        width: 80,
                        height: 80,
                        borderRadius: "50%",
                        backgroundColor: "rgba(46, 255, 123, 0.1)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        mb: 3,
                    }}
                >
                    <GitHubIcon sx={{ fontSize: 40, color: "#2eff7b" }} />
                </Box>
                <Typography variant="h5" sx={{ color: "#fff", mb: 1, fontWeight: 600 }}>
                    Login Required
                </Typography>
                <Typography variant="body1" sx={{ mb: 3, maxWidth: 400 }}>
                    You need to log in with your GitHub account to publish packages.
                </Typography>
                <Button
                    variant="contained"
                    color="primary"
                    startIcon={loginLoading ? <CircularProgress size={20} color="inherit" /> : <GitHubIcon />}
                    onClick={handleLogin}
                    disabled={loginLoading}
                    sx={{ minWidth: 200 }}
                >
                    {loginLoading ? "Opening browser..." : "Login with GitHub"}
                </Button>
                <Typography variant="body2" sx={{ mt: 2, color: "#666", maxWidth: 350 }}>
                    This will open your browser to authenticate with GitHub.
                </Typography>
            </Box>
        )
    }

    // Wizard UI
    return (
        <Box sx={{ maxWidth: 600, mx: "auto" }}>
            {/* User chip - only show when authenticated */}
            {authState.authenticated && (
                <Box sx={{ display: "flex", alignItems: "center", justifyContent: "flex-end", mb: 2 }}>
                    <Chip
                        icon={<GitHubIcon sx={{ fontSize: 16 }} />}
                        label={authState.username}
                        size="small"
                        sx={{ backgroundColor: "#333", color: "#fff" }}
                    />
                </Box>
            )}

            {/* Step indicator */}
            <Box sx={{ display: "flex", alignItems: "center", mb: 4 }}>
                {steps.map((label, index) => (
                    <Box key={label} sx={{ display: "flex", alignItems: "center", flex: index < steps.length - 1 ? 1 : "none" }}>
                        <Box
                            sx={{
                                width: 32,
                                height: 32,
                                borderRadius: "50%",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                backgroundColor: step >= index ? "#2eff7b" : "#3a3a3a",
                                color: step >= index ? "#000" : "#888",
                                fontWeight: 600,
                                fontSize: 14,
                            }}
                        >
                            {step > index ? <CheckIcon sx={{ fontSize: 18 }} /> : index + 1}
                        </Box>
                        <Typography
                            variant="body2"
                            sx={{
                                ml: 1,
                                color: step >= index ? "#fff" : "#666",
                                fontWeight: step === index ? 600 : 400,
                            }}
                        >
                            {label}
                        </Typography>
                        {index < steps.length - 1 && (
                            <Box
                                sx={{
                                    flex: 1,
                                    height: 2,
                                    mx: 2,
                                    backgroundColor: step > index ? "#2eff7b" : "#3a3a3a",
                                }}
                            />
                        )}
                    </Box>
                ))}
            </Box>

            {/* Step 0: Select Package */}
            {step === 0 && (
                <Card variant="outlined" sx={{ backgroundColor: "#262829", border: "1px solid #3a3a3a" }}>
                    <CardContent sx={{ py: 4 }}>
                        <Box sx={{ textAlign: "center" }}>
                            <GitHubIcon sx={{ fontSize: 64, color: "#555", mb: 2 }} />
                            <Typography variant="h6" sx={{ color: "#fff", mb: 1 }}>
                                Select a Package
                            </Typography>
                            <Typography variant="body2" sx={{ color: "#888", mb: 3 }}>
                                Enter a GitHub repository URL or select a .bee_pack file
                            </Typography>

                            {/* GitHub URL Input */}
                            <Box sx={{ mb: 3 }}>
                                <TextField
                                    fullWidth
                                    size="small"
                                    placeholder="https://github.com/owner/repo"
                                    value={githubUrl}
                                    onChange={(e) => setGithubUrl(e.target.value)}
                                    disabled={fetchingGithub}
                                    InputProps={{
                                        startAdornment: (
                                            <InputAdornment position="start">
                                                <GitHubIcon sx={{ color: "#666", fontSize: 20 }} />
                                            </InputAdornment>
                                        ),
                                    }}
                                    sx={{ mb: 1.5 }}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter" && githubUrl.trim()) {
                                            handleFetchGithub()
                                        }
                                    }}
                                />
                                <Button
                                    variant="contained"
                                    fullWidth
                                    startIcon={fetchingGithub ? <CircularProgress size={20} color="inherit" /> : <GitHubIcon />}
                                    onClick={handleFetchGithub}
                                    disabled={fetchingGithub || !githubUrl.trim()}
                                >
                                    {fetchingGithub ? "Fetching from GitHub..." : "Fetch from GitHub"}
                                </Button>
                                <Typography variant="caption" sx={{ color: "#666", display: "block", mt: 1 }}>
                                    Downloads tracked via GitHub releases
                                </Typography>
                            </Box>

                            <Box sx={{ display: "flex", alignItems: "center", gap: 2, my: 2 }}>
                                <Box sx={{ flex: 1, height: 1, backgroundColor: "#3a3a3a" }} />
                                <Typography variant="body2" sx={{ color: "#666" }}>
                                    or
                                </Typography>
                                <Box sx={{ flex: 1, height: 1, backgroundColor: "#3a3a3a" }} />
                            </Box>

                            {authState.authenticated ? (
                                <Button variant="outlined" size="large" startIcon={<PublishIcon />} onClick={handleSelectFile}>
                                    Select .bee_pack File
                                </Button>
                            ) : (
                                <Box>
                                    <Button
                                        variant="outlined"
                                        size="large"
                                        startIcon={loginLoading ? <CircularProgress size={20} color="inherit" /> : <GitHubIcon />}
                                        onClick={handleLogin}
                                        disabled={loginLoading}
                                    >
                                        {loginLoading ? "Logging in..." : "Login to Upload File"}
                                    </Button>
                                    <Typography variant="caption" sx={{ color: "#666", display: "block", mt: 1 }}>
                                        Login required to upload local .bee_pack files
                                    </Typography>
                                </Box>
                            )}

                            {/* Generate bee-package.json button */}
                            <Box sx={{ mt: 3 }}>
                                <Button
                                    size="small"
                                    startIcon={<AutoFixHighIcon />}
                                    onClick={openGenerator}
                                    variant="outlined"
                                    sx={{ textTransform: "none" }}
                                >
                                    Generate bee-package.json
                                </Button>
                            </Box>

                            {(validationError || githubError) && !missingBeePackage && (
                                <Alert severity="error" sx={{ mt: 3, textAlign: "left" }}>
                                    {validationError || githubError}
                                </Alert>
                            )}

                            {missingBeePackage && (
                                <Box
                                    sx={{
                                        mt: 3,
                                        p: 2,
                                        backgroundColor: "#1a1b1c",
                                        borderRadius: 1,
                                        textAlign: "left",
                                        border: "1px solid #f9a825",
                                    }}
                                >
                                    <Typography variant="subtitle2" sx={{ color: "#f9a825", mb: 1, fontWeight: 600 }}>
                                        bee-package.json not found
                                    </Typography>
                                    <Typography variant="body2" sx={{ color: "#888", mb: 2 }}>
                                        Your .bee_pack needs a bee-package.json file at the root. Here's an example:
                                    </Typography>
                                    <Box
                                        sx={{
                                            p: 1.5,
                                            backgroundColor: "#0d0e0f",
                                            borderRadius: 1,
                                            fontFamily: "monospace",
                                            fontSize: 11,
                                            color: "#2eff7b",
                                            whiteSpace: "pre-wrap",
                                            overflow: "auto",
                                        }}
                                    >
                                        {beePackageTemplate}
                                    </Box>
                                    <Typography variant="caption" sx={{ color: "#666", display: "block", mt: 1.5 }}>
                                        The author must match your GitHub username for new packages.
                                    </Typography>
                                </Box>
                            )}
                        </Box>
                    </CardContent>
                </Card>
            )}

            {/* Step 1: Review - Error State */}
            {step === 1 && (missingBeePackage || githubError || validationError) && (
                <Card variant="outlined" sx={{ backgroundColor: "#262829", border: "1px solid #3a3a3a" }}>
                    <CardContent sx={{ py: 3 }}>
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 3 }}>
                            <ErrorOutlineIcon sx={{ color: "#f9a825" }} />
                            <Typography variant="h6" sx={{ color: "#fff" }}>
                                Package Issue
                            </Typography>
                        </Box>

                        {missingBeePackage && (
                            <Box
                                sx={{
                                    p: 2,
                                    backgroundColor: "#1a1b1c",
                                    borderRadius: 1,
                                    border: "1px solid #f9a825",
                                    mb: 3,
                                }}
                            >
                                <Typography variant="subtitle2" sx={{ color: "#f9a825", mb: 1, fontWeight: 600 }}>
                                    bee-package.json not found
                                </Typography>
                                <Typography variant="body2" sx={{ color: "#888", mb: 2 }}>
                                    Your .bee_pack needs a bee-package.json file at the root. Here's an example:
                                </Typography>
                                <Box
                                    sx={{
                                        p: 1.5,
                                        backgroundColor: "#0d0e0f",
                                        borderRadius: 1,
                                        fontFamily: "monospace",
                                        fontSize: 11,
                                        color: "#2eff7b",
                                        whiteSpace: "pre-wrap",
                                        overflow: "auto",
                                    }}
                                >
                                    {beePackageTemplate}
                                </Box>
                                <Typography variant="caption" sx={{ color: "#666", display: "block", mt: 1.5 }}>
                                    The author must match your GitHub username for new packages.
                                </Typography>
                            </Box>
                        )}

                        {(githubError || validationError) && !missingBeePackage && (
                            <Alert severity="error" sx={{ mb: 3 }}>
                                {githubError || validationError}
                            </Alert>
                        )}

                        <Button variant="outlined" onClick={goBack} fullWidth>
                            Go Back
                        </Button>
                    </CardContent>
                </Card>
            )}

            {/* Step 1: Review - Valid Package */}
            {step === 1 && packageInfo && !missingBeePackage && !githubError && !validationError && (
                <Card variant="outlined" sx={{ backgroundColor: "#262829", border: "1px solid #3a3a3a" }}>
                    <CardContent sx={{ py: 3 }}>
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 3 }}>
                            <VerifiedIcon sx={{ color: "#1db34f" }} />
                            <Typography variant="h6" sx={{ color: "#fff" }}>
                                Package Valid
                            </Typography>
                        </Box>

                        {packageInfo.packageData && (
                            <Box sx={{ display: "flex", flexDirection: "column", gap: 2, mb: 3 }}>
                                <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
                                    <Box>
                                        <Typography variant="caption" sx={{ color: "#666" }}>
                                            PACKAGE NAME
                                        </Typography>
                                        <Typography variant="body1" sx={{ fontWeight: 600, color: "#fff" }}>
                                            {packageInfo.packageData.name}
                                        </Typography>
                                    </Box>
                                    <Box>
                                        <Typography variant="caption" sx={{ color: "#666" }}>
                                            VERSION
                                        </Typography>
                                        <Typography variant="body1" sx={{ fontWeight: 600, color: "#2eff7b" }}>
                                            {packageInfo.packageData.version}
                                        </Typography>
                                    </Box>
                                </Box>
                                <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
                                    <Box>
                                        <Typography variant="caption" sx={{ color: "#666" }}>
                                            DISPLAY NAME
                                        </Typography>
                                        <Typography variant="body1" sx={{ color: "#fff" }}>
                                            {packageInfo.packageData.display_name || packageInfo.packageData.name}
                                        </Typography>
                                    </Box>
                                    <Box>
                                        <Typography variant="caption" sx={{ color: "#666" }}>
                                            AUTHOR
                                        </Typography>
                                        <Typography variant="body1" sx={{ color: "#fff" }}>
                                            {packageInfo.packageData.author}
                                        </Typography>
                                    </Box>
                                </Box>
                                <Box>
                                    <Typography variant="caption" sx={{ color: "#666" }}>
                                        COMPATIBLE WITH
                                    </Typography>
                                    <Typography variant="body1" sx={{ color: "#fff" }}>
                                        {Array.isArray(packageInfo.packageData.compatibleWith)
                                            ? packageInfo.packageData.compatibleWith.join(", ")
                                            : packageInfo.packageData.compatibleWith}
                                    </Typography>
                                </Box>
                            </Box>
                        )}

                        {packageInfo.githubRelease ? (
                            <Box
                                sx={{
                                    p: 2,
                                    backgroundColor: "#1a1b1c",
                                    borderRadius: 1,
                                    mb: 3,
                                }}
                            >
                                <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
                                    <GitHubIcon sx={{ fontSize: 18, color: "#888" }} />
                                    <Typography variant="body2" sx={{ color: "#fff", fontWeight: 500 }}>
                                        {packageInfo.githubRelease.owner}/{packageInfo.githubRelease.repo}
                                    </Typography>
                                </Box>
                                <Typography variant="caption" sx={{ color: "#888", display: "block" }}>
                                    Release: {packageInfo.githubRelease.name || packageInfo.githubRelease.tag}
                                </Typography>
                                <Typography variant="caption" sx={{ color: "#2eff7b", display: "block" }}>
                                    {packageInfo.githubRelease.downloads} downloads so far
                                </Typography>
                            </Box>
                        ) : (
                            <Box
                                sx={{
                                    p: 1.5,
                                    backgroundColor: "#1a1b1c",
                                    borderRadius: 1,
                                    fontFamily: "monospace",
                                    fontSize: 12,
                                    color: "#666",
                                    wordBreak: "break-all",
                                    mb: 3,
                                }}
                            >
                                {selectedPath}
                            </Box>
                        )}

                        <Box sx={{ display: "flex", gap: 2 }}>
                            <Button variant="outlined" onClick={goBack} sx={{ flex: 1 }}>
                                Back
                            </Button>
                            <Button variant="contained" onClick={handlePublish} startIcon={<CloudUploadIcon />} sx={{ flex: 2 }}>
                                Publish Package
                            </Button>
                        </Box>
                    </CardContent>
                </Card>
            )}

            {/* Step 2: Publishing */}
            {step === 2 && (
                <Card variant="outlined" sx={{ backgroundColor: "#262829", border: "1px solid #3a3a3a" }}>
                    <CardContent sx={{ py: 4, textAlign: "center" }}>
                        {publishing ? (
                            <>
                                <CircularProgress size={64} sx={{ color: "#2eff7b", mb: 3 }} />
                                <Typography variant="h6" sx={{ color: "#fff", mb: 1 }}>
                                    Publishing...
                                </Typography>
                                <Typography variant="body2" sx={{ color: "#888" }}>
                                    Uploading package to registry
                                </Typography>
                            </>
                        ) : publishResult && !publishResult.success ? (
                            <>
                                <ErrorOutlineIcon sx={{ fontSize: 64, color: "#f44336", mb: 2 }} />
                                <Typography variant="h6" sx={{ color: "#fff", mb: 1 }}>
                                    Publish Failed
                                </Typography>
                                <Typography variant="body2" sx={{ color: "#f44336", mb: 3 }}>
                                    {publishResult.message || publishResult.error}
                                </Typography>
                                <Box sx={{ display: "flex", gap: 2, justifyContent: "center" }}>
                                    <Button variant="outlined" onClick={() => setStep(1)}>
                                        Go Back
                                    </Button>
                                    <Button variant="contained" onClick={handlePublish}>
                                        Retry
                                    </Button>
                                </Box>
                            </>
                        ) : null}
                    </CardContent>
                </Card>
            )}

            {/* Step 3: Done */}
            {step === 3 && publishResult?.success && (
                <Card variant="outlined" sx={{ backgroundColor: "#262829", border: "1px solid #3a3a3a" }}>
                    <CardContent sx={{ py: 4, textAlign: "center" }}>
                        <CheckCircleIcon sx={{ fontSize: 64, color: "#1db34f", mb: 2 }} />
                        <Typography variant="h6" sx={{ color: "#fff", mb: 1 }}>
                            Published Successfully!
                        </Typography>
                        <Typography variant="body2" sx={{ color: "#888", mb: 1 }}>
                            {publishResult.message}
                        </Typography>
                        {packageInfo?.packageData && (
                            <Box
                                sx={{
                                    mt: 2,
                                    p: 2,
                                    backgroundColor: "#1a1b1c",
                                    borderRadius: 1,
                                    display: "inline-block",
                                }}
                            >
                                <Typography variant="body2" sx={{ color: "#888", mb: 0.5 }}>
                                    Install with:
                                </Typography>
                                <Typography variant="body1" sx={{ color: "#2eff7b", fontFamily: "monospace" }}>
                                    beepm install {packageInfo.packageData.author.toLowerCase()}@{packageInfo.packageData.name.toLowerCase()}
                                </Typography>
                            </Box>
                        )}
                        <Box sx={{ mt: 4 }}>
                            <Button variant="contained" onClick={resetWizard} size="large">
                                Publish Another Package
                            </Button>
                        </Box>
                    </CardContent>
                </Card>
            )}

            {/* bee-package.json Generator Dialog */}
            <Dialog open={showGenerator} onClose={() => setShowGenerator(false)} maxWidth="sm" fullWidth>
                <DialogTitle>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                        <AutoFixHighIcon sx={{ color: "#2eff7b" }} />
                        Generate bee-package.json
                    </Box>
                </DialogTitle>
                <DialogContent>
                    <Typography variant="body2" sx={{ color: "#888", mb: 3 }}>
                        Fill out the fields below to generate your bee-package.json file.
                    </Typography>

                    <TextField
                        label="Display Name"
                        placeholder="My Awesome Package"
                        fullWidth
                        value={generatorForm.display_name}
                        onChange={(e) => handleGeneratorChange("display_name", e.target.value)}
                        helperText="Package name will be auto-generated from this"
                        sx={{ mb: 2 }}
                        size="small"
                    />

                    <TextField
                        label="Description"
                        placeholder="What does your package do?"
                        fullWidth
                        multiline
                        rows={2}
                        value={generatorForm.description}
                        onChange={(e) => handleGeneratorChange("description", e.target.value)}
                        sx={{ mb: 2 }}
                        size="small"
                    />

                    <Box sx={{ display: "flex", gap: 2, mb: 2 }}>
                        <TextField
                            label="Version"
                            placeholder="1.0.0"
                            value={generatorForm.version}
                            onChange={(e) => handleGeneratorChange("version", e.target.value)}
                            size="small"
                            sx={{ flex: 1 }}
                        />
                        <TextField
                            label="Compatible With"
                            placeholder=">=2.4.46"
                            value={generatorForm.compatibleWith}
                            onChange={(e) => handleGeneratorChange("compatibleWith", e.target.value)}
                            helperText="BEE2 version"
                            size="small"
                            sx={{ flex: 1 }}
                        />
                    </Box>

                    <Autocomplete
                        multiple
                        freeSolo
                        options={availablePackages.map(pkg => pkg.label)}
                        value={generatorForm.dependencies}
                        onChange={(e, newValue) => handleGeneratorChange("dependencies", newValue)}
                        renderTags={(value, getTagProps) =>
                            value.map((option, index) => (
                                <Chip
                                    variant="outlined"
                                    label={option}
                                    size="small"
                                    {...getTagProps({ index })}
                                    key={option}
                                />
                            ))
                        }
                        renderInput={(params) => (
                            <TextField
                                {...params}
                                label="Dependencies (optional)"
                                placeholder="Search packages..."
                                helperText="Select packages this depends on"
                                size="small"
                            />
                        )}
                        sx={{ mb: 2 }}
                    />

                    {authState.authenticated && (
                        <Alert severity="info" sx={{ mb: 2 }}>
                            Author will be set to: <strong>{authState.username}</strong>
                        </Alert>
                    )}

                    <Button
                        variant="contained"
                        fullWidth
                        onClick={generateBeePackageJson}
                        disabled={!generatorForm.display_name}
                        startIcon={<AutoFixHighIcon />}
                        sx={{ mb: 2 }}
                    >
                        Generate
                    </Button>

                    {generatedJson && (
                        <Box>
                            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 1 }}>
                                <Typography variant="subtitle2" sx={{ color: "#2eff7b" }}>
                                    Generated bee-package.json
                                </Typography>
                                <Button
                                    size="small"
                                    startIcon={generatorCopied ? <CheckIcon /> : <ContentCopyIcon />}
                                    onClick={copyGeneratedJson}
                                    sx={{ color: generatorCopied ? "#2eff7b" : "#888" }}
                                >
                                    {generatorCopied ? "Copied!" : "Copy"}
                                </Button>
                            </Box>
                            <Box
                                sx={{
                                    p: 2,
                                    backgroundColor: "#0d0e0f",
                                    borderRadius: 1,
                                    fontFamily: "monospace",
                                    fontSize: 12,
                                    color: "#2eff7b",
                                    whiteSpace: "pre-wrap",
                                    overflow: "auto",
                                    maxHeight: 200,
                                }}
                            >
                                {generatedJson}
                            </Box>
                            <Typography variant="caption" sx={{ color: "#666", display: "block", mt: 1 }}>
                                Save this as "bee-package.json" in the root of your .bee_pack archive.
                            </Typography>
                        </Box>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setShowGenerator(false)}>Close</Button>
                </DialogActions>
            </Dialog>
        </Box>
    )
}

export default PublishView
