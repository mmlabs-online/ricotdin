'use client'

import Link from 'next/link'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { browserClient } from '@/lib/supabase/browser'

function EyeIcon({ visible }: { visible: boolean }) {
  return visible ? (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}

export default function LoginPage() {
  const router = useRouter()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(true)
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number | null>(null)
  const [countdown, setCountdown] = useState(0)

  useEffect(() => {
    browserClient.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        router.replace('/meetings')
      } else {
        setChecking(false)
      }
    })
  }, [router])

  // Countdown ticker while rate-limited.
  useEffect(() => {
    if (!rateLimitedUntil) return
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((rateLimitedUntil - Date.now()) / 1_000))
      setCountdown(remaining)
      if (remaining === 0) setRateLimitedUntil(null)
    }
    tick()
    const id = setInterval(tick, 1_000)
    return () => clearInterval(id)
  }, [rateLimitedUntil])

  const isRateLimited = rateLimitedUntil !== null && countdown > 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (isRateLimited) return
    setError(null)
    setLoading(true)

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      })
      const data = (await res.json()) as {
        access_token?: string
        refresh_token?: string
        error?: string
      }

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') ?? '900', 10)
        setRateLimitedUntil(Date.now() + retryAfter * 1_000)
        setError(data.error ?? 'Too many failed attempts. Please try again later.')
        return
      }

      if (!res.ok || !data.access_token || !data.refresh_token) {
        setError(data.error ?? 'Login failed. Please try again.')
        return
      }

      await browserClient.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      })

      router.replace('/meetings')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (checking) return null

  return (
    <div className="w-full max-w-sm">
      {/* Card */}
      <div className="bg-white rounded-3xl border border-b-border shadow-b-xl p-8 relative">
        {/* Wordmark */}
        <div className="mb-6 text-center flex justify-center">
          <img src="/long-logo.png" alt="Ricotdin" style={{ height: '50px', width: 'auto' }} />
        </div>

        <p className="text-center font-serif text-xl font-semibold text-b-fg mb-6">
          Welcome back
        </p>

        <form onSubmit={(e) => { void handleSubmit(e) }} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-widest text-b-fg/70 font-sans">
              Email or username
            </span>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
              autoComplete="username"
              autoFocus
              className="input-botanical"
              placeholder="you@example.com or username"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-widest text-b-fg/70 font-sans">
              Password
            </span>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="input-botanical w-full pr-10"
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-b-fg/35 hover:text-b-fg/60 transition-colors duration-150"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                <EyeIcon visible={showPassword} />
              </button>
            </div>
          </label>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-2xl px-4 py-2.5">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || isRateLimited}
            className="btn-primary mt-1 w-full"
            style={{ opacity: loading || isRateLimited ? 0.65 : 1 }}
          >
            {loading ? 'Signing in…' : isRateLimited ? `Try again in ${countdown}s` : 'Sign in'}
          </button>
        </form>

        <p className="text-center text-sm text-b-fg/50 mt-5 font-sans">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="text-b-terra font-medium hover:underline">
            Create one
          </Link>
        </p>
      </div>
    </div>
  )
}
