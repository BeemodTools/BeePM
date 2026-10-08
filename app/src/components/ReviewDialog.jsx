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
    MenuItem,
    Radio,
    RadioGroup,
    TextField,
    Typography,
} from "@mui/material"
import { api } from "../api.js"
import { formatDate } from "../lib/format.js"
import { useApp } from "../state/context.js"
import ErrorAlert from "./ErrorAlert.jsx"

const smallChip = { height: 20, fontSize: 11 }
// Who publishes a package on BeePM: its scope ("@areng/items" -> "areng"). Shown with BeePM's
// version of a package, since any package can have that BEE2 ID first.
const publisherOf = (name) => /^@([^/]+)\//.exec(name)?.[1] ?? name
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
 * A BEE2 check to choose from (the one with reviewId, else a new one), while `active`: which copy
 * of a duplicate to keep (the newest to start with), and which of the user's own packages switch
 * to BeePM's version. apply(closeBee2) resolves to bee2:resolve's answer, or null when BEE2 is
 * open (bee2Open: it's offered to close it).
 */
function useReview(active, reviewId = null) {
    const [check, setCheck] = useState(null) // what bee2:check found, or { error }
    const [choices, setChoices] = useState({ packages: {}, items: {} })
    const [adopt, setAdopt] = useState({}) // BEE2 ID -> use BeePM's version
    const [repair, setRepair] = useState({}) // path of a package BEE2 can't load -> fix/remove/leave
    const [working, setWorking] = useState(false)
    const [bee2Open, setBee2Open] = useState(false)

    useEffect(() => {
        if (!active) return
        let cancelled = false
        setCheck(null)
        setBee2Open(false)
        api.bee2.check(reviewId ? { reviewId } : {}).then((res) => {
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
            // Fixed when it can be, else removed (to the Recycle Bin): the user can leave it
            setRepair(
                Object.fromEntries(
                    (res.damaged ?? []).map((p) => [p.path, p.fixable ? "fix" : "remove"]),
                ),
            )
        })
        return () => {
            cancelled = true
        }
    }, [active, reviewId])

    const duplicates = check?.duplicates
    const groups = duplicates ? duplicates.packages.length + duplicates.items.length : 0
    const onBeepm = check?.onBeepm ?? []
    const damaged = check?.damaged ?? []
    const loaded = Boolean(check && !check.error)

    async function apply(closeBee2 = false) {
        setWorking(true)
        const res = await api.bee2.resolve({
            reviewId: check.reviewId,
            choices,
            adopt: onBeepm.filter((p) => adopt[p.id]).map((p) => p.id),
            keep: onBeepm.filter((p) => !adopt[p.id]).map((p) => p.id),
            damaged: repair,
            closeBee2,
        })
        setWorking(false)
        if (!res.ok && res.code === "bee2_running") {
            setBee2Open(true)
            return null
        }
        return res
    }

    const pick = (kind, key) => (event) =>
        setChoices((current) => ({
            ...current,
            [kind]: { ...current[kind], [key]: event.target.value },
        }))

    return {
        check,
        duplicates,
        onBeepm,
        damaged,
        choices,
        pick,
        adopt,
        setAdopt,
        repair,
        setRepair,
        working,
        bee2Open,
        apply,
        loaded,
        // Nothing to choose: Apply isn't offered
        nothing: loaded && !groups && !onBeepm.length && !damaged.length,
    }
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`

/** What was applied, for a notice: "Deleted 1 package, fixed 1, installed @a/b@1.0.0". */
function doneText(res) {
    const made = (res.fixed ?? []).reduce((sum, f) => sum + f.created.length, 0)
    const done = [
        res.removed.length && `Deleted ${plural(res.removed.length, "package")}`,
        res.fixed?.length &&
            `fixed ${plural(res.fixed.length, "zip")} into ${plural(made, "package")}`,
        res.installed.length && `installed ${res.installed.join(", ")}`,
    ].filter(Boolean)
    if (!done.length) return null
    const text = done.join(", ")
    return `${text[0].toUpperCase()}${text.slice(1)}.`
}

/** The choices themselves; onApply(closeBee2) when BEE2 has to be closed to finish. */
function ReviewBody({ review, onApply }) {
    const { check, duplicates, onBeepm, damaged, choices, pick, adopt, setAdopt, repair } = review
    const { setRepair, working, bee2Open } = review
    return (
        <>
            {!check && (
                <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
                    <CircularProgress size={18} />
                    <Typography sx={{ color: "#aaa" }}>Checking BEE2's packages…</Typography>
                </Box>
            )}
            {check?.error && <Alert severity="error">{check.error}</Alert>}
            {review.nothing && (
                <Typography sx={{ color: "#aaa" }}>
                    Nothing to fix: no duplicates or broken packages, and none of your own packages
                    are on BeePM.
                </Typography>
            )}

            {damaged.length > 0 && (
                <Box sx={groupSx}>
                    <Typography sx={{ color: "#fff", fontWeight: 600 }}>
                        BEE2 can't load {damaged.length === 1 ? "this" : "these"}
                    </Typography>
                    <Typography variant="body2" sx={{ color: "#888" }}>
                        Fixing makes a package of each folder inside the zip. Removed files go to
                        the Recycle Bin.
                    </Typography>
                    {damaged.map((pkg) => (
                        <Box
                            key={pkg.path}
                            sx={{ display: "flex", alignItems: "center", gap: 2, py: 0.75 }}
                        >
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                                <Typography noWrap sx={{ color: "#fff", fontSize: 14 }}>
                                    {pkg.file}
                                    {pkg.managed && (
                                        <Chip
                                            label="BeePM"
                                            size="small"
                                            color="primary"
                                            variant="outlined"
                                            sx={{ ...smallChip, ml: 1 }}
                                        />
                                    )}
                                </Typography>
                                <Typography variant="body2" sx={{ color: "#888" }}>
                                    {pkg.message}
                                </Typography>
                            </Box>
                            <TextField
                                select
                                size="small"
                                value={repair[pkg.path] ?? "leave"}
                                onChange={(event) =>
                                    setRepair((current) => ({
                                        ...current,
                                        [pkg.path]: event.target.value,
                                    }))
                                }
                                sx={{ width: 130, flexShrink: 0 }}
                            >
                                {pkg.fixable && <MenuItem value="fix">Fix it</MenuItem>}
                                <MenuItem value="remove">Remove it</MenuItem>
                                <MenuItem value="leave">Leave it</MenuItem>
                            </TextField>
                        </Box>
                    ))}
                </Box>
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
                        {group.packages.map((p) => p.name ?? p.copies[0].file).join(" and ")} have{" "}
                        {group.items.length === 1 ? "an item" : `${group.items.length} items`} in
                        common
                    </Typography>
                    <Typography variant="body2" sx={{ color: "#888" }}>
                        BEE2 can't load them together. Keep:
                    </Typography>
                    <RadioGroup value={choices.items[index] ?? ""} onChange={pick("items", index)}>
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
                                        Use BeePM's {pkg.name}{" "}
                                        <Box component="span" sx={{ color: "#aaa" }}>
                                            by @{publisherOf(pkg.package)}
                                        </Box>
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
                            onClick={() => onApply(true)}
                        >
                            Close BEE2
                        </Button>
                    }
                >
                    BEE2 is open. Save your work in it, then close it to finish.
                </Alert>
            )}
        </>
    )
}

/** Cancel (or Close, with nothing to choose) and Apply. */
function ReviewButtons({ review, onCancel, onApply }) {
    const offer = review.loaded && !review.nothing
    return (
        <>
            <Button onClick={onCancel} disabled={review.working}>
                {offer ? "Cancel" : "Close"}
            </Button>
            {offer && (
                <Button
                    variant="contained"
                    onClick={() => onApply(false)}
                    disabled={review.working}
                >
                    {review.working ? <CircularProgress size={18} color="inherit" /> : "Apply"}
                </Button>
            )}
        </>
    )
}

/** The BEE2 check in BeePM's window (Settings > Check packages): looked at again each time. */
export default function ReviewDialog() {
    const { reviewOpen, closeReview, notify, refreshInstalled } = useApp()
    const review = useReview(reviewOpen)

    async function apply(closeBee2) {
        const res = await review.apply(closeBee2)
        if (!res) return
        if (!res.ok) return notify(res.error, "error")
        await refreshInstalled()
        closeReview()
        const text = doneText(res)
        if (text) notify(`${text} Restart BEE2 to load the changes.`, "success")
    }

    return (
        <Dialog
            open={reviewOpen}
            onClose={review.working ? undefined : closeReview}
            maxWidth="sm"
            fullWidth
        >
            <DialogTitle>BEE2's packages</DialogTitle>
            <DialogContent dividers>
                <ReviewBody review={review} onApply={apply} />
            </DialogContent>
            <DialogActions>
                <ReviewButtons review={review} onCancel={closeReview} onApply={apply} />
            </DialogActions>
        </Dialog>
    )
}

/**
 * The corner window's "Choose", in a window of its own (backend/main.js showReview): the check
 * that was just made, not a new one. It closes once the choices are applied.
 */
export function ReviewWindow({ reviewId }) {
    const review = useReview(true, reviewId)
    const [error, setError] = useState(null)

    async function apply(closeBee2) {
        setError(null)
        const res = await review.apply(closeBee2)
        if (!res) return
        if (!res.ok) return setError(res.error)
        window.close()
    }

    return (
        <Box
            sx={{
                height: "100vh",
                display: "flex",
                flexDirection: "column",
                backgroundColor: "#262829",
            }}
        >
            <Box sx={{ flex: 1, overflowY: "auto", px: 3, pt: 2.5, pb: 1 }}>
                <ReviewBody review={review} onApply={apply} />
                {error && <ErrorAlert error={error} sx={{ mt: 1.5 }} />}
            </Box>
            <Box
                sx={{
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 1,
                    px: 3,
                    py: 1.5,
                    borderTop: "1px solid #3a3a3a",
                }}
            >
                <ReviewButtons review={review} onCancel={() => window.close()} onApply={apply} />
            </Box>
        </Box>
    )
}
