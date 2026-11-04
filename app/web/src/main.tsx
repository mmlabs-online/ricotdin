import '@fontsource/inter/400.css'
import '@fontsource/inter/600.css'
import './styles/index.css'
import './styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router'
import { I18nextProvider } from 'react-i18next'
import { createApiClient, createFetchApi } from './api/client'
import { ApiError } from './api/errors'
import { AuthProvider } from './auth/AuthProvider'
import { AuthSession } from './auth/session'
import { createRouter } from './app/router'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ErrorScreen } from './components/ErrorScreen'
import { initI18n } from './i18n'
import { loadRuntimeConfig } from './lib/config'
import { ThemeProvider } from './theme/ThemeProvider'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('#root element missing in index.html')
const root = createRoot(rootElement)
const i18n = initI18n()

function retryable(failureCount: number, error: unknown): boolean {
  // 4xx answers will not change on retry; network trouble and 5xx get two more tries.
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
  return failureCount < 2
}

async function boot(): Promise<void> {
  let config
  try {
    config = await loadRuntimeConfig()
  } catch (err) {
    console.error('config.json', err)
    root.render(
      <I18nextProvider i18n={i18n}>
        <ErrorScreen messageKey="error.config" />
      </I18nextProvider>,
    )
    return
  }
  const session = new AuthSession(config.authUrl)
  const api = createApiClient(config.apiUrl, session)
  const fetchApi = createFetchApi(config.apiUrl, session)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: retryable, staleTime: 30_000 } } })
  const router = createRouter()
  root.render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <ErrorBoundary>
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <AuthProvider session={session} api={api} fetchApi={fetchApi}>
                <RouterProvider router={router} />
              </AuthProvider>
            </QueryClientProvider>
          </ThemeProvider>
        </ErrorBoundary>
      </I18nextProvider>
    </StrictMode>,
  )
}

void boot()
