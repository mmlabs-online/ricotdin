import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '../api/client'
import type { AuthSession, AuthState } from './session'

type AuthValue = { session: AuthSession; api: ApiClient }
const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ session, api, children }: AuthValue & { children: ReactNode }) {
  const queryClient = useQueryClient()
  useEffect(() => {
    void session.start()
    // Cached data belongs to the previous user: drop it when the session ends or changes hands.
    let lastUser: string | null = null
    return session.subscribe(() => {
      const state = session.getState()
      const user = state.status === 'signedIn' ? state.user.id : null
      if (user !== lastUser) queryClient.clear()
      lastUser = user
    })
  }, [session, queryClient])
  return <AuthContext.Provider value={{ session, api }}>{children}</AuthContext.Provider>
}

function useAuthContext(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth outside AuthProvider')
  return value
}

export function useAuth(): { state: AuthState; session: AuthSession } {
  const { session } = useAuthContext()
  const state = useSyncExternalStore(session.subscribe, session.getState)
  return { state, session }
}

export function useApi(): ApiClient {
  return useAuthContext().api
}
