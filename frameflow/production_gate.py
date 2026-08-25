from __future__ import annotations

import hashlib
import hmac
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_BLOCKED_ARTIFACT_STATUSES = {
    "audit_blocked",
    "generated_pending_qa",
    "mapping_required",
    "pending_qa",
    "rejected",
    "revision_required",
    "revoked",
    "superseded",
}
_BLOCKED_LOGICAL_STATUSES = {
    "approved_pending_registration",
    "audit_blocked",
    "blocked",
    "generated-pending-qa",
    "generated_pending_qa",
    "mapping-required",
    "mapping_required",
    "missing",
    "pending_qa",
    "rejected",
    "revision-required",
    "revision_required",
    "revoked",
    "superseded",
}


@dataclass(frozen=True)
class ProductionArtifactGateError(Exception):
    code: str
    message: str
    artifact_id: str
    project_id: str
    details: dict[str, Any]

    def __str__(self) -> str:
        return self.message

    def payload(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "artifact_id": self.artifact_id,
            "project_id": self.project_id,
            "details": self.details,
        }


def _fail(code: str, message: str, artifact_id: str, project_id: str, **details: Any) -> None:
    raise ProductionArtifactGateError(code, message, artifact_id, project_id, details)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _logical_asset(document: dict[str, Any], logical_asset_id: str) -> dict[str, Any] | None:
    for item in document.get("assets") or []:
        if isinstance(item, dict) and str(item.get("id") or "") == logical_asset_id:
            return item
    return None


