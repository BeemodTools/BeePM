const { app, BrowserWindow, ipcMain } = require("electron")
const path = require("path")
const fs = require("fs")
const https = require("https")
const crypto = require("crypto")
const os = require("os")
const { spawn } = require("child_process")
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3")
const AdmZip = require("adm-zip")

// Load environment variables from CLI's .env
const envPath = path.join(__dirname, "..", "cli", ".env")
const dotenvResult = require("dotenv").config({ path: envPath })

// Generate a package ID from the name: UPPERCASE_NAME_XXXX
function generatePackageId(name) {
    // Convert name to uppercase, replace non-alphanumeric with underscores
    const baseName = name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") // Trim leading/trailing underscores
        .replace(/_+/g, "_") // Collapse multiple underscores

    // Generate a 4-character random suffix
    const suffix = crypto.randomBytes(2).toString("hex").toUpperCase()

    return `${baseName}_${suffix}`
}

// Extract package ID from info.txt content
function getIdFromInfoTxt(content) {
    // Look for ID field (case-insensitive): "ID" "SOME_ID"
    const match = content.match(/^\s*"ID"\s+"([^"]+)"/im)
    if (!match) {
        return null
    }
    return match[1].toUpperCase()
}

// Validate package ID format (uppercase letters, numbers, underscores)
function validatePackageId(id) {
    return /^[A-Z0-9_]+$/.test(id)
}

// Allowed file extensions for packages (must match CLI's publish.py)
const ALLOWED_EXTENSIONS = new Set([
    '.txt', '.vtf', '.vmt', '.mdl', '.vvd', '.vtx', '.phy', '.3ds',
    '.wav', '.mp3', '.vcd', '.pcf', '.vmf', '.vmx', '.cfg', '.json',
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tga', '.webp', '.nut'
])

// Clean a .bee_pack by removing files with disallowed extensions
function cleanBeePackage(packagePath) {
    const zip = new AdmZip(packagePath)
    const entries = zip.getEntries()
    const removedFiles = []
    const keptFiles = []

    for (const entry of entries) {
        if (entry.isDirectory) continue

        const ext = path.extname(entry.entryName).toLowerCase()
        if (!ALLOWED_EXTENSIONS.has(ext)) {
            removedFiles.push(entry.entryName)
        } else {
            keptFiles.push(entry.entryName)
        }
    }

    if (removedFiles.length === 0) {
        // No cleaning needed, return original path
        return { cleanedPath: packagePath, removedFiles: [], wasModified: false }
    }

    // Create a new cleaned package
    const newZip = new AdmZip()
    for (const entry of entries) {
        if (entry.isDirectory) continue
        const ext = path.extname(entry.entryName).toLowerCase()
        if (ALLOWED_EXTENSIONS.has(ext)) {
            newZip.addFile(entry.entryName, entry.getData(), entry.comment)
        }
    }

    // Save to temp file
    const tempDir = os.tmpdir()
    const tempFileName = `beepm_cleaned_${Date.now()}_${path.basename(packagePath)}`
    const cleanedPath = path.join(tempDir, tempFileName)
    newZip.writeZip(cleanedPath)

    log("package", `Cleaned package: removed ${removedFiles.length} files with disallowed extensions`)
    removedFiles.forEach(f => log("package", `  Removed: ${f}`))

    return { cleanedPath, removedFiles, wasModified: true }
}

// Logging helper
const log = (category, message, data = null) => {
    const timestamp = new Date().toISOString().split("T")[1].slice(0, 8)
    const prefix = `[${timestamp}] [${category}]`
    if (data) {
        console.log(prefix, message, data)
    } else {
        console.log(prefix, message)
    }
}

const isDev = !app.isPackaged

// Startup logs
log("main", "BeePM starting...")
log("main", `Mode: ${isDev ? "development" : "production"}`)
if (dotenvResult.error) {
    log("dotenv", `Failed to load .env from ${envPath}:`, dotenvResult.error.message)
} else {
    const envVars = Object.keys(dotenvResult.parsed || {}).length
    log("dotenv", `Loaded ${envVars} variables from cli/.env`)
}

let mainWindow = null

// Registry URL - use env var from CLI's .env, fallback to direct R2 URL
const REGISTRY_URL =
    process.env.BEEPM_REGISTRY_URL || "https://pub-adc08815222c4c608465419f2d5751a5.r2.dev/registry.json"
const GITHUB_PACKAGES_URL = REGISTRY_URL.replace("registry.json", "github_packages.json")
log("config", `Registry URL: ${REGISTRY_URL}`)
log("config", `GitHub Packages URL: ${GITHUB_PACKAGES_URL}`)

// Get BeePM paths
function getBeepmPaths() {
    const appdata = process.env.APPDATA || ""
    const beepmRoot = path.join(appdata, "beepm")

    return {
        root: beepmRoot,
        packages: path.join(beepmRoot, "packages"),
        config: path.join(beepmRoot, "config"),
        configFile: path.join(beepmRoot, "config", "beepm_config.json"),
        installedFile: path.join(beepmRoot, "config", "installed_packages.json"),
    }
}

// Load installed packages
function loadInstalledPackages() {
    const paths = getBeepmPaths()

    if (!fs.existsSync(paths.installedFile)) {
        return { packages: {} }
    }

    try {
        const data = fs.readFileSync(paths.installedFile, "utf-8")
        return JSON.parse(data)
    } catch {
        return { packages: {} }
    }
}

// Load config
function loadConfig() {
    const paths = getBeepmPaths()

    if (!fs.existsSync(paths.configFile)) {
        return null
    }

    try {
        const data = fs.readFileSync(paths.configFile, "utf-8")
        return JSON.parse(data)
    } catch {
        return null
    }
}

// Fetch URL with redirect support
function fetchUrl(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) {
            reject(new Error("Too many redirects"))
            return
        }

        const parsedUrl = new URL(url)
        const protocol = parsedUrl.protocol === "https:" ? https : require("http")

        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            headers: {
                "User-Agent": "BeePM/1.0",
                Accept: "application/json",
            },
        }

        protocol
            .get(options, (res) => {
                // Handle redirects
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const redirectUrl = res.headers.location.startsWith("http")
                        ? res.headers.location
                        : new URL(res.headers.location, url).href
                    fetchUrl(redirectUrl, maxRedirects - 1)
                        .then(resolve)
                        .catch(reject)
                    return
                }

                let data = ""

                res.on("data", (chunk) => {
                    data += chunk
                })

                res.on("end", () => {
                    resolve({ statusCode: res.statusCode, data })
                })
            })
            .on("error", (err) => {
                reject(err)
            })
    })
}

