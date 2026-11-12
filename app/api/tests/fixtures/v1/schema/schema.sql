-- ============================================================================
-- Meeting Assistant — Postgres / Supabase schema (MVP)
-- ============================================================================
-- Run order matters. Apply this file as a single migration.
-- Target: Supabase (Postgres 15+) with the `vector` (pgvector) extension.
--
-- Conventions:
--   * Primary keys are uuid (gen_random_uuid()).
--   * All timestamps are timestamptz, stored in UTC.
--   * Child rows are removed via ON DELETE CASCADE when a meeting is deleted.
--   * Row Level Security (RLS) is ON for every table; a user only ever sees
--     their own rows. For a single-user MVP you may disable RLS, but keeping
--     it on now means no rework when you add real auth.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Extensions
-- ----------------------------------------------------------------------------
create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "vector";      -- pgvector for embeddings


-- ----------------------------------------------------------------------------
-- 2. Enums
-- ----------------------------------------------------------------------------
-- Lifecycle of a meeting through the processing pipeline.
create type meeting_status as enum (
  'pending',      -- audio uploaded, not processed yet
  'processing',   -- Gemini pipeline running
  'done',         -- transcript + notes + todos ready
  'failed'        -- pipeline errored (see error_message)
);

create type todo_status as enum (
  'open',
  'done',
  'dismissed'
);

create type chat_role as enum (
  'user',
  'assistant'
);


-- ----------------------------------------------------------------------------
-- 3. Shared trigger: auto-maintain updated_at
-- ----------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4. meetings  — one row per recorded meeting (the aggregate root)
-- ----------------------------------------------------------------------------
create table meetings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,

  title            text not null default 'Untitled meeting',
  status           meeting_status not null default 'pending',

  -- Storage: path of the audio object in the Supabase Storage bucket
  -- (e.g. 'recordings/<user_id>/<meeting_id>.webm'). Audio is optional to keep
  -- long-term; you may null this after processing to save free-tier storage.
  audio_path       text,
  duration_seconds integer,
  language         text,                       -- detected primary language, e.g. 'vi', 'en'

  -- AI outputs (filled by the pipeline)
  summary          text,                        -- short summary
  notes            text,                        -- structured meeting note (markdown)

  -- Diagnostics
  error_message    text,                        -- populated when status = 'failed'

  started_at       timestamptz,                 -- when the meeting actually took place
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create trigger trg_meetings_updated_at
  before update on meetings
  for each row execute function set_updated_at();

create index idx_meetings_user_id    on meetings (user_id);
create index idx_meetings_status     on meetings (status);
create index idx_meetings_created_at on meetings (created_at desc);


-- ----------------------------------------------------------------------------
-- 5. transcript_segments — the time-stamped, speaker-attributed transcript
-- ----------------------------------------------------------------------------
-- This is the canonical transcript: one row per utterance/segment. Used to
-- render the transcript UI and as the citation target for todos / chat answers.
create table transcript_segments (
  id            uuid primary key default gen_random_uuid(),
  meeting_id    uuid not null references meetings (id) on delete cascade,

  segment_index integer not null,              -- order within the meeting (0-based)
  speaker       text,                          -- diarization label, e.g. 'Speaker 1'
  start_ms      integer not null,              -- offset from meeting start
  end_ms        integer not null,
  text          text not null,

  created_at    timestamptz not null default now(),

  unique (meeting_id, segment_index)
);

create index idx_segments_meeting on transcript_segments (meeting_id, segment_index);


-- ----------------------------------------------------------------------------
-- 6. transcript_chunks — embedding store for RAG (pgvector)
-- ----------------------------------------------------------------------------
-- Transcript is re-chunked into retrieval-sized passages (a chunk usually spans
-- several segments). Each chunk carries its own embedding + the time range it
-- covers, so chat answers can cite a timestamp.
--
-- Embedding dimension = 768. This matches Gemini's `gemini-embedding-001`
-- called with output_dimensionality = 768 (the model also supports 1536/3072).
-- IMPORTANT: the number below MUST equal the dimension you request from Gemini,
-- and you cannot change a populated vector column's dimension without a rebuild.
create table transcript_chunks (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references meetings (id) on delete cascade,

  chunk_index integer not null,
  content     text not null,                   -- the chunk text that was embedded
  embedding   vector(768) not null,

  -- time range this chunk covers, for citation
  start_ms    integer,
  end_ms      integer,
  token_count integer,

  created_at  timestamptz not null default now(),

  unique (meeting_id, chunk_index)
);

-- HNSW index for cosine similarity search. HNSW gives strong recall and fast
-- queries. Cosine (vector_cosine_ops) pairs with normalized embeddings, which
-- is what Gemini returns. For very small datasets the planner may seqscan
-- anyway — that's fine for an MVP.
create index idx_chunks_embedding
  on transcript_chunks
  using hnsw (embedding vector_cosine_ops);

create index idx_chunks_meeting on transcript_chunks (meeting_id);


