// Cloudflare Turnstile (AUT-05): mmlabs requires a challenge token for sign-up and
// forgot-password, and for sign-in after 3 failures for an email. The script comes from
// challenges.cloudflare.com (allowed in the CSP: script-src + frame-src); the token goes only to
// mmlabs. Rendered explicitly so React controls the widget's lifetime.
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

type TurnstileApi = {
  render(el: HTMLElement, opts: Record<string, unknown>): string
  remove(id: string): void
}
declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let loading: Promise<TurnstileApi> | null = null

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SRC
    script.async = true
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile')))
    script.onerror = () => {
      loading = null
      script.remove()
      reject(new Error('turnstile'))
    }
    document.head.appendChild(script)
  })
  return loading
}

/** Calls `onToken(token)` when the challenge passes and `onToken(null)` when it expires or fails.
 * Change `resetKey` to get a fresh challenge (a token is single use). */
export function Turnstile({ siteKey, onToken, resetKey = 0 }: { siteKey: string; onToken: (token: string | null) => void; resetKey?: number }) {
  const { t, i18n } = useTranslation()
  const box = useRef<HTMLDivElement>(null)
  const callback = useRef(onToken)
  useLayoutEffect(() => {
    callback.current = onToken
  })

  useEffect(() => {
    if (!siteKey || !box.current) return
    const widget: { id: string | null; gone: boolean } = { id: null, gone: false }
    const el = box.current
    callback.current(null)
    loadTurnstile()
      .then((api) => {
        if (widget.gone) return
        widget.id = api.render(el, {
          sitekey: siteKey,
          language: i18n.language === 'vi' ? 'vi' : 'en',
          callback: (token: string) => callback.current(token),
          'expired-callback': () => callback.current(null),
          'error-callback': () => callback.current(null),
        })
      })
      .catch(() => callback.current(null))
    return () => {
      widget.gone = true
      if (widget.id && window.turnstile) window.turnstile.remove(widget.id)
    }
  }, [siteKey, resetKey, i18n.language])

  if (!siteKey) {
    return (
      <p className="auth-error" role="alert">
        {t('auth.turnstile.unavailable')}
      </p>
    )
  }
  return <div ref={box} className="turnstile" aria-label={t('auth.turnstile.label')} />
}
