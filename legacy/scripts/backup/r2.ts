// OPS-03 — upload / prune encrypted DB backups in the dedicated R2 backup bucket.
// Run by .github/workflows/backup.yml (CI only; not part of the app).
//
//   npx tsx scripts/backup/r2.ts upload <encrypted-file>   → db/ricotdin-db-<UTC>.tar.gz.age
//   npx tsx scripts/backup/r2.ts prune                     → delete backups older than retention
//
// Env (GitHub secrets): R2_BACKUP_ACCOUNT_ID, R2_BACKUP_ACCESS_KEY_ID,
// R2_BACKUP_SECRET_ACCESS_KEY, R2_BACKUP_BUCKET; optional BACKUP_RETENTION_DAYS (default 30).
// The R2 token should be scoped to the backup bucket only. Secrets are never printed.

import * as fs from 'node:fs'
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { BACKUP_PREFIX, backupObjectKey, selectExpiredBackups } from '../../lib/backup/retention.js'

const DEFAULT_RETENTION_DAYS = 30

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`[backup] missing required env var ${name}`)
    process.exit(2)
  }
  return v
}

function client(): { s3: S3Client; bucket: string } {
  const accountId = requireEnv('R2_BACKUP_ACCOUNT_ID')
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requireEnv('R2_BACKUP_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_BACKUP_SECRET_ACCESS_KEY'),
    },
  })
  return { s3, bucket: requireEnv('R2_BACKUP_BUCKET') }
}

async function upload(file: string | undefined): Promise<void> {
  if (!file || !fs.existsSync(file)) {
    console.error('[backup] usage: r2.ts upload <encrypted-file> (file not found)')
    process.exit(2)
  }
  if (!file.endsWith('.age')) {
    console.error('[backup] refusing to upload a file that is not age-encrypted (*.age)')
    process.exit(2)
  }
  const { s3, bucket } = client()
  const key = backupObjectKey(new Date())
  const body = fs.readFileSync(file)
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'application/octet-stream',
    IfNoneMatch: '*', // never overwrite an existing backup
  }))
  console.log(`[backup] uploaded ${key} (${body.length} bytes)`)
}

async function listKeys(s3: S3Client, bucket: string): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: BACKUP_PREFIX, ContinuationToken: token }))
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key)
    token = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (token)
  return keys
}

async function prune(): Promise<void> {
  const raw = process.env.BACKUP_RETENTION_DAYS
  const days = raw ? Number(raw) : DEFAULT_RETENTION_DAYS
  const { s3, bucket } = client()
  const keys = await listKeys(s3, bucket)
  const expired = selectExpiredBackups(keys, Date.now(), days)
  for (const key of expired) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    console.log(`[backup] deleted expired ${key}`)
  }
  console.log(`[backup] prune done: ${keys.length} objects listed, ${expired.length} deleted (retention ${days}d)`)
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'upload') return upload(arg)
  if (cmd === 'prune') return prune()
  console.error('[backup] usage: r2.ts <upload <file> | prune>')
  process.exit(2)
}

main().catch((err: unknown) => {
  // Error messages from the SDK never contain the secret key; avoid dumping the full object.
  console.error('[backup] failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
