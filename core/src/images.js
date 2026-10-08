import zlib from "node:zlib"
import jpeg from "jpeg-js"
import { PNG } from "pngjs"

/**
 * Small icons of what's in packages (contents.js): PNG, JPEG or VTF (Source's texture format,
 * which BEE2 also reads) shrunk to a PNG thumbnail. The VTF decoder and PNG encoder are ported
 * from BeePEE (backend/utils/vmfConverter/textures.js).
 */

export const THUMBNAIL_SIZE = 128
// A small enough PNG is kept as it is
const KEEP_BYTES = 64 * 1024
// Bigger images aren't decoded: a few bytes can claim to be huge
const MAX_SIDE = 4096
const MAX_JPEG_MEGAPIXELS = 17

// ---------- VTF ----------

const FORMAT = {
    RGBA8888: 0,
    ABGR8888: 1,
    RGB888: 2,
    BGR888: 3,
    RGB565: 4,
    I8: 5,
    IA88: 6,
    P8: 7,
    A8: 8,
    RGB888_BLUESCREEN: 9,
    BGR888_BLUESCREEN: 10,
    ARGB8888: 11,
    BGRA8888: 12,
    DXT1: 13,
    DXT3: 14,
    DXT5: 15,
    BGRX8888: 16,
    BGR565: 17,
    BGRX5551: 18,
    BGRA4444: 19,
    DXT1_ONEBITALPHA: 20,
    BGRA5551: 21,
    UV88: 22,
    UVWQ8888: 23,
    RGBA16161616F: 24,
    RGBA16161616: 25,
    UVLX8888: 26,
    R32F: 27,
    RGB323232F: 28,
    RGBA32323232F: 29,
}

const BYTES_PER_PIXEL = {
    [FORMAT.RGBA8888]: 4,
    [FORMAT.ABGR8888]: 4,
    [FORMAT.RGB888]: 3,
    [FORMAT.BGR888]: 3,
    [FORMAT.RGB565]: 2,
    [FORMAT.I8]: 1,
    [FORMAT.IA88]: 2,
    [FORMAT.P8]: 1,
    [FORMAT.A8]: 1,
    [FORMAT.RGB888_BLUESCREEN]: 3,
    [FORMAT.BGR888_BLUESCREEN]: 3,
    [FORMAT.ARGB8888]: 4,
    [FORMAT.BGRA8888]: 4,
    [FORMAT.BGRX8888]: 4,
    [FORMAT.BGR565]: 2,
    [FORMAT.BGRX5551]: 2,
    [FORMAT.BGRA4444]: 2,
    [FORMAT.BGRA5551]: 2,
    [FORMAT.UV88]: 2,
    [FORMAT.UVWQ8888]: 4,
    [FORMAT.RGBA16161616F]: 8,
    [FORMAT.RGBA16161616]: 8,
    [FORMAT.UVLX8888]: 4,
    [FORMAT.R32F]: 4,
    [FORMAT.RGB323232F]: 12,
    [FORMAT.RGBA32323232F]: 16,
}

const isDxt1 = (format) => format === FORMAT.DXT1 || format === FORMAT.DXT1_ONEBITALPHA
const isDxt = (format) => isDxt1(format) || format === FORMAT.DXT3 || format === FORMAT.DXT5

function imageSize(format, width, height) {
    if (isDxt(format)) {
        const blocks = Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4))
        return blocks * (isDxt1(format) ? 8 : 16)
    }
    const bpp = BYTES_PER_PIXEL[format]
    if (!bpp) throw new Error(`Unsupported VTF image format ${format}`)
    return width * height * bpp
}

function expand565(c) {
    const r = (c >> 11) & 31
    const g = (c >> 5) & 63
    const b = c & 31
    return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)]
}

