-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "member_role" AS ENUM ('owner', 'editor', 'viewer');

-- CreateEnum
CREATE TYPE "member_status" AS ENUM ('active', 'invited', 'removed');

-- CreateEnum
CREATE TYPE "project_stage" AS ENUM ('planning', 'developing', 'paused', 'done');

-- CreateEnum
CREATE TYPE "task_priority" AS ENUM ('p0', 'p1', 'p2');

-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('todo', 'doing', 'done');

-- CreateEnum
CREATE TYPE "entry_type" AS ENUM ('note', 'design', 'adr', 'troubleshoot', 'command');

-- CreateEnum
CREATE TYPE "entry_status" AS ENUM ('draft', 'verified', 'archived');

-- CreateEnum
CREATE TYPE "transfer_type" AS ENUM ('export_json', 'export_markdown', 'import');

-- CreateEnum
CREATE TYPE "transfer_state" AS ENUM ('uploaded', 'validating', 'preview_ready', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email_normalized" VARCHAR(320) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "status" "user_status" NOT NULL DEFAULT 'active',
    "password_changed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "csrf_token_hash" VARCHAR(64) NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "member_role" NOT NULL DEFAULT 'viewer',
    "status" "member_status" NOT NULL DEFAULT 'active',
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("workspace_id","user_id")
);

