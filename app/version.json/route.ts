import { NextResponse } from 'next/server'
import { resolveAppVersion } from '@/lib/release/version'

// Public: which release is running. RICOTDIN_VERSION comes from the
// deployment repo's release.env; BUILD_COMMIT is baked in at image build.
export const dynamic = 'force-dynamic'

export function GET() {
  const version = resolveAppVersion({
    version: process.env.RICOTDIN_VERSION,
    commit: process.env.BUILD_COMMIT,
  })
  return NextResponse.json({ version }, { headers: { 'Cache-Control': 'no-store' } })
}
