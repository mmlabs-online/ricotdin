import { Navigate, createBrowserRouter } from 'react-router'
import { RequireRole } from '../auth/RequireAuth'
import { ErrorScreen } from '../components/ErrorScreen'
import { ChatPage } from '../routes/ChatPage'
import { ProfilePage } from '../routes/ProfilePage'
import { MeetingDetailPage } from '../routes/MeetingDetailPage'
import { ForgotPasswordPage } from '../routes/auth/ForgotPasswordPage'
import { RegisterPage } from '../routes/auth/RegisterPage'
import { ResetPasswordPage } from '../routes/auth/ResetPasswordPage'
import { VerifyEmailPage } from '../routes/auth/VerifyEmailPage'
import { MeetingsPage } from '../routes/MeetingsPage'
import { RecordPage } from '../routes/RecordPage'
import { SignInPage } from '../routes/SignInPage'
import { StatusPage } from '../routes/StatusPage'
import { AdminActivityPage } from '../routes/admin/AdminActivityPage'
import { AdminAuditPage } from '../routes/admin/AdminAuditPage'
import { AdminConfigPage } from '../routes/admin/AdminConfigPage'
import { AdminDocsPage } from '../routes/admin/AdminDocsPage'
import { AdminFeaturesPage } from '../routes/admin/AdminFeaturesPage'
import { AdminHealthPage, AdminStoragePage } from '../routes/admin/AdminHealthPage'
import { AdminKeysPage } from '../routes/admin/AdminKeysPage'
import { AdminOverviewPage } from '../routes/admin/AdminOverviewPage'
import { AdminPipelinePage } from '../routes/admin/AdminPipelinePage'
import { AdminUsagePage } from '../routes/admin/AdminUsagePage'
import { AdminUserDetailPage } from '../routes/admin/AdminUserDetailPage'
import { AdminUsersPage } from '../routes/admin/AdminUsersPage'

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
      children: [
        { index: true, element: <AdminOverviewPage /> },
        { path: 'users', element: <AdminUsersPage /> },
        { path: 'users/:userId', element: <AdminUserDetailPage /> },
        { path: 'pipeline', element: <AdminPipelinePage /> },
        { path: 'usage', element: <AdminUsagePage /> },
        { path: 'activity', element: <AdminActivityPage /> },
        { path: 'audit', element: <AdminAuditPage /> },
        { path: 'keys', element: <AdminKeysPage /> },
        { path: 'storage', element: <AdminStoragePage /> },
        { path: 'config', element: <AdminConfigPage /> },
        { path: 'features', element: <AdminFeaturesPage /> },
        { path: 'health', element: <AdminHealthPage /> },
        { path: 'docs', element: <AdminDocsPage /> },
        { path: '*', element: <StatusPage kind="notFound" /> },
      ],
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
        { path: 'chat', element: <ChatPage /> },
        { path: 'profile', element: <ProfilePage /> },
        { path: '*', element: <StatusPage kind="notFound" /> },
      ],
    },
  ])
}
