-- ============================================================================
-- Migration 017: features table
-- ============================================================================
-- Feature registry seeded once from ai-instruction/features/ via
-- scripts/seed-features.ts.  After seeding the DB is the sole source of
-- truth — no runtime code reads the instruction files.
--
-- Admins can view and edit features at /admin/features.
-- Writes: service-role only (seeder + admin API routes).
-- Reads:  admin only via RLS.
--
-- Apply in Supabase dashboard → SQL editor.
-- ============================================================================

CREATE TABLE IF NOT EXISTS features (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,                    -- email of last human editor

  -- Stable identity (set at seed time, never changes)
  key           text        NOT NULL UNIQUE,   -- e.g. 'REC-01', 'PRP-05'
  source_path   text,                          -- e.g. 'ai-instruction/features/feature-Recording-REC.md'

  -- Module grouping (denormalised — same value for all features in a module)
  module_prefix text        NOT NULL,          -- e.g. 'REC', 'PRP'
  module_name   text        NOT NULL,          -- e.g. 'Recording', 'Processing Pipeline'

  -- Feature identity
  title         text        NOT NULL,          -- e.g. 'Toggle recording & mix sources'
  user_story    text,                          -- 'As a user, I want …'
  description   text,                          -- short one-liner (from tracking.md)

  -- Full editable body (markdown: Use Cases + Frontend + Backend sections)
  content       text,

  -- Status (normalised from ✅/❌/⚠️ in the source files)
  status        text        NOT NULL DEFAULT 'not_started'
                  CHECK (status IN ('done', 'partial', 'not_started')),

  -- Classification
  priority      text        CHECK (priority IN ('high', 'medium', 'low')),
  note_tags     text[]      NOT NULL DEFAULT '{}',   -- e.g. ['Blocker', 'Mandatory']

  -- Dependency graph (informational feature-code references, not FK constraints)
  depends_on    text[]      NOT NULL DEFAULT '{}',   -- e.g. ['PRP-01', 'AUT-04']
  blocks        text[]      NOT NULL DEFAULT '{}',

  -- Implementation pointers inherited from the module header
  key_files     text[]      NOT NULL DEFAULT '{}',

  -- Flexible overflow: module overview, data-flow diagram, extra per-module fields
  metadata      jsonb       NOT NULL DEFAULT '{}',

  -- Optional note left by the last editor
  change_note   text
);

-- Efficient filtering by module and status
CREATE INDEX IF NOT EXISTS features_module_prefix_idx ON features (module_prefix);
CREATE INDEX IF NOT EXISTS features_status_idx        ON features (status);
-- UNIQUE on key already creates an index

-- Auto-bump updated_at on every row change
CREATE OR REPLACE FUNCTION update_features_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER features_updated_at
  BEFORE UPDATE ON features
  FOR EACH ROW EXECUTE FUNCTION update_features_updated_at();

-- RLS: admin-only reads; all writes go through the service-role client
ALTER TABLE features ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_features"
  ON features FOR SELECT
  USING (auth.jwt()->>'user_role' = 'admin');