// Fetch registry from URL
async function fetchRegistry() {
    log("registry", `Fetching from ${REGISTRY_URL}...`)
    const result = await fetchUrl(REGISTRY_URL)

    if (result.statusCode === 404) {
        log("registry", "Registry not found (404)")
        throw new Error("Registry not found (404). The registry may not be set up yet.")
    }

    if (result.statusCode !== 200) {
        log("registry", `Registry returned HTTP ${result.statusCode}`)
        throw new Error(`Registry returned HTTP ${result.statusCode}`)
    }

    let registry
    try {
        registry = JSON.parse(result.data)
        // Validate structure
        if (!registry.packages || !registry.packages.by_id) {
            throw new Error("Registry has invalid structure (missing packages.by_id)")
        }
        const pkgCount = Object.keys(registry.packages.by_id).length
        log("registry", `Loaded ${pkgCount} packages from main registry`)
    } catch (parseErr) {
        if (parseErr.message.includes("Registry")) {
            throw parseErr // Re-throw our validation errors
        }
        log("registry", `Failed to parse: ${parseErr.message}`)
        throw new Error("Failed to parse registry JSON: " + parseErr.message)
    }

    // Also fetch GitHub packages and merge them
    try {
        log("registry", `Fetching GitHub packages from ${GITHUB_PACKAGES_URL}...`)
        const githubResult = await fetchUrl(GITHUB_PACKAGES_URL)

        if (githubResult.statusCode === 200) {
            const githubPackages = JSON.parse(githubResult.data)
            if (githubPackages.packages) {
                // Merge GitHub packages into main registry
                for (const [id, pkg] of Object.entries(githubPackages.packages)) {
                    // Mark as GitHub package and add to registry
                    registry.packages.by_id[id] = { ...pkg, isGithub: true }
                    // Also add to by_name index
                    if (registry.packages.by_name && pkg.author && pkg.name) {
                        const nameKey = `${pkg.author.toLowerCase()}@${pkg.name.toLowerCase()}`
                        registry.packages.by_name[nameKey] = id
                    }
                }
                const githubCount = Object.keys(githubPackages.packages).length
                log("registry", `Merged ${githubCount} GitHub packages`)
            }
        } else if (githubResult.statusCode === 404) {
            log("registry", "No GitHub packages found (404)")
        } else {
            log("registry", `GitHub packages returned HTTP ${githubResult.statusCode}`)
        }
    } catch (githubErr) {
        // Don't fail if GitHub packages can't be fetched
        log("registry", `Failed to fetch GitHub packages: ${githubErr.message}`)
    }

    const totalCount = Object.keys(registry.packages.by_id).length
    log("registry", `Total packages: ${totalCount}`)
    return registry
}

// Protocol handler for beepm:// URLs
const PROTOCOL_PREFIX = "beepm"
let pendingProtocolUrl = null

// Register protocol handler (must be done before app ready)
if (process.defaultApp) {
    // Dev mode - need to pass the script path
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(PROTOCOL_PREFIX, process.execPath, [path.resolve(process.argv[1])])
    }
} else {
    app.setAsDefaultProtocolClient(PROTOCOL_PREFIX)
}
log("protocol", `Registered ${PROTOCOL_PREFIX}:// protocol handler`)

// Parse protocol URL and extract action/params
function parseProtocolUrl(url) {
    log("protocol", `Parsing URL: ${url}`)
    try {
        // URL format: beepm://publish?file=C:/path/to/file.bee_pack
        const parsed = new URL(url)
        const action = parsed.hostname || parsed.pathname.replace(/^\/+/, "")
        const params = Object.fromEntries(parsed.searchParams)

        log("protocol", `Action: ${action}, Params:`, params)
        return { action, params }
    } catch (err) {
        log("protocol", `Failed to parse URL: ${err.message}`)
        return null
    }
}

// Send protocol action to renderer
function handleProtocolUrl(url) {
    const parsed = parseProtocolUrl(url)
    if (!parsed) return

    if (mainWindow && mainWindow.webContents) {
        log("protocol", "Sending to renderer")
        mainWindow.webContents.send("protocol-action", parsed)
        mainWindow.focus()
    } else {
        // Window not ready yet, store for later
        log("protocol", "Window not ready, storing for later")
        pendingProtocolUrl = parsed
    }
}

// Single instance lock (Windows/Linux)
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
    log("main", "Another instance is running, quitting...")
    app.quit()
} else {
    app.on("second-instance", (event, commandLine) => {
        log("protocol", "Second instance detected, command line:", commandLine)
        // Find the protocol URL in command line args
        const protocolUrl = commandLine.find((arg) => arg.startsWith(`${PROTOCOL_PREFIX}://`))
        if (protocolUrl) {
            handleProtocolUrl(protocolUrl)
        }
        // Focus the existing window
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.focus()
        }
    })
}

// macOS: handle open-url event
app.on("open-url", (event, url) => {
    event.preventDefault()
    log("protocol", `open-url event: ${url}`)
    handleProtocolUrl(url)
})

const createWindow = () => {
    const win = new BrowserWindow({
        title: "BeePM",
        width: 1100,
        height: 850,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },
        show: false,
    })

    win.once("ready-to-show", () => {
        log("main", "Window ready to show")
        win.show()

        // Send any pending protocol URL after a short delay to ensure renderer is ready
        if (pendingProtocolUrl) {
            setTimeout(() => {
                log("protocol", "Sending pending protocol URL to renderer")
                win.webContents.send("protocol-action", pendingProtocolUrl)
                pendingProtocolUrl = null
            }, 500)
        }
    })

    if (isDev) {
        log("main", "Loading dev server: http://localhost:5173")
        win.loadURL("http://localhost:5173")
    } else {
        const indexPath = path.join(app.getAppPath(), "dist", "index.html")
        log("main", `Loading production build: ${indexPath}`)
        win.loadFile(indexPath)
    }

    mainWindow = win

    return win
}

