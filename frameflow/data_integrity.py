from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .database import SCHEMA_VERSION, utcnow


_MEDIA_SUFFIXES = {
    ".aac", ".flac", ".gif", ".jpeg", ".jpg", ".m4a", ".mov", ".mp3", ".mp4",
    ".ogg", ".png", ".wav", ".webm", ".webp",
}


def _json(value: str | None, default: Any) -> Any:
    try:
        return json.loads(value or "")
    except (TypeError, ValueError):
        return default


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def scan_data_integrity(database: Any, data_dir: Path, project_id: str | None = None) -> dict[str, Any]:
    """Read-only DB/media authority audit shared by all V3 integrity endpoints."""
    projects_root = (Path(data_dir) / "projects").resolve()
    with database.connect() as connection:
        tables = {str(row[0]) for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        project_rows = connection.execute("SELECT id,document_json,revision,updated_at FROM projects ORDER BY id").fetchall()
        artifact_rows = connection.execute(
            "SELECT * FROM artifacts" + (" WHERE project_id=?" if project_id else "") + " ORDER BY id",
            (project_id,) if project_id else (),
        ).fetchall()
    all_project_ids = {str(row["id"]) for row in project_rows}
    selected_rows = [row for row in project_rows if not project_id or str(row["id"]) == project_id]
    directory_ids = {path.name for path in projects_root.iterdir() if path.is_dir()} if projects_root.is_dir() else set()
    missing_project_directories = sorted(str(row["id"]) for row in selected_rows if str(row["id"]) not in directory_ids)
    unregistered_project_directories = sorted(directory_ids - all_project_ids) if not project_id else []
    project_records = []
    documents: dict[str, dict[str, Any]] = {}
    for row in selected_rows:
        pid = str(row["id"])
        document = _json(row["document_json"], {})
        documents[pid] = document if isinstance(document, dict) else {}
        root = (projects_root / pid).resolve()
        project_records.append({
            "project_id": pid,
            "name": documents[pid].get("name") or pid,
            "revision": int(row["revision"]),
            "directory": str(root),
            "directory_exists": root.is_dir(),
            "status": "ready" if root.is_dir() else "missing_project_directory",
        })

    artifact_issues: list[dict[str, Any]] = []
    registered_paths: set[Path] = set()
    artifact_ids = {str(row["id"]) for row in artifact_rows}
    artifact_by_id = {str(row["id"]): row for row in artifact_rows}
    for row in artifact_rows:
        aid = str(row["id"]); pid = str(row["project_id"] or "")
        path = Path(str(row["local_path"] or "")).resolve()
        root = (projects_root / pid).resolve()
        inside = path == root or root in path.parents
        exists = path.is_file()
        issue: dict[str, Any] | None = None
        if pid not in all_project_ids:
            issue = {"code": "artifact_project_missing", "artifact_id": aid, "project_id": pid}
        elif not inside:
            issue = {"code": "broken_ownership", "artifact_id": aid, "project_id": pid, "path": str(path)}
        elif not exists:
            issue = {"code": "missing_media", "artifact_id": aid, "project_id": pid, "path": str(path)}
        else:
            registered_paths.add(path)
            expected = str(row["sha256"] or "").lower()
            if not expected:
                issue = {"code": "hash_missing", "artifact_id": aid, "project_id": pid, "path": str(path)}
            else:
                actual = _sha256(path)
                if actual != expected:
                    issue = {"code": "hash_mismatch", "artifact_id": aid, "project_id": pid, "path": str(path), "expected_sha256": expected, "actual_sha256": actual}
        if issue:
            issue.update({"file_exists": exists, "inside_project_directory": inside, "status": row["status"]})
            artifact_issues.append(issue)

    unregistered_media_files: list[dict[str, Any]] = []
    for row in selected_rows:
        pid = str(row["id"]); artifact_root = (projects_root / pid / "artifacts").resolve()
        if not artifact_root.is_dir():
            continue
        for path in artifact_root.rglob("*"):
            resolved = path.resolve()
            if path.is_file() and path.suffix.lower() in _MEDIA_SUFFIXES and resolved not in registered_paths:
                unregistered_media_files.append({"code": "unregistered_media", "project_id": pid, "path": str(resolved)})

    orphan_rows: list[dict[str, Any]] = []
    with database.connect() as connection:
        for table in sorted(tables):
            columns = {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}
            # Durable audit history intentionally survives project deletion so
            # the record of the deletion remains queryable. It is not an
            # owned/live project row and must not be reported as an orphan.
            if "project_id" not in columns or table in {"projects", "audit_events_v16"}:
                continue
            rows = connection.execute(f"SELECT project_id,COUNT(*) count FROM {table} WHERE project_id IS NOT NULL GROUP BY project_id").fetchall()
            for row in rows:
                pid = str(row["project_id"])
                if pid not in all_project_ids and (not project_id or pid == project_id):
                    orphan_rows.append({"code": "orphan_project_row", "table": table, "project_id": pid, "count": int(row["count"])})

    asset_version_issues: list[dict[str, Any]] = []
    qa_issues: list[dict[str, Any]] = []
    reference_issues: list[dict[str, Any]] = []
    lineage_issues: list[dict[str, Any]] = []
    broken_story_refs: list[dict[str, Any]] = []
    board_issues: list[dict[str, Any]] = []
    with database.connect() as connection:
        version_rows = connection.execute("SELECT * FROM asset_versions" + (" WHERE project_id=?" if project_id else ""), (project_id,) if project_id else ()).fetchall()
        by_logical: dict[tuple[str, str], list[Any]] = {}
        for row in version_rows:
            pid=str(row["project_id"]); logical=str(row["logical_asset_id"]); by_logical.setdefault((pid,logical),[]).append(row)
            artifact=connection.execute("SELECT project_id,logical_asset_id FROM artifacts WHERE id=?",(row["artifact_id"],)).fetchone()
            if not artifact or str(artifact["project_id"])!=pid or str(artifact["logical_asset_id"] or "")!=logical:
                asset_version_issues.append({"code":"asset_version_artifact_invalid","asset_version_id":row["id"],"project_id":pid,"logical_asset_id":logical,"artifact_id":row["artifact_id"]})
        for (pid,logical),rows in by_logical.items():
            active=[row for row in rows if int(row["is_active"] or 0)==1]
            if len(active)>1 or any(str(row["status"] or "").lower()!="active" for row in active):
                asset_version_issues.append({"code":"invalid_active_version","project_id":pid,"logical_asset_id":logical,"active_count":len(active)})

        qa_rows = connection.execute("SELECT * FROM asset_qa_runs" + (" WHERE project_id=?" if project_id else ""), (project_id,) if project_id else ()).fetchall()
        for row in qa_rows:
            artifact=connection.execute("SELECT project_id,logical_asset_id FROM artifacts WHERE id=?",(row["artifact_id"],)).fetchone()
            if not artifact or str(artifact["project_id"])!=str(row["project_id"]) or str(artifact["logical_asset_id"] or "")!=str(row["logical_asset_id"]):
                qa_issues.append({"code":"qa_artifact_invalid","qa_run_id":row["id"],"project_id":row["project_id"],"artifact_id":row["artifact_id"]})

        ref_rows = connection.execute("SELECT * FROM asset_reference_roles_v4" + (" WHERE project_id=?" if project_id else ""), (project_id,) if project_id else ()).fetchall()
        for row in ref_rows:
            pid=str(row["project_id"]); logical=str(row["logical_asset_id"]); doc=documents.get(pid) or _json(connection.execute("SELECT document_json FROM projects WHERE id=?",(pid,)).fetchone()[0],{}) if pid in all_project_ids else {}
            logical_ids={str(item.get("id")) for item in doc.get("assets",[]) if isinstance(item,dict) and item.get("id")}
            if logical not in logical_ids or (row["artifact_id"] and str(row["artifact_id"]) not in artifact_ids):
                reference_issues.append({"code":"reference_authority_broken","reference_row_id":row["id"],"project_id":pid,"logical_asset_id":logical,"artifact_id":row["artifact_id"]})

        lineage_rows = connection.execute("SELECT * FROM artifact_lineage_v3" + (" WHERE project_id=?" if project_id else ""), (project_id,) if project_id else ()).fetchall()
        for row in lineage_rows:
            if str(row["parent_artifact_id"]) not in artifact_ids or str(row["child_artifact_id"]) not in artifact_ids:
                lineage_issues.append({"code":"lineage_artifact_missing","project_id":row["project_id"],"parent_artifact_id":row["parent_artifact_id"],"child_artifact_id":row["child_artifact_id"]})

        for row in selected_rows:
            pid=str(row["id"]); doc=documents.get(pid,{})
            logical_ids={str(item.get("id")) for item in doc.get("assets",[]) if isinstance(item,dict) and item.get("id")}
            for shot in doc.get("shots",[]):
                if not isinstance(shot,dict):continue
                for requirement in shot.get("assetRequirements") or []:
                    aid=str(requirement.get("assetId") or requirement.get("asset_id") or "") if isinstance(requirement,dict) else ""
                    if aid and aid not in logical_ids:broken_story_refs.append({"code":"story_asset_missing","project_id":pid,"shot_id":shot.get("id"),"asset_id":aid})
        if "asset_boards_v7" in tables:
            rows=connection.execute("SELECT project_id,board_json FROM asset_boards_v7" + (" WHERE project_id=?" if project_id else ""), (project_id,) if project_id else ()).fetchall()
            for row in rows:
                board=_json(row["board_json"],{});node_ids=[str(item.get("id")) for item in board.get("nodes",[]) if isinstance(item,dict)];edge_ids=[str(item.get("id")) for item in board.get("edges",[]) if isinstance(item,dict)]
                if len(node_ids)!=len(set(node_ids)) or len(edge_ids)!=len(set(edge_ids)):board_issues.append({"code":"duplicate_node_or_edge_id","project_id":row["project_id"]})

    critical_issues = (
        [{"code":"missing_project_directory","project_id":pid} for pid in missing_project_directories]
        + [{"code":"unregistered_project_directory","project_id":pid} for pid in unregistered_project_directories]
        + artifact_issues + unregistered_media_files + orphan_rows + asset_version_issues + qa_issues + reference_issues + lineage_issues + broken_story_refs + board_issues
    )
    return {
        "ok": not critical_issues,
        "generated_at": utcnow(),
        "schema_version": SCHEMA_VERSION,
        "project_id": project_id,
        "project_ids": sorted(all_project_ids),
        "projects": project_records,
        "orphan_directories": unregistered_project_directories,
        "missing_project_records": missing_project_directories,
        "unregistered_project_directories": unregistered_project_directories,
        "missing_project_directories": missing_project_directories,
        "artifact_mismatches": artifact_issues,
        "broken_artifacts": artifact_issues,
        "unregistered_media_files": unregistered_media_files,
        "orphan_rows": orphan_rows,
        "asset_version_issues": asset_version_issues,
        "qa_issues": qa_issues,
        "reference_issues": reference_issues,
        "lineage_issues": lineage_issues,
        "broken_story_asset_refs": broken_story_refs,
        "board_issues": board_issues,
        "critical_issues": critical_issues,
        "counts": {"projects":len(all_project_ids),"artifacts":len(artifact_rows),"critical_issues":len(critical_issues)},
        "recovery_policy": "只读扫描；孤立目录和未知媒体不得自动登记，必须先走 Recovery Preview / Dry Run。",
    }
