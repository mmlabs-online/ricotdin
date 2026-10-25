// SERVER ONLY — provider-agnostic audio storage abstraction.
//
// All audio I/O must go through this module. Nothing else imports Supabase
// storage methods or @aws-sdk directly.
//
// NEW writes (storage_provider = 'r2') always go to Cloudflare R2.
// LEGACY reads/deletes (storage_provider = 'supabase') use Supabase Storage —
// these branches exist ONLY to serve meetings created before migration CST-02.
// No new row will ever have storage_provider = 'supabase'. Do NOT remove the
// Supabase branches until every row has been migrated and the bucket retired.
//
// R2 bucket CORS: paste lib/storage/CORS.json into Cloudflare dashboard →
// R2 → <bucket> → Settings → CORS policy (replace AllowedOrigins with your domain).

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createServerClient } from '@/lib/supabase/server'
import { errorToMessage } from '@/lib/logger'
import { getR2Config } from './config'

// Supabase bucket name — kept only for legacy reads/deletes.
const SUPABASE_BUCKET = 'recordings'

// ---------------------------------------------------------------------------
// R2 client — resolved from storage_config (DB) only.
//
// Credentials come from getR2Config() (admin-managed, 30s TTL cache). The
// S3Client is memoised per account+key so we don't rebuild it on every call, and
// automatically rebuilt when the resolved credentials change (config edit).
// ---------------------------------------------------------------------------

let _r2: S3Client | null = null
let _r2Fingerprint = ''

/** Build (or reuse) the S3Client for the currently-resolved R2 credentials. */
async function r2(): Promise<S3Client> {
  const cfg = await getR2Config()
  if (!cfg) {
    throw new Error('R2 storage is not configured. Add a storage config at /admin/storage.')
  }
  // Rebuild the client only when the resolved credentials actually change.
  const fingerprint = `${cfg.accountId}:${cfg.accessKeyId}`
  if (!_r2 || fingerprint !== _r2Fingerprint) {
    _r2 = new S3Client({
      region: 'auto',
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    })
    _r2Fingerprint = fingerprint
  }
  return _r2
}

/** Resolve the active R2 bucket name. */
async function r2Bucket(): Promise<string> {
  const cfg = await getR2Config()
  if (!cfg) {
    throw new Error('R2 storage is not configured. Add a storage config at /admin/storage.')
  }
  return cfg.bucket
}

/**
 * Verify a set of R2 credentials by issuing a HeadBucket call. Used by the admin
 * "Test connection" action before saving so bad credentials can't silently break
 * uploads. Never throws — returns { ok, error? }.
 */
export async function testR2Connection(creds: {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${creds.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    })
    await client.send(new HeadBucketCommand({ Bucket: creds.bucket }))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errorToMessage(e) }
  }
}

// ---------------------------------------------------------------------------
// R2-only writes  (new rows — no legacy branch needed)
// ---------------------------------------------------------------------------

/**
 * Returns a presigned PUT URL for direct browser-to-R2 upload.
 *
 * IMPORTANT: the browser PUT request MUST include the header
 *   Content-Type: <contentType>
 * with the exact same value used here. R2 returns 403 on mismatch.
 *
 * The server echoes `contentType` back to the client in the POST /api/meetings
 * response so the browser can use the authoritative value without guessing.
 */
export async function createSignedUploadUrl({
  key,
  contentType,
  expiresIn = 900,
}: {
  key: string
  contentType: string
  expiresIn?: number
}): Promise<string> {
  const [client, bucket] = await Promise.all([r2(), r2Bucket()])
  return getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn },
  )
}

/**
 * Server-side upload of raw bytes to R2.
 * Used after server-side video→mp3 extraction where the browser is not involved.
 */
export async function uploadBytes({
  key,
  buffer,
  contentType,
}: {
  key: string
  buffer: Buffer
  contentType: string
}): Promise<void> {
  const [client, bucket] = await Promise.all([r2(), r2Bucket()])
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
  )
}

// ---------------------------------------------------------------------------
// Provider-dispatched reads
// ---------------------------------------------------------------------------

