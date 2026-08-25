"""Safe, repeatable maintenance helpers for the FrameFlow V3 workspace.

This module deliberately does not remove project media. Database cleanup is
explicitly scoped to one project id and returns counts so callers can audit the
operation before and after it runs.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .database import Database, utcnow
from . import audit_trail
from .data_integrity import scan_data_integrity


PROJECT_SCOPED_TABLES = (
    "tasks",
    "artifacts",
    "conversations",
    "workflow_runs",
    "approvals",
    "asset_qa_runs",
    "asset_versions",
    "prompt_versions",
    "story_versions",
    "story_workflow_chains",
    "asset_events",
    "workflow_graphs",
    "workflow_graph_events",
    "workflow_runs_v3",
    "artifact_lineage_v3",
    "timelines_v3",
    "asset_dependencies_v4",
    "asset_reference_roles_v4",
    "asset_comparisons_v4",
    "agent_plans_v5",
    "agent_candidate_versions_v5",
    "timeline_events_v6",
    "render_jobs_v6",
    "media_proxies_v6",
    "asset_boards_v7",
)

ACTIVE_RUN_STATUSES = ("queued", "running", "awaiting_confirmation", "paused")


def _table_names(database: Database) -> set[str]:
    with database.connect() as connection:
        rows = connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    return {str(row[0]) for row in rows}


def active_project_runs(database: Database, project_id: str) -> dict[str, int]:
    tables = _table_names(database)
    result: dict[str, int] = {}
    with database.connect() as connection:
        if "tasks" in tables:
            result["tasks"] = int(connection.execute(
                "SELECT COUNT(*) FROM tasks WHERE project_id=? AND status IN (?,?,?,?)",
                (project_id, *ACTIVE_RUN_STATUSES),
            ).fetchone()[0])
        if "workflow_runs_v3" in tables:
            result["workflow_runs_v3"] = int(connection.execute(
                "SELECT COUNT(*) FROM workflow_runs_v3 WHERE project_id=? AND status IN (?,?,?,?)",
                (project_id, *ACTIVE_RUN_STATUSES),
            ).fetchone()[0])
        if "render_jobs_v6" in tables:
            result["render_jobs_v6"] = int(connection.execute(
                "SELECT COUNT(*) FROM render_jobs_v6 WHERE project_id=? AND status IN (?,?,?,?)",
                (project_id, *ACTIVE_RUN_STATUSES),
            ).fetchone()[0])
    return result


def _delete_by_ids(connection: Any, table: str, column: str, ids: list[str]) -> int:
    if not ids:
        return 0
    placeholders = ",".join("?" for _ in ids)
    result = connection.execute(
        f"DELETE FROM {table} WHERE {column} IN ({placeholders})",
        ids,
    )
    return int(result.rowcount if result.rowcount >= 0 else 0)


def delete_project_records(database: Database, project_id: str, *, audit_event: dict[str, Any] | None = None) -> dict[str, int]:
    """Delete all database records owned by one project, preserving files."""

    tables = _table_names(database)
    counts: dict[str, int] = {}
    with database.connect() as connection:
        if "tasks" in tables and "task_events" in tables:
            task_ids = [str(row[0]) for row in connection.execute("SELECT id FROM tasks WHERE project_id=?", (project_id,)).fetchall()]
            counts["task_events"] = _delete_by_ids(connection, "task_events", "task_id", task_ids)
        if "conversations" in tables and "messages" in tables:
            conversation_ids = [str(row[0]) for row in connection.execute("SELECT id FROM conversations WHERE project_id=?", (project_id,)).fetchall()]
            counts["messages"] = _delete_by_ids(connection, "messages", "conversation_id", conversation_ids)
        if "workflow_runs_v3" in tables:
            run_ids = [str(row[0]) for row in connection.execute("SELECT id FROM workflow_runs_v3 WHERE project_id=?", (project_id,)).fetchall()]
            for table, column in (("node_runs_v3", "run_id"), ("workflow_run_events_v3", "run_id"), ("approval_gates_v3", "run_id")):
                if table in tables:
                    counts[table] = _delete_by_ids(connection, table, column, run_ids)
        if "agent_plans_v5" in tables:
            plan_ids = [str(row[0]) for row in connection.execute("SELECT id FROM agent_plans_v5 WHERE project_id=?", (project_id,)).fetchall()]
            if "agent_plan_events_v5" in tables:
                counts["agent_plan_events_v5"] = _delete_by_ids(connection, "agent_plan_events_v5", "plan_id", plan_ids)

        for table in PROJECT_SCOPED_TABLES:
            if table not in tables:
                continue
            result = connection.execute(f"DELETE FROM {table} WHERE project_id=?", (project_id,))
            counts[table] = int(result.rowcount if result.rowcount >= 0 else 0)

        if audit_event:
            audit_trail.write_event_connection(connection, database, project_id=project_id, **audit_event)
        result = connection.execute("DELETE FROM projects WHERE id=?", (project_id,))
        counts["projects"] = int(result.rowcount if result.rowcount >= 0 else 0)
    return counts


def _json(value: str | None) -> Any:
    try:
        return json.loads(value or "{}")
    except (TypeError, ValueError):
        return {}


def _shot_ids(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            result.append(item.strip())
        elif isinstance(item, dict):
            shot_id = item.get("shot_id") or item.get("shotId") or item.get("id")
            if shot_id:
                result.append(str(shot_id).strip())
    return list(dict.fromkeys(result))


def derive_story_asset_links(document: dict[str, Any], artifact_rows: list[Any]) -> dict[str, Any]:
    """Derive only explicit, verifiable shot relationships.

    The function never changes readiness or registration state. It only adds
    missing requirements and returns unresolved references for human review.
    """

    doc = json.loads(json.dumps(document, ensure_ascii=False))
    assets = [item for item in doc.get("assets", []) if isinstance(item, dict) and item.get("id")]
    shots = [item for item in doc.get("shots", []) if isinstance(item, dict) and item.get("id")]
    assets_by_id = {str(item["id"]): item for item in assets}
    shots_by_id = {str(item["id"]): item for item in shots}
    added: list[dict[str, str]] = []
    unresolved: list[dict[str, str]] = []
    links: set[tuple[str, str]] = set()

    def add_link(asset_id: str, shot_id: str, source: str) -> None:
        asset = assets_by_id.get(asset_id)
        shot = shots_by_id.get(shot_id)
        if not asset or not shot:
            unresolved.append({"asset_id": asset_id, "shot_id": shot_id, "source": source})
            return
        links.add((asset_id, shot_id))
        requirements = shot.setdefault("assetRequirements", [])
        if not isinstance(requirements, list):
            requirements = []
            shot["assetRequirements"] = requirements
        if any(isinstance(item, dict) and str(item.get("assetId") or "") == asset_id for item in requirements):
            return
        requirements.append({
            "assetId": asset_id,
            "assetClass": asset.get("assetClass") or asset.get("assetRole") or "unknown",
            "role": asset.get("assetRole") or "asset reference",
            "priority": asset.get("grade") or "B",
            "required": bool(asset.get("required", True)),
            "requiredReadiness": "production" if asset.get("required") else "registered",
            "source": "metadata-repair",
        })
        added.append({"asset_id": asset_id, "shot_id": shot_id, "source": source})

    for asset in assets:
        asset_id = str(asset["id"])
        for item in _shot_ids(asset.get("promptRelevantShots") or asset.get("relevantShots")):
            add_link(asset_id, item, "asset_metadata")
        for item in asset.get("shotDependencies") or []:
            if isinstance(item, dict):
                add_link(asset_id, str(item.get("shot_id") or item.get("shotId") or ""), "asset_dependency")

    for row in artifact_rows:
        asset_id = str(row["logical_asset_id"] or "")
        metadata = _json(row["metadata_json"])
        for shot_id in _shot_ids(metadata.get("relevant_shots") or metadata.get("relevantShots")):
            add_link(asset_id, shot_id, "artifact_metadata")

    return {"document": doc, "added": added, "unresolved": unresolved, "links": sorted(links)}


def audit_database(database: Database, root: Path) -> dict[str, Any]:
    return scan_data_integrity(database, root / "data")

    # Retained below only as historical implementation context during the
    # remediation sequence; the shared service above is the sole authority.
    tables = _table_names(database)
    project_ids: set[str] = set()
    counts: dict[str, int] = {}
    orphan_rows: list[dict[str, Any]] = []
    broken_artifacts: list[dict[str, Any]] = []
    broken_story_refs: list[dict[str, Any]] = []
    board_issues: list[dict[str, Any]] = []

    with database.connect() as connection:
        if "projects" in tables:
            rows = connection.execute("SELECT id FROM projects").fetchall()
            project_ids = {str(row[0]) for row in rows}
            counts["projects"] = len(project_ids)
        for table in sorted(tables):
            try:
                counts[table] = int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            except Exception:
                continue
            columns = {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}
            if "project_id" not in columns or table == "projects":
                continue
            rows = connection.execute(f"SELECT project_id, COUNT(*) AS count FROM {table} WHERE project_id IS NOT NULL GROUP BY project_id").fetchall()
            for row in rows:
                if str(row[0]) not in project_ids:
                    orphan_rows.append({"table": table, "project_id": str(row[0]), "count": int(row[1])})
        if "artifacts" in tables:
            for row in connection.execute("SELECT id, project_id, local_path FROM artifacts").fetchall():
                if row["local_path"] and not Path(str(row["local_path"])).exists():
                    broken_artifacts.append({"id": row["id"], "project_id": row["project_id"], "local_path": row["local_path"]})
        if "projects" in tables:
            for row in connection.execute("SELECT id, document_json FROM projects").fetchall():
                doc = _json(row["document_json"])
                asset_ids = {str(item.get("id")) for item in doc.get("assets", []) if isinstance(item, dict) and item.get("id")}
                for shot in doc.get("shots", []):
                    if not isinstance(shot, dict):
                        continue
                    for requirement in shot.get("assetRequirements") or []:
                        asset_id = str(requirement.get("assetId") or "") if isinstance(requirement, dict) else ""
                        if asset_id and asset_id not in asset_ids:
                            broken_story_refs.append({"project_id": row["id"], "shot_id": shot.get("id"), "asset_id": asset_id})
        if "asset_boards_v7" in tables:
            for row in connection.execute("SELECT project_id, board_json FROM asset_boards_v7").fetchall():
                board = _json(row["board_json"])
                node_ids = [str(item.get("id")) for item in board.get("nodes", []) if isinstance(item, dict)]
                edge_ids = [str(item.get("id")) for item in board.get("edges", []) if isinstance(item, dict)]
                if len(node_ids) != len(set(node_ids)) or len(edge_ids) != len(set(edge_ids)):
                    board_issues.append({"project_id": row["project_id"], "issue": "duplicate_node_or_edge_id"})

    project_root = root / "data" / "projects"
    directories = {path.name for path in project_root.iterdir() if path.is_dir()} if project_root.exists() else set()
    unregistered_directories = sorted(directories - project_ids)
    missing_directories = sorted(project_ids - directories)
    return {
        "ok": not orphan_rows and not broken_artifacts and not broken_story_refs and not board_issues,
        "generated_at": utcnow(),
        "schema_version": 8,
        "project_ids": sorted(project_ids),
        "counts": counts,
        "orphan_rows": orphan_rows,
        "broken_artifacts": broken_artifacts,
        "broken_story_asset_refs": broken_story_refs,
        "board_issues": board_issues,
        "unregistered_project_directories": unregistered_directories,
        "missing_project_directories": missing_directories,
    }
