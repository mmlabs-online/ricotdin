import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { AuthLayout } from '../../components/AuthLayout'
import { useDocumentTitle } from '../../lib/useDocumentTitle'
import { EmailLinkForm } from './ResendForm'

/** Request a reset link for the mmlabs account (AUT-05; always "check your inbox": no account
 * enumeration). */
export function ForgotPasswordPage() {
  const { t } = useTranslation()
  useDocumentTitle('auth.forgotTitle')
  return (
    <AuthLayout>
      <div className="auth-card">
        <h1>{t('auth.forgotTitle')}</h1>
        <p>{t('auth.forgotHelp')}</p>
        <EmailLinkForm submitKey="auth.forgotSubmit" />
        <small>
          <Link to="/sign-in">{t('auth.backToSignIn')}</Link>
        </small>
      </div>
    </AuthLayout>
  )
}
