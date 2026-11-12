-- Migration 023: Revoke column-level SELECT on encrypted columns in admin_config
--
-- FINDING-4 (MEDIUM): The admin_read_admin_config SELECT policy had no column restriction.
-- An admin calling the Supabase REST API directly (/rest/v1/admin_config?select=*)
-- could read value_ciphertext, value_iv, and value_auth_tag for all stored provider
-- keys — violating the CLAUDE.md contract: "key_ciphertext, key_iv, key_auth_tag are
-- NEVER returned in any API response, ever."
--
-- Fix (option A): REVOKE column-level SELECT on the three encrypted columns.
-- The service-role client (lib/keys/provider.ts) bypasses this restriction and can
-- still read ciphertext for decryption. Admin REST/PostgREST callers cannot.
--
-- Two-sided test:
--   - lib/keys/provider.ts (service-role) reads admin_config → ciphertext columns readable ✓
--   - Admin REST GET /rest/v1/admin_config?select=* → value_ciphertext omitted / error ✓

REVOKE SELECT (value_ciphertext, value_iv, value_auth_tag)
  ON admin_config
  FROM authenticated;
