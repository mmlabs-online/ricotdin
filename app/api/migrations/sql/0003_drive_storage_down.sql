-- Reverse of 0003_drive_storage.sql. Drops the Drive configuration and the key → file id map
-- (the files themselves stay in Drive).
DROP TABLE IF EXISTS public.storage_objects;
DROP TABLE IF EXISTS public.drive_config;
