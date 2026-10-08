import { useEffect, useState } from "react"
import {
    Alert,
    Box,
    Button,
    Checkbox,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    Radio,
    RadioGroup,
    Typography,
} from "@mui/material"
import { api } from "../api.js"
import { formatDate } from "../lib/format.js"
import { useApp } from "../state/context.js"

const smallChip = { height: 20, fontSize: 11 }
const groupSx = { mb: 2 }
const optionSx = { mr: 0, alignItems: "flex-start", "& .MuiRadio-root": { pt: 0.75 } }

/** A copy of a package: its name, where it is in BEE2's packages folder, when it changed. */
function CopyLabel({ copy, name = copy.name }) {
    return (
        <Box sx={{ minWidth: 0, py: 0.5 }}>
            <Typography noWrap sx={{ color: "#fff", fontSize: 14 }}>
                {name ?? copy.file}
                {copy.managed && (
                    <Chip
                        label="BeePM"
                        size="small"
                        color="primary"
                        variant="outlined"
                        sx={{ ...smallChip, ml: 1 }}
                    />
                )}
            </Typography>
            <Typography variant="body2" noWrap sx={{ color: "#888" }}>
                {copy.file}
                {copy.modified ? ` · ${formatDate(copy.modified)}` : ""}
            </Typography>
        </Box>
    )
}

/**
 * The BEE2 check in BeePM's window (the corner window's "Choose", or Settings > Check packages):
 * which copy of a duplicate to keep (the newest is picked to start with), and which of the
 * user's own packages switch to BeePM's version.
 */
