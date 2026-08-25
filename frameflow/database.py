from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator


SCHEMA_VERSION = 16


def utcnow() -> str:
    return datetime.now(UTC).isoformat()


_BASE_SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    document_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_profiles (
    id TEXT PRIMARY KEY,
    provider_type TEXT NOT NULL,
    display_name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    credential_ref TEXT,
    model_config_json TEXT NOT NULL DEFAULT '{}',
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_health_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS capability_bindings (
    capability TEXT PRIMARY KEY,
    provider_profile_id TEXT NOT NULL,
    model TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(provider_profile_id) REFERENCES provider_profiles(id)
);
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    task_type TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_profile_id TEXT,
    provider_model TEXT,
    request_json TEXT NOT NULL,
    result_json TEXT,
    error_kind TEXT,
    error_message TEXT,
    paid INTEGER NOT NULL DEFAULT 0,
    confirmed_at TEXT,
    provider_task_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    artifact_type TEXT NOT NULL,
    role TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    local_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    mime_type TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    provider_profile_id TEXT,
    provider_model TEXT,
    prompt_version TEXT,
    task_id TEXT,
    qa_owner TEXT,
    qa_decision TEXT NOT NULL DEFAULT 'Pending',
    status TEXT NOT NULL DEFAULT 'generated_pending_qa',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);
CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    skill_version TEXT NOT NULL,
    status TEXT NOT NULL,
    input_json TEXT NOT NULL,
    output_json TEXT,
    gate_result_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
"""

_V2_UP = """
ALTER TABLE artifacts ADD COLUMN logical_asset_id TEXT;
ALTER TABLE artifacts ADD COLUMN asset_class TEXT;
ALTER TABLE artifacts ADD COLUMN asset_role TEXT;
ALTER TABLE artifacts ADD COLUMN collection TEXT NOT NULL DEFAULT 'intake';
ALTER TABLE artifacts ADD COLUMN intake_status TEXT NOT NULL DEFAULT 'mapped';
ALTER TABLE artifacts ADD COLUMN source_type TEXT;
ALTER TABLE artifacts ADD COLUMN generation_id TEXT;
ALTER TABLE artifacts ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE artifacts ADD COLUMN qa_report_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE artifacts ADD COLUMN rejection_reason TEXT;
ALTER TABLE artifacts ADD COLUMN supersedes_artifact_id TEXT;
ALTER TABLE artifacts ADD COLUMN updated_at TEXT;

