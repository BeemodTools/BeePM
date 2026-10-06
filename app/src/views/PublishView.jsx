import { useCallback, useEffect, useRef, useState } from "react"
import {
    Alert,
    Box,
    Button,
    ButtonBase,
    Card,
    CardContent,
    Checkbox,
    Chip,
    CircularProgress,
    Collapse,
    Divider,
    FormControlLabel,
    LinearProgress,
    MenuItem,
    TextField,
    Typography,
} from "@mui/material"
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh"
import CheckCircleIcon from "@mui/icons-material/CheckCircle"
import CheckIcon from "@mui/icons-material/Check"
import CloudUploadIcon from "@mui/icons-material/CloudUpload"
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline"
import ExpandMoreIcon from "@mui/icons-material/ExpandMore"
import FolderOpenIcon from "@mui/icons-material/FolderOpen"
import GitHubIcon from "@mui/icons-material/GitHub"
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined"
import InsertDriveFileIcon from "@mui/icons-material/InsertDriveFile"
import LoginIcon from "@mui/icons-material/Login"
import VerifiedIcon from "@mui/icons-material/Verified"
import { PUBLISH_RULES } from "@beepm/core/rules"
import semver from "semver"
import { api, onEvent } from "../api.js"
import ErrorAlert from "../components/ErrorAlert.jsx"
import ManifestEditor from "../components/ManifestEditor.jsx"
import { formatBytes } from "../lib/format.js"
import { useApp } from "../state/context.js"

const cardSx = { backgroundColor: "#262829", border: "1px solid #3a3a3a" }
const STEPS = ["Choose", "Review", "Terms & Info", "Publish"]
const PHASE_STEP = {
    choose: 0,
    preparing: 0,
    problems: 0,
    review: 1,
    terms: 2,
    uploading: 3,
    done: 4,
}

function StepIndicator({ active }) {
    return (
        <Box sx={{ display: "flex", alignItems: "center", mb: 3 }}>
            {STEPS.map((label, index) => (
                <Box
                    key={label}
                    sx={{
                        display: "flex",
                        alignItems: "center",
                        flex: index < STEPS.length - 1 ? 1 : "none",
                    }}
                >
                    <Box
                        sx={{
                            width: 32,
                            height: 32,
                            borderRadius: "50%",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: active >= index ? "#2eff7b" : "#3a3a3a",
                            color: active >= index ? "#000" : "#888",
                            fontWeight: 600,
                            fontSize: 14,
                        }}
                    >
                        {active > index ? <CheckIcon sx={{ fontSize: 18 }} /> : index + 1}
                    </Box>
                    <Typography
                        variant="body2"
                        sx={{
                            ml: 1,
                            color: active >= index ? "#fff" : "#666",
                            fontWeight: active === index ? 600 : 400,
                        }}
                    >
                        {label}
                    </Typography>
                    {index < STEPS.length - 1 && (
                        <Box
                            sx={{
                                flex: 1,
                                height: 2,
                                mx: 2,
                                backgroundColor: active > index ? "#2eff7b" : "#3a3a3a",
                            }}
                        />
                    )}
                </Box>
            ))}
        </Box>
    )
}

const fileName = (path) =>
    String(path ?? "")
        .split(/[\\/]/)
        .pop()

function Field({ label, children, wide }) {
    return (
        <Box sx={{ gridColumn: wide ? "1 / -1" : "auto", minWidth: 0 }}>
            <Typography
                sx={{ fontSize: 11, color: "#777", textTransform: "uppercase", letterSpacing: 0.5 }}
            >
                {label}
            </Typography>
            <Box sx={{ color: "#fff", overflowWrap: "anywhere" }}>{children}</Box>
        </Box>
    )
}

const files = (count) => `${count} file${count === 1 ? "" : "s"}`