app.whenReady().then(() => {
    log("main", "App ready, creating window...")

    // Check for protocol URL in initial launch args (Windows)
    const protocolUrl = process.argv.find((arg) => arg.startsWith(`${PROTOCOL_PREFIX}://`))
    if (protocolUrl) {
        log("protocol", `Found protocol URL in launch args: ${protocolUrl}`)
        pendingProtocolUrl = parseProtocolUrl(protocolUrl)
    }

    createWindow()

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow()
        }
    })
})

app.on("window-all-closed", () => {
    log("main", "All windows closed")
    if (process.platform !== "darwin") {
        app.quit()
    }
})

// IPC Handlers
ipcMain.handle("get-app-version", () => {
    return app.getVersion()
})

ipcMain.handle("fetch-registry", async () => {
    try {
        const registry = await fetchRegistry()
        return { success: true, data: registry }
    } catch (err) {
        return { success: false, error: err.message }
    }
})

ipcMain.handle("get-installed-packages", () => {
    try {
        const installed = loadInstalledPackages()
        return { success: true, data: installed }
    } catch (err) {
        return { success: false, error: err.message }
    }
})

ipcMain.handle("clear-installed-packages", () => {
    try {
        const paths = getBeepmPaths()
        // Reset installed packages to empty
        const emptyInstalled = { packages: {} }
        fs.writeFileSync(paths.installedFile, JSON.stringify(emptyInstalled, null, 2))
        log("ipc", "Cleared all installed packages")
        return { success: true }
    } catch (err) {
        log("ipc", `Failed to clear installed packages: ${err.message}`)
        return { success: false, error: err.message }
    }
})

ipcMain.handle("get-config", () => {
    try {
        const config = loadConfig()
        return { success: true, data: config }
    } catch (err) {
        return { success: false, error: err.message }
    }
})

ipcMain.handle("is-initialized", () => {
    const config = loadConfig()
    const paths = getBeepmPaths()

    // Check if BeePM config exists
    if (!config) {
        return { initialized: false, config: null }
    }

    // Check if BEE2 is actually hooked to BeePM by reading BEE2's config
    const appdata = process.env.APPDATA || ""
    const bee2ConfigPath = path.join(appdata, "BEEMOD2", "config", "config.cfg")

    try {
        if (fs.existsSync(bee2ConfigPath)) {
            const bee2ConfigContent = fs.readFileSync(bee2ConfigPath, "utf-8")

            // Parse INI-style config to find [Directories] package value
            const lines = bee2ConfigContent.split("\n")
            let inDirectories = false

            for (const line of lines) {
                const trimmed = line.trim()
                if (trimmed === "[Directories]") {
                    inDirectories = true
                } else if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
                    inDirectories = false
                } else if (inDirectories && trimmed.startsWith("package")) {
                    // Extract value after "package = " or "package="
                    const match = trimmed.match(/^package\s*=\s*(.+)$/i)
                    if (match) {
                        const currentPkgDir = match[1].trim()
                        // Normalize paths for comparison
                        const normalizedCurrent = path.normalize(currentPkgDir).toLowerCase()
                        const normalizedBeepm = path.normalize(paths.packages).toLowerCase()

                        const isHooked = normalizedCurrent === normalizedBeepm
                        return { initialized: isHooked, config }
                    }
                }
            }
        }
    } catch {
        // If we can't read BEE2 config, fall back to just checking if BeePM config exists
    }

    // If we couldn't determine from BEE2 config, assume not hooked
    return { initialized: false, config }
})

// Run CLI command
function runCliCommand(command, args = []) {
    return new Promise((resolve, reject) => {
        // Set working directory to CLI folder so it can find .env
        const cliDir = path.join(__dirname, "..", "cli")
        const fullCmd = `beepm ${command} ${args.join(" ")}`
        log("cli", `Running: ${fullCmd}`)
        log("cli", `Working directory: ${cliDir}`)

        // Run with chcp 65001 to set UTF-8 encoding on Windows
        const fullCommand = process.platform === "win32" ? `chcp 65001 >nul && beepm ${command} ${args.join(" ")}` : `beepm ${command} ${args.join(" ")}`

        const proc = spawn(fullCommand, [], {
            shell: true,
            env: {
                ...process.env,
                PYTHONIOENCODING: "utf-8", // Fix Unicode encoding issues
                PYTHONUNBUFFERED: "1", // Ensure output is not buffered
                PYTHONUTF8: "1", // Force Python UTF-8 mode
            },
            cwd: cliDir,
        })

        let stdout = ""
        let stderr = ""

        proc.stdout.on("data", (data) => {
            const chunk = data.toString()
            stdout += chunk
            // Log output in real-time
            chunk.split("\n").filter(Boolean).forEach((line) => {
                log("cli:stdout", line)
            })
        })

        proc.stderr.on("data", (data) => {
            const chunk = data.toString()
            stderr += chunk
            chunk.split("\n").filter(Boolean).forEach((line) => {
                log("cli:stderr", line)
            })
        })

        proc.on("close", (code) => {
            log("cli", `Command exited with code ${code}`)
            if (code === 0) {
                resolve({ success: true, output: stdout })
            } else {
                resolve({ success: false, error: stderr || stdout, code })
            }
        })

        proc.on("error", (err) => {
            log("cli", `Command error: ${err.message}`)
            reject(err)
        })
    })
}

ipcMain.handle("run-hook", async () => {
    try {
        const result = await runCliCommand("hook", ["--json"])
        // Parse JSON output from CLI
        if (result.output) {
            try {
                const parsed = JSON.parse(result.output.trim())
                return { success: parsed.success, message: parsed.message, output: result.output }
            } catch {
                // If JSON parse fails, return raw output
                return result
            }
        }
        return result
    } catch (err) {
        return { success: false, error: err.message }
    }
})

ipcMain.handle("run-unhook", async () => {
    try {
        const result = await runCliCommand("unhook", ["--json"])
        // Parse JSON output from CLI
        if (result.output) {
            try {
                const parsed = JSON.parse(result.output.trim())
                return { success: parsed.success, message: parsed.message, output: result.output }
            } catch {
                // If JSON parse fails, return raw output
                return result
            }
        }
        return result
    } catch (err) {
        return { success: false, error: err.message }
    }
})

