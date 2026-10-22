import { NextResponse } from 'next/server'

// Liveness probe for the container HEALTHCHECK and the deploy workflow.
// Public, no DB or provider calls — must succeed even with no secrets set.
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json({ status: 'ok' })
}