/** A dropdown: the title, and every file when it's opened. */
function FileDropdown({ title, names }) {
    const [open, setOpen] = useState(false)
    return (
        <Box sx={{ border: "1px solid #3a3a3a", borderRadius: 1, backgroundColor: "#1f2122" }}>
            <ButtonBase
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                sx={{ width: "100%", justifyContent: "flex-start", gap: 1.25, px: 1.5, py: 1.25 }}
            >
                <InfoOutlinedIcon sx={{ fontSize: 20, color: "info.main" }} />
                <Typography variant="body2" sx={{ flex: 1, textAlign: "left", color: "#ccc" }}>
                    {title}
                </Typography>
                <ExpandMoreIcon
                    sx={{
                        color: "#888",
                        transform: open ? "rotate(180deg)" : "none",
                        transition: "transform 150ms",
                    }}
                />
            </ButtonBase>
            <Collapse in={open}>
                <Box
                    component="ul"
                    sx={{
                        m: 0,
                        px: 1.5,
                        py: 1,
                        listStyle: "none",
                        maxHeight: 240,
                        overflowY: "auto",
                        borderTop: "1px solid #3a3a3a",
                    }}
                >
                    {names.map((name) => (
                        <Box
                            component="li"
                            key={name}
                            sx={{
                                py: 0.25,
                                fontFamily: "monospace",
                                fontSize: 12,
                                color: "#aaa",
                                overflowWrap: "anywhere",
                            }}
                        >
                            {name}
                        </Box>
                    ))}
                </Box>
            </Collapse>
        </Box>
    )
}

function LoginRequired({ onLogin }) {
    return (
        <Box
            sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                minHeight: "60vh",
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
                <LoginIcon sx={{ fontSize: 40, color: "#2eff7b" }} />
            </Box>
            <Typography variant="h5" sx={{ color: "#fff", mb: 3, fontWeight: 600 }}>
                Log in to publish
            </Typography>
            <Button variant="contained" startIcon={<LoginIcon />} onClick={onLogin}>
                Log in
            </Button>
        </Box>
    )
}

/**
 * How to publish the next version, depending on where this one comes from. A GitHub release
 * can have the repo's next releases published automatically (watch).
 */
function UpdateInfo({ prepared, watch, onWatchChange }) {
    const next = semver.inc(prepared.manifest.version, "patch") ?? "a higher one"
    const how = prepared.github
        ? watch
            ? `BeePM checks ${prepared.github.fullName} about every 15 minutes and publishes its newest release. Give each release's bee-package.json a higher "version" (like ${next}).`
            : `Make a new release on ${prepared.github.fullName} with a .bee_pack whose bee-package.json has a higher "version" (like ${next}), then publish that release here.`
        : prepared.isFolder
          ? `Raise "version" in the folder's bee-package.json (like ${next}), then publish the folder here again.`
          : `Publish the new .bee_pack here, with a higher "version" in its bee-package.json (like ${next}).`
    return (
        <Box
            sx={{
                px: 2,
                py: 1.5,
                mb: 2,
                border: "1px solid #3a3a3a",
                borderRadius: 1,
                backgroundColor: "#1f2122",
            }}
        >
            <Typography variant="body2" sx={{ color: "#ccc" }}>
                Updating it later
            </Typography>
            {prepared.github && (
                <FormControlLabel
                    sx={{ mt: 0.5 }}
                    control={
                        <Checkbox
                            size="small"
                            checked={watch}
                            onChange={(event) => onWatchChange(event.target.checked)}
                        />
                    }
                    label={
                        <Typography variant="body2">
                            Publish new releases of {prepared.github.fullName} automatically
                        </Typography>
                    }
                />
            )}
            <Box
                component="ul"
                sx={{ m: 0, mt: 0.5, pl: 2.5, color: "#aaa", fontSize: 13, lineHeight: 1.6 }}
            >
                <li>{how}</li>
                <li>Anyone who installed it gets the new version when they update.</li>
                <li>If a version turns out broken, yank it from the package's page.</li>
            </Box>
        </Box>
    )
}

/** The publishing rules, and the box to tick before anything is published. */
function RulesAgreement({ agreed, onChange }) {
    return (
        <Box
            sx={{
                px: 2,
                py: 1.5,
                border: "1px solid #3a3a3a",
                borderRadius: 1,
                backgroundColor: "#1f2122",
            }}
        >
            <Typography variant="body2" sx={{ color: "#ccc" }}>
                {PUBLISH_RULES.intro}
            </Typography>
            <Box
                component="ul"
                sx={{ m: 0, mt: 0.5, pl: 2.5, color: "#aaa", fontSize: 13, lineHeight: 1.6 }}
            >
                {PUBLISH_RULES.items.map((item) => (
                    <li key={item}>{item}</li>
                ))}
            </Box>
            <FormControlLabel
                sx={{ mt: 0.5, mb: -0.5 }}
                control={
                    <Checkbox
                        size="small"
                        checked={agreed}
                        onChange={(event) => onChange(event.target.checked)}
                    />
                }
                label={<Typography variant="body2">I agree</Typography>}
            />
        </Box>
    )
}