// Fetch BEE2 versions from GitHub
ipcMain.handle("fetch-bee2-versions", async () => {
    try {
        const result = await fetchUrl("https://api.github.com/repos/BEEmod/BEE2.4/releases")

        if (result.statusCode !== 200) {
            return { success: false, error: `HTTP ${result.statusCode}` }
        }

        const releases = JSON.parse(result.data)
        const versions = releases
            .filter((r) => !r.draft && !r.prerelease)
            .map((r) => ({
                tag: r.tag_name,
                name: r.name,
                published_at: r.published_at,
            }))
            .slice(0, 30) // Limit to 30 versions

        return { success: true, versions }
    } catch (err) {
        return { success: false, error: err.message }
    }
})

// Run init/reinit with specific version
ipcMain.handle("run-reinit", async (event, versionTag) => {
    try {
        const result = await runCliCommand("init", ["--version", versionTag, "--json"])
        if (result.output) {
            try {
                const parsed = JSON.parse(result.output.trim())
                return { success: parsed.success, message: parsed.message, output: result.output }
            } catch {
                return result
            }
        }
        return result
    } catch (err) {
        return { success: false, error: err.message }
    }
})

// Calculate content hash of a .bee_pack file, excluding bee-package.json
// This is used to detect duplicate content with different metadata
function calculateContentHash(zipPath) {
    const AdmZip = require("adm-zip")
    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries()

    // Sort entries by name for consistent hash
    const sortedEntries = entries
        .filter((e) => e.entryName !== "bee-package.json" && e.entryName !== "/bee-package.json" && !e.isDirectory)
        .sort((a, b) => a.entryName.localeCompare(b.entryName))

    const hash = crypto.createHash("sha256")

    for (const entry of sortedEntries) {
        // Include both filename and content in hash
        hash.update(entry.entryName)
        hash.update(entry.getData())
    }

    return hash.digest("hex")
}

// Clean up CLI output - remove spinner frames and keep only meaningful lines
function cleanCliOutput(output) {
    if (!output) return ""

    // Split into lines and filter out spinner animation frames
    const lines = output.split("\n")
    const cleanedLines = lines.filter((line) => {
        const trimmed = line.trim()
        // Skip empty lines
        if (!trimmed) return false
        // Skip spinner animation frames (start with braille spinner chars or contain progress bar patterns)
        if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(trimmed)) return false
        // Skip lines that are just progress bars
        if (/^\s*[-─]+\s*\d+.*MB/.test(trimmed)) return false
        return true
    })

    return cleanedLines.join("\n")
}

// Install a package
ipcMain.handle("run-install", async (event, packageSpec) => {
    log("ipc", `install requested: ${packageSpec}`)
    try {
        const result = await runCliCommand("install", [packageSpec])
        // Check if install succeeded - look for success indicators in output
        const output = result.output || ""
        const error = result.error || ""
        const hasSuccess = output.includes("Installation complete") || output.includes("[OK]")
        const success = result.success && hasSuccess

        // Extract meaningful error message from output
        let message
        if (success) {
            message = `Successfully installed ${packageSpec}`
        } else {
            // Try to find error message in output
            const errorMatch = output.match(/\[X\]\s*(.+)/m) || error.match(/\[X\]\s*(.+)/m)
            message = errorMatch ? errorMatch[1].trim() : error || output || "Installation failed"
        }

        log("ipc", `install result: success=${success}, message=${message}`)
        return {
            success,
            message,
            output: cleanCliOutput(output) + (error ? "\n" + error : ""),
        }
    } catch (err) {
        log("ipc", `install error: ${err.message}`)
        return { success: false, error: err.message }
    }
})

// Uninstall a package
ipcMain.handle("run-uninstall", async (event, packageSpec) => {
    log("ipc", `uninstall requested: ${packageSpec}`)
    try {
        // Use --yes to skip confirmation prompt
        const result = await runCliCommand("uninstall", [packageSpec, "--yes"])
        const output = result.output || ""
        const error = result.error || ""
        const hasSuccess = output.includes("has been uninstalled") || output.includes("[OK]")
        const success = result.success && hasSuccess

        let message
        if (success) {
            message = `Successfully uninstalled ${packageSpec}`
        } else {
            const errorMatch = output.match(/\[X\]\s*(.+)/m) || error.match(/\[X\]\s*(.+)/m)
            message = errorMatch ? errorMatch[1].trim() : error || output || "Uninstall failed"
        }

        log("ipc", `uninstall result: success=${success}, message=${message}`)
        return {
            success,
            message,
            output: cleanCliOutput(output) + (error ? "\n" + error : ""),
        }
    } catch (err) {
        log("ipc", `uninstall error: ${err.message}`)
        return { success: false, error: err.message }
    }
})

// Validate GitHub token by making an API request
async function validateGithubToken(token) {
    return new Promise((resolve) => {
        const options = {
            hostname: "api.github.com",
            path: "/user",
            method: "GET",
            headers: {
                "Authorization": `Bearer ${token}`,
                "User-Agent": "BeePM",
                "Accept": "application/vnd.github+json",
            },
        }

        const req = https.request(options, (res) => {
            let data = ""
            res.on("data", (chunk) => (data += chunk))
            res.on("end", () => {
                if (res.statusCode === 200) {
                    try {
                        const user = JSON.parse(data)
                        resolve({ valid: true, username: user.login })
                    } catch {
                        resolve({ valid: false })
                    }
                } else {
                    log("auth", `Token validation failed: ${res.statusCode}`)
                    resolve({ valid: false })
                }
            })
        })

        req.on("error", () => resolve({ valid: false }))
        req.setTimeout(5000, () => {
            req.destroy()
            resolve({ valid: false })
        })
        req.end()
    })
}

// Check authentication status
ipcMain.handle("check-auth", async () => {
    const paths = getBeepmPaths()
    const authFile = path.join(paths.config, "auth.json")

    if (!fs.existsSync(authFile)) {
        return { authenticated: false, username: null }
    }

    try {
        const data = fs.readFileSync(authFile, "utf-8")
        const auth = JSON.parse(data)

        if (!auth.token) {
            return { authenticated: false, username: null }
        }

        // Validate token with GitHub API
        const validation = await validateGithubToken(auth.token)

        if (!validation.valid) {
            log("auth", "Token expired or invalid, clearing auth file")
            // Token is invalid, delete the auth file
            try {
                fs.unlinkSync(authFile)
            } catch {}
            return { authenticated: false, username: null, expired: true }
        }

        return {
            authenticated: true,
            username: validation.username || auth.username || null,
        }
    } catch {
        return { authenticated: false, username: null }
    }
})

