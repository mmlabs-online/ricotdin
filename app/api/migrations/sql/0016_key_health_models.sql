-- ADM-12: the key health check also records, per key, which allowed models the key can call:
-- {"<model>": "ok" | "limited" | "unavailable" | "unknown"}. NULL = models not checked (the key
-- failed its check, or the provider has no generation models). Admin-only like the other
-- health columns: ricotdin_app has no access to admin_config.
ALTER TABLE public.admin_config ADD COLUMN health_models jsonb;

-- The worker writes it with the other key health columns (0005).
GRANT UPDATE (health_models) ON public.admin_config TO ricotdin_worker;
