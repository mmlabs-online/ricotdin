-- Migration 013: add position column to folders for drag-and-drop ordering

ALTER TABLE folders ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;

-- Initialise positions using current alphabetical order per user
-- so existing data gets a sensible starting order
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY lower(name)) - 1 AS rn
  FROM folders
)
UPDATE folders SET position = ranked.rn FROM ranked WHERE folders.id = ranked.id;

CREATE INDEX IF NOT EXISTS folders_user_position ON folders (user_id, position);