// Run login command
ipcMain.handle("run-login", async () => {
    log("ipc", "login requested")
    try {
        const result = await runCliCommand("login", [])
        const output = result.output || ""
        const error = result.error || ""
        const hasSuccess = output.includes("Login successful") || output.includes("Authenticated as")

        // Extract username from output
        const usernameMatch = output.match(/Authenticated as[:\s]+(\S+)/i)
        const username = usernameMatch ? usernameMatch[1] : null

        log("ipc", `login result: success=${result.success}, username=${username}`)
        return {
            success: result.success && hasSuccess,
            username,
            message: hasSuccess ? "Login successful" : error || "Login failed",
            output: cleanCliOutput(output),
        }
    } catch (err) {
        log("ipc", `login error: ${err.message}`)
        return { success: false, error: err.message }
    }
})

// Open file/folder dialog
ipcMain.handle("show-open-dialog", async (event, options) => {
    const { dialog } = require("electron")
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: options.directory ? ["openDirectory"] : ["openFile"],
            filters: options.filters || [],
            title: options.title || "Select file",
        })
        return {
            canceled: result.canceled,
            filePaths: result.filePaths,
        }
    } catch (err) {
        log("ipc", `dialog error: ${err.message}`)
        return { canceled: true, filePaths: [], error: err.message }
    }
})

// Validate package before publishing
ipcMain.handle("validate-package", async (event, packagePath) => {
    log("ipc", `validate package: ${packagePath}`)

    try {
        // Check if path exists
        if (!fs.existsSync(packagePath)) {
            return { valid: false, error: "Path does not exist" }
        }

        const stats = fs.statSync(packagePath)
        const isDirectory = stats.isDirectory()

        if (isDirectory) {
            // For directories, read bee-package.json directly
            const beePackageJsonPath = path.join(packagePath, "bee-package.json")
            if (!fs.existsSync(beePackageJsonPath)) {
                return { valid: false, error: "bee-package.json not found in directory", missingBeePackage: true }
            }

            try {
                const data = fs.readFileSync(beePackageJsonPath, "utf-8").trim()

                // Check for empty bee-package.json
                if (!data) {
                    return { valid: false, error: "bee-package.json is empty. It must contain valid JSON with package metadata.", missingBeePackage: true }
                }

                let packageData
                try {
                    packageData = JSON.parse(data)
                } catch (jsonErr) {
                    return { valid: false, error: `bee-package.json contains invalid JSON: ${jsonErr.message}`, missingBeePackage: true }
                }

                // Validate required fields
                const required = ["name", "author", "version", "compatibleWith"]
                const missing = required.filter((f) => !packageData[f])
                if (missing.length > 0) {
                    return { valid: false, error: `Missing required fields: ${missing.join(", ")}` }
                }

                // Get ID from info.txt (authoritative source)
                const infoTxtPath = path.join(packagePath, "info.txt")
                if (!fs.existsSync(infoTxtPath)) {
                    return { valid: false, error: "info.txt not found in directory" }
                }
                const infoContent = fs.readFileSync(infoTxtPath, "utf-8")
                const infoId = getIdFromInfoTxt(infoContent)
                if (!infoId) {
                    return { valid: false, error: "ID field not found in info.txt" }
                }
                if (!validatePackageId(infoId)) {
                    return { valid: false, error: `Invalid package ID in info.txt: ${infoId} (must contain only uppercase letters, numbers, and underscores)` }
                }
                packageData.id = infoId

                return {
                    valid: true,
                    isDirectory: true,
                    packagePath,
                    packageData,
                }
            } catch (parseErr) {
                return { valid: false, error: `Failed to read bee-package.json: ${parseErr.message}` }
            }
        } else {
            // For .bee_pack files, extract and check contents
            if (!packagePath.endsWith(".bee_pack")) {
                return { valid: false, error: "File must be a .bee_pack file or a directory" }
            }

            // Check for empty file
            if (stats.size === 0) {
                return { valid: false, error: "File is empty. A .bee_pack file must be a valid ZIP archive." }
            }

            // Use Node's built-in zlib or a simple ZIP check
            const AdmZip = require("adm-zip")

            try {
                const zip = new AdmZip(packagePath)
                const zipEntries = zip.getEntries()

                // Look for bee-package.json at root
                const beePackageEntry = zipEntries.find(
                    (entry) => entry.entryName === "bee-package.json" || entry.entryName === "/bee-package.json"
                )

                if (!beePackageEntry) {
                    return { valid: false, error: "bee-package.json not found in .bee_pack archive", missingBeePackage: true }
                }

                // Read and parse bee-package.json
                const beePackageContent = beePackageEntry.getData().toString("utf-8").trim()

                // Check for empty bee-package.json
                if (!beePackageContent) {
                    return { valid: false, error: "bee-package.json is empty. It must contain valid JSON with package metadata.", missingBeePackage: true }
                }

                let packageData
                try {
                    packageData = JSON.parse(beePackageContent)
                } catch (jsonErr) {
                    return { valid: false, error: `bee-package.json contains invalid JSON: ${jsonErr.message}`, missingBeePackage: true }
                }

                // Validate required fields
                const required = ["name", "author", "version", "compatibleWith"]
                const missing = required.filter((f) => !packageData[f])
                if (missing.length > 0) {
                    return { valid: false, error: `Missing required fields: ${missing.join(", ")}` }
                }

                // Get ID from info.txt (authoritative source)
                const infoTxtEntry = zipEntries.find(
                    (entry) => entry.entryName === "info.txt" || entry.entryName === "/info.txt"
                )
                if (!infoTxtEntry) {
                    return { valid: false, error: "info.txt not found in .bee_pack archive" }
                }
                const infoContent = infoTxtEntry.getData().toString("utf-8")
                const infoId = getIdFromInfoTxt(infoContent)
                if (!infoId) {
                    return { valid: false, error: "ID field not found in info.txt" }
                }
                if (!validatePackageId(infoId)) {
                    return { valid: false, error: `Invalid package ID in info.txt: ${infoId} (must contain only uppercase letters, numbers, and underscores)` }
                }
                packageData.id = infoId

                return {
                    valid: true,
                    isDirectory: false,
                    packagePath,
                    fileName: path.basename(packagePath),
                    size: stats.size,
                    packageData,
                }
            } catch (zipErr) {
                log("ipc", `zip error: ${zipErr.message}`)
                // Provide better error messages for common issues
                if (zipErr.message.includes("Invalid or unsupported zip format")) {
                    return { valid: false, error: "File is not a valid ZIP archive. Make sure it's a properly created .bee_pack file." }
                }
                return { valid: false, error: `Invalid .bee_pack file: ${zipErr.message}` }
            }
        }
    } catch (err) {
        log("ipc", `validate error: ${err.message}`)
        return { valid: false, error: err.message }
    }
})

