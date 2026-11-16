import { useId, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth, useTurnstileSiteKey } from '../../auth/AuthProvider'
import { publicAuthErrorKey } from '../../auth/authErrors'
import { normalizeEmail, validateEmail } from '../../auth/validate'
import { Turnstile } from '../../components/Turnstile'
import { Button } from '../../components/ui/Button'

/** "Send me a reset link" for the mmlabs account (AUT-05). mmlabs always answers 202 (no account
 * enumeration) and always requires a Turnstile token. */
export function EmailLinkForm({ initialEmail = '', submitKey }: { initialEmail?: string; submitKey: string }) {
  const { t } = useTranslation()
  const { session } = useAuth()
  const siteKey = useTurnstileSiteKey()
  const id = useId()
  const [email, setEmail] = useState(initialEmail)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [turnstile, setTurnstile] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const value = normalizeEmail(email)
    const invalid = validateEmail(value)
    if (invalid) {
      setErrorKey(invalid)
      inputRef.current?.focus()
      return
    }
    if (!turnstile) {
      setErrorKey('auth.errors.turnstile_required')
      return
    }
    setBusy(true)
    setErrorKey(null)
    try {
      await session.publicAuth('/password/forgot', { email: value, turnstile_token: turnstile })
      setDone(true)
    } catch (err) {
      setErrorKey(publicAuthErrorKey(err, 'reset'))
      setRound((n) => n + 1) // the Turnstile token was used
      requestAnimationFrame(() => inputRef.current?.focus())
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <p className="auth-success" role="status" tabIndex={-1} ref={(el) => el?.focus()}>
        {t('auth.linkSent')}
      </p>
    )
  }
  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <label className="auth-field">
        {t('auth.register.email')}
        <input
          ref={inputRef}
          type="email"
          autoComplete="email"
          value={email}
          maxLength={320}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={errorKey ? true : undefined}
          aria-describedby={errorKey ? id : undefined}
        />
      </label>
      <Turnstile siteKey={siteKey} onToken={setTurnstile} resetKey={round} />
      {errorKey && (
        <p id={id} className="auth-error" role="alert">
          {t(errorKey)}
        </p>
      )}
      <Button type="submit" variant="primary" className="full" disabled={busy} aria-busy={busy}>
        {t(submitKey)}
      </Button>
    </form>
  )
}
