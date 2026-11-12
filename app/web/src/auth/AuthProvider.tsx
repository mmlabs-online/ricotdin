import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient, FetchApi } from '../api/client'
import type { AuthSession, AuthState } from './session'

type AuthValue = { session: AuthSession; api: ApiClient; fetchApi: FetchApi; apiUrl: string }
const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ session, api, fetchApi, apiUrl, children }: AuthValue & { children: ReactNode }) {
  const queryClient = useQueryClient()
  useEffect(() => {
    void session.start()
    // Cached data belongs to the previous user: drop it when the session ends or changes hands.
    const userOf = () => {
      const state = session.getState()
      return state.status === 'signedIn' ? state.user.id : null
    }
    let lastUser = userOf()
    return session.subscribe(() => {
      const user = userOf()
      if (user !== lastUser) {
        void queryClient.cancelQueries()
        queryClient.clear()
      }
      lastUser = user
    })
  }, [session, queryClient])
  return <AuthContext.Provider value={{ session, api, fetchApi, apiUrl }}>{children}</AuthContext.Provider>
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

export function useFetchApi(): FetchApi {
  return useAuthContext().fetchApi
}

/** The API origin, for URLs the browser loads itself (the `/media` playback link). */
export function useApiUrl(): string {
  return useAuthContext().apiUrl
}
