import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/AuthProvider'
import { publicAuthErrorKey } from '../../auth/authErrors'
import { normalizeEmail, validateEmail } from '../../auth/validate'
import { Button } from '../../components/ui/Button'

/** Email form for "send me a link" (resend verification / forgot password). The API always
 * answers 202, so the result never reveals whether an account exists. */
export function EmailLinkForm({
  path,
  initialEmail = '',
  submitKey,
}: {
  path: '/resend-verification' | '/forgot-password'
  initialEmail?: string
  submitKey: string
}) {
  const { t } = useTranslation()
  const { session } = useAuth()
  const id = useId()
  const [email, setEmail] = useState(initialEmail)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const value = normalizeEmail(email)
    const invalid = validateEmail(value)
    if (invalid) {
      setErrorKey(invalid)
      return
    }
    setBusy(true)
    setErrorKey(null)
    try {
      await session.publicAuth(path, { email: value })
      setDone(true)
    } catch (err) {
      setErrorKey(publicAuthErrorKey(err, 'verify'))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <p className="auth-success" role="status">
        {t('auth.linkSent')}
      </p>
    )
  }
  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <label className="auth-field">
        {t('auth.register.email')}
        <input
          type="email"
          autoComplete="email"
          value={email}
          maxLength={320}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={errorKey ? true : undefined}
          aria-describedby={errorKey ? id : undefined}
        />
      </label>
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
