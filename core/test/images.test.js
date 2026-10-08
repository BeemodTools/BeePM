/**
 * Icons of what's in packages (images.js): PNG, JPEG and VTF, shrunk to small PNG thumbnails.
 */
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"
import { decodeVtf, encodePng, THUMBNAIL_SIZE, thumbnail } from "../src/images.js"

const require = createRequire(import.meta.url)
const { PNG } = require("pngjs")
const jpeg = require("jpeg-js")

/** width×height pixels of one color */
const fill = (width, height, [r, g, b, a]) => {
    const rgba = Buffer.alloc(width * height * 4)
    for (let i = 0; i < rgba.length; i += 4) rgba.set([r, g, b, a], i)
    return rgba
}
const read = (data) => PNG.sync.read(data)

/** A VTF 7.2 (RGBA8888) with each mipmap a different color, smallest first in the file. */
function vtf(width, height, colors) {
    const header = Buffer.alloc(80)
    header.write("VTF\0", 0, "latin1")
    header.writeUInt32LE(7, 4)
    header.writeUInt32LE(2, 8)
    header.writeUInt32LE(80, 12) // header size
    header.writeUInt16LE(width, 16)
    header.writeUInt16LE(height, 18)
    header.writeUInt16LE(1, 24) // frames
    header.writeInt32LE(0, 52) // RGBA8888
    header[56] = colors.length // mipmaps
    header.writeInt32LE(-1, 57) // no low-res image
    header.writeUInt16LE(1, 63) // depth
    const mips = colors.map((color, level) =>
        fill(Math.max(1, width >> level), Math.max(1, height >> level), color),
    )
    return Buffer.concat([header, ...mips.reverse()])
}

test("small PNGs stay as they are; big ones shrink, keeping their shape", () => {
    const small = encodePng(64, 64, fill(64, 64, [255, 0, 0, 255]))
    assert.equal(thumbnail({ type: "image/png", data: small }).data, small)

    const wide = encodePng(512, 256, fill(512, 256, [0, 128, 255, 255]))
    const shrunk = read(thumbnail({ type: "image/png", data: wide }).data)
    assert.deepEqual([shrunk.width, shrunk.height], [THUMBNAIL_SIZE, THUMBNAIL_SIZE / 2])
    assert.deepEqual([...shrunk.data.subarray(0, 4)], [0, 128, 255, 255])

    // See-through pixels don't darken the color they're averaged with
    const half = fill(256, 256, [255, 255, 255, 255])
    for (let i = 0; i < half.length; i += 8) half.set([0, 0, 0, 0], i)
    const faded = read(thumbnail({ type: "image/png", data: encodePng(256, 256, half) }).data)
    assert.deepEqual([...faded.data.subarray(0, 4)], [255, 255, 255, 128])
})

test("JPEGs and VTFs become PNG thumbnails", () => {
    const photo = jpeg.encode(
        { width: 300, height: 150, data: fill(300, 150, [200, 30, 30, 255]) },
        95,
    )
    const fromJpeg = read(thumbnail({ type: "image/jpeg", data: photo.data }).data)
    assert.deepEqual([fromJpeg.width, fromJpeg.height], [128, 64])
    assert.ok(Math.abs(fromJpeg.data[0] - 200) < 8)

    // The smallest mipmap that's still big enough is used
    const texture = vtf(512, 512, [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [9, 9, 9, 255],
    ])
    const decoded = decodeVtf(texture, { minSide: 128 })
    assert.deepEqual(
        [decoded.width, decoded.height, ...decoded.rgba.subarray(0, 4)],
        [128, 128, 0, 0, 255, 255],
    )
    assert.deepEqual([...decodeVtf(texture).rgba.subarray(0, 4)], [255, 0, 0, 255]) // full size
    const fromVtf = read(thumbnail({ type: "image/vtf", data: texture }).data)
    assert.deepEqual([fromVtf.width, ...fromVtf.data.subarray(0, 3)], [128, 0, 0, 255])
})

test("images that aren't what they say, or claim to be huge, are refused", () => {
    assert.throws(() => thumbnail({ type: "image/png", data: Buffer.from("not a png") }))
    assert.throws(() => thumbnail({ type: "image/vtf", data: Buffer.from("VTF\0") }))
    // A PNG header claiming 100000×100000 isn't decoded
    const huge = encodePng(1, 1, fill(1, 1, [0, 0, 0, 255]))
    huge.writeUInt32BE(100000, 16)
    huge.writeUInt32BE(100000, 20)
    assert.throws(() => thumbnail({ type: "image/png", data: huge }), /Not a PNG BeePM shows/)
})