/**
 * Picks a .bee_pack from a release of one of the linked GitHub account's repositories. Next
 * hands it on ({ owner, repo, tag, asset, fullName }); the registry downloads it when published.
 */
function GithubImport({ disabled, onNext }) {
    const [repos, setRepos] = useState({ loading: true, list: [], error: null })
    const [repo, setRepo] = useState("") // owner/name
    const [releases, setReleases] = useState({ loading: false, list: [], error: null })
    const [tag, setTag] = useState("")
    const [asset, setAsset] = useState("")

    useEffect(() => {
        let cancelled = false
        api.publish.githubRepos().then((res) => {
            if (cancelled) return
            setRepos(
                res.ok
                    ? { loading: false, list: res.repos, error: null }
                    : { loading: false, list: [], error: res.error },
            )
        })
        return () => {
            cancelled = true
        }
    }, [])

    const chosen = repos.list.find((r) => r.fullName === repo) ?? null
    useEffect(() => {
        if (!chosen) return
        let cancelled = false
        setReleases({ loading: true, list: [], error: null })
        setTag("")
        setAsset("")
        api.publish.githubReleases({ owner: chosen.owner, repo: chosen.name }).then((res) => {
            if (cancelled) return
            const list = res.ok ? res.releases : []
            setReleases({ loading: false, list, error: res.ok ? null : res.error })
            if (list.length) {
                setTag(list[0].tag)
                setAsset(list[0].assets[0])
            }
        })
        return () => {
            cancelled = true
        }
    }, [chosen])

    const release = releases.list.find((r) => r.tag === tag) ?? null

    const releaseNote = releases.error
        ? releases.error
        : chosen && !releases.loading && !releases.list.length
          ? "No releases with a .bee_pack"
          : null

    return (
        <Box>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
                <GitHubIcon sx={{ fontSize: 20, color: "#aaa" }} />
                <Typography sx={{ color: "#fff", fontWeight: 600 }}>
                    From a GitHub release
                </Typography>
            </Box>
            <Box sx={{ display: "flex", gap: 1.5, flexWrap: "wrap" }}>
                <TextField
                    select
                    size="small"
                    label={repos.loading ? "Loading repositories…" : "Repository"}
                    value={repo}
                    onChange={(event) => setRepo(event.target.value)}
                    disabled={repos.loading || !repos.list.length}
                    error={Boolean(repos.error)}
                    helperText={
                        repos.error ??
                        (!repos.loading && !repos.list.length ? "No public repositories" : null)
                    }
                    sx={{ flex: "2 1 240px" }}
                >
                    {repos.list.map((r) => (
                        <MenuItem key={r.fullName} value={r.fullName}>
                            {r.fullName}
                        </MenuItem>
                    ))}
                </TextField>
                <TextField
                    select
                    size="small"
                    label={releases.loading ? "Loading releases…" : "Release"}
                    value={tag}
                    onChange={(event) => {
                        setTag(event.target.value)
                        setAsset(
                            releases.list.find((r) => r.tag === event.target.value)?.assets[0] ??
                                "",
                        )
                    }}
                    disabled={!chosen || releases.loading || !releases.list.length}
                    error={Boolean(releases.error)}
                    helperText={releaseNote}
                    slotProps={{ select: { renderValue: (value) => value } }}
                    sx={{ flex: "1 1 160px" }}
                >
                    {releases.list.map((r) => (
                        <MenuItem key={r.tag} value={r.tag}>
                            {r.tag}
                            {r.name && r.name !== r.tag && (
                                <Box component="span" sx={{ ml: 1, color: "#888" }}>
                                    {r.name}
                                </Box>
                            )}
                        </MenuItem>
                    ))}
                </TextField>
                {release && release.assets.length > 1 && (
                    <TextField
                        select
                        size="small"
                        label=".bee_pack"
                        value={asset}
                        onChange={(event) => setAsset(event.target.value)}
                        sx={{ flex: "1 1 160px" }}
                    >
                        {release.assets.map((name) => (
                            <MenuItem key={name} value={name}>
                                {name}
                            </MenuItem>
                        ))}
                    </TextField>
                )}
            </Box>
            <Button
                variant="outlined"
                fullWidth
                sx={{ mt: 2 }}
                startIcon={<GitHubIcon />}
                disabled={disabled || !release}
                onClick={() =>
                    onNext({
                        owner: chosen.owner,
                        repo: chosen.name,
                        tag: release.tag,
                        asset,
                        fullName: chosen.fullName,
                    })
                }
            >
                Next
            </Button>
        </Box>
    )
}

