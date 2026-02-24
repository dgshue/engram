-- Fix: Re-apply identity framework migration with idempotent CREATE TYPE.
-- The original 20260221_add_identity_framework_tables migration failed because
-- CREATE TYPE statements lacked IF NOT EXISTS, causing a rollback that also
-- reverted the ALTER TABLE cloud_links ADD COLUMN cloud_sync_key.
-- All statements here are idempotent (IF NOT EXISTS / DO $$ EXCEPTION blocks).

-- Enums
DO $$ BEGIN
CREATE TYPE "TrustSignalType" AS ENUM ('SUCCESS', 'FAILURE', 'CORRECTION');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
CREATE TYPE "TaskStatus" AS ENUM ('ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
CREATE TYPE "ContractStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'VERIFIED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Missing column on cloud_links
ALTER TABLE "cloud_links" ADD COLUMN IF NOT EXISTS "cloud_sync_key" TEXT;

-- Trust signals
CREATE TABLE IF NOT EXISTS "trust_signals" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "signal_type" "TrustSignalType" NOT NULL,
    "context" TEXT NOT NULL,
    "category" TEXT,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "source_memory_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trust_signals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "trust_signals_user_id_created_at_idx" ON "trust_signals"("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "trust_signals_user_id_category_idx" ON "trust_signals"("user_id", "category");
CREATE INDEX IF NOT EXISTS "trust_signals_user_id_signal_type_idx" ON "trust_signals"("user_id", "signal_type");
CREATE INDEX IF NOT EXISTS "trust_signals_agent_id_created_at_idx" ON "trust_signals"("agent_id", "created_at");

-- Trust scores
CREATE TABLE IF NOT EXISTS "trust_scores" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "category" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "signal_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "correction_count" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trust_scores_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "trust_scores_user_id_category_idx" ON "trust_scores"("user_id", "category");
CREATE INDEX IF NOT EXISTS "trust_scores_user_id_computed_at_idx" ON "trust_scores"("user_id", "computed_at");
CREATE INDEX IF NOT EXISTS "trust_scores_agent_id_category_idx" ON "trust_scores"("agent_id", "category");

-- Capability checkpoints
CREATE TABLE IF NOT EXISTS "capability_checkpoints" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "capabilities" JSONB NOT NULL,
    "checkpoint_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "capability_checkpoints_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "capability_checkpoints_user_id_checkpoint_at_idx" ON "capability_checkpoints"("user_id", "checkpoint_at");
CREATE INDEX IF NOT EXISTS "capability_checkpoints_agent_id_checkpoint_at_idx" ON "capability_checkpoints"("agent_id", "checkpoint_at");

-- Experience weights
CREATE TABLE IF NOT EXISTS "experience_weights" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "category" TEXT NOT NULL,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "experience_weights_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "experience_weights_user_id_weight_idx" ON "experience_weights"("user_id", "weight" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "experience_weights_user_id_agent_id_category_key" ON "experience_weights"("user_id", "agent_id", "category");

-- Agent teams
CREATE TABLE IF NOT EXISTS "agent_teams" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "user_id" TEXT NOT NULL,
    "shared_capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trust_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "collaboration_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "agent_teams_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "agent_teams_user_id_idx" ON "agent_teams"("user_id");

-- Agent team members
CREATE TABLE IF NOT EXISTS "agent_team_members" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "role" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_team_members_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "agent_team_members_agent_id_idx" ON "agent_team_members"("agent_id");
CREATE UNIQUE INDEX IF NOT EXISTS "agent_team_members_team_id_agent_id_key" ON "agent_team_members"("team_id", "agent_id");

-- Agent team collaborations
CREATE TABLE IF NOT EXISTS "agent_team_collaborations" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "task_description" TEXT NOT NULL,
    "participant_agent_ids" TEXT[],
    "outcome" TEXT,
    "score" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_team_collaborations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "agent_team_collaborations_team_id_created_at_idx" ON "agent_team_collaborations"("team_id", "created_at");

-- Delegated tasks
CREATE TABLE IF NOT EXISTS "delegated_tasks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "assigned_to" TEXT NOT NULL,
    "assigned_by" TEXT NOT NULL,
    "task_description" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'ASSIGNED',
    "deadline" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "result" TEXT,
    "metadata" JSONB,
    "memory_id" TEXT,
    "template_id" TEXT,
    "contract_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "delegated_tasks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "delegated_tasks_user_id_status_idx" ON "delegated_tasks"("user_id", "status");
CREATE INDEX IF NOT EXISTS "delegated_tasks_assigned_to_status_idx" ON "delegated_tasks"("assigned_to", "status");
CREATE INDEX IF NOT EXISTS "delegated_tasks_assigned_by_idx" ON "delegated_tasks"("assigned_by");
CREATE INDEX IF NOT EXISTS "delegated_tasks_contract_id_idx" ON "delegated_tasks"("contract_id");

-- Delegation templates
CREATE TABLE IF NOT EXISTS "delegation_templates" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "task_type" TEXT NOT NULL,
    "required_capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "default_instructions" TEXT,
    "expected_outputs" TEXT,
    "typical_duration_ms" INTEGER,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "delegation_templates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "delegation_templates_user_id_task_type_idx" ON "delegation_templates"("user_id", "task_type");
CREATE UNIQUE INDEX IF NOT EXISTS "delegation_templates_user_id_name_key" ON "delegation_templates"("user_id", "name");

-- Delegation contracts
CREATE TABLE IF NOT EXISTS "delegation_contracts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "delegator" TEXT NOT NULL,
    "delegate" TEXT NOT NULL,
    "task_description" TEXT NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'PROPOSED',
    "terms" JSONB NOT NULL,
    "result" TEXT,
    "verified_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "delegation_contracts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "delegation_contracts_user_id_status_idx" ON "delegation_contracts"("user_id", "status");
CREATE INDEX IF NOT EXISTS "delegation_contracts_delegator_idx" ON "delegation_contracts"("delegator");
CREATE INDEX IF NOT EXISTS "delegation_contracts_delegate_idx" ON "delegation_contracts"("delegate");

-- Foreign keys
DO $$ BEGIN
ALTER TABLE "agent_team_members" ADD CONSTRAINT "agent_team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "agent_teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
ALTER TABLE "agent_team_collaborations" ADD CONSTRAINT "agent_team_collaborations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "agent_teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
ALTER TABLE "delegated_tasks" ADD CONSTRAINT "delegated_tasks_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "delegation_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
ALTER TABLE "delegated_tasks" ADD CONSTRAINT "delegated_tasks_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "delegation_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