// Fetch package from GitHub releases
ipcMain.handle("fetch-github-package", async (event, owner, repo) => {
    log("ipc", `fetch github package: ${owner}/${repo}`)

    try {
        // Fetch latest release from GitHub API
        const releaseUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`
        const releaseResult = await fetchUrl(releaseUrl)

        if (releaseResult.statusCode === 404) {
            return { success: false, error: "No releases found for this repository" }
        }

        if (releaseResult.statusCode !== 200) {
            return { success: false, error: `GitHub API error: HTTP ${releaseResult.statusCode}` }
        }

        const release = JSON.parse(releaseResult.data)

        // Find .bee_pack asset
        const beePackAsset = release.assets.find((a) => a.name.endsWith(".bee_pack"))
        if (!beePackAsset) {
            return { success: false, error: "No .bee_pack file found in the latest release" }
        }

        // Download the .bee_pack file to temp
        const tempDir = path.join(app.getPath("temp"), "beepm-github")
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true })
        }

        const tempPath = path.join(tempDir, beePackAsset.name)
        log("ipc", `Downloading ${beePackAsset.browser_download_url} to ${tempPath}`)

        // Download file
        await new Promise((resolve, reject) => {
            const downloadUrl = beePackAsset.browser_download_url
            const file = fs.createWriteStream(tempPath)

            const doDownload = (url, redirects = 5) => {
                if (redirects <= 0) {
                    reject(new Error("Too many redirects"))
                    return
                }

                const parsedUrl = new URL(url)
                const protocol = parsedUrl.protocol === "https:" ? https : require("http")

                protocol
                    .get(
                        url,
                        {
                            headers: {
                                "User-Agent": "BeePM/1.0",
                                Accept: "application/octet-stream",
                            },
                        },
                        (res) => {
                            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                                doDownload(res.headers.location, redirects - 1)
                                return
                            }

                            if (res.statusCode !== 200) {
                                reject(new Error(`Download failed: HTTP ${res.statusCode}`))
                                return
                            }

                            res.pipe(file)
                            file.on("finish", () => {
                                file.close()
                                resolve()
                            })
                        }
                    )
                    .on("error", (err) => {
                        fs.unlink(tempPath, () => {})
                        reject(err)
                    })
            }

            doDownload(downloadUrl)
        })

        // Validate the downloaded package
        const AdmZip = require("adm-zip")
        const stats = fs.statSync(tempPath)

        try {
            const zip = new AdmZip(tempPath)
            const zipEntries = zip.getEntries()

            // Look for bee-package.json at root
            const beePackageEntry = zipEntries.find(
                (entry) => entry.entryName === "bee-package.json" || entry.entryName === "/bee-package.json"
            )

            if (!beePackageEntry) {
                fs.unlinkSync(tempPath)
                return {
                    success: false,
                    error: "bee-package.json not found in .bee_pack archive",
                    missingBeePackage: true,
                }
            }

            // Read and parse bee-package.json
            const beePackageContent = beePackageEntry.getData().toString("utf-8")
            const packageData = JSON.parse(beePackageContent)

            // Validate required fields
            const required = ["name", "author", "version", "compatibleWith"]
            const missing = required.filter((f) => !packageData[f])
            if (missing.length > 0) {
                fs.unlinkSync(tempPath)
                return { success: false, error: `Missing required fields: ${missing.join(", ")}` }
            }

            // Get ID from info.txt (authoritative source)
            const infoTxtEntry = zipEntries.find(
                (entry) => entry.entryName === "info.txt" || entry.entryName === "/info.txt"
            )
            if (!infoTxtEntry) {
                fs.unlinkSync(tempPath)
                return { success: false, error: "info.txt not found in .bee_pack archive" }
            }
            const infoContent = infoTxtEntry.getData().toString("utf-8")
            const infoId = getIdFromInfoTxt(infoContent)
            if (!infoId) {
                fs.unlinkSync(tempPath)
                return { success: false, error: "ID field not found in info.txt" }
            }
            if (!validatePackageId(infoId)) {
                fs.unlinkSync(tempPath)
                return { success: false, error: `Invalid package ID in info.txt: ${infoId} (must contain only uppercase letters, numbers, and underscores)` }
            }
            packageData.id = infoId

            // Check for files with disallowed extensions
            const disallowedFiles = []
            for (const entry of zipEntries) {
                if (entry.isDirectory) continue
                const ext = path.extname(entry.entryName).toLowerCase()
                if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
                    disallowedFiles.push(entry.entryName)
                }
            }

            // Calculate content hash for duplicate detection
            const contentHash = calculateContentHash(tempPath)
            log("ipc", `GitHub package validated: ${packageData.id} v${packageData.version}, hash: ${contentHash.substring(0, 12)}...`)
            if (disallowedFiles.length > 0) {
                log("ipc", `GitHub package has ${disallowedFiles.length} files with disallowed extensions`)
            }

            return {
                success: true,
                valid: true,
                isDirectory: false,
                packagePath: tempPath,
                fileName: beePackAsset.name,
                size: stats.size,
                packageData,
                contentHash,
                disallowedFiles,
                githubRelease: {
                    owner,
                    repo,
                    tag: release.tag_name,
                    name: release.name,
                    downloadUrl: beePackAsset.browser_download_url,
                    downloads: beePackAsset.download_count,
                },
            }
        } catch (zipErr) {
            log("ipc", `zip error: ${zipErr.message}`)
            fs.unlinkSync(tempPath)
            return { success: false, error: `Invalid .bee_pack file: ${zipErr.message}` }
        }
    } catch (err) {
        log("ipc", `fetch github error: ${err.message}`)
        return { success: false, error: err.message }
    }
})

// Run publish command
ipcMain.handle("run-publish", async (event, packagePath) => {
    log("ipc", `publish requested: ${packagePath}`)

    let cleanedPath = null
    let cleanupNeeded = false

    try {
        // Clean the package by removing disallowed file types
        const cleanResult = cleanBeePackage(packagePath)
        cleanedPath = cleanResult.cleanedPath
        cleanupNeeded = cleanResult.wasModified

        if (cleanResult.wasModified) {
            log("ipc", `Package cleaned: removed ${cleanResult.removedFiles.length} files`)
        }

        const result = await runCliCommand("publish", [`"${cleanedPath}"`])
        const output = result.output || ""
        const error = result.error || ""
        const hasSuccess = output.includes("published successfully") || output.includes("Package published")

        let message
        if (hasSuccess) {
            // Extract package info from output
            const packageMatch = output.match(/Package:\s*(@\S+)/m)
            const versionMatch = output.match(/Version:\s*(\S+)/m)
            message = `Published ${packageMatch ? packageMatch[1] : "package"} v${versionMatch ? versionMatch[1] : ""}`
            if (cleanResult.wasModified) {
                message += ` (cleaned ${cleanResult.removedFiles.length} unsupported files)`
            }
        } else {
            const errorMatch = output.match(/\[X\]\s*(.+)/m) || error.match(/\[X\]\s*(.+)/m)
            message = errorMatch ? errorMatch[1].trim() : error || output || "Publish failed"
        }

        log("ipc", `publish result: success=${hasSuccess}, message=${message}`)
        return {
            success: hasSuccess,
            message,
            output: cleanCliOutput(output) + (error ? "\n" + error : ""),
            removedFiles: cleanResult.removedFiles,
        }
    } catch (err) {
        log("ipc", `publish error: ${err.message}`)
        return { success: false, error: err.message }
    } finally {
        // Clean up temp file if created
        if (cleanupNeeded && cleanedPath && cleanedPath !== packagePath) {
            try {
                fs.unlinkSync(cleanedPath)
                log("ipc", `Cleaned up temp file: ${cleanedPath}`)
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    }
})

// Get S3 client for R2
function getR2Client() {
    const accessKeyId = process.env.R2_ACCESS_KEY_ID
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
    const endpoint = process.env.R2_ENDPOINT_URL

    if (!accessKeyId || !secretAccessKey || !endpoint) {
        return null
    }

    return new S3Client({
        region: "auto",
        endpoint: endpoint,
        credentials: {
            accessKeyId,
            secretAccessKey,
        },
    })
}

// Publish GitHub package to R2 bucket
ipcMain.handle("publish-github-package", async (event, packageData, githubRelease, contentHash) => {
    log("ipc", `publish github package: ${packageData.id} from ${githubRelease.owner}/${githubRelease.repo}, hash: ${contentHash?.substring(0, 12) || "none"}...`)

    const bucketName = process.env.R2_BUCKET_NAME
    if (!bucketName) {
        return { success: false, error: "R2 bucket not configured" }
    }

    const s3Client = getR2Client()
    if (!s3Client) {
        return { success: false, error: "R2 credentials not configured" }
    }

    try {
        // Fetch existing github_packages.json or create new one
        let githubPackages = { packages: {}, lastUpdated: null }

        try {
            const getCommand = new GetObjectCommand({
                Bucket: bucketName,
                Key: "github_packages.json",
            })
            const response = await s3Client.send(getCommand)
            const body = await response.Body.transformToString()
            githubPackages = JSON.parse(body)
            log("ipc", `Loaded existing github_packages.json with ${Object.keys(githubPackages.packages).length} packages`)
        } catch (err) {
            if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
                log("ipc", "github_packages.json not found, creating new one")
            } else {
                log("ipc", `Error fetching github_packages.json: ${err.message}`)
                // Continue with empty object
            }
        }

        const packageId = packageData.id
        const existingPkg = githubPackages.packages[packageId]

        // Check author permissions
        if (existingPkg) {
            // Package exists - verify the author matches the existing package author
            // This prevents someone from hijacking an existing package
            if (packageData.author.toLowerCase() !== existingPkg.author.toLowerCase()) {
                return {
                    success: false,
                    error: `Package "${existingPkg.name}" is owned by "${existingPkg.author}". You cannot publish as "${packageData.author}".`,
                }
            }

            // Check if this exact version already exists
            if (existingPkg.versions?.[packageData.version]) {
                return {
                    success: false,
                    error: `Version ${packageData.version} is already published. Update your release with a new version.`,
                }
            }
        } else {
            // New package - author must match GitHub repo owner
            // This ensures only the repo owner can first publish a package
            if (packageData.author.toLowerCase() !== githubRelease.owner.toLowerCase()) {
                return {
                    success: false,
                    error: `Package author "${packageData.author}" doesn't match GitHub repo owner "${githubRelease.owner}". Only the repo owner can publish this package.`,
                }
            }
        }

        // Check for duplicate GitHub repo (same owner/repo but different package ID)
        const githubKey = `${githubRelease.owner.toLowerCase()}/${githubRelease.repo.toLowerCase()}`
        for (const [existingId, existing] of Object.entries(githubPackages.packages)) {
            if (existingId === packageId) continue // Skip self
            // Check any version for the GitHub info
            const existingVersions = Object.values(existing.versions || {})
            for (const ver of existingVersions) {
                if (ver.github) {
                    const existingKey = `${ver.github.owner.toLowerCase()}/${ver.github.repo.toLowerCase()}`
                    if (existingKey === githubKey) {
                        return {
                            success: false,
                            error: `This GitHub repository is already registered as "${existing.name}" (${existingId})`,
                        }
                    }
                }
            }
        }

        // Check for duplicate content hash (same content but different package ID)
        // This prevents someone from taking another package and just changing the bee-package.json
        if (contentHash) {
            for (const [existingId, existing] of Object.entries(githubPackages.packages)) {
                if (existingId === packageId) continue // Skip self (same package can have same content for updates)
                const existingVersions = Object.values(existing.versions || {})
                for (const ver of existingVersions) {
                    if (ver.contentHash === contentHash) {
                        return {
                            success: false,
                            error: `This package content already exists as "${existing.name}" by ${existing.author}. Duplicate packages are not allowed.`,
                        }
                    }
                }
            }
        }

        // Add/update the package entry
        const newVersion = {
            version: packageData.version,
            compatibleWith: packageData.compatibleWith,
            downloadUrl: githubRelease.downloadUrl,
            github: {
                owner: githubRelease.owner,
                repo: githubRelease.repo,
                tag: githubRelease.tag,
                releaseName: githubRelease.name,
            },
            downloads: githubRelease.downloads,
            contentHash: contentHash || null,
            publishedAt: new Date().toISOString(),
        }

        if (existingPkg) {
            // Package exists, add new version
            githubPackages.packages[packageId].versions[packageData.version] = newVersion
            // Update display_name in case it changed
            githubPackages.packages[packageId].display_name = packageData.display_name || packageData.name
            log("ipc", `Added version ${packageData.version} to existing package ${packageId}`)
        } else {
            // New package
            githubPackages.packages[packageId] = {
                id: packageData.id,
                name: packageData.name,
                display_name: packageData.display_name || packageData.name,
                author: packageData.author,
                description: packageData.description || "",
                versions: {
                    [packageData.version]: newVersion,
                },
            }
            log("ipc", `Created new package ${packageId}`)
        }

        githubPackages.lastUpdated = new Date().toISOString()

        // Upload updated github_packages.json
        const putCommand = new PutObjectCommand({
            Bucket: bucketName,
            Key: "github_packages.json",
            Body: JSON.stringify(githubPackages, null, 2),
            ContentType: "application/json",
        })

        await s3Client.send(putCommand)
        log("ipc", `Successfully published ${packageId} to github_packages.json`)

        return {
            success: true,
            message: `Published ${packageData.name} v${packageData.version} (via GitHub)`,
            packageId,
            downloadUrl: githubRelease.downloadUrl,
        }
    } catch (err) {
        log("ipc", `publish github error: ${err.message}`)
        return { success: false, error: err.message }
    }
})

