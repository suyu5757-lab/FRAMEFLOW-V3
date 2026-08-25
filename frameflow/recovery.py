from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import secrets
import sqlite3
from pathlib import Path
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile

from .database import SCHEMA_VERSION, utcnow
from .idempotency import canonical_json


_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
_MEDIA_SUFFIXES = {
    ".aac", ".flac", ".gif", ".jpeg", ".jpg", ".m4a", ".mov", ".mp3", ".mp4",
    ".ogg", ".png", ".wav", ".webm", ".webp",
}


class RecoveryError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}

    def payload(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "details": self.details}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _manifest_sha256(manifest: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(manifest).encode("utf-8")).hexdigest()


def _media_manifest_sha256(manifest: dict[str, Any]) -> str:
    stable = {key: value for key, value in manifest.items() if key != "generated_at"}
    return _manifest_sha256(stable)


def _safe_project_root(data_dir: Path, project_id: str) -> Path:
    if not _SAFE_ID.fullmatch(project_id):
        raise RecoveryError("invalid_project_id", "项目目录 ID 格式无效。", {"project_id": project_id})
    projects_root = (Path(data_dir) / "projects").resolve()
    root = (projects_root / project_id).resolve()
    if root.parent != projects_root:
        raise RecoveryError("unsafe_project_path", "项目目录越出正式 projects 根目录。", {"project_id": project_id})
    return root


def media_manifest(data_dir: Path, project_id: str | None = None) -> dict[str, Any]:
    projects_root = (Path(data_dir) / "projects").resolve()
    roots = [_safe_project_root(data_dir, project_id)] if project_id else sorted((path for path in projects_root.iterdir() if path.is_dir()), key=lambda path: path.name) if projects_root.is_dir() else []
    entries: list[dict[str, Any]] = []
    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted((item for item in root.rglob("*") if item.is_file()), key=lambda item: str(item)):
            relative = path.relative_to(projects_root).as_posix()
            entries.append({
                "project_id": root.name,
                "relative_path": relative,
                "size_bytes": path.stat().st_size,
                "mime_type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                "sha256": _sha256(path),
            })
    return {
        "manifest_version": 1,
        "schema_version": SCHEMA_VERSION,
        "project_id": project_id,
        "root": str(projects_root),
        "file_count": len(entries),
        "total_bytes": sum(int(item["size_bytes"]) for item in entries),
        "files": entries,
        "generated_at": utcnow(),
    }


def create_verified_backup(database: Any, data_dir: Path, backup_root: Path, project_id: str | None = None) -> dict[str, Any]:
    backup_root = Path(backup_root).resolve(); backup_root.mkdir(parents=True, exist_ok=True)
    backup_id = f"BACKUP_{secrets.token_hex(8)}"; stamp = backup_id.lower()
    database_path = backup_root / f"{stamp}.db"; manifest_path = backup_root / f"{stamp}.manifest.json"
    with database.connect() as connection:
        checkpoint = tuple(connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone())
    source = sqlite3.connect(database.path); destination = sqlite3.connect(database_path)
    try:
        source.backup(destination)
        integrity = str(destination.execute("PRAGMA integrity_check").fetchone()[0])
    finally:
        destination.close(); source.close()
    if integrity != "ok":
        raise RecoveryError("backup_integrity_failed", "SQLite 备份完整性校验失败。", {"integrity": integrity})
    manifest = media_manifest(data_dir, project_id)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    database_sha = _sha256(database_path); manifest_sha = _sha256(manifest_path); now = utcnow()
    detail = {"checkpoint": list(checkpoint), "integrity_check": integrity, "database_bytes": database_path.stat().st_size, "media_file_count": manifest["file_count"], "media_bytes": manifest["total_bytes"]}
    with database.connect() as connection:
        connection.execute("INSERT INTO backup_records_v11(id,database_path,database_sha256,manifest_path,manifest_sha256,project_id,status,detail_json,created_at,verified_at) VALUES(?,?,?,?,?,?,?, ?,?,?)",(backup_id,str(database_path),database_sha,str(manifest_path),manifest_sha,project_id,"verified",database.encode(detail),now,now))
    return {"id":backup_id,"status":"verified","database_path":str(database_path),"database_sha256":database_sha,"manifest_path":str(manifest_path),"manifest_sha256":manifest_sha,"project_id":project_id,"detail":detail,"created_at":now,"verified_at":now}