function decodeDxt(data, offset, width, height, format) {
    const out = Buffer.alloc(width * height * 4)
    const blocksX = Math.max(1, Math.ceil(width / 4))
    const blocksY = Math.max(1, Math.ceil(height / 4))
    const blockSize = isDxt1(format) ? 8 : 16
    const colors = new Uint8Array(16)
    const alphas = new Uint8Array(16)
    let p = offset

    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            const colorOffset = isDxt1(format) ? p : p + 8
            const c0 = data.readUInt16LE(colorOffset)
            const c1 = data.readUInt16LE(colorOffset + 2)
            const bits = data.readUInt32LE(colorOffset + 4)
            const a = expand565(c0)
            const b = expand565(c1)
            colors.set([a[0], a[1], a[2], 255, b[0], b[1], b[2], 255])
            if (!isDxt1(format) || c0 > c1) {
                for (let i = 0; i < 3; i++) {
                    colors[8 + i] = ((2 * a[i] + b[i] + 1) / 3) | 0
                    colors[12 + i] = ((a[i] + 2 * b[i] + 1) / 3) | 0
                }
                colors[11] = 255
                colors[15] = 255
            } else {
                for (let i = 0; i < 3; i++) {
                    colors[8 + i] = ((a[i] + b[i]) / 2) | 0
                    colors[12 + i] = 0
                }
                colors[11] = 255
                colors[15] = 0
            }

            if (format === FORMAT.DXT3) {
                for (let i = 0; i < 16; i++) {
                    const byte = data[p + (i >> 1)]
                    alphas[i] = ((i & 1 ? byte >> 4 : byte) & 15) * 17
                }
            } else if (format === FORMAT.DXT5) {
                const a0 = data[p]
                const a1 = data[p + 1]
                const table = [a0, a1]
                if (a0 > a1) {
                    for (let i = 1; i <= 6; i++) table.push((((7 - i) * a0 + i * a1) / 7) | 0)
                } else {
                    for (let i = 1; i <= 4; i++) table.push((((5 - i) * a0 + i * a1) / 5) | 0)
                    table.push(0, 255)
                }
                const lo = data[p + 2] | (data[p + 3] << 8) | (data[p + 4] << 16)
                const hi = data[p + 5] | (data[p + 6] << 8) | (data[p + 7] << 16)
                for (let i = 0; i < 16; i++) {
                    const index = i < 8 ? (lo >> (3 * i)) & 7 : (hi >> (3 * (i - 8))) & 7
                    alphas[i] = table[index]
                }
            }

            for (let py = 0; py < 4; py++) {
                const y = by * 4 + py
                if (y >= height) break
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px
                    if (x >= width) break
                    const i = py * 4 + px
                    const index = (bits >>> (2 * i)) & 3
                    const o = (y * width + x) * 4
                    out[o] = colors[index * 4]
                    out[o + 1] = colors[index * 4 + 1]
                    out[o + 2] = colors[index * 4 + 2]
                    out[o + 3] = isDxt1(format) ? colors[index * 4 + 3] : alphas[i]
                }
            }
            p += blockSize
        }
    }
    return out
}

function halfToFloat(h) {
    const exponent = (h >> 10) & 31
    const mantissa = h & 1023
    const sign = h & 32768 ? -1 : 1
    if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024)
    if (exponent === 31) return mantissa ? NaN : sign * Infinity
    return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024)
}

const toByte = (f) => (Number.isNaN(f) ? 0 : Math.max(0, Math.min(255, Math.round(f * 255))))

