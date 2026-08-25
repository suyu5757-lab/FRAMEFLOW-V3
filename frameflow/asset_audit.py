"""Asset intake, technical validation, domain QA routing, registration and
quarantine state machine for FRAMEFLOW.

This module is the single server-side authority for asset state. The browser is
never trusted to write Approved / registered / ready directly: every transition
runs through the transition map below and is recorded in asset_events.
"""
from __future__ import annotations

import hashlib
import mimetypes
import re
import secrets
import tempfile
from pathlib import Path
from typing import Any

from .media import (
    audio_signature_ok,
    image_dimensions,
    media_info,
    sniff_image_format,
    video_signature_ok,
)

# ---------------------------------------------------------------------------
# Canonical asset classes and their QA owner.
# ---------------------------------------------------------------------------

ASSET_CLASSES = {
    "character", "scene", "prop", "product", "style", "fusion",
    "audio", "music", "sfx", "video", "post", "unknown",
}

QA_OWNER_BY_CLASS = {
    "character": "video-character-design-director",
    "scene": "video-scene-design-director",
    "prop": "video-prop-design-director",
    "product": "video-prop-design-director",
    "style": "video-asset-regulator",
    "fusion": "video-fusion-production-director",
    "video": "video-shot-director",
    "audio": "voice-controller",
    "music": "voice-controller",
    "sfx": "voice-controller",
    "post": "video-shot-director",
    "unknown": "video-asset-regulator",
}

CLASS_BY_SKILL = {skill: cls for cls, skill in QA_OWNER_BY_CLASS.items()}

SKILL_BY_CLASS = QA_OWNER_BY_CLASS

# asset class <-> human type label used by the frontend.
CLASS_TYPE_LABEL = {
    "character": "角色",
    "scene": "场景",
    "prop": "道具",
    "fusion": "融合",
    "audio": "音频",
    "music": "音乐",
    "sfx": "音效",
    "video": "视频",
    "post": "后期",
    "product": "产品",
    "style": "风格",
    "unknown": "待识别",
}

ALLOWED_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif",
    ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg",
    ".mp4", ".webm", ".mov", ".mkv",
    ".srt", ".vtt",
}

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv"}

REFERENCE_NAME_PATTERN = re.compile(r"(?:storyboard|keyframe|panel|overview|分镜|关键帧|构图)", re.IGNORECASE)

QA_DECISIONS = {"Approved", "Needs revision", "Reject and rebuild prompt", "Rejected", "Blocked"}

# Execution / intake status transitions. New media uploads and re-uploads create
# a new artifact; a single artifact only moves forward through this map.
TRANSITIONS: dict[str, set[str]] = {
    "uploading": {"technical_validation", "technical_rejected", "mapping_required"},
    "technical_validation": {"technical_rejected", "mapping_required", "generated_pending_qa", "reference_pending_review"},
    "mapping_required": {"generated_pending_qa", "reference_pending_review", "archived"},
    "generated_pending_qa": {"qa_in_progress", "audit_blocked", "archived"},
    "reference_pending_review": {"qa_in_progress", "reference", "unqualified", "archived"},
    "qa_in_progress": {"approved_pending_registration", "reference", "revision_required", "rejected", "audit_blocked", "awaiting_human_review"},
    "approved_pending_registration": {"ready", "archived"},
    "revision_required": {"archived"},
    "rejected": {"archived"},
    "audit_blocked": {"generated_pending_qa", "awaiting_human_review", "approved_pending_registration", "revision_required", "rejected", "archived"},
    "awaiting_human_review": {"approved_pending_registration", "revision_required", "rejected", "generated_pending_qa", "archived"},
    "ready": {"superseded", "archived"},
    "reference": {"archived"},
    "unqualified": {"generated_pending_qa", "reference", "archived"},
    "superseded": {"archived"},
    "archived": set(),
}


def collection_for_status(status: str) -> str:
    if status in {"technical_rejected", "mapping_required", "revision_required", "rejected", "audit_blocked", "awaiting_human_review", "unqualified"}:
        return "unqualified"
    if status in {"ready", "superseded"}:
        return "qualified"
    if status in {"reference"}:
        return "reference"
    return "intake"


