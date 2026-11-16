-- PRF-09: GET /profile/activity reads the share rows that target the caller.
CREATE INDEX IF NOT EXISTS activity_log_target_created
  ON public.activity_log USING btree (target_user_id, created_at DESC)
  WHERE target_user_id IS NOT NULL;
