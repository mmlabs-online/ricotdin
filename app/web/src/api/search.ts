// Library-wide search (PRO-05): GET /search.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useFetchApi } from '../auth/AuthProvider'
import { validQuery } from '../lib/search/search'
import { apiJson } from './json'

export interface SearchItem {
  kind: 'transcript' | 'summary' | 'notes'
  startMs: number | null
  text: string
  ranges: Array<[number, number]>
  source: 'keyword' | 'semantic' | 'both'
}
export interface SearchGroup {
  meetingId: string
  title: string
  createdAt: string
  items: SearchItem[]
}
export interface SearchResult {
  query: string
  semanticAvailable: boolean
  groups: SearchGroup[]
}

export function useSearch(q: string, folder: string) {
  const fetchApi = useFetchApi()
  const query = q.trim()
  return useQuery({
    queryKey: ['search', query, folder] as const,
    enabled: validQuery(query),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: () => {
      const p = new URLSearchParams({ q: query })
      if (folder) p.set('folderId', folder)
      return apiJson<SearchResult>(fetchApi, `/search?${p}`)
    },
  })
}
