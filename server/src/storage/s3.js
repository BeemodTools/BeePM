import { createReadStream, createWriteStream } from "node:fs"
import { stat } from "node:fs/promises"
import { pipeline } from "node:stream/promises"
import {
    CopyObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

const encodeKey = (key) => key.split("/").map(encodeURIComponent).join("/")

/**
 * Object storage on an S3-compatible bucket (a Railway bucket in production).
 * The bucket is private: clients only ever get short-lived presigned URLs.
 */
export function createS3Storage(cfg) {
    const client = new S3Client({
        region: cfg.region,
        endpoint: cfg.endpoint,
        forcePathStyle: cfg.forcePathStyle,
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
        // The SDK's default CRC32 checksums end up in presigned URLs and streamed uploads,
        // which S3-compatible stores don't all accept. Only send them when an API requires it.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
    })
    const Bucket = cfg.bucket

    return {
        kind: "s3",

        /** Where the client should PUT the file. The signature pins the exact size. */
        async uploadTarget(key, { size, expiresIn = 3600 }) {
            const command = new PutObjectCommand({
                Bucket,
                Key: key,
                ContentLength: size,
                ContentType: "application/octet-stream",
            })
            const url = await getSignedUrl(client, command, {
                expiresIn,
                signableHeaders: new Set(["content-length", "content-type"]),
            })
            return { method: "PUT", url, headers: { "Content-Type": "application/octet-stream" } }
        },

        downloadUrl(key, { filename, expiresIn = 600 } = {}) {
            const command = new GetObjectCommand({
                Bucket,
                Key: key,
                ResponseContentDisposition: filename
                    ? `attachment; filename="${filename.replace(/["\\]/g, "")}"`
                    : undefined,
            })
            return getSignedUrl(client, command, { expiresIn })
        },

        async head(key) {
            try {
                const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }))
                return { size: Number(res.ContentLength) }
            } catch (err) {
                if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") return null
                throw err
            }
        },

        async downloadTo(key, filePath) {
            const res = await client.send(new GetObjectCommand({ Bucket, Key: key }))
            await pipeline(res.Body, createWriteStream(filePath))
        },

        async putFile(key, filePath, { contentType = "application/octet-stream" } = {}) {
            const { size } = await stat(filePath)
            await client.send(
                new PutObjectCommand({
                    Bucket,
                    Key: key,
                    Body: createReadStream(filePath),
                    ContentLength: size,
                    ContentType: contentType,
                }),
            )
        },

        async copy(fromKey, toKey) {
            await client.send(
                new CopyObjectCommand({
                    Bucket,
                    Key: toKey,
                    CopySource: `${Bucket}/${encodeKey(fromKey)}`,
                }),
            )
        },

        async remove(key) {
            await client.send(new DeleteObjectCommand({ Bucket, Key: key }))
        },
    }
}