function decodeUncompressed(data, offset, width, height, format) {
    const out = Buffer.alloc(width * height * 4)
    const bpp = BYTES_PER_PIXEL[format]
    for (let i = 0; i < width * height; i++) {
        const s = offset + i * bpp
        const o = i * 4
        let r = 0
        let g = 0
        let b = 0
        let a = 255
        switch (format) {
            case FORMAT.RGBA8888:
            case FORMAT.UVWQ8888:
                r = data[s]
                g = data[s + 1]
                b = data[s + 2]
                a = data[s + 3]
                break
            case FORMAT.ABGR8888:
                a = data[s]
                b = data[s + 1]
                g = data[s + 2]
                r = data[s + 3]
                break
            case FORMAT.ARGB8888:
                a = data[s]
                r = data[s + 1]
                g = data[s + 2]
                b = data[s + 3]
                break
            case FORMAT.BGRA8888:
                b = data[s]
                g = data[s + 1]
                r = data[s + 2]
                a = data[s + 3]
                break
            case FORMAT.BGRX8888:
                b = data[s]
                g = data[s + 1]
                r = data[s + 2]
                break
            case FORMAT.UVLX8888:
                r = data[s]
                g = data[s + 1]
                b = data[s + 2]
                break
            case FORMAT.RGB888:
            case FORMAT.RGB888_BLUESCREEN:
                r = data[s]
                g = data[s + 1]
                b = data[s + 2]
                break
            case FORMAT.BGR888:
            case FORMAT.BGR888_BLUESCREEN:
                b = data[s]
                g = data[s + 1]
                r = data[s + 2]
                break
            case FORMAT.RGB565:
            case FORMAT.BGR565: {
                const v = data.readUInt16LE(s)
                const low = ((v & 31) << 3) | ((v & 31) >> 2)
                const mid = (((v >> 5) & 63) << 2) | (((v >> 5) & 63) >> 4)
                const high = (((v >> 11) & 31) << 3) | (((v >> 11) & 31) >> 2)
                g = mid
                if (format === FORMAT.RGB565) {
                    r = low
                    b = high
                } else {
                    b = low
                    r = high
                }
                break
            }
            case FORMAT.BGRA5551:
            case FORMAT.BGRX5551: {
                const v = data.readUInt16LE(s)
                const ch = (shift) => (((v >> shift) & 31) << 3) | (((v >> shift) & 31) >> 2)
                b = ch(0)
                g = ch(5)
                r = ch(10)
                if (format === FORMAT.BGRA5551) a = v & 32768 ? 255 : 0
                break
            }
            case FORMAT.BGRA4444: {
                const v = data.readUInt16LE(s)
                b = (v & 15) * 17
                g = ((v >> 4) & 15) * 17
                r = ((v >> 8) & 15) * 17
                a = ((v >> 12) & 15) * 17
                break
            }
            case FORMAT.I8:
                r = g = b = data[s]
                break
            case FORMAT.IA88:
                r = g = b = data[s]
                a = data[s + 1]
                break
            case FORMAT.A8:
                a = data[s]
                break
            case FORMAT.UV88:
                r = data[s]
                g = data[s + 1]
                break
            case FORMAT.RGBA16161616F:
                r = toByte(halfToFloat(data.readUInt16LE(s)))
                g = toByte(halfToFloat(data.readUInt16LE(s + 2)))
                b = toByte(halfToFloat(data.readUInt16LE(s + 4)))
                a = toByte(halfToFloat(data.readUInt16LE(s + 6)))
                break
            case FORMAT.RGBA16161616:
                r = data.readUInt16LE(s) >> 8
                g = data.readUInt16LE(s + 2) >> 8
                b = data.readUInt16LE(s + 4) >> 8
                a = data.readUInt16LE(s + 6) >> 8
                break
            case FORMAT.R32F:
                r = g = b = toByte(data.readFloatLE(s))
                break
            case FORMAT.RGB323232F:
                r = toByte(data.readFloatLE(s))
                g = toByte(data.readFloatLE(s + 4))
                b = toByte(data.readFloatLE(s + 8))
                break
            case FORMAT.RGBA32323232F:
                r = toByte(data.readFloatLE(s))
                g = toByte(data.readFloatLE(s + 4))
                b = toByte(data.readFloatLE(s + 8))
                a = toByte(data.readFloatLE(s + 12))
                break
            default:
                throw new Error(`Unsupported VTF image format ${format}`)
        }
        if (
            (format === FORMAT.RGB888_BLUESCREEN || format === FORMAT.BGR888_BLUESCREEN) &&
            r === 0 &&
            g === 0 &&
            b === 255
        ) {
            a = 0
        }
        out[o] = r
        out[o + 1] = g
        out[o + 2] = b
        out[o + 3] = a
    }
    return out
}