def _project_rows(database: Any, project_id: str) -> dict[str, list[dict[str, Any]]]:
    direct_tables = (
        "projects", "artifacts", "asset_versions", "asset_qa_runs", "prompt_versions",
        "asset_reference_roles_v4", "artifact_lineage_v3", "timelines_v3", "workflow_graphs",
    )
    result: dict[str, list[dict[str, Any]]] = {}
    with database.connect() as connection:
        tables = {str(row[0]) for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        for table in direct_tables:
            if table not in tables:
                continue
            column = "id" if table == "projects" else "project_id"
            rows = connection.execute(f"SELECT * FROM {table} WHERE {column}=?", (project_id,)).fetchall()
            result[table] = [dict(row) for row in rows]
    return result


def export_project(database: Any, data_dir: Path, export_root: Path, project_id: str) -> dict[str, Any]:
    root = _safe_project_root(data_dir, project_id)
    with database.connect() as connection:
        project = connection.execute("SELECT id,name,revision,created_at,updated_at FROM projects WHERE id=?", (project_id,)).fetchone()
    if not project:
        raise RecoveryError("project_missing", "项目不存在，无法导出。", {"project_id": project_id})
    export_root = Path(export_root).resolve(); export_root.mkdir(parents=True, exist_ok=True)
    export_id=f"EXPORT_{secrets.token_hex(8)}"; archive=export_root/f"{export_id.lower()}-{project_id}.zip"
    files = media_manifest(data_dir, project_id)
    manifest = {
        "export_version": 1,
        "schema_version": SCHEMA_VERSION,
        "export_id": export_id,
        "project_id": project_id,
        "project": dict(project),
        "database_rows": _project_rows(database, project_id),
        "files": files["files"],
        "created_at": utcnow(),
    }
    manifest["manifest_sha256"] = _manifest_sha256(manifest)
    with ZipFile(archive, "w", compression=ZIP_DEFLATED) as package:
        package.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        if root.is_dir():
            for entry in files["files"]:
                relative_from_project = Path(entry["relative_path"]).relative_to(project_id)
                package.write(root / relative_from_project, f"media/{relative_from_project.as_posix()}")
    with ZipFile(archive, "r") as package:
        verified_manifest = json.loads(package.read("manifest.json").decode("utf-8"))
        for entry in verified_manifest["files"]:
            relative_from_project = Path(entry["relative_path"]).relative_to(project_id).as_posix()
            digest = hashlib.sha256(package.read(f"media/{relative_from_project}")).hexdigest()
            if digest != entry["sha256"]:
                raise RecoveryError("export_hash_mismatch", "导出包文件校验失败。", {"relative_path": entry["relative_path"]})
    return {"id":export_id,"status":"verified","project_id":project_id,"archive_path":str(archive),"archive_sha256":_sha256(archive),"manifest":manifest,"file_count":len(files["files"])}


def recovery_scan(database: Any, data_dir: Path) -> dict[str, Any]:
    projects_root=(Path(data_dir)/"projects").resolve()
    with database.connect() as connection:
        ids={str(row[0]) for row in connection.execute("SELECT id FROM projects").fetchall()}
    dirs={path.name for path in projects_root.iterdir() if path.is_dir()} if projects_root.is_dir() else set()
    return {"generated_at":utcnow(),"missing_project_directories":sorted(ids-dirs),"unregistered_project_directories":sorted(dirs-ids),"apply_performed":False}


def create_recovery_preview(database: Any, data_dir: Path, source_project_id: str, proposed_name: str | None = None) -> dict[str, Any]:
    root=_safe_project_root(data_dir,source_project_id)
    if not root.is_dir():raise RecoveryError("source_directory_missing","恢复源目录不存在。",{"source_project_id":source_project_id})
    with database.connect() as connection:
        existing=connection.execute("SELECT id FROM projects WHERE id=?",(source_project_id,)).fetchone()
    conflicts=[]
    if existing:conflicts.append({"code":"project_id_exists","project_id":source_project_id})
    manifest=media_manifest(data_dir,source_project_id); manifest_hash=_media_manifest_sha256(manifest); plan_id=f"RECOVERY_{secrets.token_hex(8)}"; now=utcnow(); name=(proposed_name or f"Recovered {source_project_id}").strip()
    detail={"mode":"dry-run","media_candidates":sum(1 for item in manifest["files"] if Path(item["relative_path"]).suffix.lower() in _MEDIA_SUFFIXES),"apply_performed":False}
    with database.connect() as connection:
        connection.execute("INSERT INTO recovery_plans_v11(id,source_project_id,proposed_project_id,proposed_name,status,manifest_json,manifest_sha256,conflicts_json,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",(plan_id,source_project_id,source_project_id,name,"blocked" if conflicts else "preview",database.encode(manifest),manifest_hash,database.encode(conflicts),database.encode(detail),now))
    return {"id":plan_id,"status":"blocked" if conflicts else "preview","source_project_id":source_project_id,"proposed_project_id":source_project_id,"proposed_name":name,"manifest":manifest,"manifest_sha256":manifest_hash,"conflicts":conflicts,"dry_run":True,"apply_allowed":not conflicts,"apply_performed":False,"created_at":now}


def apply_recovery_plan(database: Any, data_dir: Path, plan_id: str, manifest_sha256: str, confirmed: bool) -> dict[str, Any]:
    if not confirmed:raise RecoveryError("confirmation_required","Recovery Apply 必须显式确认。")
    with database.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        plan=connection.execute("SELECT * FROM recovery_plans_v11 WHERE id=?",(plan_id,)).fetchone()
        if not plan:raise RecoveryError("recovery_plan_missing","恢复预览不存在。",{"plan_id":plan_id})
        if plan["status"]!="preview":raise RecoveryError("recovery_plan_not_applicable","恢复预览已阻塞、已使用或状态无效。",{"status":plan["status"]})
        if str(plan["manifest_sha256"])!=manifest_sha256:raise RecoveryError("manifest_token_mismatch","恢复清单确认令牌不一致。")
        if database.decode(plan["conflicts_json"],[]):raise RecoveryError("recovery_conflict","恢复计划存在冲突，禁止 Apply。")
        current=media_manifest(data_dir,str(plan["source_project_id"]));current_hash=_media_manifest_sha256(current)
        if current_hash!=manifest_sha256:raise RecoveryError("source_changed","恢复源在 Preview 后发生变化，请重新扫描。",{"expected":manifest_sha256,"actual":current_hash})
        project_id=str(plan["proposed_project_id"]);now=utcnow()
        if connection.execute("SELECT 1 FROM projects WHERE id=?",(project_id,)).fetchone():raise RecoveryError("project_id_exists","目标项目记录已存在。")
        document={"id":project_id,"name":plan["proposed_name"],"ratio":"16:9","duration":30,"generator":"recovery","brief":"Recovered from verified orphan directory preview.","stage":0,"sortOrder":0,"productionStatus":"recovery_review_required","lifecycleStatus":"active","createdAt":now,"script":"","assets":[],"shots":[],"audio":{},"assetRegulator":{},"generations":[],"seedancePackages":[],"providerOverrides":{},"undoStack":[],"scriptVersions":[],"storyboardVersions":[],"storyWorkflowRuns":[],"recovery":{"plan_id":plan_id,"manifest_sha256":manifest_sha256,"review_required":True}}
        connection.execute("INSERT INTO projects(id,name,document_json,revision,created_at,updated_at,lifecycle_status) VALUES(?,?,?,?,?,?,?)",(project_id,plan["proposed_name"],database.encode(document),1,now,now,"active"))
        artifact_count=0
        projects_root=(Path(data_dir)/"projects").resolve()
        for entry in current["files"]:
            suffix=Path(entry["relative_path"]).suffix.lower()
            if suffix not in _MEDIA_SUFFIXES:continue
            path=(projects_root/entry["relative_path"]).resolve();artifact_id=f"ART_RECOVERED_{secrets.token_hex(8)}"
            connection.execute("INSERT INTO artifacts(id,project_id,artifact_type,local_path,sha256,mime_type,metadata_json,qa_decision,status,created_at,collection,intake_status,source_type,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(artifact_id,project_id,"recovered_media",str(path),entry["sha256"],entry["mime_type"],database.encode({"recovery_plan_id":plan_id,"original_relative_path":entry["relative_path"],"recovery_review_required":True}),"Pending","mapping_required",now,"intake","mapping_required","recovery",now));artifact_count+=1
        connection.execute("UPDATE recovery_plans_v11 SET status='applied',applied_at=?,verified_at=?,detail_json=? WHERE id=? AND status='preview'",(now,now,database.encode({"apply_performed":True,"artifact_candidates_created":artifact_count,"verification":"manifest_hash_matched"}),plan_id))
    return {"id":plan_id,"status":"applied","project_id":project_id,"artifact_candidates_created":artifact_count,"manifest_sha256":manifest_sha256,"verified":True,"applied_at":now}