/**
 * Publishing in four steps: choose a .bee_pack or folder (or a GitHub release), review what was
 * found, agree to the terms, publish. If bee-package.json is missing or invalid, it can be
 * created here. A GitHub release skips the review: the registry downloads and checks it.
 */
export default function PublishView() {
    const app = useApp()
    const { auth, publishRequest } = app
    const [phase, setPhase] = useState("choose") // choose | preparing | problems | review | terms | uploading | done
    const [source, setSource] = useState(null) // { label, path } or { label, github }
    const [prepared, setPrepared] = useState(null)
    const [problem, setProblem] = useState(null)
    const [upload, setUpload] = useState({ sent: 0, total: 0 })
    const [uploadError, setUploadError] = useState(null)
    const [result, setResult] = useState(null)
    const [editor, setEditor] = useState(null) // { path, id }
    const [agreed, setAgreed] = useState(false)
    const [watch, setWatch] = useState(true) // GitHub: publish the repo's new releases too
    const [githubKey, setGithubKey] = useState(0) // a new key empties the GitHub picker
    const preparedRef = useRef(null)
    const requestRef = useRef(0)

    // The prepared package is a temporary copy in the main process: drop it when it's replaced
    const keepPrepared = useCallback((value) => {
        const previous = preparedRef.current
        if (previous && previous.id !== value?.id) api.publish.discard(previous.id)
        preparedRef.current = value
        setPrepared(value)
    }, [])

    useEffect(() => {
        const ref = preparedRef
        return () => {
            if (ref.current) api.publish.discard(ref.current.id)
        }
    }, [])

    useEffect(
        () =>
            onEvent("publish:progress", (progress) => {
                if (progress.id === preparedRef.current?.id)
                    setUpload({ sent: progress.sent, total: progress.total })
            }),
        [],
    )

    /** Checks a package (a file or folder, or a GitHub release's .bee_pack), then shows it. */
    const check = useCallback(
        async (next) => {
            const request = ++requestRef.current
            keepPrepared(null)
            setSource(next)
            setProblem(null)
            setUploadError(null)
            setResult(null)
            setAgreed(false)
            setWatch(true)
            setPhase("preparing")
            const res = next.github
                ? await api.publish.prepareGithub(next.github)
                : await api.publish.prepare(next.path)
            if (request !== requestRef.current) {
                // Something else was chosen meanwhile
                if (res.ok) api.publish.discard(res.id)
                return
            }
            if (res.ok) {
                keepPrepared(res)
                setPhase("review")
            } else {
                setProblem(res)
                setPhase("problems")
            }
        },
        [keepPrepared],
    )
    const prepare = useCallback((path) => check({ label: fileName(path), path }), [check])
    const prepareGithub = (release) => check({ label: release.asset, github: release })

    // beepm://publish?file=...
    useEffect(() => {
        if (publishRequest) prepare(publishRequest.file)
    }, [publishRequest, prepare])

    async function choose(kind) {
        const res = await api.publish.pick(kind)
        if (!res.ok) app.notify(res.error, "error")
        else if (!res.canceled) prepare(res.path)
    }

    async function publish() {
        if (!prepared) return
        setUploadError(null)
        setUpload({ sent: 0, total: prepared.github ? 0 : prepared.size })
        setPhase("uploading")
        const res = await api.publish.upload(prepared.id, { watch })
        if (!res.ok) {
            setUploadError(res)
            setPhase("terms")
            if (res.code === "login_required" || res.status === 401) app.refreshAuth()
            return
        }
        if (prepared.github) setGithubKey((key) => key + 1)
        preparedRef.current = null // published: the main process already removed its copy
        setPrepared(null)
        setResult(res.result)
        setPhase("done")
        app.bumpRegistry()
    }

    function startOver() {
        requestRef.current++
        keepPrepared(null)
        setSource(null)
        setProblem(null)
        setUploadError(null)
        setResult(null)
        setAgreed(false)
        setPhase("choose")
    }

    if (auth.loading) {
        return (
            <Box sx={{ display: "flex", justifyContent: "center", py: 10 }}>
                <CircularProgress />
            </Box>
        )
    }
    if (!auth.loggedIn) return <LoginRequired onLogin={() => app.startLogin("login")} />

    const blocked = auth.canPublish === false
    const hasGithub = auth.identities?.some((identity) => identity.provider === "github")
    const m = prepared?.manifest
    const manifestMissing = problem?.problems?.some((p) =>
        p.startsWith("bee-package.json is missing"),
    )
    const finishing = upload.total > 0 && upload.sent >= upload.total
    const fromGithub = Boolean(prepared?.github)

    return (
        <Box sx={{ maxWidth: 680, mx: "auto" }}>
            {blocked && (
                <Alert severity={auth.banned ? "error" : "warning"} sx={{ mb: 2 }}>
                    {auth.publishBlockedReason || "Your account can't publish packages."}
                </Alert>
            )}
            {auth.offline && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                    Can't reach the registry right now. You can check a package, but publishing
                    needs a connection.
                </Alert>
            )}

            <StepIndicator active={PHASE_STEP[phase]} />

            <Card
                variant="outlined"
                sx={{ ...cardSx, display: phase === "choose" ? "block" : "none" }}
            >
                <CardContent sx={{ p: 3 }}>
                    <Typography variant="h6" sx={{ color: "#fff" }}>
                        Choose a package
                    </Typography>
                    <Box sx={{ display: "flex", gap: 2, mt: 2 }}>
                        <Button
                            variant="contained"
                            size="large"
                            startIcon={<InsertDriveFileIcon />}
                            onClick={() => choose("file")}
                            sx={{ flex: 1 }}
                        >
                            Choose .bee_pack file
                        </Button>
                        <Button
                            variant="outlined"
                            size="large"
                            startIcon={<FolderOpenIcon />}
                            onClick={() => choose("folder")}
                            sx={{ flex: 1 }}
                        >
                            Choose package folder
                        </Button>
                    </Box>
                    {hasGithub && (
                        <>
                            <Divider sx={{ my: 3, color: "#666", fontSize: 13 }}>or</Divider>
                            <GithubImport
                                key={githubKey}
                                disabled={blocked}
                                onNext={prepareGithub}
                            />
                        </>
                    )}
                </CardContent>
            </Card>

            {phase === "preparing" && (
                <Card variant="outlined" sx={cardSx}>
                    <CardContent sx={{ py: 5, textAlign: "center" }}>
                        <CircularProgress sx={{ mb: 2 }} />
                        <Typography sx={{ color: "#fff", overflowWrap: "anywhere" }}>
                            Checking {source?.label ?? "the package"}…
                        </Typography>
                    </CardContent>
                </Card>
            )}

            {phase === "problems" && problem && (
                <Card variant="outlined" sx={cardSx}>
                    <CardContent sx={{ p: 3 }}>
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                            <ErrorOutlineIcon sx={{ color: "#f9a825" }} />
                            <Typography variant="h6" sx={{ color: "#fff" }}>
                                This package can't be published yet
                            </Typography>
                        </Box>
                        <Typography
                            variant="body2"
                            sx={{ color: "#888", mt: 0.5, mb: 2, overflowWrap: "anywhere" }}
                        >
                            {source?.label}
                        </Typography>
                        <ErrorAlert
                            error={problem.code === "invalid_package" ? null : problem.error}
                            problems={problem.problems}
                        />
                        {problem.manifestProblem && source?.github && (
                            <Typography variant="body2" sx={{ color: "#ccc", mt: 2 }}>
                                Fix bee-package.json in the release's .bee_pack, then check again.
                            </Typography>
                        )}
                        {problem.manifestProblem && source?.path && (
                            <Box sx={{ mt: 2, p: 2, border: "1px dashed #555", borderRadius: 1 }}>
                                <Typography variant="body2" sx={{ color: "#ccc", mb: 1.5 }}>
                                    bee-package.json{" "}
                                    {manifestMissing ? "is missing" : "has problems"}. BeePM can
                                    fill it in from info.txt for you.
                                </Typography>
                                <Button
                                    variant="contained"
                                    startIcon={<AutoFixHighIcon />}
                                    onClick={() => setEditor({ path: source.path, id: Date.now() })}
                                >
                                    {manifestMissing
                                        ? "Create bee-package.json"
                                        : "Fix bee-package.json"}
                                </Button>
                            </Box>
                        )}
                        <Box sx={{ display: "flex", gap: 2, mt: 3 }}>
                            <Button variant="outlined" onClick={startOver} sx={{ flex: 1 }}>
                                Choose another
                            </Button>
                            <Button
                                variant="outlined"
                                onClick={() => check(source)}
                                sx={{ flex: 1 }}
                            >
                                Check again
                            </Button>
                        </Box>
                    </CardContent>
                </Card>
            )}

            {phase === "review" && prepared && (
                <Card variant="outlined" sx={cardSx}>
                    <CardContent sx={{ p: 3 }}>
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2.5 }}>
                            <VerifiedIcon sx={{ color: "#1db34f" }} />
                            <Typography variant="h6" sx={{ color: "#fff" }}>
                                Ready to publish
                            </Typography>
                        </Box>
                        <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
                            <Field label="Name">
                                <Box
                                    component="span"
                                    sx={{ fontFamily: "monospace", fontWeight: 600 }}
                                >
                                    {m.fullName}
                                </Box>
                            </Field>
                            <Field label="Version">
                                <Box component="span" sx={{ color: "#2eff7b", fontWeight: 600 }}>
                                    {m.version}
                                </Box>
                            </Field>
                            <Field label="Display name">{m.displayName || "Not set"}</Field>
                            <Field label="BEE2 versions">{m.compatibleWith || "Any version"}</Field>
                            <Field label="Size">{formatBytes(prepared.size)}</Field>
                            {prepared.github && (
                                <Field label="From GitHub" wide>
                                    {prepared.github.fullName} {prepared.github.tag}
                                </Field>
                            )}
                            {m.description && (
                                <Field label="Description" wide>
                                    <Box
                                        sx={{ color: "#ccc", fontSize: 14, whiteSpace: "pre-line" }}
                                    >
                                        {m.description}
                                    </Box>
                                </Field>
                            )}
                            <Field label="Dependencies" wide>
                                {Object.keys(m.dependencies).length ? (
                                    <Box
                                        sx={{
                                            display: "flex",
                                            gap: 0.75,
                                            flexWrap: "wrap",
                                            mt: 0.5,
                                        }}
                                    >
                                        {Object.entries(m.dependencies).map(([dep, range]) => (
                                            <Chip
                                                key={dep}
                                                size="small"
                                                variant="outlined"
                                                label={range === "*" ? dep : `${dep} ${range}`}
                                                sx={{ fontFamily: "monospace" }}
                                            />
                                        ))}
                                    </Box>
                                ) : (
                                    "None"
                                )}
                            </Field>
                        </Box>

                        {(prepared.skipped.length > 0 || prepared.stripped.length > 0) && (
                            <Box sx={{ mt: 2, display: "flex", flexDirection: "column", gap: 1 }}>
                                {prepared.skipped.length > 0 && (
                                    <FileDropdown
                                        title={`Left ${files(prepared.skipped.length)} out of the zip`}
                                        names={prepared.skipped}
                                    />
                                )}
                                {prepared.stripped.length > 0 && (
                                    <FileDropdown
                                        title={`Removed ${files(prepared.stripped.length)} of types packages can't include`}
                                        names={prepared.stripped}
                                    />
                                )}
                            </Box>
                        )}
                        <Box sx={{ display: "flex", gap: 2, mt: 3 }}>
                            <Button variant="outlined" onClick={startOver} sx={{ flex: 1 }}>
                                Back
                            </Button>
                            <Button
                                variant="contained"
                                onClick={() => setPhase("terms")}
                                disabled={blocked}
                                sx={{ flex: 2 }}
                            >
                                Next
                            </Button>
                        </Box>
                    </CardContent>
                </Card>
            )}

            {phase === "terms" && prepared && (
                <Card variant="outlined" sx={cardSx}>
                    <CardContent sx={{ p: 3 }}>
                        <Typography variant="h6" sx={{ color: "#fff", mb: 2 }}>
                            Terms & Info
                        </Typography>
                        <UpdateInfo prepared={prepared} watch={watch} onWatchChange={setWatch} />
                        <RulesAgreement agreed={agreed} onChange={setAgreed} />
                        {uploadError && (
                            <ErrorAlert
                                error={uploadError.error}
                                problems={uploadError.problems}
                                sx={{ mt: 2 }}
                            />
                        )}
                        <Box sx={{ display: "flex", gap: 2, mt: 3 }}>
                            <Button
                                variant="outlined"
                                onClick={() => setPhase("review")}
                                sx={{ flex: 1 }}
                            >
                                Back
                            </Button>
                            <Button
                                variant="contained"
                                startIcon={prepared.github ? <GitHubIcon /> : <CloudUploadIcon />}
                                onClick={publish}
                                disabled={blocked || !agreed}
                                sx={{ flex: 2 }}
                            >
                                {uploadError ? "Try again" : "Publish"}
                            </Button>
                        </Box>
                    </CardContent>
                </Card>
            )}

            {phase === "uploading" && (
                <Card variant="outlined" sx={cardSx}>
                    <CardContent sx={{ py: 5, px: 4, textAlign: "center" }}>
                        <Typography variant="h6" sx={{ color: "#fff", mb: 2 }}>
                            {fromGithub ? "Publishing…" : finishing ? "Finishing…" : "Uploading…"}
                        </Typography>
                        <LinearProgress
                            variant={fromGithub || finishing ? "indeterminate" : "determinate"}
                            value={
                                upload.total ? Math.min(100, (upload.sent / upload.total) * 100) : 0
                            }
                            sx={{ height: 8, borderRadius: 4, backgroundColor: "#3a3a3a" }}
                        />
                        <Typography variant="body2" sx={{ color: "#888", mt: 1.5 }}>
                            {fromGithub
                                ? "The registry is downloading and checking the release."
                                : finishing
                                  ? "The registry is checking the package."
                                  : `${formatBytes(upload.sent)} of ${formatBytes(upload.total)}`}
                        </Typography>
                    </CardContent>
                </Card>
            )}

            {phase === "done" && result && (
                <Card variant="outlined" sx={cardSx}>
                    <CardContent sx={{ py: 4, textAlign: "center" }}>
                        <CheckCircleIcon sx={{ fontSize: 64, color: "#1db34f", mb: 1 }} />
                        <Typography variant="h6" sx={{ color: "#fff" }}>
                            Published {result.name}@{result.version}
                        </Typography>
                        {result.created && (
                            <Typography variant="body2" sx={{ color: "#888", mt: 0.5 }}>
                                It's a new package in the registry.
                            </Typography>
                        )}
                        {result.watching && (
                            <Typography variant="body2" sx={{ color: "#888", mt: 0.5 }}>
                                Its new GitHub releases will be published automatically.
                            </Typography>
                        )}
                        {result.strippedFiles?.length > 0 && (
                            <Alert severity="info" sx={{ mt: 2, textAlign: "left" }}>
                                The registry left out {files(result.strippedFiles.length)} of types
                                packages can't include.
                            </Alert>
                        )}
                        <Box sx={{ display: "flex", gap: 2, mt: 3 }}>
                            <Button
                                variant="outlined"
                                onClick={() => app.openPackage(result.name)}
                                sx={{ flex: 1 }}
                            >
                                View package
                            </Button>
                            <Button variant="contained" onClick={startOver} sx={{ flex: 2 }}>
                                Publish another
                            </Button>
                        </Box>
                    </CardContent>
                </Card>
            )}

            <ManifestEditor
                target={editor}
                onClose={() => setEditor(null)}
                onSaved={() => {
                    const path = editor?.path
                    setEditor(null)
                    if (path) prepare(path)
                }}
            />
        </Box>
    )
}
