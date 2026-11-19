REVOKE UPDATE (health_models) ON public.admin_config FROM ricotdin_worker;
ALTER TABLE public.admin_config DROP COLUMN IF EXISTS health_models;
