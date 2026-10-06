import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto"

export const randomId = (bytes = 16) => randomBytes(bytes).toString("base64url")

export const sha256Hex = (value) => createHash("sha256").update(value).digest("hex")

export function safeEqual(a, b) {
    const left = Buffer.from(String(a))
    const right = Buffer.from(String(b))
    return left.length === right.length && timingSafeEqual(left, right)
}

// No 0/O, 1/I/L, so the code is easy to compare by eye
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

/** A short code like "K7QD-4MXP", shown in both the app and the browser to match them up. */
export function confirmCode() {
    let code = ""
    for (let i = 0; i < 8; i++) {
        if (i === 4) code += "-"
        code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    }
    return code
}

/** A BeePM API token. The bpm_ prefix makes leaked tokens easy to spot. */
export const newApiToken = () => `bpm_${randomBytes(24).toString("base64url")}`
