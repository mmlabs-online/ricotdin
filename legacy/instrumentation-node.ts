// Node.js-only instrumentation. Imported lazily by `instrumentation.ts` and
// ONLY on the Node.js runtime, so the `node:*` imports below never reach the
// Edge bundle.
//
// Why this exists: this machine sits behind a corporate TLS-inspecting proxy
// (TMA) that re-signs HTTPS certificates with a private root CA. Node uses its
// own bundled CA list and ignores the OS trust store, so every outbound `fetch`
// (Speechmatics, Gemini, Supabase) fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
//
// We install a global undici dispatcher whose TLS context trusts BOTH Node's
// default roots AND the corporate CA bundle. This is independent of how the
// server is launched (unlike NODE_EXTRA_CA_CERTS, which must be present in the
// exact shell that started the server).
//
// The CA bundle is optional: if neither NODE_EXTRA_CA_CERTS nor the default
// project path exists, this is a harmless no-op and normal TLS verification
// applies. So on machines NOT behind the proxy nothing changes.

import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { Agent, setGlobalDispatcher } from 'undici'

const caPath =
  process.env.NODE_EXTRA_CA_CERTS ||
  path.join(process.cwd(), 'certs', 'tma-corporate-ca.pem')

try {
  if (fs.existsSync(caPath)) {
    const corpCa = fs.readFileSync(caPath, 'utf8')
    if (corpCa.includes('BEGIN CERTIFICATE')) {
      // IMPORTANT: include Node's default roots — passing `ca` REPLACES the
      // trust list rather than appending, so public-CA hosts would otherwise
      // stop verifying.
      setGlobalDispatcher(
        new Agent({
          connect: { ca: [...tls.rootCertificates, corpCa] },
        }),
      )
      console.log('[instrumentation] outbound TLS trusts corporate CA bundle:', caPath)
    }
  }
} catch (err) {
  console.warn('[instrumentation] failed to load corporate CA bundle:', err)
}
