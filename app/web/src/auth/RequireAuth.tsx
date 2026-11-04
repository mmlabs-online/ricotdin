import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { FullPageLoading } from '../components/FullPageLoading'
import { ForbiddenPage } from '../routes/ForbiddenPage'
import { useAuth } from './AuthProvider'
import { type Role, type SessionView, guardDecision, signInPath } from './guards'
import type { AuthState } from './session'

function view(state: AuthState): SessionView {
  return state.status === 'signedIn' ? { status: 'signedIn', role: state.user.role } : state
}

export function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { state } = useAuth()
  const location = useLocation()
  switch (guardDecision(view(state), role)) {
    case 'wait':
      return <FullPageLoading />
    case 'signIn':
      return <Navigate to={signInPath(location.pathname, location.search, location.hash)} replace />
    case 'forbidden':
      return <ForbiddenPage />
    case 'allow':
      return <>{children}</>
  }
}
