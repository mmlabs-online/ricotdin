-- Reverse of 0006_worker_schedulers.sql. Audit rows and reconcile ledger rows stay.
DROP FUNCTION IF EXISTS public.retention_purge_audit(uuid, text, integer);
DROP FUNCTION IF EXISTS public.quota_reconcile_wallets(uuid);
DROP FUNCTION IF EXISTS public.legacy_reserve_refund(uuid);
DROP TABLE IF EXISTS public.scheduler_runs;