// Get list of admin usernames from environment
function getAdminUsers() {
    const adminsEnv = process.env.BEEPM_ADMINS || ""
    return adminsEnv
        .split(",")
        .map((u) => u.trim().toLowerCase())
        .filter((u) => u.length > 0)
}

// Check if current user is an admin
ipcMain.handle("check-admin", () => {
    const paths = getBeepmPaths()
    const authFile = path.join(paths.config, "auth.json")

    if (!fs.existsSync(authFile)) {
        return { isAdmin: false, username: null }
    }

    try {
        const data = fs.readFileSync(authFile, "utf-8")
        const auth = JSON.parse(data)
        const username = auth.username?.toLowerCase() || ""
        const admins = getAdminUsers()
        const isAdmin = admins.includes(username)

        log("admin", `User ${auth.username} admin check: ${isAdmin} (admins: ${admins.join(", ")})`)
        return {
            isAdmin,
            username: auth.username,
            admins, // For debugging
        }
    } catch (err) {
        log("admin", `Error checking admin: ${err.message}`)
        return { isAdmin: false, username: null }
    }
})

// Remove a package from the registry (admin only)
ipcMain.handle("remove-package", async (event, packageId, registryType) => {
    log("admin", `Remove package request: ${packageId} from ${registryType}`)

    // Verify user is admin
    const paths = getBeepmPaths()
    const authFile = path.join(paths.config, "auth.json")

    if (!fs.existsSync(authFile)) {
        return { success: false, error: "Not authenticated" }
    }

    let username
    try {
        const data = fs.readFileSync(authFile, "utf-8")
        const auth = JSON.parse(data)
        username = auth.username?.toLowerCase() || ""
    } catch {
        return { success: false, error: "Failed to read auth" }
    }

    const admins = getAdminUsers()
    if (!admins.includes(username)) {
        log("admin", `User ${username} is not an admin, denying removal`)
        return { success: false, error: "Permission denied: not an admin" }
    }

    const bucketName = process.env.R2_BUCKET_NAME
    if (!bucketName) {
        return { success: false, error: "R2 bucket not configured" }
    }

    const s3Client = getR2Client()
    if (!s3Client) {
        return { success: false, error: "Failed to create R2 client" }
    }

    try {
        // Determine which registry file to modify
        const registryFile = registryType === "github" ? "github_packages.json" : "registry.json"

        // Fetch current registry
        const getCommand = new GetObjectCommand({
            Bucket: bucketName,
            Key: registryFile,
        })

        let registryData
        try {
            const response = await s3Client.send(getCommand)
            const body = await response.Body.transformToString()
            registryData = JSON.parse(body)
        } catch (fetchErr) {
            if (fetchErr.name === "NoSuchKey") {
                return { success: false, error: `Registry file ${registryFile} not found` }
            }
            throw fetchErr
        }

        // Find and remove the package
        let removed = false
        if (registryType === "github") {
            if (registryData.packages && registryData.packages[packageId]) {
                const pkgName = registryData.packages[packageId].name
                delete registryData.packages[packageId]
                registryData.lastUpdated = new Date().toISOString()
                removed = true
                log("admin", `Removed ${packageId} (${pkgName}) from github_packages.json`)
            }
        } else {
            // Regular registry has packages.by_id structure
            if (registryData.packages?.by_id && registryData.packages.by_id[packageId]) {
                const pkgName = registryData.packages.by_id[packageId].name
                delete registryData.packages.by_id[packageId]

                // Also clean up any by_name entries that point to this package ID
                if (registryData.packages?.by_name) {
                    const keysToDelete = []
                    for (const [key, id] of Object.entries(registryData.packages.by_name)) {
                        if (id === packageId) {
                            keysToDelete.push(key)
                        }
                    }
                    for (const key of keysToDelete) {
                        delete registryData.packages.by_name[key]
                        log("admin", `Removed by_name entry: ${key}`)
                    }
                }

                registryData.lastUpdated = new Date().toISOString()
                removed = true
                log("admin", `Removed ${packageId} (${pkgName}) from registry.json`)
            }
        }

        if (!removed) {
            return { success: false, error: `Package ${packageId} not found in ${registryFile}` }
        }

        // Upload updated registry
        const putCommand = new PutObjectCommand({
            Bucket: bucketName,
            Key: registryFile,
            Body: JSON.stringify(registryData, null, 2),
            ContentType: "application/json",
        })

        await s3Client.send(putCommand)
        log("admin", `Successfully removed ${packageId} from ${registryFile}`)

        return {
            success: true,
            message: `Package ${packageId} removed from registry`,
        }
    } catch (err) {
        log("admin", `Error removing package: ${err.message}`)
        return { success: false, error: err.message }
    }
})
