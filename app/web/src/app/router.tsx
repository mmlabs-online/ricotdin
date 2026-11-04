import { Navigate, createBrowserRouter } from 'react-router'
import { RequireRole } from '../auth/RequireAuth'
import { ErrorScreen } from '../components/ErrorScreen'
import { AdminSectionPage } from '../routes/AdminSectionPage'
import { MeetingDetailPage } from '../routes/MeetingDetailPage'
import { PlaceholderPage } from '../routes/PlaceholderPage'
import { ForgotPasswordPage } from '../routes/auth/ForgotPasswordPage'
import { RegisterPage } from '../routes/auth/RegisterPage'
import { ResetPasswordPage } from '../routes/auth/ResetPasswordPage'
import { VerifyEmailPage } from '../routes/auth/VerifyEmailPage'
import { MeetingsPage } from '../routes/MeetingsPage'
import { RecordPage } from '../routes/RecordPage'
import { SignInPage } from '../routes/SignInPage'
import { StatusPage } from '../routes/StatusPage'
import { ADMIN_SECTIONS } from './adminSections'
import { AdminShell } from './AdminShell'
import { AppShell } from './AppShell'

export function createRouter() {
  return createBrowserRouter([
    { path: '/sign-in', element: <SignInPage />, errorElement: <ErrorScreen /> },
    // Email-link targets (#token=…) stay public: never redirect them through /sign-in.
    { path: '/verify-email', element: <VerifyEmailPage />, errorElement: <ErrorScreen /> },
    { path: '/reset-password', element: <ResetPasswordPage />, errorElement: <ErrorScreen /> },
    { path: '/register', element: <RegisterPage />, errorElement: <ErrorScreen /> },
    { path: '/forgot-password', element: <ForgotPasswordPage />, errorElement: <ErrorScreen /> },
    {
      path: '/admin',
      element: (
        <RequireRole role="admin">
          <AdminShell />
        </RequireRole>
      ),
      errorElement: <ErrorScreen />,
      children: ADMIN_SECTIONS.map(({ slug, key }) =>
        slug ? { path: slug, element: <AdminSectionPage sectionKey={key} /> } : { index: true, element: <AdminSectionPage sectionKey={key} /> },
      ).concat([{ path: '*', element: <StatusPage kind="notFound" /> }]),
    },
    {
      path: '/',
      element: (
        <RequireRole role="user">
          <AppShell />
        </RequireRole>
      ),
      errorElement: <ErrorScreen />,
      children: [
        { index: true, element: <Navigate to="/meetings" replace /> },
        { path: 'meetings', element: <MeetingsPage /> },
        { path: 'meetings/:meetingId', element: <MeetingDetailPage /> },
        { path: 'record', element: <RecordPage /> },
        { path: 'chat', element: <PlaceholderPage titleKey="page.chat.title" subtitleKey="page.chat.subtitle" /> },
        {
          path: 'profile',
          element: <PlaceholderPage eyebrowKey="page.profile.eyebrow" titleKey="page.profile.title" subtitleKey="page.profile.subtitle" />,
        },
        { path: '*', element: <StatusPage kind="notFound" /> },
      ],
    },
  ])
}
