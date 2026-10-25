// TypeScript types mirroring the Postgres schema (schema.sql + migrations/).
// Keep in sync with any schema migrations.

export type UserRole = 'user' | 'admin'
export type FolderRole = 'owner' | 'editor' | 'viewer'
export type FolderRow = {
  id: string
  user_id: string
  name: string
  position: number
  created_at: string
  updated_at: string
}
export type FolderWithRole = FolderRow & {
  myRole: FolderRole
  ownerUsername: string | null  // null when myRole = 'owner'; set for shared folders
  memberCount: number           // number of people this folder is shared with (owned folders only; 0 for shared-with-me)
}
export type FolderShareRow = {
  id: string
  folder_id: string
  user_id: string
  role: 'editor' | 'viewer'
  invited_by: string | null
  created_at: string
}
export type FolderShareMember = {
  userId: string
  username: string
  role: 'editor' | 'viewer'
}
export type MeetingStatus = 'pending' | 'processing' | 'done' | 'failed'
export type MeetingSource = 'recorded' | 'uploaded' | 'video'
export type StorageProvider = 'supabase' | 'r2'
export type TodoStatus = 'open' | 'done' | 'dismissed'
export type ChatRole = 'user' | 'assistant'
export type UsageUnit = 'tokens' | 'audio_seconds'
export type UsageStatus = 'ok' | 'rate_limited' | 'error'
export type QuotaLedgerReason = 'topup' | 'admin_grant' | 'generate' | 'agent_query' | 'refund' | 'adjustment'

export type QuotaWallet = {
  user_id: string
  audio_seconds_remaining: number
  agent_queries_remaining: number
  updated_at: string
}

export type QuotaLedger = {
  id: string
  user_id: string
  delta_audio_seconds: number
  delta_agent_queries: number
  reason: QuotaLedgerReason
  dedup_key: string | null
  meeting_id: string | null
  created_by: string | null
  metadata: Record<string, unknown>
  created_at: string
}

// Citation object stored in chat_messages.citations (jsonb)
export type Citation = {
  chunk_id: string
  meeting_id: string
  start_ms: number
  end_ms: number
}

// ---------------------------------------------------------------------------
// Row shapes — what you get back from SELECT *
// ---------------------------------------------------------------------------

export type Profile = {
  id: string       // same UUID as auth.users.id
  username: string // unique, lowercase, 3-30 chars [a-z0-9_-]
  role: UserRole
  created_at: string
  display_name?: string | null
  avatar_key?: string | null
  theme_preference?: 'luxury' | 'default' | 'playful' | null
  default_provider?: string | null // AIP-06 (PRF-08)
  default_model?: string | null     // AIP-06 (PRF-08)
}

// Use `type` aliases (not `interface`) for Row shapes so that when supabase-js v2
// intersects them with `Record<string, unknown>` in its TablesAndViews computation,
// TypeScript can correctly resolve property types via the intersection.
// With `interface`, the column resolver fails and returns SelectQueryError.
export type Meeting = {
  id: string
  user_id: string
  title: string
  status: MeetingStatus
  source: MeetingSource
  storage_provider: StorageProvider
  audio_path: string | null
  /** Set when the retention job deleted the audio (PRV-02, migration 032). */
  audio_purged_at: string | null
  duration_seconds: number | null
  language: string | null
  summary: string | null
  notes: string | null
  error_message: string | null
  started_at: string | null
  pinned_at: string | null
  folder_id: string | null
  generation_provider: string | null
  generation_model: string | null
  created_at: string
  updated_at: string
}

export type TranscriptSegment = {
  id: string
  meeting_id: string
  segment_index: number
  speaker: string | null
  start_ms: number
  end_ms: number
  text: string
  confidence: number | null
  created_at: string
}

export type TranscriptChunk = {
  id: string
  meeting_id: string
  chunk_index: number
  content: string
  // pgvector returns a number array; embeddings are dimension 768
  embedding: number[]
  start_ms: number | null
  end_ms: number | null
  token_count: number | null
  created_at: string
}

export type Todo = {
  id: string
  meeting_id: string
  content: string
  assignee: string | null
  due_date: string | null
  status: TodoStatus
  source_segment_id: string | null
  created_at: string
  updated_at: string
}

export type CalendarSuggestion = {
  id: string
  meeting_id: string
  title: string
  proposed_at: string | null
  raw_mention: string | null
  source_segment_id: string | null
  dismissed: boolean
  created_at: string
}

export type ChatSession = {
  id: string
  user_id: string
  meeting_id: string | null
  folder_id: string | null   // set for folder-scoped sessions (RAG-04)
  title: string | null
  created_at: string
  updated_at: string
}

export type ChatMessage = {
  id: string
  session_id: string
  role: ChatRole
  content: string
  citations: Citation[]
  created_at: string
}