/**
 * Decodes the first frame of a VTF: { width, height, rgba }. Mipmaps are smaller copies, so it
 * reads the smallest one that's still at least minSide wide or tall (the full size by default).
 */
export function decodeVtf(data, { minSide = Infinity } = {}) {
    if (data.length < 64 || data.toString("latin1", 0, 4) !== "VTF\0") {
        throw new Error("Not a VTF file")
    }
    const width = data.readUInt16LE(16)
    const height = data.readUInt16LE(18)
    const major = data.readUInt32LE(4)
    const minor = data.readUInt32LE(8)
    if (major !== 7) throw new Error(`Unsupported VTF version ${major}.${minor}`)
    if (!width || !height || width > MAX_SIDE * 4 || height > MAX_SIDE * 4) {
        throw new Error("The VTF's size isn't usable")
    }
    const headerSize = data.readUInt32LE(12)
    const flags = data.readUInt32LE(20)
    const frames = Math.max(1, data.readUInt16LE(24))
    const firstFrame = data.readUInt16LE(26)
    const format = data.readInt32LE(52)
    const mipCount = Math.max(1, data[56])
    const lowFormat = data.readInt32LE(57)
    const lowWidth = data[61]
    const lowHeight = data[62]
    const depth = minor >= 2 ? Math.max(1, data.readUInt16LE(63)) : 1

    const ENVMAP = 0x4000
    let faces = 1
    if (flags & ENVMAP) faces = minor < 5 && firstFrame !== 0xffff ? 7 : 6

    let offset
    if (minor >= 3) {
        const resourceCount = data.readUInt32LE(68)
        offset = -1
        for (let i = 0; i < resourceCount && 80 + i * 8 + 8 <= data.length; i++) {
            const at = 80 + i * 8
            const tag = data.toString("latin1", at, at + 3)
            if (tag === "AXC") throw new Error("Compressed (Strata) VTFs aren't supported")
            if (tag === "\x30\0\0") offset = data.readUInt32LE(at + 4)
        }
        if (offset === -1) throw new Error("The VTF has no high-resolution image")
    } else {
        offset = headerSize
        if (lowFormat !== -1 && lowWidth && lowHeight) {
            offset += imageSize(lowFormat, lowWidth, lowHeight)
        }
    }

    // Mipmaps are stored smallest first, the full size last
    let level = 0
    while (
        level + 1 < mipCount &&
        Math.max(width >> (level + 1), height >> (level + 1)) >= Math.min(minSide, MAX_SIDE)
    ) {
        level++
    }
    for (let mip = mipCount - 1; mip > level; mip--) {
        const w = Math.max(1, width >> mip)
        const h = Math.max(1, height >> mip)
        const d = Math.max(1, depth >> mip)
        offset += imageSize(format, w, h) * frames * faces * d
    }
    const w = Math.max(1, width >> level)
    const h = Math.max(1, height >> level)
    if (w > MAX_SIDE || h > MAX_SIDE) throw new Error("The VTF is too big to read")
    if (offset + imageSize(format, w, h) > data.length) {
        throw new Error("The VTF's image data is cut short")
    }
    const rgba = isDxt(format)
        ? decodeDxt(data, offset, w, h, format)
        : decodeUncompressed(data, offset, w, h, format)
    return { width: w, height: h, rgba }
}

// ---------- PNG ----------

const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        table[n] = c >>> 0
    }
    return table
})()

function crc32(buffer) {
    let c = 0xffffffff
    for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
}

