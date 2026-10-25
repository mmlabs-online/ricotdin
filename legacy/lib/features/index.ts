// SERVER ONLY — DB-access service for the feature registry.
// No filesystem access: all reads/writes go to the `features` table via the
// service-role client (bypasses RLS).

import { createServerClient } from '@/lib/supabase/server'

// ── Types ─────────────────────────────────────────────────────────────────────

export type FeatureStatus = 'done' | 'partial' | 'not_started'

export interface Feature {
  id: string
  created_at: string
  updated_at: string
  updated_by: string | null
  key: string
  source_path: string | null
  module_prefix: string
  module_name: string
  title: string
  user_story: string | null
  description: string | null
  content: string | null
  status: FeatureStatus
  priority: 'high' | 'medium' | 'low' | null
  note_tags: string[]
  depends_on: string[]
  blocks: string[]
  key_files: string[]
  metadata: Record<string, unknown>
  change_note: string | null
}

export interface ListFeaturesFilters {
  module_prefix?: string
  status?: FeatureStatus
  search?: string
  page?: number
  perPage?: number
}

export interface UpdateFeatureFields {
  title?: string
  description?: string
  content?: string
  status?: FeatureStatus
  priority?: 'high' | 'medium' | 'low' | null
  note_tags?: string[]
  depends_on?: string[]
  blocks?: string[]
  key_files?: string[]
  change_note?: string
}

export interface CreateFeatureFields {
  key: string
  module_prefix: string
  module_name: string
  title: string
  description?: string
  user_story?: string
  content?: string
  status?: FeatureStatus
  priority?: 'high' | 'medium' | 'low' | null
  note_tags?: string[]
  depends_on?: string[]
  blocks?: string[]
  key_files?: string[]
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function listFeatures(filters: ListFeaturesFilters = {}): Promise<Feature[]> {
  const db = createServerClient()
  const { module_prefix, status, search, page = 1, perPage = 100 } = filters

  let query = db
    .from('features')
    .select('*')
    .order('module_prefix', { ascending: true })
    .order('key', { ascending: true })

  if (module_prefix) {
    query = query.eq('module_prefix', module_prefix)
  }
  if (status) {
    query = query.eq('status', status)
  }
  if (search) {
    query = query.or(
      `key.ilike.%${search}%,title.ilike.%${search}%,description.ilike.%${search}%`,
    )
  }

  const from = (page - 1) * perPage
  query = query.range(from, from + perPage - 1)

  const { data, error } = await query
  if (error) throw new Error(`listFeatures: ${error.message}`)
  return (data ?? []) as unknown as Feature[]
}

export async function getFeature(key: string): Promise<Feature | null> {
  const db = createServerClient()
  const { data, error } = await db
    .from('features')
    .select('*')
    .eq('key', key)
    .maybeSingle()

  if (error) throw new Error(`getFeature: ${error.message}`)
  return data as unknown as Feature | null
}

export async function createFeature(
  fields: CreateFeatureFields,
  createdBy: string,
): Promise<Feature> {
  const db = createServerClient()
  const { data, error } = await db
    .from('features')
    .insert({
      key: fields.key,
      module_prefix: fields.module_prefix,
      module_name: fields.module_name,
      title: fields.title,
      description: fields.description ?? null,
      user_story: fields.user_story ?? null,
      content: fields.content ?? null,
      status: fields.status ?? 'not_started',
      priority: fields.priority ?? null,
      note_tags: fields.note_tags ?? [],
      depends_on: fields.depends_on ?? [],
      blocks: fields.blocks ?? [],
      key_files: fields.key_files ?? [],
      updated_by: createdBy,
      metadata: {},
    })
    .select()
    .single()

  if (error) throw new Error(`createFeature: ${error.message}`)
  return data as unknown as Feature
}

export async function updateFeature(
  id: string,
  fields: UpdateFeatureFields,
  updatedBy: string,
): Promise<Feature> {
  const db = createServerClient()
  const { data, error } = await db
    .from('features')
    .update({ ...fields, updated_by: updatedBy })
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(`updateFeature: ${error.message}`)
  return data as unknown as Feature
}