export type UsageLog = {
  id: string
  created_at: string
  provider: string
  model: string
  operation: string
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  audio_seconds: number | null
  unit: UsageUnit
  quantity: number
  status: UsageStatus
  http_code: number | null
  meeting_id: string | null
  user_id: string | null
}

export type ConfigEntryStatus = 'active' | 'disabled'

// Full admin_config DB row — value_ciphertext/value_iv/value_auth_tag are server-only.
// NEVER return these fields in any API response or log them.
export type AdminConfigRow = {
  id: string
  created_at: string
  updated_at: string
  config_key: string       // e.g. 'gemini_api_key', 'speechmatics_api_key'
  label: string
  value_ciphertext: string // AES-256-GCM ciphertext (base64) — NEVER expose to client
  value_iv: string         // GCM IV (base64) — NEVER expose to client
  value_auth_tag: string   // GCM auth tag (base64) — NEVER expose to client
  last4: string
  status: ConfigEntryStatus
  disabled_reason: string | null
  last_used_at: string | null
  created_by: string | null
  health_status: HealthCheckStatus | null    // 029: last health-check verdict
  health_checked_at: string | null           // 029: when the verdict was recorded
  health_detail: string | null               // 029: human-readable verdict detail
}

// Per-key health-check verdict (migration 029). See lib/keys/healthcheck.ts.
export type HealthCheckStatus = 'healthy' | 'unhealthy' | 'unknown'

// Safe display shape — never contains ciphertext or plaintext value.
export type MaskedAdminConfig = {
  id: string
  created_at: string
  config_key: string
  label: string
  last4: string
  status: ConfigEntryStatus
  disabled_reason: string | null
  last_used_at: string | null
  health_status: HealthCheckStatus | null
  health_checked_at: string | null
  health_detail: string | null
}

// ---------------------------------------------------------------------------
// Database interface for Supabase generic typing
// createClient<Database>() gives column-level type inference on all queries.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// supabase-js v2 generic type compatibility notes
//
// supabase-js v2 checks `Database['public'] extends GenericSchema` where:
//   GenericSchema = { Tables: Record<string, GenericTable>; Views: Record<string, GenericView>; Functions: ... }
//
// Problem: TypeScript's conditional-type `extends` check does NOT treat a
// named-property object type (e.g. `{ meetings: X }`) as satisfying
// `Record<string, GenericTable>`, even if each named property extends GenericTable.
// The check requires an explicit index signature.
//
// Fix: intersect the named Tables object with an index-signature type whose value
// type is compatible with (i.e. not narrower than) our specific table shapes.
// This preserves the per-table named types for IDE autocomplete while letting the
// generic constraint pass. Same treatment for Views.
// ---------------------------------------------------------------------------

// Minimum shape required by supabase-js GenericTable constraint.
// All our table types already satisfy these fields; the intersection is a no-op
// on named table access but adds the required index signature to the Tables object.
type NoRelationships = never[]
type MinTableShape = {
  Row: Record<string, unknown>
  Insert: Record<string, unknown>
  Update: Record<string, unknown>
  Relationships: NoRelationships
}

