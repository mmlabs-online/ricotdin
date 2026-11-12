-- ARC-17: Google Drive storage.
--   drive_config    — the single connected Google account (written by scripts.connect_gdrive).
--                     client secret + refresh token AES-256-GCM encrypted (KEY_ENCRYPTION_SECRET).
--   storage_objects — storage key → Drive file id (+ size, type, md5) for every stored file.
-- ricotdin_service: read/write both. ricotdin_worker: read drive_config, read/write
-- storage_objects (pipeline reads audio, retention purge deletes it). ricotdin_app: nothing.
CREATE TABLE public.drive_config (
  id boolean PRIMARY KEY DEFAULT true CONSTRAINT drive_config_single_row CHECK (id),
  client_id text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 256),
  client_secret_ciphertext text NOT NULL,
  client_secret_iv text NOT NULL,
  client_secret_auth_tag text NOT NULL,
  refresh_token_ciphertext text NOT NULL,
  refresh_token_iv text NOT NULL,
  refresh_token_auth_tag text NOT NULL,
  root_folder_id text NOT NULL CHECK (root_folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  account_email text NOT NULL CHECK (char_length(account_email) BETWEEN 3 AND 320),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.storage_objects (
  key text PRIMARY KEY CHECK (char_length(key) BETWEEN 1 AND 121),
  file_id text NOT NULL UNIQUE CHECK (file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  content_type text NOT NULL,
  md5 text NULL CHECK (md5 IS NULL OR md5 ~ '^[0-9a-f]{32}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.drive_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storage_objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_all ON public.drive_config AS PERMISSIVE FOR ALL
  TO ricotdin_service USING (true) WITH CHECK (true);
CREATE POLICY worker_read ON public.drive_config AS PERMISSIVE FOR SELECT
  TO ricotdin_worker USING (true);
CREATE POLICY service_all ON public.storage_objects AS PERMISSIVE FOR ALL
  TO ricotdin_service, ricotdin_worker USING (true) WITH CHECK (true);

REVOKE ALL ON public.drive_config, public.storage_objects FROM PUBLIC, ricotdin_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.drive_config TO ricotdin_service;
GRANT SELECT ON public.drive_config TO ricotdin_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.storage_objects TO ricotdin_service, ricotdin_worker;