/** RGBA pixels as a PNG (with its alpha channel). */
export function encodePng(width, height, rgba) {
    const stride = width * 4 + 1
    const raw = Buffer.alloc(stride * height)
    for (let y = 0; y < height; y++) {
        Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
            raw,
            y * stride + 1,
        )
    }
    const header = Buffer.alloc(13)
    header.writeUInt32BE(width, 0)
    header.writeUInt32BE(height, 4)
    header[8] = 8 // bit depth
    header[9] = 6 // RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", zlib.deflateSync(raw)),
        pngChunk("IEND", Buffer.alloc(0)),
    ])
}

/** A PNG's size from its header, or null if it isn't one. */
function pngSize(data) {
    if (
        data.length < 24 ||
        data.readUInt32BE(0) !== 0x89504e47 ||
        data.readUInt32BE(12) !== 0x49484452
    ) {
        return null
    }
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

// ---------- thumbnails ----------

/** Shrinks to fit size×size, keeping the shape: each pixel averages the ones it covers. */
function shrink({ width, height, rgba }, size) {
    const scale = Math.min(1, size / Math.max(width, height))
    if (scale === 1) return { width, height, rgba }
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    const out = Buffer.alloc(w * h * 4)
    for (let y = 0; y < h; y++) {
        const y0 = Math.floor((y * height) / h)
        const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h))
        for (let x = 0; x < w; x++) {
            const x0 = Math.floor((x * width) / w)
            const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w))
            // Colors weighed by their alpha, so see-through pixels don't darken edges
            let r = 0
            let g = 0
            let b = 0
            let a = 0
            for (let sy = y0; sy < y1; sy++) {
                for (let s = (sy * width + x0) * 4, end = (sy * width + x1) * 4; s < end; s += 4) {
                    const alpha = rgba[s + 3]
                    r += rgba[s] * alpha
                    g += rgba[s + 1] * alpha
                    b += rgba[s + 2] * alpha
                    a += alpha
                }
            }
            const o = (y * w + x) * 4
            if (a) {
                out[o] = Math.round(r / a)
                out[o + 1] = Math.round(g / a)
                out[o + 2] = Math.round(b / a)
            }
            out[o + 3] = Math.round(a / ((y1 - y0) * (x1 - x0)))
        }
    }
    return { width: w, height: h, rgba: out }
}

/** Decodes a PNG, JPEG or VTF: { width, height, rgba }. Throws if it can't (or it's too big). */
function decode(type, data) {
    if (type === "image/png") {
        const size = pngSize(data)
        if (!size || size.width > MAX_SIDE || size.height > MAX_SIDE) {
            throw new Error("Not a PNG BeePM shows")
        }
        const png = PNG.sync.read(data)
        return { width: png.width, height: png.height, rgba: png.data }
    }
    if (type === "image/jpeg") {
        const image = jpeg.decode(data, {
            useTArray: true,
            formatAsRGBA: true,
            maxResolutionInMP: MAX_JPEG_MEGAPIXELS,
            maxMemoryUsageInMB: 256,
        })
        const { buffer, byteOffset, byteLength } = image.data
        return {
            width: image.width,
            height: image.height,
            rgba: Buffer.from(buffer, byteOffset, byteLength),
        }
    }
    if (type === "image/vtf") return decodeVtf(data, { minSide: THUMBNAIL_SIZE })
    throw new Error(`BeePM doesn't read ${type}`)
}

/**
 * An icon as a small PNG ({ type, data }): at most THUMBNAIL_SIZE on its longer side. A small
 * PNG stays as it is. Throws for images it can't read.
 */
export function thumbnail({ type, data }) {
    if (type === "image/png") {
        const size = pngSize(data)
        if (
            size &&
            size.width <= THUMBNAIL_SIZE &&
            size.height <= THUMBNAIL_SIZE &&
            data.length <= KEEP_BYTES
        ) {
            return { type, data }
        }
    }
    const small = shrink(decode(type, data), THUMBNAIL_SIZE)
    return { type: "image/png", data: encodePng(small.width, small.height, small.rgba) }
}