/**
 * Returns a signed download URL for browser playback, ffmpeg, or ffprobe.
 * Branches on `provider` so legacy Supabase meetings continue to work.
 */
export async function createSignedDownloadUrl({
  key,
  provider,
  expiresIn = 3_600,
}: {
  key: string
  provider: string
  expiresIn?: number
}): Promise<string> {
  if (provider === 'r2') {
    const [client, bucket] = await Promise.all([r2(), r2Bucket()])
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn },
    )
  }

  // LEGACY — Supabase Storage. Serves meetings created before migration CST-02.
  // No new row will ever reach this branch. Remove when the bucket is retired.
  const db = createServerClient()
  const { data, error } = await db.storage.from(SUPABASE_BUCKET).createSignedUrl(key, expiresIn)
  if (error || !data?.signedUrl) {
    throw new Error(`Supabase createSignedUrl failed: ${error?.message ?? 'no URL returned'}`)
  }
  return data.signedUrl
}

/**
 * Downloads the full object and returns it as a Buffer.
 * Used by the pipeline to fetch audio before writing to a temp file.
 */
export async function getObjectBytes({
  key,
  provider,
}: {
  key: string
  provider: string
}): Promise<Buffer> {
  if (provider === 'r2') {
    const [client, bucket] = await Promise.all([r2(), r2Bucket()])
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    if (!res.Body) throw new Error(`R2 GetObject returned no body for key: ${key}`)
    const chunks: Uint8Array[] = []
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  // LEGACY — Supabase Storage. Remove when bucket is retired.
  const db = createServerClient()
  const { data: blob, error } = await db.storage.from(SUPABASE_BUCKET).download(key)
  if (error || !blob) throw new Error(`Supabase download failed: ${error?.message ?? 'no data'}`)
  return Buffer.from(await blob.arrayBuffer())
}

/**
 * Returns the object size in bytes, or null if not found.
 * Used for server-side enforcement of the MAX_UPLOAD_BYTES limit in /uploaded.
 */
export async function getObjectSize({
  key,
  provider,
}: {
  key: string
  provider: string
}): Promise<number | null> {
  if (provider === 'r2') {
    try {
      const [client, bucket] = await Promise.all([r2(), r2Bucket()])
      const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      return res.ContentLength ?? null
    } catch {
      return null
    }
  }

  // LEGACY — Supabase Storage. Remove when bucket is retired.
  const db = createServerClient()
  const dir = key.split('/').slice(0, -1).join('/')
  const filename = key.split('/').at(-1)
  const { data: files } = await db.storage
    .from(SUPABASE_BUCKET)
    .list(dir, { search: filename, limit: 1 })
  if (!files || files.length === 0) return null
  const size = (files[0].metadata as Record<string, unknown> | null)?.['size']
  return typeof size === 'number' ? size : null
}

// ---------------------------------------------------------------------------
// Provider-dispatched deletes
// ---------------------------------------------------------------------------

/**
 * Deletes a single object. Throws on failure — caller decides severity.
 */
export async function deleteObject({
  key,
  provider,
}: {
  key: string
  provider: string
}): Promise<void> {
  if (provider === 'r2') {
    const [client, bucket] = await Promise.all([r2(), r2Bucket()])
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    return
  }

  // LEGACY — Supabase Storage. Remove when bucket is retired.
  const db = createServerClient()
  const { error } = await db.storage.from(SUPABASE_BUCKET).remove([key])
  if (error) throw new Error(`Supabase remove failed: ${error.message}`)
}

/**
 * Deletes multiple objects, potentially from mixed providers (legacy + R2 rows).
 * Returns an array of keys that failed; never throws.
 */
export async function deleteObjects(
  items: Array<{ key: string; provider: string }>,
): Promise<string[]> {
  const failed: string[] = []
  await Promise.allSettled(
    items.map(({ key, provider }) =>
      deleteObject({ key, provider }).catch(() => {
        failed.push(key)
      }),
    ),
  )
  return failed
}
