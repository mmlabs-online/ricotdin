-- Migration 011: folders table + folder_id on meetings

-- 1. Folders table
CREATE TABLE IF NOT EXISTS folders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive unique name per user
CREATE UNIQUE INDEX IF NOT EXISTS folders_user_name_ci
  ON folders (user_id, lower(name));

CREATE INDEX IF NOT EXISTS folders_user_id
  ON folders (user_id);

-- 2. RLS for folders — strict owner-only (no admin bypass: folder names are personal)
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own_folders"
  ON folders FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 3. Add folder_id to meetings
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS folder_id uuid
    REFERENCES folders(id)
    ON DELETE SET NULL;  -- deleting a folder moves meetings to Uncategorized (NULL), never deletes them

CREATE INDEX IF NOT EXISTS meetings_folder_id
  ON meetings (folder_id);
