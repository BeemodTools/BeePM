import { useEffect, useMemo, useState } from "react"
import {
    Alert,
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    TextField,
    Typography,
} from "@mui/material"
import AddIcon from "@mui/icons-material/Add"
import CloseIcon from "@mui/icons-material/Close"
import { validateManifest } from "@beepm/core/manifest"
import { api } from "../api.js"
import { isNewer } from "../lib/format.js"
import { useLastValue } from "../lib/useLastValue.js"
import { useApp } from "../state/context.js"
import ErrorAlert from "./ErrorAlert.jsx"

const text = (value) => (typeof value === "string" ? value : "")

/**
 * The form's starting values: the suggestion from info.txt with the current file's values on
 * top, corrected where they can't be published: a package already published with this BEE2 ID
 * keeps its name and gets a new version, and anything else goes under your own handle.
 */
function initialForm(suggested, existing, published, handle) {
    const merged = { ...suggested, ...(existing ?? {}) }
    let name = text(merged.name)
    if (name && !name.startsWith("@") && existing?.author)
        name = `@${String(existing.author).toLowerCase()}/${name}`
    if (published) name = published.name
    else if (handle && name.startsWith("@") && !name.startsWith(`@${handle}/`))
        name = `@${handle}/${name.slice(name.indexOf("/") + 1)}`
    let version = text(merged.version) || "1.0.0"
    if (published?.latest && !isNewer(version, published.latest)) version = suggested.version
    const compat = Array.isArray(merged.compatibleWith)
        ? merged.compatibleWith.join(" || ")
        : text(merged.compatibleWith)
    const deps =
        merged.dependencies &&
        typeof merged.dependencies === "object" &&
        !Array.isArray(merged.dependencies)
            ? Object.entries(merged.dependencies).map(([dep, range]) => ({
                  name: dep,
                  range: text(range) || "*",
              }))
            : []
    return {
        name,
        version,
        display_name: text(merged.display_name),
        description: text(merged.description),
        compatibleWith: compat,
        dependencies: deps,
    }
}

/** bee-package.json from the form, leaving out empty optional fields. */
function buildManifest(form) {
    const manifest = { name: form.name.trim(), version: form.version.trim() }
    if (form.display_name.trim()) manifest.display_name = form.display_name.trim()
    if (form.description.trim()) manifest.description = form.description.trim()
    if (form.compatibleWith.trim()) manifest.compatibleWith = form.compatibleWith.trim()
    const deps = form.dependencies.filter((dep) => dep.name.trim())
    if (deps.length) {
        manifest.dependencies = Object.fromEntries(
            deps.map((dep) => [dep.name.trim(), dep.range.trim() || "*"]),
        )
    }
    return manifest
}

