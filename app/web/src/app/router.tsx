import { Navigate, createBrowserRouter } from 'react-router'
import { RequireRole } from '../auth/RequireAuth'
import { ErrorScreen } from '../components/ErrorScreen'
import { AdminSectionPage } from '../routes/AdminSectionPage'
import { MeetingDetailPage } from '../routes/MeetingDetailPage'
import { PlaceholderPage } from '../routes/PlaceholderPage'
import { PublicPlaceholderPage } from '../routes/PublicPlaceholderPage'
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
    { path: '/verify-email', element: <PublicPlaceholderPage titleKey="page.verifyEmail.title" />, errorElement: <ErrorScreen /> },
    { path: '/reset-password', element: <PublicPlaceholderPage titleKey="page.resetPassword.title" />, errorElement: <ErrorScreen /> },
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
        { path: 'meetings', element: <PlaceholderPage titleKey="page.meetings.title" subtitleKey="page.meetings.subtitle" /> },
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