export interface Database {
  public: {
    // Intersection with `{ [k: string]: MinTableShape }` adds the index signature that
    // supabase-js needs to satisfy `Record<string, GenericTable>`.
    Tables: {
      profiles: {
        Row: Profile
        Insert: {
          id: string
          username: string
          role?: UserRole
          created_at?: string
        }
        Update: Partial<Profile>
        Relationships: NoRelationships
      }
      meetings: {
        Row: Meeting
        // Nullable DB columns omit correctly — required only: user_id.
        // title/status have DB defaults so are optional here.
        Insert: {
          id?: string
          user_id: string
          title?: string
          status?: MeetingStatus
          source?: MeetingSource
          storage_provider?: StorageProvider
          audio_path?: string | null
          audio_purged_at?: string | null
          duration_seconds?: number | null
          language?: string | null
          summary?: string | null
          notes?: string | null
          error_message?: string | null
          started_at?: string | null
          pinned_at?: string | null
          folder_id?: string | null
          generation_provider?: string | null
          generation_model?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Meeting>
        Relationships: NoRelationships
      }
      folders: {
        Row: FolderRow
        Insert: {
          id?: string
          user_id: string
          name: string
          position?: number
          created_at?: string
          updated_at?: string
        }
        Update: Partial<FolderRow>
        Relationships: NoRelationships
      }
      folder_shares: {
        Row: FolderShareRow
        Insert: {
          id?: string
          folder_id: string
          user_id: string
          role: 'editor' | 'viewer'
          invited_by?: string | null
          created_at?: string
        }
        Update: { role?: 'editor' | 'viewer' }
        Relationships: NoRelationships
      }
      transcript_segments: {
        Row: TranscriptSegment
        Insert: {
          id?: string
          meeting_id: string
          segment_index: number
          speaker?: string | null
          start_ms: number
          end_ms: number
          text: string
          confidence?: number | null
          created_at?: string
        }
        Update: Partial<TranscriptSegment>
        Relationships: NoRelationships
      }
      transcript_chunks: {
        Row: TranscriptChunk
        Insert: {
          id?: string
          meeting_id: string
          chunk_index: number
          content: string
          embedding: number[]
          start_ms?: number | null
          end_ms?: number | null
          token_count?: number | null
          created_at?: string
        }
        Update: Partial<TranscriptChunk>
        Relationships: NoRelationships
      }
      todos: {
        Row: Todo
        Insert: {
          id?: string
          meeting_id: string
          content: string
          assignee?: string | null
          due_date?: string | null
          status?: TodoStatus
          source_segment_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Todo>
        Relationships: NoRelationships
      }
      calendar_suggestions: {
        Row: CalendarSuggestion
        Insert: {
          id?: string
          meeting_id: string
          title: string
          proposed_at?: string | null
          raw_mention?: string | null
          source_segment_id?: string | null
          dismissed?: boolean
          created_at?: string
        }
        Update: Partial<CalendarSuggestion>
        Relationships: NoRelationships
      }
      chat_sessions: {
        Row: ChatSession
        Insert: {
          id?: string
          user_id: string
          meeting_id?: string | null
          title?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<ChatSession>
        Relationships: NoRelationships
      }
      chat_messages: {
        Row: ChatMessage
        Insert: {
          id?: string
          session_id: string
          role: ChatRole
          content: string
          citations?: Citation[]
          created_at?: string
        }
        Update: Partial<ChatMessage>
        Relationships: NoRelationships
      }
      usage_log: {
        Row: UsageLog
        Insert: {
          id?: string
          created_at?: string
          provider: string
          model: string
          operation: string
          input_tokens?: number | null
          output_tokens?: number | null
          total_tokens?: number | null
          audio_seconds?: number | null
          unit: UsageUnit
          quantity: number
          status?: UsageStatus
          http_code?: number | null
          meeting_id?: string | null
          user_id?: string | null
        }
        Update: Partial<UsageLog>
        Relationships: NoRelationships
      }
      quota_wallets: {
        Row: QuotaWallet
        Insert: {
          user_id: string
          audio_seconds_remaining?: number
          agent_queries_remaining?: number
          updated_at?: string
        }
        Update: Partial<QuotaWallet>
        Relationships: NoRelationships
      }
      quota_ledger: {
        Row: QuotaLedger
        Insert: {
          id?: string
          user_id: string
          delta_audio_seconds?: number
          delta_agent_queries?: number
          reason: QuotaLedgerReason
          dedup_key?: string | null
          meeting_id?: string | null
          created_by?: string | null
          metadata?: Record<string, unknown>
          created_at?: string
        }
        Update: Partial<QuotaLedger>
        Relationships: NoRelationships
      }
      admin_config: {
        Row: AdminConfigRow
        Insert: {
          id?: string
          created_at?: string
          updated_at?: string
          config_key: string
          label: string
          value_ciphertext: string
          value_iv: string
          value_auth_tag: string
          last4: string
          status?: ConfigEntryStatus
          disabled_reason?: string | null
          last_used_at?: string | null
          created_by?: string | null
        }
        Update: Partial<AdminConfigRow>
        Relationships: NoRelationships
      }
    } & { [tableName: string]: MinTableShape }
    // No views in this schema.
    // supabase CLI generates `{ [_ in never]: never }` for empty views. This is
    // NOT the same as `{}` or `Record<never, never>` — as a mapped type it satisfies
    // the GenericSchema `Views: Record<string, GenericView>` constraint vacuously,
    // while `Tables & { [_ in never]: never }` = `Tables` (identity intersection),
    // so the table types are preserved unchanged.
    Views: { [_ in never]: never }
    Functions: {
      quota_apply_movement: {
        Args: {
          p_user_id: string
          p_delta_audio_seconds: number
          p_delta_agent_queries: number
          p_reason: string
          p_dedup_key: string | null
          p_allow_overdraw: boolean
          p_meeting_id: string | null
          p_created_by: string | null
          p_metadata: Record<string, unknown>
        }
        Returns: Array<{ status: string; audio_remaining: number; agent_remaining: number }>
      }
      match_transcript_chunks: {
        Args: {
          query_embedding: number[]
          match_count?: number
          filter_meeting_id?: string | null
        }
        Returns: Array<{
          id: string
          meeting_id: string
          content: string
          start_ms: number
          end_ms: number
          similarity: number
        }>
      }
    }
    Enums: {
      meeting_status: MeetingStatus
      todo_status: TodoStatus
      chat_role: ChatRole
    }
  }
}