-- CreateTable
CREATE TABLE "workspace_invites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "email_normalized" VARCHAR(320) NOT NULL,
    "role" "member_role" NOT NULL DEFAULT 'viewer',
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "invited_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_recovery_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_recovery_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "user_id" UUID NOT NULL,
    "theme" VARCHAR(16) NOT NULL DEFAULT 'system',
    "default_workspace_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "workspace_user_preferences" (
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tip_shown_at" TIMESTAMPTZ(3),
    "last_business_export_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "workspace_user_preferences_pkey" PRIMARY KEY ("workspace_id","user_id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "repo" VARCHAR(300),
    "stack" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "stage" "project_stage" NOT NULL DEFAULT 'planning',
    "next_step" VARCHAR(300) NOT NULL,
    "progress_manual" BOOLEAN NOT NULL DEFAULT false,
    "manual_progress" INTEGER,
    "color" VARCHAR(16),
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "origin_metadata" JSONB,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "priority" "task_priority" NOT NULL DEFAULT 'p2',
    "status" "task_status" NOT NULL DEFAULT 'todo',
    "due_date" DATE,
    "ai_context" VARCHAR(4000),
    "blocker" VARCHAR(4000),
    "done_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "origin_metadata" JSONB,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "development_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "log_date" DATE NOT NULL,
    "text" VARCHAR(4000) NOT NULL,
    "author_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "origin_metadata" JSONB,

    CONSTRAINT "development_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "type" "entry_type" NOT NULL DEFAULT 'note',
    "title" VARCHAR(200) NOT NULL,
    "summary" VARCHAR(300),
    "body" TEXT NOT NULL,
    "lang" VARCHAR(32),
    "project_id" UUID,
    "source" VARCHAR(32),
    "status" "entry_status" NOT NULL DEFAULT 'draft',
    "rating" INTEGER,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "origin_metadata" JSONB,

    CONSTRAINT "entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entry_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "saved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "saved_by" UUID NOT NULL,
    "source_version" INTEGER NOT NULL,

    CONSTRAINT "entry_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entry_usage" (
    "workspace_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entry_usage_pkey" PRIMARY KEY ("workspace_id","entry_id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name_normalized" VARCHAR(32) NOT NULL,
    "display_name" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entry_tags" (
    "workspace_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,

    CONSTRAINT "entry_tags_pkey" PRIMARY KEY ("entry_id","tag_id")
);

-- CreateTable
CREATE TABLE "task_entries" (
    "workspace_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_entries_pkey" PRIMARY KEY ("task_id","entry_id")
);

-- CreateTable
CREATE TABLE "ledger_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "record_date" DATE NOT NULL,
    "project_id" UUID,
    "tool" VARCHAR(32) NOT NULL,
    "scene" VARCHAR(32) NOT NULL,
    "minutes" INTEGER NOT NULL,
    "saved_minutes" INTEGER NOT NULL,
    "effect" INTEGER NOT NULL,
    "note" VARCHAR(4000),
    "entry_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "origin_metadata" JSONB,

    CONSTRAINT "ledger_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "scope" VARCHAR(64) NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "response_ref" JSONB,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "type" "transfer_type" NOT NULL,
    "state" "transfer_state" NOT NULL DEFAULT 'uploaded',
    "source_namespace" VARCHAR(64),
    "file_ref" VARCHAR(300),
    "file_hash" VARCHAR(64),
    "plan_hash" VARCHAR(64),
    "base_versions" JSONB,
    "counts" JSONB,
    "lease_until" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(64),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID NOT NULL,
    "entity_type" VARCHAR(32) NOT NULL,
    "source_id" VARCHAR(200) NOT NULL,
    "normalized_payload" JSONB NOT NULL,
    "validation_result" JSONB,
    "decision" VARCHAR(16),
    "before_image" JSONB,
    "applied_version" INTEGER,

    CONSTRAINT "import_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_entity_mappings" (
    "workspace_id" UUID NOT NULL,
    "source_namespace" VARCHAR(64) NOT NULL,
    "entity_type" VARCHAR(32) NOT NULL,
    "legacy_id" VARCHAR(200) NOT NULL,
    "entity_id" UUID NOT NULL,
    "source_updated_at" TIMESTAMPTZ(3),
    "last_imported_version" INTEGER,

    CONSTRAINT "import_entity_mappings_pkey" PRIMARY KEY ("workspace_id","source_namespace","entity_type","legacy_id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID,
    "actor_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "entity_type" VARCHAR(32),
    "entity_id" UUID,
    "request_id" VARCHAR(64),
    "result" VARCHAR(16) NOT NULL,
    "summary" VARCHAR(300),
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_normalized_key" ON "users"("email_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_absolute_expires_at_idx" ON "sessions"("user_id", "revoked_at", "absolute_expires_at");

-- CreateIndex
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_invites_token_hash_key" ON "workspace_invites"("token_hash");

-- CreateIndex
CREATE INDEX "workspace_invites_workspace_id_created_at_idx" ON "workspace_invites"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "account_recovery_tokens_token_hash_key" ON "account_recovery_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "account_recovery_tokens_user_id_expires_at_idx" ON "account_recovery_tokens"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "projects_workspace_id_updated_at_id_idx" ON "projects"("workspace_id", "updated_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "projects_workspace_id_last_activity_at_idx" ON "projects"("workspace_id", "last_activity_at");

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspace_id_id_key" ON "projects"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "tasks_workspace_id_updated_at_id_idx" ON "tasks"("workspace_id", "updated_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "tasks_workspace_id_status_due_date_id_idx" ON "tasks"("workspace_id", "status", "due_date", "id");

-- CreateIndex
CREATE INDEX "tasks_workspace_id_project_id_status_idx" ON "tasks"("workspace_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_workspace_id_id_key" ON "tasks"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "development_logs_workspace_id_log_date_created_at_id_idx" ON "development_logs"("workspace_id", "log_date" DESC, "created_at" DESC, "id");

-- CreateIndex
CREATE UNIQUE INDEX "development_logs_workspace_id_id_key" ON "development_logs"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "entries_workspace_id_updated_at_id_idx" ON "entries"("workspace_id", "updated_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "entries_workspace_id_status_type_updated_at_id_idx" ON "entries"("workspace_id", "status", "type", "updated_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "entries_workspace_id_project_id_idx" ON "entries"("workspace_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "entries_workspace_id_id_key" ON "entries"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "entry_revisions_workspace_id_entry_id_saved_at_idx" ON "entry_revisions"("workspace_id", "entry_id", "saved_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "entry_usage_entry_id_key" ON "entry_usage"("entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_workspace_id_name_normalized_key" ON "tags"("workspace_id", "name_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "tags_workspace_id_id_key" ON "tags"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "entry_tags_workspace_id_tag_id_entry_id_idx" ON "entry_tags"("workspace_id", "tag_id", "entry_id");

-- CreateIndex
CREATE INDEX "task_entries_workspace_id_entry_id_idx" ON "task_entries"("workspace_id", "entry_id");

-- CreateIndex
CREATE INDEX "ledger_records_workspace_id_record_date_scene_idx" ON "ledger_records"("workspace_id", "record_date", "scene");

-- CreateIndex
CREATE INDEX "ledger_records_workspace_id_project_id_record_date_idx" ON "ledger_records"("workspace_id", "project_id", "record_date");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_records_workspace_id_id_key" ON "ledger_records"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_user_id_workspace_id_scope_key_key" ON "idempotency_records"("user_id", "workspace_id", "scope", "key");

-- CreateIndex
CREATE INDEX "transfer_jobs_workspace_id_created_at_idx" ON "transfer_jobs"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "transfer_jobs_state_lease_until_created_at_idx" ON "transfer_jobs"("state", "lease_until", "created_at");

-- CreateIndex
CREATE INDEX "import_items_job_id_entity_type_idx" ON "import_items"("job_id", "entity_type");

-- CreateIndex
CREATE INDEX "audit_events_workspace_id_at_id_idx" ON "audit_events"("workspace_id", "at" DESC, "id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_recovery_tokens" ADD CONSTRAINT "account_recovery_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "development_logs" ADD CONSTRAINT "development_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_revisions" ADD CONSTRAINT "entry_revisions_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_usage" ADD CONSTRAINT "entry_usage_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_tags" ADD CONSTRAINT "entry_tags_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_tags" ADD CONSTRAINT "entry_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_entries" ADD CONSTRAINT "task_entries_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_entries" ADD CONSTRAINT "task_entries_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_records" ADD CONSTRAINT "ledger_records_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_records" ADD CONSTRAINT "ledger_records_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_records" ADD CONSTRAINT "ledger_records_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_jobs" ADD CONSTRAINT "transfer_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "transfer_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
