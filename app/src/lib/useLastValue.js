import { useState } from "react"

/**
 * The value, or the last one that wasn't null. Dialogs use it to keep showing their content
 * while they fade out after the value is cleared.
 */
export function useLastValue(value) {
    const [last, setLast] = useState(value)
    if (value != null && value !== last) setLast(value)
    return value ?? last
}