export default function ReviewDialog() {
    const { reviewOpen, closeReview, notify, refreshInstalled } = useApp()
    const [check, setCheck] = useState(null) // what bee2:check found, or { error }
    const [choices, setChoices] = useState({ packages: {}, items: {} })
    const [adopt, setAdopt] = useState({}) // BEE2 ID -> use BeePM's version
    const [working, setWorking] = useState(false)
    const [bee2Open, setBee2Open] = useState(false)

    useEffect(() => {
        if (!reviewOpen) return
        let cancelled = false
        setCheck(null)
        setBee2Open(false)
        api.bee2.check().then((res) => {
            if (cancelled) return
            if (!res.ok) return setCheck({ error: res.error })
            setCheck(res)
            setChoices({
                packages: Object.fromEntries(
                    res.duplicates.packages.map((g) => [g.id, g.copies[0].path]),
                ),
                items: Object.fromEntries(
                    res.duplicates.items.map((g, i) => [i, g.packages[0].id]),
                ),
            })
            setAdopt(Object.fromEntries(res.onBeepm.map((p) => [p.id, true])))
        })
        return () => {
            cancelled = true
        }
    }, [reviewOpen])

    const duplicates = check?.duplicates
    const groups = duplicates ? duplicates.packages.length + duplicates.items.length : 0
    const onBeepm = check?.onBeepm ?? []
    const loaded = Boolean(check && !check.error)
    const nothing = loaded && !groups && !onBeepm.length

    async function apply(closeBee2 = false) {
        setWorking(true)
        const res = await api.bee2.resolve({
            reviewId: check.reviewId,
            choices,
            adopt: onBeepm.filter((p) => adopt[p.id]).map((p) => p.id),
            keep: onBeepm.filter((p) => !adopt[p.id]).map((p) => p.id),
            closeBee2,
        })
        setWorking(false)
        if (!res.ok) {
            if (res.code === "bee2_running") return setBee2Open(true)
            return notify(res.error, "error")
        }
        await refreshInstalled()
        closeReview()
        const done = [
            res.removed.length &&
                `Deleted ${res.removed.length} duplicate${res.removed.length === 1 ? "" : "s"}`,
            res.installed.length && `installed ${res.installed.join(", ")}`,
        ].filter(Boolean)
        if (done.length) {
            const text = done.join(", ")
            notify(
                `${text[0].toUpperCase()}${text.slice(1)}. Restart BEE2 to load the changes.`,
                "success",
            )
        }
    }

    const pick = (kind, key) => (event) =>
        setChoices((current) => ({
            ...current,
            [kind]: { ...current[kind], [key]: event.target.value },
        }))

    return (
        <Dialog
            open={reviewOpen}
            onClose={working ? undefined : closeReview}
            maxWidth="sm"
            fullWidth
        >
            <DialogTitle>BEE2's packages</DialogTitle>
            <DialogContent dividers>
                {!check && (
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
                        <CircularProgress size={18} />
                        <Typography sx={{ color: "#aaa" }}>Checking BEE2's packages…</Typography>
                    </Box>
                )}
                {check?.error && <Alert severity="error">{check.error}</Alert>}
                {nothing && (
                    <Typography sx={{ color: "#aaa" }}>
                        No duplicates, and none of your own packages are on BeePM.
                    </Typography>
                )}
                {check?.offline && (
                    <Alert severity="warning" sx={{ mt: 1 }}>
                        BeePM can't be reached, so your packages weren't looked up on it.
                    </Alert>
                )}

                {duplicates?.packages.map((group) => (
                    <Box key={group.id} sx={groupSx}>
                        <Typography sx={{ color: "#fff", fontWeight: 600 }}>
                            {group.name ?? group.copies[0].file} is in BEE2{" "}
                            {group.copies.length === 2 ? "twice" : `${group.copies.length} times`}
                        </Typography>
                        <Typography variant="body2" sx={{ color: "#888" }}>
                            Keep:
                        </Typography>
                        <RadioGroup
                            value={choices.packages[group.id] ?? ""}
                            onChange={pick("packages", group.id)}
                        >
                            {group.copies.map((copy) => (
                                <FormControlLabel
                                    key={copy.path}
                                    value={copy.path}
                                    control={<Radio size="small" />}
                                    label={<CopyLabel copy={copy} />}
                                    sx={optionSx}
                                />
                            ))}
                        </RadioGroup>
                    </Box>
                ))}
                {duplicates?.items.map((group, index) => (
                    <Box key={group.packages.map((p) => p.id).join("|")} sx={groupSx}>
                        <Typography sx={{ color: "#fff", fontWeight: 600 }}>
                            {group.packages.map((p) => p.name ?? p.copies[0].file).join(" and ")}{" "}
                            have{" "}
                            {group.items.length === 1 ? "an item" : `${group.items.length} items`}{" "}
                            in common
                        </Typography>
                        <Typography variant="body2" sx={{ color: "#888" }}>
                            BEE2 can't load them together. Keep:
                        </Typography>
                        <RadioGroup
                            value={choices.items[index] ?? ""}
                            onChange={pick("items", index)}
                        >
                            {group.packages.map((pkg) => (
                                <FormControlLabel
                                    key={pkg.id}
                                    value={pkg.id}
                                    control={<Radio size="small" />}
                                    label={<CopyLabel copy={pkg.copies[0]} name={pkg.name} />}
                                    sx={optionSx}
                                />
                            ))}
                        </RadioGroup>
                    </Box>
                ))}

                {onBeepm.length > 0 && (
                    <Box sx={groupSx}>
                        <Typography sx={{ color: "#fff", fontWeight: 600 }}>On BeePM</Typography>
                        <Typography variant="body2" sx={{ color: "#888" }}>
                            BeePM's versions get updates. Yours go to BeePM's backups.
                        </Typography>
                        {onBeepm.map((pkg) => (
                            <FormControlLabel
                                key={pkg.id}
                                sx={{ ...optionSx, display: "flex" }}
                                control={
                                    <Checkbox
                                        size="small"
                                        checked={Boolean(adopt[pkg.id])}
                                        onChange={(event) =>
                                            setAdopt((current) => ({
                                                ...current,
                                                [pkg.id]: event.target.checked,
                                            }))
                                        }
                                    />
                                }
                                label={
                                    <Box sx={{ minWidth: 0, py: 0.5 }}>
                                        <Typography noWrap sx={{ color: "#fff", fontSize: 14 }}>
                                            Use BeePM's {pkg.name}
                                        </Typography>
                                        <Typography variant="body2" noWrap sx={{ color: "#888" }}>
                                            {pkg.package} · yours: {pkg.file}
                                        </Typography>
                                    </Box>
                                }
                            />
                        ))}
                    </Box>
                )}

                {bee2Open && (
                    <Alert
                        severity="warning"
                        action={
                            <Button
                                color="inherit"
                                size="small"
                                disabled={working}
                                onClick={() => apply(true)}
                            >
                                Close BEE2
                            </Button>
                        }
                    >
                        BEE2 is open. Save your work in it, then close it to finish.
                    </Alert>
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={closeReview} disabled={working}>
                    {loaded && !nothing ? "Cancel" : "Close"}
                </Button>
                {loaded && !nothing && (
                    <Button variant="contained" onClick={() => apply(false)} disabled={working}>
                        {working ? <CircularProgress size={18} color="inherit" /> : "Apply"}
                    </Button>
                )}
            </DialogActions>
        </Dialog>
    )
}
