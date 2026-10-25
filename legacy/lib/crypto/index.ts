// SERVER ONLY — AES-256-GCM encryption helpers for storing provider API keys.
//
// SECURITY RULES:
// - KEY_ENCRYPTION_SECRET must be 32 bytes (64 hex chars or 44 base64 chars).
//   Losing this secret makes all stored keys unrecoverable — back it up.
// - Never log KEY_ENCRYPTION_SECRET or any decrypted key value.
// - Decrypted keys must exist only in server-side memory, at call time.
//
// The *WithKey variants take an explicit key buffer — used in unit tests.
// The public encryptSecret / decryptSecret read KEY_ENCRYPTION_SECRET from env.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm' as const
const IV_BYTES  = 12  // 96-bit IV; standard GCM recommendation
const KEY_BYTES = 32  // AES-256
const TAG_BYTES = 16  // GCM auth tag length (default)

export type EncryptedSecret = {
  ciphertext: string  // base64
  iv: string          // base64
  authTag: string     // base64
}

function loadMasterKey(): Buffer {
  const raw = process.env.KEY_ENCRYPTION_SECRET
  if (!raw) {
    throw new Error(
      'KEY_ENCRYPTION_SECRET is not set. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    )
  }
  // Accept 64-char hex or 44-char base64url/base64
  const buf = raw.length === 64 ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `KEY_ENCRYPTION_SECRET must decode to exactly ${KEY_BYTES} bytes ` +
      `(provide 64 hex chars or 44 base64 chars). Got ${buf.length} bytes.`,
    )
  }
  return buf
}

/** Encrypt plaintext with an explicit 32-byte key. Pure — suitable for unit tests. */
export function encryptSecretWithKey(plaintext: string, key: Buffer): EncryptedSecret {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes, got ${key.length}.`)
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    ciphertext: encrypted.toString('base64'),
    iv:         iv.toString('base64'),
    authTag:    cipher.getAuthTag().toString('base64'),
  }
}

/** Decrypt with an explicit 32-byte key. Throws on tampered data (GCM auth fails). */
export function decryptSecretWithKey(secret: EncryptedSecret, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Decryption key must be ${KEY_BYTES} bytes, got ${key.length}.`)
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(secret.iv, 'base64'), {
    authTagLength: TAG_BYTES,
  })
  decipher.setAuthTag(Buffer.from(secret.authTag, 'base64'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, 'base64')),
    decipher.final(),  // throws if GCM authentication tag does not match
  ])
  return decrypted.toString('utf8')
}

/** Encrypt a plaintext secret using KEY_ENCRYPTION_SECRET. Server-only. */
export function encryptSecret(plaintext: string): EncryptedSecret {
  return encryptSecretWithKey(plaintext, loadMasterKey())
}

/** Decrypt a stored secret using KEY_ENCRYPTION_SECRET. Server-only. */
export function decryptSecret(secret: EncryptedSecret): string {
  return decryptSecretWithKey(secret, loadMasterKey())
}