def asset_class_for_skill(skill: str | None) -> str:
    return {
        "character": "character", "scene": "scene", "prop": "prop", "product": "product",
        "style": "style", "fusion": "fusion", "audio": "audio", "music": "music",
        "sfx": "sfx", "video": "video", "post": "post",
    }.get(skill, "unknown")


def classify_by_role(asset_role: str | None) -> str:
    """Map a frontend asset_role string back to an asset class."""
    if not asset_role:
        return "unknown"
    role = asset_role.upper()
    if role.startswith("DES") or role.startswith("FACE") or role.startswith("EXPR") or role.startswith("COSTUME") or role.startswith("DETAIL") or role.startswith("C0") or role.startswith("CHARACTER"):
        return "character"
    if role.startswith("SCENE") or role.startswith("TOPDOWN") or role.startswith("CAM") or role.startswith("S0"):
        return "scene"
    if role.startswith("PROP") or role.startswith("P0"):
        return "prop"
    if role.startswith("PRODUCT") or role.startswith("PRD"):
        return "product"
    if role.startswith("STYLE") or role.startswith("STY"):
        return "style"
    if role.startswith("FUSION") or role.startswith("BLEND") or role.startswith("KEY") or role.startswith("FIRST") or role.startswith("LAST"):
        return "fusion"
    if role.startswith("MUSIC"):
        return "music"
    if role.startswith("SFX"):
        return "sfx"
    if role.startswith("AUDIO") or role.startswith("VOICE"):
        return "audio"
    if role.startswith("VIDEO"):
        return "video"
    return "unknown"


