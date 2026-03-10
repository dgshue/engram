-- ============================================================================
-- Migration: 20260310_rls_enforcement
-- Enable full RLS enforcement via SET LOCAL ROLE app.
--
-- Context:
--   The RLS interceptor sets `app.current_account_id` but the DB connection
--   runs as a BYPASSRLS role, making all RLS policies effectively ignored.
--   This migration ensures the `app` role exists with proper grants so the
--   interceptor can do SET LOCAL ROLE app within each request transaction.
--
-- Safe to re-run: all statements are idempotent.
-- ============================================================================

-- ============================================================================
-- STEP 1: Create the `app` role if it doesn't already exist
-- ============================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- ============================================================================
-- STEP 2: Grant schema access
-- ============================================================================
GRANT USAGE ON SCHEMA public TO app;

-- ============================================================================
-- STEP 3: Grant table + sequence access (existing tables)
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app;

-- ============================================================================
-- STEP 4: Default privileges so future tables auto-grant to app
-- ============================================================================
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app;

-- ============================================================================
-- STEP 5: Also grant function execution (for rls_account_id(), rls_user_ids(), etc.)
-- ============================================================================
GRANT EXECUTE ON FUNCTION rls_account_id() TO app;
GRANT EXECUTE ON FUNCTION rls_user_ids() TO app;
GRANT EXECUTE ON FUNCTION rls_agent_ids() TO app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO app;

-- ============================================================================
-- STEP 6: Enable RLS on tables added after the initial RLS migration that
--         were missed (idempotent via IF NOT EXISTS pattern for policies).
-- ============================================================================

-- dedup_candidates: links through memory_id_1/memory_id_2 → memories → user_id
-- No direct userId — filter through memory ownership chain.
ALTER TABLE dedup_candidates ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_policies
    WHERE tablename = 'dedup_candidates' AND policyname = 'account_isolation'
  ) THEN
    CREATE POLICY account_isolation ON dedup_candidates FOR ALL USING (
      rls_account_id() IS NULL
      OR memory_id_1 IN (
        SELECT id FROM memories WHERE user_id IN (SELECT rls_user_ids())
      )
    );
  END IF;
END $$;

-- ============================================================================
-- NOTE: Tables intentionally WITHOUT RLS (system/global tables)
-- These have no user/account scoping and are safe for cross-account reads:
--   - dream_cycle_runs       (dream cycle mutex, instanceId only)
--   - dream_cycle_stage_runs (audit log per run, no userId)
--   - awareness_cycle_runs   (system-level run tracker)
--   - system_metrics         (key/value health store, global)
--   - inbound_emails         (email ingestion queue, no account col)
--   - monitoring_snapshots   (global system health)
--   - fog_index_snapshots    (global clarity scores)
--   - eval_runs              (global eval tracking)
--   - drift_snapshots        (global drift tracking)
--   - memory_clusters        (background clustering output)
--   - ensemble_* tables      (model config & reembed jobs)
-- ============================================================================