def production_artifact_gate(
    database: Any,
    project_id: str,
    artifact_id: str,
    projects_root: Path,
) -> dict[str, Any]:
    """Validate the single production authority chain for a timeline input.

    The gate deliberately reads current database and disk state on every call.
    Callers near final output must not trust an earlier result or a client-side
    readiness snapshot.
    """
    with database.connect() as connection:
        project_row = connection.execute(
            "SELECT id,document_json,revision FROM projects WHERE id=?",
            (project_id,),
        ).fetchone()
        artifact = connection.execute("SELECT * FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
    if not project_row:
        _fail("project_missing", "当前项目不存在，生产素材门禁拒绝放行。", artifact_id, project_id)
    if not artifact:
        _fail("artifact_missing", "生产素材未登记。", artifact_id, project_id)
    if str(artifact["project_id"] or "") != project_id:
        _fail(
            "wrong_project",
            "生产素材不属于当前项目。",
            artifact_id,
            project_id,
            actual_project_id=artifact["project_id"],
        )

    project_root = (Path(projects_root) / project_id).resolve()
    path = Path(str(artifact["local_path"] or "")).resolve()
    try:
        path.relative_to(project_root)
    except ValueError:
        _fail("file_outside_project", "生产素材文件不在当前项目目录内。", artifact_id, project_id)
    if not path.is_file():
        _fail("file_missing", "生产素材文件不存在。", artifact_id, project_id)

    expected_hash = str(artifact["sha256"] or "").strip().lower()
    if not _SHA256_RE.fullmatch(expected_hash):
        _fail("hash_missing", "生产素材缺少有效 SHA-256。", artifact_id, project_id)
    actual_hash = _sha256(path)
    if not hmac.compare_digest(actual_hash, expected_hash):
        _fail(
            "hash_mismatch",
            "生产素材文件哈希与登记记录不一致。",
            artifact_id,
            project_id,
            expected_sha256=expected_hash,
            actual_sha256=actual_hash,
        )

    qa_decision = str(artifact["qa_decision"] or "")
    if qa_decision != "Approved":
        _fail(
            "qa_not_approved",
            "生产素材尚未通过正式 QA。",
            artifact_id,
            project_id,
            qa_decision=qa_decision or None,
        )
    artifact_status = str(artifact["status"] or "").strip().lower()
    if artifact_status != "ready" or artifact_status in _BLOCKED_ARTIFACT_STATUSES:
        _fail(
            "artifact_not_ready",
            "生产素材未处于已登记可用状态。",
            artifact_id,
            project_id,
            artifact_status=artifact_status or None,
        )

    logical_asset_id = str(artifact["logical_asset_id"] or "").strip()
    if not logical_asset_id:
        _fail("artifact_unmapped", "生产素材尚未映射到逻辑资产。", artifact_id, project_id)
    with database.connect() as connection:
        approved_qa = connection.execute(
            "SELECT id,qa_type,finished_at FROM asset_qa_runs "
            "WHERE project_id=? AND artifact_id=? AND status='completed' AND decision='Approved' "
            "ORDER BY finished_at DESC,created_at DESC LIMIT 1",
            (project_id, artifact_id),
        ).fetchone()
        active_versions = connection.execute(
            "SELECT * FROM asset_versions WHERE project_id=? AND logical_asset_id=? AND is_active=1 ORDER BY version DESC",
            (project_id, logical_asset_id),
        ).fetchall()
    if not approved_qa:
        _fail("qa_record_missing", "生产素材没有可验证的已完成 Approved QA 记录。", artifact_id, project_id)
    if len(active_versions) != 1:
        _fail(
            "active_version_ambiguous",
            "逻辑资产必须且只能有一个 active version。",
            artifact_id,
            project_id,
            logical_asset_id=logical_asset_id,
            active_version_count=len(active_versions),
        )
    active_version = active_versions[0]
    if str(active_version["artifact_id"] or "") != artifact_id:
        _fail(
            "artifact_superseded",
            "生产素材不是逻辑资产的当前 active version。",
            artifact_id,
            project_id,
            logical_asset_id=logical_asset_id,
            active_artifact_id=active_version["artifact_id"],
            active_version_id=active_version["id"],
        )
    if str(active_version["status"] or "").lower() != "active":
        _fail(
            "active_version_invalid",
            "当前 asset version 的状态不是 active。",
            artifact_id,
            project_id,
            active_version_id=active_version["id"],
            version_status=active_version["status"],
        )

    document = database.decode(project_row["document_json"], {})
    logical_asset = _logical_asset(document, logical_asset_id)
    if not logical_asset:
        _fail(
            "logical_asset_missing",
            "当前项目文档中不存在该逻辑资产。",
            artifact_id,
            project_id,
            logical_asset_id=logical_asset_id,
        )
    logical_status = str(logical_asset.get("status") or "").strip().lower()
    if logical_status in _BLOCKED_LOGICAL_STATUSES or logical_status != "ready":
        _fail(
            "logical_asset_not_ready",
            "逻辑资产未处于生产可用状态。",
            artifact_id,
            project_id,
            logical_asset_id=logical_asset_id,
            logical_asset_status=logical_status or None,
        )
    if logical_asset.get("regulatorRegistered") is not True:
        _fail(
            "logical_asset_unregistered",
            "逻辑资产没有正式登记权威。",
            artifact_id,
            project_id,
            logical_asset_id=logical_asset_id,
        )
    if str(logical_asset.get("qaDecision") or "") != "Approved":
        _fail(
            "logical_asset_qa_not_approved",
            "逻辑资产当前 QA 权威不是 Approved。",
            artifact_id,
            project_id,
            logical_asset_id=logical_asset_id,
        )
    current_artifact_id = str(logical_asset.get("artifactId") or logical_asset.get("artifact_id") or "")
    if current_artifact_id != artifact_id:
        _fail(
            "logical_asset_artifact_mismatch",
            "逻辑资产当前 artifact 与时间线输入不一致。",
            artifact_id,
            project_id,
            logical_asset_id=logical_asset_id,
            current_artifact_id=current_artifact_id or None,
        )
    current_version_id = str(logical_asset.get("activeVersionId") or logical_asset.get("active_version_id") or "")
    if current_version_id and current_version_id != str(active_version["id"]):
        _fail(
            "logical_asset_version_mismatch",
            "逻辑资产当前版本指针与数据库 active version 不一致。",
            artifact_id,
            project_id,
            logical_asset_id=logical_asset_id,
            current_version_id=current_version_id,
            active_version_id=active_version["id"],
        )

    return {
        "artifact_id": artifact_id,
        "project_id": project_id,
        "logical_asset_id": logical_asset_id,
        "asset_version_id": str(active_version["id"]),
        "asset_version": int(active_version["version"]),
        "qa_run_id": str(approved_qa["id"]),
        "qa_type": str(approved_qa["qa_type"]),
        "sha256": actual_hash,
        "relative_path": path.relative_to(project_root).as_posix(),
        "artifact_status": artifact_status,
        "logical_asset_status": logical_status,
        "project_revision": int(project_row["revision"]),
    }