function EditorBody({ target, onClose, onSaved }) {
    const { auth, notify } = useApp()
    const handle = auth.loggedIn ? auth.user?.handle : null
    const [loaded, setLoaded] = useState({
        loading: true,
        error: null,
        isFolder: false,
        hadFile: false,
    })
    const [form, setForm] = useState(null)
    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState(null)

    useEffect(() => {
        let cancelled = false
        api.publish.suggestManifest(target).then((res) => {
            if (cancelled) return
            if (!res.ok)
                return setLoaded({ loading: false, error: res, isFolder: false, hadFile: false })
            setForm(initialForm(res.manifest, res.existing, res.published, handle))
            setLoaded({
                loading: false,
                error: null,
                isFolder: res.isFolder,
                hadFile: Boolean(res.existingText),
            })
        })
        return () => {
            cancelled = true
        }
    }, [target, handle])

    const manifest = useMemo(() => (form ? buildManifest(form) : null), [form])
    const json = manifest ? JSON.stringify(manifest, null, 4) + "\n" : ""
    // The same checks the registry runs
    const problems = useMemo(() => {
        if (!manifest) return []
        try {
            const valid = validateManifest(manifest, { defaultScope: handle })
            // New packages can only go under your own handle
            if (handle && valid.scope !== handle) {
                return [`Use your handle: @${handle}/${valid.name} (or just ${valid.name}).`]
            }
            return []
        } catch (err) {
            return err.problems ?? [err.message]
        }
    }, [manifest, handle])

    const set = (field) => (event) =>
        setForm((current) => ({ ...current, [field]: event.target.value }))
    const setDep = (index, field) => (event) =>
        setForm((current) => ({
            ...current,
            dependencies: current.dependencies.map((dep, i) =>
                i === index ? { ...dep, [field]: event.target.value } : dep,
            ),
        }))
    const addDep = () =>
        setForm((current) => ({
            ...current,
            dependencies: [...current.dependencies, { name: "", range: "*" }],
        }))
    const removeDep = (index) =>
        setForm((current) => ({
            ...current,
            dependencies: current.dependencies.filter((_dep, i) => i !== index),
        }))

    async function save() {
        setSaving(true)
        setSaveError(null)
        const res = await api.publish.writeManifest(target, manifest)
        setSaving(false)
        if (!res.ok) return setSaveError(res)
        notify(
            res.insidePack
                ? `Saved bee-package.json inside ${res.file.split(/[\\/]/).pop()}`
                : `Saved ${res.file}`,
            "success",
        )
        onSaved()
    }

    return (
        <>
            <DialogTitle>
                {loaded.hadFile ? "Fix bee-package.json" : "Create bee-package.json"}
            </DialogTitle>
            <DialogContent>
                {loaded.loading && (
                    <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                        <CircularProgress />
                    </Box>
                )}
                {loaded.error && (
                    <ErrorAlert error={loaded.error.error} problems={loaded.error.problems} />
                )}
                {form && (
                    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <Box sx={{ display: "flex", gap: 2 }}>
                            <TextField
                                label="Name"
                                size="small"
                                value={form.name}
                                onChange={set("name")}
                                helperText={`@${handle ?? "your-handle"}/name: lowercase letters, digits, - _ .`}
                                sx={{ flex: 2 }}
                            />
                            <TextField
                                label="Version"
                                size="small"
                                value={form.version}
                                onChange={set("version")}
                                helperText="Like 1.0.0"
                                sx={{ flex: 1 }}
                            />
                        </Box>
                        <TextField
                            label="Display name"
                            size="small"
                            value={form.display_name}
                            onChange={set("display_name")}
                        />
                        <TextField
                            label="Description"
                            size="small"
                            multiline
                            minRows={2}
                            value={form.description}
                            onChange={set("description")}
                        />
                        <TextField
                            label="BEE2 versions"
                            size="small"
                            value={form.compatibleWith}
                            onChange={set("compatibleWith")}
                            helperText="A range like >=2.4.46. Leave it empty if it works with any version."
                        />
                        <Box>
                            <Typography variant="subtitle2" sx={{ mb: 1 }}>
                                Dependencies
                            </Typography>
                            {form.dependencies.map((dep, index) => (
                                <Box key={index} sx={{ display: "flex", gap: 1, mb: 1 }}>
                                    <TextField
                                        size="small"
                                        placeholder="@scope/name"
                                        value={dep.name}
                                        onChange={setDep(index, "name")}
                                        sx={{ flex: 2 }}
                                    />
                                    <TextField
                                        size="small"
                                        placeholder="*"
                                        value={dep.range}
                                        onChange={setDep(index, "range")}
                                        sx={{ flex: 1 }}
                                    />
                                    <IconButton
                                        aria-label="Remove dependency"
                                        onClick={() => removeDep(index)}
                                    >
                                        <CloseIcon fontSize="small" />
                                    </IconButton>
                                </Box>
                            ))}
                            <Button size="small" startIcon={<AddIcon />} onClick={addDep}>
                                Add dependency
                            </Button>
                            <Typography variant="body2" sx={{ color: "#777", mt: 0.5 }}>
                                BEE2's own packages are @beemod/&lt;ID&gt;, e.g.
                                @beemod/BEE2_CLEAN_STYLE.
                            </Typography>
                        </Box>

                        {problems.length > 0 && (
                            <ErrorAlert severity="warning" problems={problems} />
                        )}

                        <Box>
                            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                                bee-package.json
                            </Typography>
                            <Box
                                component="pre"
                                sx={{
                                    m: 0,
                                    p: 1.5,
                                    backgroundColor: "#0d0e0f",
                                    borderRadius: 1,
                                    fontSize: 12,
                                    color: "#2eff7b",
                                    overflow: "auto",
                                    maxHeight: 220,
                                }}
                            >
                                {json}
                            </Box>
                        </Box>

                        {loaded.isFolder ? (
                            loaded.hadFile && (
                                <Alert severity="info">
                                    This replaces the bee-package.json in the folder.
                                </Alert>
                            )
                        ) : (
                            <Alert severity="info">
                                {loaded.hadFile
                                    ? "This replaces the bee-package.json inside the .bee_pack."
                                    : "BeePM saves this as bee-package.json inside the .bee_pack."}{" "}
                                Everything else in the file stays exactly the same.
                            </Alert>
                        )}
                        {saveError && (
                            <ErrorAlert error={saveError.error} problems={saveError.problems} />
                        )}
                    </Box>
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Cancel</Button>
                {form && (
                    <Button
                        variant="contained"
                        onClick={save}
                        disabled={saving || problems.length > 0}
                    >
                        {saving ? "Saving…" : "Save and check again"}
                    </Button>
                )}
            </DialogActions>
        </>
    )
}

/**
 * Creates or fixes bee-package.json for target.path: written into a folder, or added inside a
 * .bee_pack (the zip's other files are kept byte for byte).
 * target: { path, id } (a new id starts over). onSaved: check the package again.
 */
export default function ManifestEditor({ target, onClose, onSaved }) {
    const shown = useLastValue(target)
    return (
        <Dialog open={Boolean(target)} onClose={onClose} maxWidth="md" fullWidth>
            {shown && (
                <EditorBody
                    key={shown.id}
                    target={shown.path}
                    onClose={onClose}
                    onSaved={onSaved}
                />
            )}
        </Dialog>
    )
}