-- ----------------------------------------------------------------------------
-- 7. todos — action items extracted from the meeting
-- ----------------------------------------------------------------------------
create table todos (
  id                uuid primary key default gen_random_uuid(),
  meeting_id        uuid not null references meetings (id) on delete cascade,

  content           text not null,
  assignee          text,                       -- free text if a name was mentioned
  due_date          date,                       -- null if no date was stated
  status            todo_status not null default 'open',

  -- citation: which segment this was inferred from (nullable)
  source_segment_id uuid references transcript_segments (id) on delete set null,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger trg_todos_updated_at
  before update on todos
  for each row execute function set_updated_at();

create index idx_todos_meeting on todos (meeting_id);
create index idx_todos_status  on todos (status);


-- ----------------------------------------------------------------------------
-- 8. calendar_suggestions — datetime mentions surfaced for the user to confirm
-- ----------------------------------------------------------------------------
-- MVP only surfaces these (e.g. as an .ics download). No OAuth / auto-create.
create table calendar_suggestions (
  id                uuid primary key default gen_random_uuid(),
  meeting_id        uuid not null references meetings (id) on delete cascade,

  title             text not null,              -- proposed event title
  proposed_at       timestamptz,                -- parsed datetime, null if vague
  raw_mention       text,                       -- the original phrasing in the meeting
  source_segment_id uuid references transcript_segments (id) on delete set null,

  dismissed         boolean not null default false,
  created_at        timestamptz not null default now()
);

create index idx_calsug_meeting on calendar_suggestions (meeting_id);


-- ----------------------------------------------------------------------------
-- 9. chat_sessions / chat_messages — RAG chatbot history
-- ----------------------------------------------------------------------------
-- A session can be scoped to one meeting or span all of the user's meetings
-- (meeting_id null => cross-meeting Q&A).
create table chat_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  meeting_id  uuid references meetings (id) on delete cascade,

  title       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger trg_chat_sessions_updated_at
  before update on chat_sessions
  for each row execute function set_updated_at();

create index idx_chat_sessions_user    on chat_sessions (user_id);
create index idx_chat_sessions_meeting on chat_sessions (meeting_id);

create table chat_messages (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references chat_sessions (id) on delete cascade,

  role        chat_role not null,
  content     text not null,

  -- citations: array of { chunk_id, meeting_id, start_ms, end_ms } objects the
  -- assistant used to ground its answer. Stored as jsonb for flexibility.
  citations   jsonb not null default '[]'::jsonb,

  created_at  timestamptz not null default now()
);

create index idx_chat_messages_session on chat_messages (session_id, created_at);


-- ----------------------------------------------------------------------------
-- 10. RAG retrieval function (call via Supabase RPC)
-- ----------------------------------------------------------------------------
-- pgvector similarity search is exposed to the app as an RPC. Pass the query
-- embedding (768-dim), how many chunks to return, and optionally a meeting_id
-- to restrict the search to a single meeting (null = search all of the user's
-- meetings the caller is allowed to see, enforced by RLS on the underlying table).
--
-- Returns cosine similarity in [0,1] (1 = identical). The `<=>` operator is
-- cosine DISTANCE, so similarity = 1 - distance.
create or replace function match_transcript_chunks (
  query_embedding vector(768),
  match_count     int default 6,
  filter_meeting_id uuid default null
)
returns table (
  id          uuid,
  meeting_id  uuid,
  content     text,
  start_ms    integer,
  end_ms      integer,
  similarity  float
)
language sql
stable
as $$
  select
    c.id,
    c.meeting_id,
    c.content,
    c.start_ms,
    c.end_ms,
    1 - (c.embedding <=> query_embedding) as similarity
  from transcript_chunks c
  where filter_meeting_id is null or c.meeting_id = filter_meeting_id
  order by c.embedding <=> query_embedding
  limit match_count;
$$;


-- ----------------------------------------------------------------------------
-- 11. Row Level Security
-- ----------------------------------------------------------------------------
-- Each table is locked to the owning user. Child tables resolve ownership
-- through their parent meeting. auth.uid() is the logged-in Supabase user.

alter table meetings              enable row level security;
alter table transcript_segments   enable row level security;
alter table transcript_chunks     enable row level security;
alter table todos                 enable row level security;
alter table calendar_suggestions  enable row level security;
alter table chat_sessions         enable row level security;
alter table chat_messages         enable row level security;

-- meetings: direct ownership
create policy "own meetings"
  on meetings for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- helper: ownership via parent meeting
create policy "own transcript_segments"
  on transcript_segments for all
  using (exists (select 1 from meetings m where m.id = meeting_id and m.user_id = auth.uid()))
  with check (exists (select 1 from meetings m where m.id = meeting_id and m.user_id = auth.uid()));

create policy "own transcript_chunks"
  on transcript_chunks for all
  using (exists (select 1 from meetings m where m.id = meeting_id and m.user_id = auth.uid()))
  with check (exists (select 1 from meetings m where m.id = meeting_id and m.user_id = auth.uid()));

create policy "own todos"
  on todos for all
  using (exists (select 1 from meetings m where m.id = meeting_id and m.user_id = auth.uid()))
  with check (exists (select 1 from meetings m where m.id = meeting_id and m.user_id = auth.uid()));

create policy "own calendar_suggestions"
  on calendar_suggestions for all
  using (exists (select 1 from meetings m where m.id = meeting_id and m.user_id = auth.uid()))
  with check (exists (select 1 from meetings m where m.id = meeting_id and m.user_id = auth.uid()));

create policy "own chat_sessions"
  on chat_sessions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "own chat_messages"
  on chat_messages for all
  using (exists (select 1 from chat_sessions s where s.id = session_id and s.user_id = auth.uid()))
  with check (exists (select 1 from chat_sessions s where s.id = session_id and s.user_id = auth.uid()));

-- NOTE: the processing pipeline (server-side) should use the Supabase SERVICE
-- ROLE key, which bypasses RLS, so background writes to transcripts/chunks work
-- regardless of an active user session. Never expose the service role key to
-- the browser.

-- ============================================================================
-- End of schema
-- ============================================================================