def infer_artifact_usage(
    filename: str | None,
    mime_type: str | None,
    asset_class: str | None,
    asset_role: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Classify intake media without promoting storyboard references to production."""
    metadata = metadata if isinstance(metadata, dict) else {}
    name = str(filename or metadata.get("original_name") or "")
    mime = str(mime_type or metadata.get("mime_type") or "").lower()
    cls = str(asset_class or "").lower()
    role = str(asset_role or "").lower()
    explicit_scope = str(metadata.get("usage_scope") or "").lower()
    is_reference = explicit_scope == "reference" or (
        mime.startswith("image/") and bool(REFERENCE_NAME_PATTERN.search(name))
    )
    if is_reference:
        return {
            "usage_scope": "reference",
            "artifact_kind": "storyboard_reference" if REFERENCE_NAME_PATTERN.search(name) else "image_reference",
            "qa_type": "reference",
            "production_eligible": False,
            "reference_kind": "storyboard_keyframe" if REFERENCE_NAME_PATTERN.search(name) else "image_reference",
        }
    if cls == "video" or mime.startswith("video/") or role.startswith("shot"):
        return {"usage_scope": "production", "artifact_kind": "shot_video", "qa_type": "video", "production_eligible": True}
    if cls in {"audio", "music", "sfx"} or mime.startswith("audio/"):
        return {"usage_scope": "production", "artifact_kind": "audio", "qa_type": "audio", "production_eligible": True}
    return {"usage_scope": "production", "artifact_kind": "asset_media", "qa_type": "image", "production_eligible": True}


def qa_type_for_artifact(asset_class: str | None, mime_type: str | None = None, metadata: dict[str, Any] | None = None) -> str:
    return str(infer_artifact_usage(None, mime_type, asset_class, metadata=metadata)["qa_type"])


# Every reference used by a production asset must declare exactly one of these
# roles.  Keeping the vocabulary server-side prevents a prompt from silently
# treating a scene reference as an identity anchor (or vice versa).
REFERENCE_ROLES = {
    "identity", "outfit", "action", "composition", "scene_structure",
    "style", "lighting", "product_structure",
}
ASSET_GRADES = {"A+", "A", "B", "C", "optional", "Reject"}


def normalize_references(references: Any) -> tuple[list[dict[str, Any]], list[str]]:
    """Validate and normalize reference-role records for asset metadata."""
    if references is None:
        return [], []
    if not isinstance(references, list):
        return [], ["references 必须是数组"]
    normalized: list[dict[str, Any]] = []
    errors: list[str] = []
    for index, value in enumerate(references):
        if not isinstance(value, dict):
            errors.append(f"references[{index}] 必须是对象")
            continue
        reference_id = str(value.get("reference_id") or value.get("referenceId") or value.get("id") or value.get("artifact_id") or value.get("artifactId") or value.get("url") or "").strip()
        role = str(value.get("role") or value.get("reference_role") or value.get("referenceRole") or "").strip()
        if not reference_id:
            errors.append(f"references[{index}] 缺少 reference_id")
            continue
        if role not in REFERENCE_ROLES:
            errors.append(f"references[{index}] 的 role 必须是 {', '.join(sorted(REFERENCE_ROLES))}")
            continue
        normalized.append({
            "reference_id": reference_id,
            "reference_kind": str(value.get("reference_kind") or value.get("referenceKind") or "artifact"),
            "artifact_id": value.get("artifact_id") or value.get("artifactId"),
            "role": role,
            "source": str(value.get("source") or "project"),
            "notes": str(value.get("notes") or ""),
        })
    return normalized, errors


def asset_readiness(asset: dict[str, Any] | None) -> dict[str, Any]:
    """Return a regulator-level readiness report for one logical asset."""
    if not isinstance(asset, dict):
        return {
            "status": "missing", "required": True, "missing": ["logical_asset"], "ready": False,
            "registered_ready": False, "production_ready": False, "production_missing": ["logical_asset"],
            "next_action": "创建逻辑资产",
        }
    asset_class = str(asset.get("assetClass") or asset.get("asset_class") or asset.get("skill") or "").strip().lower()
    is_audio = asset_class in {"audio", "music", "sfx"}
    grade = str(asset.get("grade") or asset.get("priority") or "B")
    required = grade in {"A", "A+"}
    missing: list[str] = []
    has_file = bool(asset.get("artifactId") or asset.get("filePath") or asset.get("url"))
    usage_scope = str(asset.get("usage_scope") or asset.get("usageScope") or "").strip().lower()

    # Storyboards, keyframes and panels are references, not timeline media.
    if usage_scope == "reference" or asset_class == "storyboard_reference":
        if not has_file:
            missing.append("project_file")
        if asset.get("qaDecision") != "Approved":
            missing.append("reference_review")
        if str(asset.get("status")) in {"rejected", "revision-required", "blocked"}:
            status = "blocked"
        elif has_file and not missing:
            status = "reference"
        else:
            status = "partial" if has_file else "missing"
        return {
            "status": status,
            "kind": "reference",
            "reference_ready": status == "reference",
            "required": required,
            "grade": grade,
            "ready": False,
            "registered_ready": False,
            "production_ready": False,
            "missing": missing,
            "production_missing": ["reference_only"],
            "qa_decision": asset.get("qaDecision"),
            "qa_kind": "reference",
            "registered": False,
            "has_file": has_file,
            "manual_production_approval": None,
            "manual_approval_active": False,
            "next_action": "完成参考审核" if asset.get("qaDecision") != "Approved" else "仅供参考，不可入镜",
        }

    # Audio is a first-class production asset, not a visual asset with a
    # different extension.  It must pass human listening/technical QA and
    # registration, but it has no Prompt or image-QA gate.
    if is_audio:
        if not has_file:
            missing.append("project_file")
        if asset.get("qaDecision") != "Approved":
            missing.append("audio_qa")
        if asset.get("regulatorRegistered") is not True:
            missing.append("asset_registration")
        asset_status = str(asset.get("status") or "")
        if asset_status in {"rejected", "revision-required", "blocked"}:
            status = "blocked"
        elif asset_status in {"generated-pending-qa", "pending_qa", "qa_in_progress", "approved_pending_registration", "revision_required"}:
            # A new candidate must not inherit the previous approved version's
            # readiness. Registration of this exact artifact is still required.
            status = "partial" if has_file else "missing"
        elif has_file and not missing:
            status = "ready"
        else:
            status = "partial" if has_file else "missing"
        registered_ready = status == "ready"
        production_missing: list[str] = []
        if not registered_ready:
            production_missing.extend([f"registered:{item}" for item in missing] or ["asset_registration"])
        authorization = str(asset.get("authorizationStatus") or asset.get("authorization_status") or "").strip().lower()
        authorization_ok = {"cleared", "approved", "authorized", "已授权", "已通过", "not-required", "consent-verified", "provider-cleared"}
        if authorization and authorization not in authorization_ok:
            production_missing.append("authorization")
        if asset_status in {"rejected", "revision-required", "blocked"}:
            production_missing.append("blocked")
        production_ready = registered_ready and not production_missing
        if status == "blocked":
            next_action = "检查声音 QA 失败原因"
        elif not has_file:
            next_action = "上传或生成声音候选"
        elif asset_status in {"generated-pending-qa", "pending_qa", "qa_in_progress"}:
            next_action = "开始声音 QA"
        elif asset.get("qaDecision") != "Approved":
            next_action = "开始声音 QA"
        elif asset.get("regulatorRegistered") is not True:
            next_action = "登记声音候选"
        elif "authorization" in production_missing:
            next_action = "确认声音授权"
        else:
            next_action = "可交给下游"
        return {
            "status": status,
            "asset_class": asset_class,
            "required": required,
            "grade": grade,
            "ready": status == "ready",
            "registered_ready": registered_ready,
            "production_ready": production_ready,
            "missing": missing,
            "production_missing": list(dict.fromkeys(production_missing)),
            "qa_decision": asset.get("qaDecision"),
            "qa_kind": "audio",
            "registered": asset.get("regulatorRegistered") is True,
            "has_file": has_file,
            "manual_production_approval": None,
            "manual_approval_active": False,
            "next_action": next_action,
        }

    if required and not has_file:
        missing.append("project_file")
    qa_kind = "video" if asset_class == "video" else "image"
    if required and asset.get("qaDecision") != "Approved":
        missing.append("video_qa" if qa_kind == "video" else "generated_image_qa")
    if required and asset.get("regulatorRegistered") is not True:
        missing.append("asset_registration")
    if required:
        status = "ready" if not missing else ("partial" if has_file or asset.get("prompt") else "missing")
    else:
        # Planned B/C assets are never production-ready merely because a
        # logical record exists.  They become ready only after a file has
        # passed QA and has been registered; a prompt/spec alone is partial.
        registered_ready = has_file and asset.get("qaDecision") == "Approved" and asset.get("regulatorRegistered") is True
        status = "ready" if registered_ready else ("partial" if has_file or asset.get("prompt") or asset.get("note") else "missing")
    if str(asset.get("status")) in {"rejected", "revision-required", "blocked"}:
        status = "blocked"
    registered_ready = status == "ready"
    production_missing: list[str] = []
    if not registered_ready:
        production_missing.extend([f"registered:{item}" for item in missing] or ["asset_registration"])
    if not str(asset.get("prompt") or "").strip():
        production_missing.append("prompt")
    elif asset.get("promptQaDecision") != "Approved":
        production_missing.append("prompt_qa")
    authorization = str(asset.get("authorizationStatus") or asset.get("authorization_status") or "").strip().lower()
    if authorization and authorization not in {"cleared", "approved", "authorized", "已授权", "已通过"}:
        production_missing.append("authorization")
    if str(asset.get("status")) in {"rejected", "revision-required", "blocked"}:
        production_missing.append("blocked")
    manual = asset.get("manualProductionApproval") or asset.get("manual_production_approval")
    current_artifact_id = str(asset.get("artifactId") or asset.get("artifact_id") or "")
    manual_approval_active = bool(
        registered_ready
        and isinstance(manual, dict)
        and manual.get("approved") is True
        and current_artifact_id
        and str(manual.get("artifactId") or manual.get("artifact_id") or "") == current_artifact_id
    )
    if manual_approval_active:
        # Manual review is intentionally narrow: it waives only the prompt
        # production checks for the exact registered artifact version.
        production_missing = [item for item in production_missing if item not in {"prompt", "prompt_qa"}]
    production_ready = registered_ready and not production_missing
    if status == "blocked":
        next_action = "检查 QA 失败原因"
    elif not has_file:
        next_action = "上传候选文件"
    elif asset.get("qaDecision") != "Approved":
        next_action = "开始视频 QA" if qa_kind == "video" else "开始图片 QA"
    elif asset.get("regulatorRegistered") is not True:
        next_action = "登记候选"
    elif not str(asset.get("prompt") or "").strip() and not manual_approval_active:
        next_action = "补 Prompt"
    elif asset.get("promptQaDecision") != "Approved" and not manual_approval_active:
        next_action = "完成 Prompt QA"
    elif "authorization" in production_missing:
        next_action = "确认授权"
    else:
        next_action = "可入镜"
    return {
        "status": status,
        "required": required,
        "grade": grade,
        "ready": status == "ready",
        "registered_ready": registered_ready,
        "production_ready": production_ready,
        "missing": missing,
        "production_missing": list(dict.fromkeys(production_missing)),
        "qa_decision": asset.get("qaDecision"),
        "qa_kind": qa_kind,
        "registered": asset.get("regulatorRegistered") is True,
        "has_file": has_file,
        "manual_production_approval": manual if isinstance(manual, dict) else None,
        "manual_approval_active": manual_approval_active,
        "next_action": next_action,
    }


# ---------------------------------------------------------------------------
# Technical validation.
# ---------------------------------------------------------------------------

def technical_validation(
    raw: bytes,
    filename: str,
    project_id: str,
    max_size: int,
    *,
    total_size: int | None = None,
    sha256: str | None = None,
) -> dict[str, Any]:
    ext = Path(filename).suffix.lower() or ""
    checks: dict[str, Any] = {}
    failures: list[str] = []
    received_size = len(raw) if total_size is None else total_size

    checks["empty"] = received_size > 0
    if received_size == 0:
        failures.append("文件为空")

    checks["size_within_limit"] = received_size <= max_size
    if received_size > max_size:
        failures.append(f"文件超过大小限制（{received_size} 字节）")

    checks["extension_allowed"] = ext in ALLOWED_EXTENSIONS
    if ext not in ALLOWED_EXTENSIONS:
        failures.append(f"扩展名 {ext or '(无)'} 不受支持")

    if ext in IMAGE_EXTENSIONS:
        kind = sniff_image_format(raw)
        checks["image_signature_ok"] = bool(kind)
        if not kind:
            failures.append("图片文件签名无效或无法识别")
        else:
            dims = image_dimensions(raw)
            checks["dimensions"] = {"width": dims[0], "height": dims[1]} if dims else None
            if dims and (dims[0] < 1 or dims[1] < 1):
                failures.append("图片尺寸无效")
    elif ext in AUDIO_EXTENSIONS:
        checks["audio_signature_ok"] = audio_signature_ok(ext, raw)
        if not checks["audio_signature_ok"]:
            failures.append("音频文件签名无效")
    elif ext in VIDEO_EXTENSIONS:
        checks["video_signature_ok"] = video_signature_ok(ext, raw)
        if not checks["video_signature_ok"]:
            failures.append("视频文件签名无效")

    sha = sha256 or hashlib.sha256(raw).hexdigest()
    checks["sha256"] = sha
    mime = mimetypes.guess_type(filename)[0]
    checks["mime_type"] = mime
    checks["mime_signature_consistent"] = True
    # If a claimed image MIME disagrees with the sniffed bytes, treat as forged.
    if mime and mime.startswith("image/") and ext in IMAGE_EXTENSIONS and sniff_image_format(raw) is None:
        checks["mime_signature_consistent"] = False
        failures.append("MIME 类型与文件签名不一致")

    return {
        "ok": not failures,
        "checks": checks,
        "failures": failures,
        "extension": ext,
        "sha256": sha,
    }


def safe_filename(filename: str) -> str:
    name = Path(filename or "upload.bin").name
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)

def _default_project_root(project_id: str, database_path: Path | None = None) -> Path:
    # Production media lives under <repo-root>/data. Test and isolated runtime
    # databases use the same deterministic temp root as server.lifespan.
    root = Path(__file__).resolve().parents[1]
    if database_path is not None and database_path.resolve() != (root / "data" / "frameflow.db").resolve():
        return (Path(tempfile.gettempdir()) / f"frameflow-runtime-{database_path.stem}" / "projects" / project_id).resolve()
    return (root / "data" / "projects" / project_id).resolve()


def project_file_url(project_id: str | None, local_path: str | None,
                     project_root: Path | None = None) -> str | None:
    """Return the browser-accessible project-files URL for a stored artifact.

    Safe equivalent of server.artifact_url for payload builders that live
    outside server.py. The URL is produced only when the stored path
    resolves inside the real project root (DATA_DIR/projects/{project_id},
    or an explicitly injected project_root); a forged path that merely
    contains a coincidental 'projects/{project_id}' segment is rejected.
    Returns None when the path is outside the project (e.g. global
    generated media) or when the project id is missing. The relative part
    is the result of path.relative_to(root), so it can never contain '..'.
    """
    if not project_id or not local_path:
        return None
    try:
        root = project_root.resolve() if project_root is not None else _default_project_root(project_id)
        path = Path(local_path).resolve()
    except (OSError, ValueError):
        return None
    try:
        relative = path.relative_to(root)
    except ValueError:
        return None
    if not relative.parts:
        return None
    return f"/api/project-files/{project_id}/{relative.as_posix()}"


# ---------------------------------------------------------------------------
# QA capability gate.
# ---------------------------------------------------------------------------

def supports_vision(profile: dict[str, Any] | None) -> bool:
    if not profile:
        return False
    if profile.get("provider_type") == "openai":
        return True
    capabilities = profile.get("capabilities") or []
    return "vision" in capabilities


# ---------------------------------------------------------------------------
# Failure counting (fusion twice-fail rule).
# ---------------------------------------------------------------------------

def count_qa_failures(database: Any, project_id: str, logical_asset_id: str | None = None) -> int:
    with database.connect() as c:
        if logical_asset_id:
            rows = c.execute(
                "SELECT decision FROM asset_qa_runs WHERE project_id=? AND logical_asset_id=? AND qa_type='image'",
                (project_id, logical_asset_id),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT decision FROM asset_qa_runs WHERE project_id=? AND qa_type='image'",
                (project_id,),
            ).fetchall()
    return sum(1 for row in rows if row["decision"] in {"Needs revision", "Reject and rebuild prompt"})


def should_force_rebuild(database: Any, project_id: str, logical_asset_id: str, asset_class: str) -> bool:
    if asset_class != "fusion":
        return False
    return count_qa_failures(database, project_id, logical_asset_id) >= 2


# ---------------------------------------------------------------------------
# State helpers.
# ---------------------------------------------------------------------------

def record_event(database: Any, project_id: str, artifact_id: str | None, logical_asset_id: str | None,
                 from_status: str | None, to_status: str, detail: dict[str, Any] | None = None) -> None:
    with database.connect() as c:
        c.execute(
            "INSERT INTO asset_events(project_id, artifact_id, logical_asset_id, from_status, to_status, detail_json, created_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (project_id, artifact_id, logical_asset_id, from_status, to_status, database.encode(detail or {}), _now()),
        )


def _now() -> str:
    from .database import utcnow
    return utcnow()


def transition_artifact(database: Any, artifact_id: str, to_status: str, detail: dict[str, Any] | None = None) -> None:
    with database.connect() as c:
        row = c.execute("SELECT * FROM artifacts WHERE id=?", (artifact_id,)).fetchone()
        if not row:
            raise KeyError(artifact_id)
        old = row["status"]
        if to_status not in TRANSITIONS.get(old, set()):
            raise ValueError(f"artifact 不能从 {old} 转为 {to_status}")
        collection = collection_for_status(to_status)
        c.execute(
            "UPDATE artifacts SET status=?, collection=?, intake_status=?, updated_at=? WHERE id=?",
            (to_status, collection, to_status, _now(), artifact_id),
        )
    record_event(database, row["project_id"], artifact_id, row["logical_asset_id"], old, to_status, detail)


def set_artifact_collection(database: Any, artifact_id: str, collection: str) -> None:
    with database.connect() as c:
        c.execute("UPDATE artifacts SET collection=?, updated_at=? WHERE id=?", (collection, _now(), artifact_id))


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def artifact_payload(database: Any, row: Any) -> dict[str, Any]:
    project_root = _default_project_root(str(row["project_id"] or ""), Path(database.path) if getattr(database, "path", None) else None)
    return {
        "id": row["id"],
        "artifact_id": row["id"],
        "project_id": row["project_id"],
        "url": project_file_url(row["project_id"], row["local_path"], project_root),
        "artifact_type": row["artifact_type"],
        "role": row["role"],
        "version": row["version"],
        "logical_asset_id": row["logical_asset_id"],
        "asset_class": row["asset_class"],
        "asset_role": row["asset_role"],
        "collection": row["collection"],
        "intake_status": row["intake_status"],
        "source_type": row["source_type"],
        "generation_id": row["generation_id"],
        "prompt_version": row["prompt_version"],
        "attempt_number": row["attempt_number"],
        "local_path": row["local_path"],
        "sha256": row["sha256"],
        "mime_type": row["mime_type"],
        "metadata": database.decode(row["metadata_json"], {}),
        "provider_profile_id": row["provider_profile_id"],
        "provider_model": row["provider_model"],
        "qa_owner": row["qa_owner"],
        "qa_decision": row["qa_decision"],
        "qa_report": database.decode(row["qa_report_json"], {}),
        "rejection_reason": row["rejection_reason"],
        "supersedes_artifact_id": row["supersedes_artifact_id"],
        "status": row["status"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def qa_run_payload(database: Any, row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "artifact_id": row["artifact_id"],
        "logical_asset_id": row["logical_asset_id"],
        "qa_owner": row["qa_owner"],
        "qa_type": row["qa_type"],
        "status": row["status"],
        "decision": row["decision"],
        "report": database.decode(row["report_json"], {}),
        "provider_profile_id": row["provider_profile_id"],
        "provider_model": row["provider_model"],
        "capability": row["capability"],
        "blocked_reason": row["blocked_reason"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "created_at": row["created_at"],
    }


# ---------------------------------------------------------------------------
# Prompt versioning (revision / rebuild).
# ---------------------------------------------------------------------------

def next_prompt_version(database: Any, project_id: str, logical_asset_id: str) -> int:
    with database.connect() as c:
        row = c.execute(
            "SELECT COALESCE(MAX(version), 0) AS m FROM prompt_versions WHERE project_id=? AND logical_asset_id=?",
            (project_id, logical_asset_id),
        ).fetchone()
    return int(row["m"]) + 1


def create_prompt_version(database: Any, project_id: str, logical_asset_id: str, asset_class: str,
                          prompt: str, source: str, skill_id: str | None = None,
                          parent_version: int | None = None, change_reason: str | None = None,
                          source_qa_run_id: str | None = None,
                          rebuilt_from_failure_ids: list[str] | None = None,
                          connection: Any | None = None) -> dict[str, Any]:
    now = _now()
    def _create(c: Any) -> dict[str, Any]:
        version = int(c.execute(
            "SELECT COALESCE(MAX(version), 0) AS m FROM prompt_versions WHERE project_id=? AND logical_asset_id=?",
            (project_id, logical_asset_id),
        ).fetchone()["m"]) + 1
        pid = f"PROMPT_{logical_asset_id}_{version:03d}_{secrets.token_hex(3)}"
        c.execute(
            "INSERT INTO prompt_versions(id, project_id, logical_asset_id, asset_class, version, parent_version, "
            "prompt, source, skill_id, status, change_reason, source_qa_run_id, rebuilt_from_failure_ids, created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (pid, project_id, logical_asset_id, asset_class, version, parent_version, prompt, source, skill_id,
             "prompt_qa_pending", change_reason, source_qa_run_id,
             database.encode(rebuilt_from_failure_ids or []), now),
        )
        row = c.execute("SELECT * FROM prompt_versions WHERE id=?", (pid,)).fetchone()
        return prompt_version_payload(database, row)
    if connection is not None:
        return _create(connection)
    with database.connect() as c:
        return _create(c)


def prompt_version_payload(database: Any, row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "logical_asset_id": row["logical_asset_id"],
        "asset_class": row["asset_class"],
        "version": row["version"],
        "parent_version": row["parent_version"],
        "prompt": row["prompt"],
        "source": row["source"],
        "skill_id": row["skill_id"],
        "status": row["status"],
        "change_reason": row["change_reason"],
        "source_qa_run_id": row["source_qa_run_id"],
        "rebuilt_from_failure_ids": database.decode(row["rebuilt_from_failure_ids"], []),
        "created_at": row["created_at"],
    }


def get_prompt_version(database: Any, prompt_version: str | None, project_id: str, logical_asset_id: str) -> dict[str, Any] | None:
    with database.connect() as c:
        if prompt_version:
            row = c.execute(
                "SELECT * FROM prompt_versions WHERE id=? AND project_id=? AND logical_asset_id=?",
                (prompt_version, project_id, logical_asset_id),
            ).fetchone()
        else:
            row = c.execute(
                "SELECT * FROM prompt_versions WHERE project_id=? AND logical_asset_id=? ORDER BY version DESC LIMIT 1",
                (project_id, logical_asset_id),
            ).fetchone()
    return prompt_version_payload(database, row) if row else None


def list_prompt_versions(database: Any, project_id: str, logical_asset_id: str) -> list[dict[str, Any]]:
    with database.connect() as c:
        rows = c.execute(
            "SELECT * FROM prompt_versions WHERE project_id=? AND logical_asset_id=? ORDER BY version DESC",
            (project_id, logical_asset_id),
        ).fetchall()
    return [prompt_version_payload(database, r) for r in rows]


# ---------------------------------------------------------------------------
# Asset versioning (qualified/active version tracking).
# ---------------------------------------------------------------------------

def next_asset_version(database: Any, project_id: str, logical_asset_id: str) -> int:
    with database.connect() as c:
        row = c.execute(
            "SELECT COALESCE(MAX(version), 0) AS m FROM asset_versions WHERE project_id=? AND logical_asset_id=?",
            (project_id, logical_asset_id),
        ).fetchone()
    return int(row["m"]) + 1


def create_asset_version(database: Any, project_id: str, logical_asset_id: str, asset_class: str,
                         artifact_id: str, prompt_version: str | None, status: str,
                         is_active: bool, registration: dict[str, Any] | None = None) -> dict[str, Any]:
    now = _now()
    approved_at = now if is_active else None
    with database.connect() as c:
        version = int(c.execute(
            "SELECT COALESCE(MAX(version), 0) AS m FROM asset_versions WHERE project_id=? AND logical_asset_id=?",
            (project_id, logical_asset_id),
        ).fetchone()["m"]) + 1
        vid = f"AV_{logical_asset_id}_{version:03d}_{secrets.token_hex(3)}"
        # Supersede any previously active version for this logical asset.
        if is_active:
            c.execute(
                "UPDATE asset_versions SET is_active=0, status='superseded' WHERE project_id=? AND logical_asset_id=? AND is_active=1",
                (project_id, logical_asset_id),
            )
        prompt_version_id = None
        if prompt_version:
            prompt = c.execute(
                "SELECT id FROM prompt_versions WHERE id=? AND project_id=? AND logical_asset_id=?",
                (prompt_version, project_id, logical_asset_id),
            ).fetchone()
            prompt_version_id = prompt["id"] if prompt else None
        c.execute(
            "INSERT INTO asset_versions(id, project_id, logical_asset_id, asset_class, version, artifact_id, "
            "prompt_version, prompt_version_id, status, is_active, registration_json, created_at, approved_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (vid, project_id, logical_asset_id, asset_class, version, artifact_id, prompt_version, prompt_version_id,
             status, int(is_active), database.encode(registration or {}), now, approved_at),
        )
        row = c.execute("SELECT * FROM asset_versions WHERE id=?", (vid,)).fetchone()
    return asset_version_payload(database, row)


def asset_version_payload(database: Any, row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "logical_asset_id": row["logical_asset_id"],
        "asset_class": row["asset_class"],
        "version": row["version"],
        "artifact_id": row["artifact_id"],
        "prompt_version": row["prompt_version"],
        "prompt_version_id": row["prompt_version_id"] if "prompt_version_id" in row.keys() else None,
        "status": row["status"],
        "is_active": bool(row["is_active"]),
        "registration": database.decode(row["registration_json"], {}),
        "created_at": row["created_at"],
        "approved_at": row["approved_at"],
    }


def list_asset_versions(database: Any, project_id: str, logical_asset_id: str) -> list[dict[str, Any]]:
    with database.connect() as c:
        rows = c.execute(
            "SELECT * FROM asset_versions WHERE project_id=? AND logical_asset_id=? ORDER BY version DESC",
            (project_id, logical_asset_id),
        ).fetchall()
    return [asset_version_payload(database, r) for r in rows]