CREATE TABLE IF NOT EXISTS asset_qa_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    logical_asset_id TEXT NOT NULL,
    qa_owner TEXT NOT NULL,
    qa_type TEXT NOT NULL,
    status TEXT NOT NULL,
    decision TEXT,
    report_json TEXT NOT NULL DEFAULT '{}',
    provider_profile_id TEXT,
    provider_model TEXT,
    capability TEXT,
    blocked_reason TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_versions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    logical_asset_id TEXT NOT NULL,
    asset_class TEXT NOT NULL,
    version INTEGER NOT NULL,
    artifact_id TEXT NOT NULL,
    prompt_version TEXT,
    status TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
    registration_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    approved_at TEXT
);
CREATE TABLE IF NOT EXISTS prompt_versions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    logical_asset_id TEXT NOT NULL,
    asset_class TEXT NOT NULL,
    version INTEGER NOT NULL,
    parent_version INTEGER,
    prompt TEXT NOT NULL,
    source TEXT NOT NULL,
    skill_id TEXT,
    status TEXT NOT NULL,
    change_reason TEXT,
    source_qa_run_id TEXT,
    rebuilt_from_failure_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS story_versions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    parent_id TEXT,
    source_script_version_id TEXT,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    skill_id TEXT,
    provider_profile_id TEXT,
    provider_model TEXT,
    content_json TEXT NOT NULL,
    accepted_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS story_workflow_chains (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source_script_version_id TEXT,
    storyboard_run_id TEXT,
    regulator_run_id TEXT,
    active_step TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_profile_id TEXT,
    provider_model TEXT,
    input_json TEXT NOT NULL DEFAULT '{}',
    storyboard_output_json TEXT,
    regulator_output_json TEXT,
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    artifact_id TEXT,
    logical_asset_id TEXT,
    from_status TEXT,
    to_status TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
"""

_V2_DOWN = """
DROP TABLE IF EXISTS asset_events;
DROP TABLE IF EXISTS story_workflow_chains;
DROP TABLE IF EXISTS story_versions;
DROP TABLE IF EXISTS prompt_versions;
DROP TABLE IF EXISTS asset_versions;
DROP TABLE IF EXISTS asset_qa_runs;
ALTER TABLE artifacts DROP COLUMN logical_asset_id;
ALTER TABLE artifacts DROP COLUMN asset_class;
ALTER TABLE artifacts DROP COLUMN asset_role;
ALTER TABLE artifacts DROP COLUMN collection;
ALTER TABLE artifacts DROP COLUMN intake_status;
ALTER TABLE artifacts DROP COLUMN source_type;
ALTER TABLE artifacts DROP COLUMN generation_id;
ALTER TABLE artifacts DROP COLUMN attempt_number;
ALTER TABLE artifacts DROP COLUMN qa_report_json;
ALTER TABLE artifacts DROP COLUMN rejection_reason;
ALTER TABLE artifacts DROP COLUMN supersedes_artifact_id;
ALTER TABLE artifacts DROP COLUMN updated_at;
"""

_V3_UP = """
CREATE TABLE IF NOT EXISTS workflow_graphs (
    project_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 1,
    graph_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS workflow_graph_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS workflow_templates_v3 (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'custom',
    version INTEGER NOT NULL DEFAULT 1,
    graph_json TEXT NOT NULL,
    builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_runs_v3 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    graph_revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    request_json TEXT NOT NULL DEFAULT '{}',
    graph_snapshot_json TEXT NOT NULL,
    estimate_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT,
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS node_runs_v3 (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    input_snapshot_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT,
    error_json TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES workflow_runs_v3(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS workflow_run_events_v3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    node_id TEXT,
    event_type TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES workflow_runs_v3(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS approval_gates_v3 (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_id TEXT,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    estimate_json TEXT NOT NULL DEFAULT '{}',
    decision_detail_json TEXT NOT NULL DEFAULT '{}',
    decided_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES workflow_runs_v3(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS artifact_lineage_v3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    parent_artifact_id TEXT NOT NULL,
    child_artifact_id TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'derived_from',
    node_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(parent_artifact_id, child_artifact_id, relation)
);
CREATE TABLE IF NOT EXISTS timelines_v3 (
    project_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 1,
    document_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_graph_events_project ON workflow_graph_events(project_id, id);
CREATE INDEX IF NOT EXISTS idx_runs_v3_project ON workflow_runs_v3(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_node_runs_v3_run ON node_runs_v3(run_id, node_id);
CREATE INDEX IF NOT EXISTS idx_run_events_v3_run ON workflow_run_events_v3(run_id, id);
CREATE INDEX IF NOT EXISTS idx_lineage_v3_parent ON artifact_lineage_v3(parent_artifact_id);
CREATE INDEX IF NOT EXISTS idx_lineage_v3_child ON artifact_lineage_v3(child_artifact_id);
"""

_V3_DOWN = """
DROP TABLE IF EXISTS timelines_v3;
DROP TABLE IF EXISTS artifact_lineage_v3;
DROP TABLE IF EXISTS approval_gates_v3;
DROP TABLE IF EXISTS workflow_run_events_v3;
DROP TABLE IF EXISTS node_runs_v3;
DROP TABLE IF EXISTS workflow_runs_v3;
DROP TABLE IF EXISTS workflow_templates_v3;
DROP TABLE IF EXISTS workflow_graph_events;
DROP TABLE IF EXISTS workflow_graphs;
"""

_V4_UP = """
CREATE TABLE IF NOT EXISTS asset_dependencies_v4 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    logical_asset_id TEXT NOT NULL,
    dependency_asset_id TEXT NOT NULL,
    shot_id TEXT,
    relation TEXT NOT NULL DEFAULT 'requires',
    role TEXT,
    required INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE(project_id, logical_asset_id, dependency_asset_id, shot_id, relation)
);
CREATE TABLE IF NOT EXISTS asset_reference_roles_v4 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    logical_asset_id TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    reference_kind TEXT NOT NULL DEFAULT 'artifact',
    artifact_id TEXT,
    role TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'project',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, logical_asset_id, reference_id, role)
);
CREATE TABLE IF NOT EXISTS asset_comparisons_v4 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    logical_asset_id TEXT NOT NULL,
    comparison_group TEXT NOT NULL,
    strategy TEXT NOT NULL,
    prompt_version TEXT,
    candidates_json TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_deps_v4_asset ON asset_dependencies_v4(project_id, logical_asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_refs_v4_asset ON asset_reference_roles_v4(project_id, logical_asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_comparisons_v4_asset ON asset_comparisons_v4(project_id, logical_asset_id, created_at);
"""

_V4_DOWN = """
DROP TABLE IF EXISTS asset_comparisons_v4;
DROP TABLE IF EXISTS asset_reference_roles_v4;
DROP TABLE IF EXISTS asset_dependencies_v4;
"""

_V5_UP = """
CREATE TABLE IF NOT EXISTS agent_plans_v5 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    skill_id TEXT,
    provider_profile_id TEXT,
    provider_model TEXT,
    base_project_revision INTEGER NOT NULL,
    base_graph_revision INTEGER NOT NULL,
    input_snapshot_json TEXT NOT NULL DEFAULT '{}',
    patch_json TEXT NOT NULL DEFAULT '{}',
    preview_json TEXT NOT NULL DEFAULT '{}',
    decision_json TEXT NOT NULL DEFAULT '{}',
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS agent_plan_events_v5 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY(plan_id) REFERENCES agent_plans_v5(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS agent_candidate_versions_v5 (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    target_id TEXT,
    version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate',
    content_json TEXT NOT NULL DEFAULT '{}',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    accepted_at TEXT,
    FOREIGN KEY(plan_id) REFERENCES agent_plans_v5(id) ON DELETE CASCADE,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_plans_project ON agent_plans_v5(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_plan_events_plan ON agent_plan_events_v5(plan_id, id);
CREATE INDEX IF NOT EXISTS idx_agent_candidates_project ON agent_candidate_versions_v5(project_id, created_at);
"""

_V5_DOWN = """
DROP TABLE IF EXISTS agent_candidate_versions_v5;
DROP TABLE IF EXISTS agent_plan_events_v5;
DROP TABLE IF EXISTS agent_plans_v5;
"""

_V6_UP = """
CREATE TABLE IF NOT EXISTS timeline_events_v6 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS render_jobs_v6 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    timeline_revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    request_json TEXT NOT NULL DEFAULT '{}',
    manifest_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT,
    error_json TEXT,
    confirmed_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS media_proxies_v6 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    preset TEXT NOT NULL,
    status TEXT NOT NULL,
    local_path TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, artifact_id, source_sha256, preset),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_timeline_events_project ON timeline_events_v6(project_id, id);
CREATE INDEX IF NOT EXISTS idx_render_jobs_project ON render_jobs_v6(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_render_jobs_status ON render_jobs_v6(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_media_proxies_artifact ON media_proxies_v6(project_id, artifact_id, updated_at);
"""

_V6_DOWN = """
DROP TABLE IF EXISTS media_proxies_v6;
DROP TABLE IF EXISTS render_jobs_v6;
DROP TABLE IF EXISTS timeline_events_v6;
"""

_V7_UP = """
CREATE TABLE IF NOT EXISTS asset_boards_v7 (
    project_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 1,
    board_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_asset_boards_updated ON asset_boards_v7(updated_at);
"""

_V7_DOWN = """
DROP TABLE IF EXISTS asset_boards_v7;
"""

_V8_UP = """
CREATE INDEX IF NOT EXISTS idx_projects_lifecycle ON projects(lifecycle_status, updated_at);
"""

_V8_DOWN = """
DROP INDEX IF EXISTS idx_projects_lifecycle;
"""

_V9_UP = """
UPDATE prompt_versions AS prompt
SET status='superseded'
WHERE prompt.status='prompt_qa_approved'
  AND EXISTS (
    SELECT 1
    FROM prompt_versions AS newer
    WHERE newer.project_id=prompt.project_id
      AND newer.logical_asset_id=prompt.logical_asset_id
      AND newer.status='prompt_qa_approved'
      AND (
        newer.version>prompt.version
        OR (newer.version=prompt.version AND newer.id>prompt.id)
      )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_versions_single_approved_v9
ON prompt_versions(project_id,logical_asset_id)
WHERE status='prompt_qa_approved';

CREATE TABLE IF NOT EXISTS generation_snapshots_v9 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    logical_asset_id TEXT NOT NULL,
    artifact_id TEXT,
    operation_type TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt_version_id TEXT NOT NULL,
    prompt_sha256 TEXT NOT NULL,
    prompt_body TEXT NOT NULL,
    reference_snapshot_json TEXT NOT NULL DEFAULT '[]',
    provider_profile_id TEXT,
    provider_model TEXT,
    parameters_json TEXT NOT NULL DEFAULT '{}',
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(prompt_version_id) REFERENCES prompt_versions(id),
    FOREIGN KEY(artifact_id) REFERENCES artifacts(id)
);
CREATE INDEX IF NOT EXISTS idx_generation_snapshots_v9_asset
ON generation_snapshots_v9(project_id,logical_asset_id,created_at);
CREATE INDEX IF NOT EXISTS idx_generation_snapshots_v9_prompt
ON generation_snapshots_v9(prompt_version_id,created_at);
"""

_V9_DOWN = """
DROP INDEX IF EXISTS idx_generation_snapshots_v9_prompt;
DROP INDEX IF EXISTS idx_generation_snapshots_v9_asset;
DROP TABLE IF EXISTS generation_snapshots_v9;
DROP INDEX IF EXISTS idx_prompt_versions_single_approved_v9;
"""

_V10_UP = """
ALTER TABLE workflow_runs_v3 ADD COLUMN idempotency_fingerprint TEXT;
ALTER TABLE approval_gates_v3 ADD COLUMN approval_consumed_at TEXT;
ALTER TABLE render_jobs_v6 ADD COLUMN idempotency_fingerprint TEXT;
ALTER TABLE render_jobs_v6 ADD COLUMN approval_consumed_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_inflight_fingerprint_v10
ON workflow_runs_v3(idempotency_fingerprint)
WHERE idempotency_fingerprint IS NOT NULL
  AND status IN ('awaiting_confirmation','queued','running','paused');

CREATE UNIQUE INDEX IF NOT EXISTS idx_render_jobs_inflight_fingerprint_v10
ON render_jobs_v6(idempotency_fingerprint)
WHERE idempotency_fingerprint IS NOT NULL
  AND status IN ('awaiting_confirmation','queued','running');
"""

_V10_DOWN = """
DROP INDEX IF EXISTS idx_render_jobs_inflight_fingerprint_v10;
DROP INDEX IF EXISTS idx_workflow_runs_inflight_fingerprint_v10;
ALTER TABLE render_jobs_v6 DROP COLUMN approval_consumed_at;
ALTER TABLE render_jobs_v6 DROP COLUMN idempotency_fingerprint;
ALTER TABLE approval_gates_v3 DROP COLUMN approval_consumed_at;
ALTER TABLE workflow_runs_v3 DROP COLUMN idempotency_fingerprint;
"""

_V11_UP = """
CREATE TABLE IF NOT EXISTS backup_records_v11 (
    id TEXT PRIMARY KEY,
    database_path TEXT NOT NULL,
    database_sha256 TEXT NOT NULL,
    manifest_path TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    project_id TEXT,
    status TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    verified_at TEXT
);

CREATE TABLE IF NOT EXISTS recovery_plans_v11 (
    id TEXT PRIMARY KEY,
    source_project_id TEXT NOT NULL,
    proposed_project_id TEXT NOT NULL,
    proposed_name TEXT NOT NULL,
    status TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    conflicts_json TEXT NOT NULL DEFAULT '[]',
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    applied_at TEXT,
    verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_recovery_plans_v11_source
ON recovery_plans_v11(source_project_id,created_at);
"""

_V11_DOWN = """
DROP INDEX IF EXISTS idx_recovery_plans_v11_source;
DROP TABLE IF EXISTS recovery_plans_v11;
DROP TABLE IF EXISTS backup_records_v11;
"""

_V12_UP = """
ALTER TABLE asset_reference_roles_v4 ADD COLUMN priority INTEGER NOT NULL DEFAULT 100;
ALTER TABLE asset_reference_roles_v4 ADD COLUMN scope TEXT NOT NULL DEFAULT 'general';
ALTER TABLE asset_reference_roles_v4 ADD COLUMN authority TEXT NOT NULL DEFAULT 'supporting';
ALTER TABLE asset_reference_roles_v4 ADD COLUMN conflict_group TEXT;
ALTER TABLE asset_reference_roles_v4 ADD COLUMN effective_version TEXT;
CREATE INDEX IF NOT EXISTS idx_asset_refs_v12_authority
ON asset_reference_roles_v4(project_id,logical_asset_id,priority,authority,scope,conflict_group);
"""

_V12_DOWN = """
DROP INDEX IF EXISTS idx_asset_refs_v12_authority;
ALTER TABLE asset_reference_roles_v4 DROP COLUMN effective_version;
ALTER TABLE asset_reference_roles_v4 DROP COLUMN conflict_group;
ALTER TABLE asset_reference_roles_v4 DROP COLUMN authority;
ALTER TABLE asset_reference_roles_v4 DROP COLUMN scope;
ALTER TABLE asset_reference_roles_v4 DROP COLUMN priority;
"""

_V13_UP = """
CREATE INDEX IF NOT EXISTS idx_artifacts_project_logical_created_v13
ON artifacts(project_id,logical_asset_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_versions_project_logical_version_v13
ON asset_versions(project_id,logical_asset_id,version DESC);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_project_logical_version_v13
ON prompt_versions(project_id,logical_asset_id,version DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_asset_dependencies_project_logical_created_v13
ON asset_dependencies_v4(project_id,logical_asset_id,created_at,id);
CREATE INDEX IF NOT EXISTS idx_asset_comparisons_project_logical_created_v13
ON asset_comparisons_v4(project_id,logical_asset_id,created_at DESC,id DESC);
"""

_V13_DOWN = """
DROP INDEX IF EXISTS idx_asset_comparisons_project_logical_created_v13;
DROP INDEX IF EXISTS idx_asset_dependencies_project_logical_created_v13;
DROP INDEX IF EXISTS idx_prompt_versions_project_logical_version_v13;
DROP INDEX IF EXISTS idx_asset_versions_project_logical_version_v13;
DROP INDEX IF EXISTS idx_artifacts_project_logical_created_v13;
"""

_V14_UP = """
CREATE INDEX IF NOT EXISTS idx_artifacts_project_created_v14
ON artifacts(project_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_versions_project_version_v14
ON asset_versions(project_id,version DESC);
"""

_V14_DOWN = """
DROP INDEX IF EXISTS idx_asset_versions_project_version_v14;
DROP INDEX IF EXISTS idx_artifacts_project_created_v14;
"""

_V15_UP = """
ALTER TABLE generation_snapshots_v9 RENAME TO generation_snapshots_v9_pre_v15;
ALTER TABLE artifact_lineage_v3 RENAME TO artifact_lineage_v3_pre_v15;
ALTER TABLE asset_reference_roles_v4 RENAME TO asset_reference_roles_v4_pre_v15;
ALTER TABLE asset_versions RENAME TO asset_versions_pre_v15;
ALTER TABLE prompt_versions RENAME TO prompt_versions_pre_v15;
ALTER TABLE asset_qa_runs RENAME TO asset_qa_runs_pre_v15;
ALTER TABLE artifacts RENAME TO artifacts_pre_v15;

CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    artifact_type TEXT NOT NULL,
    role TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    local_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    mime_type TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    provider_profile_id TEXT,
    provider_model TEXT,
    prompt_version TEXT,
    task_id TEXT,
    qa_owner TEXT,
    qa_decision TEXT NOT NULL DEFAULT 'Pending',
    status TEXT NOT NULL DEFAULT 'generated_pending_qa',
    created_at TEXT NOT NULL,
    logical_asset_id TEXT,
    asset_class TEXT,
    asset_role TEXT,
    collection TEXT NOT NULL DEFAULT 'intake',
    intake_status TEXT NOT NULL DEFAULT 'mapped',
    source_type TEXT,
    generation_id TEXT,
    attempt_number INTEGER NOT NULL DEFAULT 1,
    qa_report_json TEXT NOT NULL DEFAULT '{}',
    rejection_reason TEXT,
    supersedes_artifact_id TEXT,
    updated_at TEXT,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

CREATE TABLE asset_qa_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    logical_asset_id TEXT NOT NULL,
    qa_owner TEXT NOT NULL,
    qa_type TEXT NOT NULL,
    status TEXT NOT NULL,
    decision TEXT,
    report_json TEXT NOT NULL DEFAULT '{}',
    provider_profile_id TEXT,
    provider_model TEXT,
    capability TEXT,
    blocked_reason TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE RESTRICT,
    FOREIGN KEY(artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT
);

CREATE TABLE prompt_versions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    logical_asset_id TEXT NOT NULL,
    asset_class TEXT NOT NULL,
    version INTEGER NOT NULL,
    parent_version INTEGER,
    prompt TEXT NOT NULL,
    source TEXT NOT NULL,
    skill_id TEXT,
    status TEXT NOT NULL,
    change_reason TEXT,
    source_qa_run_id TEXT,
    rebuilt_from_failure_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE RESTRICT,
    FOREIGN KEY(source_qa_run_id) REFERENCES asset_qa_runs(id) ON DELETE SET NULL
);

CREATE TABLE asset_versions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    logical_asset_id TEXT NOT NULL,
    asset_class TEXT NOT NULL,
    version INTEGER NOT NULL,
    artifact_id TEXT NOT NULL,
    prompt_version TEXT,
    prompt_version_id TEXT,
    status TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0,1)),
    registration_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    approved_at TEXT,
    UNIQUE(project_id,logical_asset_id,version),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE RESTRICT,
    FOREIGN KEY(artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
    FOREIGN KEY(prompt_version_id) REFERENCES prompt_versions(id) ON DELETE SET NULL
);

CREATE TABLE asset_reference_roles_v4 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    logical_asset_id TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    reference_kind TEXT NOT NULL DEFAULT 'artifact',
    artifact_id TEXT,
    role TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'project',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    scope TEXT NOT NULL DEFAULT 'general',
    authority TEXT NOT NULL DEFAULT 'supporting',
    conflict_group TEXT,
    effective_version TEXT,
    UNIQUE(project_id, logical_asset_id, reference_id, role),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE RESTRICT,
    FOREIGN KEY(artifact_id) REFERENCES artifacts(id) ON DELETE SET NULL,
    FOREIGN KEY(effective_version) REFERENCES asset_versions(id) ON DELETE SET NULL
);

CREATE TABLE artifact_lineage_v3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    parent_artifact_id TEXT NOT NULL,
    child_artifact_id TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'derived_from',
    node_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(parent_artifact_id, child_artifact_id, relation),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE RESTRICT,
    FOREIGN KEY(parent_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
    FOREIGN KEY(child_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT
);

CREATE TABLE generation_snapshots_v9 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    logical_asset_id TEXT NOT NULL,
    artifact_id TEXT,
    operation_type TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt_version_id TEXT NOT NULL,
    prompt_sha256 TEXT NOT NULL,
    prompt_body TEXT NOT NULL,
    reference_snapshot_json TEXT NOT NULL DEFAULT '[]',
    provider_profile_id TEXT,
    provider_model TEXT,
    parameters_json TEXT NOT NULL DEFAULT '{}',
    error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(prompt_version_id) REFERENCES prompt_versions(id),
    FOREIGN KEY(artifact_id) REFERENCES artifacts(id)
);

INSERT INTO artifacts SELECT * FROM artifacts_pre_v15;
INSERT INTO asset_qa_runs SELECT * FROM asset_qa_runs_pre_v15;
INSERT INTO prompt_versions SELECT * FROM prompt_versions_pre_v15;
INSERT INTO asset_versions(id,project_id,logical_asset_id,asset_class,version,artifact_id,prompt_version,prompt_version_id,status,is_active,registration_json,created_at,approved_at)
SELECT id,project_id,logical_asset_id,asset_class,version,artifact_id,prompt_version,NULL,status,is_active,registration_json,created_at,approved_at FROM asset_versions_pre_v15;
INSERT INTO asset_reference_roles_v4 SELECT * FROM asset_reference_roles_v4_pre_v15;
INSERT INTO artifact_lineage_v3 SELECT * FROM artifact_lineage_v3_pre_v15;
INSERT INTO generation_snapshots_v9 SELECT * FROM generation_snapshots_v9_pre_v15;

DROP TABLE generation_snapshots_v9_pre_v15;
DROP TABLE artifact_lineage_v3_pre_v15;
DROP TABLE asset_reference_roles_v4_pre_v15;
DROP TABLE asset_versions_pre_v15;
DROP TABLE prompt_versions_pre_v15;
DROP TABLE asset_qa_runs_pre_v15;
DROP TABLE artifacts_pre_v15;

CREATE INDEX IF NOT EXISTS idx_lineage_v3_parent ON artifact_lineage_v3(parent_artifact_id);
CREATE INDEX IF NOT EXISTS idx_lineage_v3_child ON artifact_lineage_v3(child_artifact_id);
CREATE INDEX IF NOT EXISTS idx_asset_refs_v4_asset ON asset_reference_roles_v4(project_id, logical_asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_refs_v12_authority ON asset_reference_roles_v4(project_id,logical_asset_id,priority,authority,scope,conflict_group);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_versions_single_approved_v9 ON prompt_versions(project_id,logical_asset_id) WHERE status='prompt_qa_approved';
CREATE INDEX IF NOT EXISTS idx_generation_snapshots_v9_asset ON generation_snapshots_v9(project_id,logical_asset_id,created_at);
CREATE INDEX IF NOT EXISTS idx_generation_snapshots_v9_prompt ON generation_snapshots_v9(prompt_version_id,created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_project_logical_created_v13 ON artifacts(project_id,logical_asset_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_versions_project_logical_version_v13 ON asset_versions(project_id,logical_asset_id,version DESC);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_project_logical_version_v13 ON prompt_versions(project_id,logical_asset_id,version DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_asset_comparisons_project_logical_created_v13 ON asset_comparisons_v4(project_id,logical_asset_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_project_created_v14 ON artifacts(project_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_versions_project_version_v14 ON asset_versions(project_id,version DESC);
"""

_V15_DOWN = """
ALTER TABLE asset_reference_roles_v4 RENAME TO asset_reference_roles_v4_rollback_v15;
CREATE TABLE asset_reference_roles_v4 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    logical_asset_id TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    reference_kind TEXT NOT NULL DEFAULT 'artifact',
    artifact_id TEXT,
    role TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'project',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    scope TEXT NOT NULL DEFAULT 'general',
    authority TEXT NOT NULL DEFAULT 'supporting',
    conflict_group TEXT,
    effective_version TEXT,
    UNIQUE(project_id, logical_asset_id, reference_id, role)
);
INSERT INTO asset_reference_roles_v4 SELECT * FROM asset_reference_roles_v4_rollback_v15;
DROP TABLE asset_reference_roles_v4_rollback_v15;
CREATE INDEX idx_asset_refs_v4_asset ON asset_reference_roles_v4(project_id, logical_asset_id);
CREATE INDEX idx_asset_refs_v12_authority ON asset_reference_roles_v4(project_id,logical_asset_id,priority,authority,scope,conflict_group);
"""

_V16_UP = """
CREATE TABLE IF NOT EXISTS audit_events_v16 (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    before_json TEXT NOT NULL DEFAULT '{}',
    after_json TEXT NOT NULL DEFAULT '{}',
    result TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_events_v16_project_created
ON audit_events_v16(project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_v16_target_created
ON audit_events_v16(target_type, target_id, created_at DESC, id DESC);
"""

_V16_DOWN = """
DROP INDEX IF EXISTS idx_audit_events_v16_target_created;
DROP INDEX IF EXISTS idx_audit_events_v16_project_created;
DROP TABLE IF EXISTS audit_events_v16;
"""

MIGRATIONS: dict[int, dict[str, str]] = {
    1: {"up": _BASE_SCHEMA, "down": ""},
    2: {"up": _V2_UP, "down": _V2_DOWN},
    3: {"up": _V3_UP, "down": _V3_DOWN},
    4: {"up": _V4_UP, "down": _V4_DOWN},
    5: {"up": _V5_UP, "down": _V5_DOWN},
    6: {"up": _V6_UP, "down": _V6_DOWN},
    7: {"up": _V7_UP, "down": _V7_DOWN},
    8: {"up": _V8_UP, "down": _V8_DOWN},
    9: {"up": _V9_UP, "down": _V9_DOWN},
    10: {"up": _V10_UP, "down": _V10_DOWN},
    11: {"up": _V11_UP, "down": _V11_DOWN},
    12: {"up": _V12_UP, "down": _V12_DOWN},
    13: {"up": _V13_UP, "down": _V13_DOWN},
    14: {"up": _V14_UP, "down": _V14_DOWN},
    15: {"up": _V15_UP, "down": _V15_DOWN},
    16: {"up": _V16_UP, "down": _V16_DOWN},
}


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.migrate()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=20, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def applied_versions(self, db: sqlite3.Connection) -> set[int]:
        db.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
        )
        rows = db.execute("SELECT version FROM schema_migrations").fetchall()
        return {int(row[0]) for row in rows}

    def migrate(self) -> None:
        with self._lock, self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            applied = self.applied_versions(db)
            for version in sorted(MIGRATIONS):
                if version not in applied:
                    if version == 8:
                        columns = {str(row[1]) for row in db.execute("PRAGMA table_info(projects)").fetchall()}
                        if "lifecycle_status" not in columns:
                            db.execute("ALTER TABLE projects ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'")
                    self._apply_migration(db, MIGRATIONS[version]["up"])
                    db.execute(
                        "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(?, ?)",
                        (version, utcnow()),
                    )
                    db.execute("COMMIT")

    def rollback_to(self, target_version: int) -> None:
        with self._lock, self.connect() as db:
            applied = self.applied_versions(db)
            for version in sorted(MIGRATIONS, reverse=True):
                if version <= target_version or version not in applied:
                    continue
                down = MIGRATIONS[version]["down"]
                if down:
                    self._apply_migration(db, down)
                db.execute("DELETE FROM schema_migrations WHERE version=?", (version,))
                db.execute("COMMIT")

    @staticmethod
    def _apply_migration(db: sqlite3.Connection, script: str) -> None:
        """Run one migration script inside an explicit transaction.

        sqlite3.Connection.executescript() commits any pending transaction before
        executing a script. Starting the transaction inside the script keeps all
        DDL/DML in the same unit, so a failed migration can be rolled back and
        retried safely on the next application start.
        """
        try:
            db.executescript(f"BEGIN;\n{script}\n")
        except Exception:
            db.rollback()
            raise

    @staticmethod
    def encode(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def decode(value: str | None, default: Any = None) -> Any:
        if value is None:
            return default
        return json.loads(value)
