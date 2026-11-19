// Running release for the sidebar footer (public GET /version.json, no token needed).
import { useQuery } from '@tanstack/react-query'
import { useFetchApi } from '../auth/AuthProvider'
import { versionLabel } from '../lib/version'

export function useAppVersion(): string | null {
  const fetchApi = useFetchApi()
  const query = useQuery({
    queryKey: ['version'],
    queryFn: async () => {
      const res = await fetchApi('/version.json')
      return res.ok ? versionLabel(await res.json().catch(() => null)) : null
    },
    staleTime: Infinity, // changes only with a deploy
    retry: false,
  })
  return query.data ?? null
}
