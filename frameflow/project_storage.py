"""Human-readable project workspace persistence for FRAMEFLOW.

The SQLite database remains the runtime authority.  This module mirrors the
authoritative project state into a predictable, inspectable folder next to the
project's existing media directory.  The mirror is deliberately additive: it
does not move or delete user media, and it keeps the database as the source of
truth for status transitions and revision checks.
"""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any


LAYOUT_VERSION = 1

_CATEGORY_BY_CLASS = {
    "character": "characters",
    "scene": "scenes",
    "prop": "props",
    "product": "props",
    "fusion": "fusion",
    "style": "style",
    "audio": "audio",
    "music": "audio",
    "sfx": "audio",
    "video": "video",
    "post": "post",
}

_LAYOUT_DIRECTORIES = (
    "story/versions/scripts",
    "story/versions/storyboards",
    "assets/characters/prompts/versions",
    "assets/scenes/prompts/versions",
    "assets/props/prompts/versions",
    "assets/fusion/prompts/versions",
    "assets/style/prompts/versions",
    "assets/audio/prompts/versions",
    "assets/video/prompts/versions",
    "assets/post/prompts/versions",
    "assets/other/prompts/versions",
    "assets/specs",
    "qa",
    "runs",
    "board",
    "timeline",
    "workflow",
    "outputs",
)


def project_root(data_dir: Path, project_id: str) -> Path:
    """Resolve one safe project folder under the configured data directory."""
    value = str(project_id or "").strip()
    if not value or Path(value).name != value or value in {".", ".."} or any(char in value for char in "\\/\x00"):
        raise ValueError("项目 ID 不是安全的单级目录名。")
    projects_root = (Path(data_dir).resolve() / "projects").resolve()
    root = (projects_root / value).resolve()
    if root.parent != projects_root:
        raise ValueError("项目目录超出 configured projects 根目录。")
    return root


def _safe_component(value: Any, fallback: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "").strip())
    text = text.strip("._")
    return text[:180] or fallback


def _write_text(path: Path, value: str) -> None:
    """Atomically update a generated project file and avoid needless rewrites."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        try:
            if path.read_text(encoding="utf-8") == value:
                return
        except (OSError, UnicodeError):
            pass
    temporary = path.with_name(
        f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
    )
    try:
        temporary.write_text(value, encoding="utf-8")
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _write_json(path: Path, value: Any) -> None:
    _write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def _json(database: Any, value: Any, default: Any) -> Any:
    try:
        parsed = database.decode(value, default)
    except (TypeError, ValueError, json.JSONDecodeError):
        return default
    return parsed if parsed is not None else default


def _relative_path(root: Path, value: Any) -> str | None:
    if not value:
        return None
    try:
        return Path(str(value)).resolve().relative_to(root.resolve()).as_posix()
    except (OSError, ValueError):
        return None


def _asset_category(asset: dict[str, Any]) -> str:
    raw = str(asset.get("assetClass") or asset.get("asset_class") or asset.get("skill") or "other").strip().lower()
    return _CATEGORY_BY_CLASS.get(raw, "other")


def _storyboard_markdown(document: dict[str, Any], project_id: str, revision: int) -> str:
    lines = [
        f"# {document.get('name') or project_id} · 分镜",
        "",
        f"- 项目 ID：`{project_id}`",
        f"- 项目修订：`{revision}`",
        f"- 画幅：`{document.get('ratio') or '未设置'}`",
        f"- 时长：`{document.get('duration') or '未设置'}` 秒",
        "",
        "## 场景",
        "",
    ]
    scenes = [item for item in document.get("scenes", []) if isinstance(item, dict)]
    if scenes:
        for scene in scenes:
            scene_id = scene.get("id") or scene.get("scene_id") or "未命名场景"
            lines.append(f"- **{scene_id}** · {scene.get('name') or scene.get('description') or ''}".rstrip())
    else:
        lines.append("- 暂无场景。")
    lines.extend(["", "## 镜头", ""])
    shots = [item for item in document.get("shots", []) if isinstance(item, dict)]
    if not shots:
        lines.append("- 暂无镜头。")
    for index, shot in enumerate(shots, start=1):
        shot_id = shot.get("id") or shot.get("shot_id") or f"SHOT_{index:03d}"
        lines.extend([
            f"### {shot_id}",
            f"- 场景：{shot.get('scene') or shot.get('scene_id') or '未设置'}",
            f"- 时长：{shot.get('duration') or '未设置'} 秒",
            f"- 目的：{shot.get('purpose') or '未填写'}",
            f"- 景别 / 机位：{shot.get('shotSize') or shot.get('camera') or '未填写'}",
            f"- 动作：{shot.get('action') or '未填写'}",
        ])
        requirements = [item for item in shot.get("assetRequirements", []) if isinstance(item, dict)]
        if requirements:
            lines.append("- 资产依赖：" + "、".join(str(item.get("assetId") or item.get("asset_id") or "未命名") for item in requirements))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _prompt_markdown(asset: dict[str, Any], prompt: str, prompt_version: dict[str, Any] | None = None) -> str:
    version_label = prompt_version.get("version") if prompt_version else "current"
    status = prompt_version.get("status") if prompt_version else asset.get("promptQaDecision") or "Pending"
    lines = [
        f"# {asset.get('id') or 'asset'} · {asset.get('name') or '未命名资产'} · Prompt v{version_label}",
        "",
        f"- 资产类别：`{asset.get('assetClass') or asset.get('asset_class') or asset.get('skill') or 'unknown'}`",
        f"- Prompt QA：`{status}`",
        f"- 来源：`{(prompt_version or {}).get('source') or asset.get('source') or 'project'}`",
    ]
    if prompt_version and prompt_version.get("id"):
        lines.append(f"- Prompt ID：`{prompt_version['id']}`")
    if prompt_version and prompt_version.get("change_reason"):
        lines.append(f"- 修改原因：{prompt_version['change_reason']}")
    lines.extend(["", "## Prompt", "", prompt.strip() or "（当前没有 Prompt）", ""])
    prompt_pack = asset.get("promptPack") or asset.get("prompt_pack") or {}
    if isinstance(prompt_pack, dict) and prompt_pack:
        lines.extend(["## 结构化 Prompt Pack", "", "```json", json.dumps(prompt_pack, ensure_ascii=False, indent=2), "```", ""])
    preserve = asset.get("mustPreserve") or asset.get("must_preserve") or []
    avoid = asset.get("mustAvoid") or asset.get("must_avoid") or []
    if preserve:
        lines.extend(["## 必须保留", "", *[f"- {item}" for item in preserve], ""])
    if avoid:
        lines.extend(["## 必须避免", "", *[f"- {item}" for item in avoid], ""])
    return "\n".join(lines).rstrip() + "\n"


def _table_names(connection: Any) -> set[str]:
    return {str(row[0]) for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}


def _fetch_rows(connection: Any, table: str, tables: set[str], project_id: str) -> list[Any]:
    if table not in tables:
        return []
    column = "id" if table == "projects" else "project_id"
    return connection.execute(f"SELECT * FROM {table} WHERE {column}=? ORDER BY rowid", (project_id,)).fetchall()


def _sync_with_connection(database: Any, data_dir: Path, project_id: str, connection: Any,
                          document: dict[str, Any] | None = None, revision: int | None = None) -> dict[str, Any]:
    project = connection.execute("SELECT document_json,revision,updated_at FROM projects WHERE id=?", (project_id,)).fetchone()
    if not project and document is None:
        raise ValueError(f"项目 {project_id} 不存在。")
    if document is None:
        document = _json(database, project["document_json"], {})
    if not isinstance(document, dict):
        document = {}
    revision_value = int(revision if revision is not None else (project["revision"] if project else 1))
    updated_at = str((project["updated_at"] if project else "") or "")
    root = project_root(data_dir, project_id)
    root.mkdir(parents=True, exist_ok=True)
    for relative in _LAYOUT_DIRECTORIES:
        (root / relative).mkdir(parents=True, exist_ok=True)

    project_payload = {
        "format": "frameflow-project",
        "layout_version": LAYOUT_VERSION,
        "project_id": project_id,
        "revision": revision_value,
        "updated_at": updated_at,
        "document": document,
    }
    _write_json(root / "project.json", project_payload)
    _write_text(root / "README.md", """# FRAMEFLOW 项目文件夹\n\n此目录由 FRAMEFLOW 工作台按项目自动维护。SQLite 是运行时状态权威；本目录保存可直接查看、复制和交接的项目文件。\n\n- `story/`：剧本、分镜和故事版本\n- `assets/`：按资产类别保存 Prompt、规格和资产登记索引\n- `qa/`：媒体 QA 与资产版本审计快照\n- `board/`：资产画布布局与镜头依赖的可读快照\n- `timeline/`：时间线文档\n- `workflow/`：工作流图\n- `outputs/`：交付或其他输出文件\n- `artifacts/`：原始上传和生成媒体，系统不会在同步时删除或覆盖\n\n所有 Prompt 和分镜文件都保留版本，不会用新版本覆盖历史内容。\n""")

    story_payload = {
        "project_id": project_id,
        "revision": revision_value,
        "spec": document.get("storySpec") or {},
        "scenes": document.get("scenes") or [],
        "shots": document.get("shots") or [],
    }
    _write_text(root / "story" / "script.md", str(document.get("script") or ""))
    _write_json(root / "story" / "storyboard.json", story_payload)
    _write_text(root / "story" / "storyboard.md", _storyboard_markdown(document, project_id, revision_value))
    for version in document.get("scriptVersions", []) if isinstance(document.get("scriptVersions"), list) else []:
        if isinstance(version, dict) and version.get("id"):
            _write_json(root / "story" / "versions" / "scripts" / f"{_safe_component(version['id'], 'script')}.json", version)
    for version in document.get("storyboardVersions", []) if isinstance(document.get("storyboardVersions"), list) else []:
        if isinstance(version, dict) and version.get("id"):
            _write_json(root / "story" / "versions" / "storyboards" / f"{_safe_component(version['id'], 'storyboard')}.json", version)

    tables = _table_names(connection)
    prompt_rows = _fetch_rows(connection, "prompt_versions", tables, project_id)
    prompt_by_asset: dict[str, list[dict[str, Any]]] = {}
    for row in prompt_rows:
        item = dict(row)
        item["rebuilt_from_failure_ids"] = _json(database, item.get("rebuilt_from_failure_ids"), [])
        prompt_by_asset.setdefault(str(item.get("logical_asset_id") or ""), []).append(item)
    asset_version_rows = _fetch_rows(connection, "asset_versions", tables, project_id)
    asset_versions_by_asset: dict[str, list[dict[str, Any]]] = {}
    for row in asset_version_rows:
        item = dict(row)
        item["registration"] = _json(database, item.get("registration_json"), {})
        asset_versions_by_asset.setdefault(str(item.get("logical_asset_id") or ""), []).append(item)
    artifact_rows = _fetch_rows(connection, "artifacts", tables, project_id)
    artifact_manifest: list[dict[str, Any]] = []
    for row in artifact_rows:
        item = dict(row)
        item["metadata"] = _json(database, item.get("metadata_json"), {})
        item["qa_report"] = _json(database, item.get("qa_report_json"), {})
        item["relative_path"] = _relative_path(root, item.get("local_path"))
        item.pop("metadata_json", None)
        item.pop("qa_report_json", None)
        item.pop("local_path", None)
        artifact_manifest.append(item)

    assets = [item for item in document.get("assets", []) if isinstance(item, dict) and item.get("id")]
    asset_manifest: list[dict[str, Any]] = []
    for asset in assets:
        asset_id = str(asset["id"])
        category = _asset_category(asset)
        category_root = root / "assets" / category
        category_root.mkdir(parents=True, exist_ok=True)
        prompt_root = category_root / "prompts" / _safe_component(asset_id, "asset")
        prompt_root.mkdir(parents=True, exist_ok=True)
        prompt = str(asset.get("prompt") or "")
        current_prompt_version = next((row for row in prompt_by_asset.get(asset_id, []) if str(row.get("id")) == str(asset.get("promptVersion") or "")), None)
        _write_text(prompt_root / "current.md", _prompt_markdown(asset, prompt, current_prompt_version))
        _write_json(prompt_root / "current.json", {
            "asset_id": asset_id,
            "prompt_version": asset.get("promptVersion"),
            "prompt": prompt,
            "prompt_pack": asset.get("promptPack") or asset.get("prompt_pack") or {},
            "prompt_quality": asset.get("promptQuality") or asset.get("prompt_quality") or {},
            "qa_decision": asset.get("promptQaDecision"),
        })
        for prompt_row in prompt_by_asset.get(asset_id, []):
            prompt_id = _safe_component(prompt_row.get("id"), f"prompt-{prompt_row.get('version', 0)}")
            prompt_text = str(prompt_row.get("prompt") or "")
            _write_text(prompt_root / "versions" / f"v{int(prompt_row.get('version') or 0):03d}-{prompt_id}.md", _prompt_markdown(asset, prompt_text, prompt_row))
            _write_json(prompt_root / "versions" / f"v{int(prompt_row.get('version') or 0):03d}-{prompt_id}.json", prompt_row)
        _write_json(root / "assets" / "specs" / f"{_safe_component(asset_id, 'asset')}.json", {
            "asset": asset,
            "asset_versions": asset_versions_by_asset.get(asset_id, []),
            "artifact_ids": [item.get("id") for item in artifact_manifest if str(item.get("logical_asset_id") or "") == asset_id],
        })
        asset_manifest.append({
            "id": asset_id,
            "name": asset.get("name"),
            "asset_class": asset.get("assetClass") or asset.get("asset_class") or asset.get("skill"),
            "category": category,
            "prompt_version": asset.get("promptVersion"),
            "prompt_qa_decision": asset.get("promptQaDecision"),
            "artifact_id": asset.get("artifactId") or asset.get("artifact_id"),
            "active_version_id": asset.get("activeVersionId") or asset.get("active_version_id"),
            "asset_versions": asset_versions_by_asset.get(asset_id, []),
        })

    qa_rows = _fetch_rows(connection, "asset_qa_runs", tables, project_id)
    qa_manifest = []
    for row in qa_rows:
        item = dict(row)
        item["report"] = _json(database, item.get("report_json"), {})
        item.pop("report_json", None)
        qa_manifest.append(item)
    _write_json(root / "assets" / "manifest.json", {"project_id": project_id, "revision": revision_value, "assets": asset_manifest, "artifacts": artifact_manifest})
    _write_json(root / "qa" / "asset-qa.json", {"project_id": project_id, "revision": revision_value, "runs": qa_manifest})
    _write_json(root / "runs" / "production-runs.json", {
        "asset_prompt_runs": document.get("assetPromptRuns") or [],
        "fusion_prompt_runs": document.get("fusionPromptRuns") or [],
        "story_workflow_runs": document.get("storyWorkflowRuns") or [],
    })

    if "timelines_v3" in tables:
        timeline = connection.execute("SELECT * FROM timelines_v3 WHERE project_id=? ORDER BY revision DESC LIMIT 1", (project_id,)).fetchone()
        if timeline:
            _write_json(root / "timeline" / "timeline.json", {
                "project_id": project_id,
                "revision": int(timeline["revision"]),
                "document": _json(database, timeline["document_json"], {}),
                "updated_at": timeline["updated_at"],
            })
    if "workflow_graphs" in tables:
        graph = connection.execute("SELECT * FROM workflow_graphs WHERE project_id=?", (project_id,)).fetchone()
        if graph:
            _write_json(root / "workflow" / "graph.json", {
                "project_id": project_id,
                "revision": int(graph["revision"]),
                "graph": _json(database, graph["graph_json"], {}),
                "updated_at": graph["updated_at"],
            })
    if "asset_boards_v7" in tables:
        board = connection.execute("SELECT * FROM asset_boards_v7 WHERE project_id=?", (project_id,)).fetchone()
        if board:
            _write_json(root / "board" / "asset-board.json", {
                "project_id": project_id,
                "revision": int(board["revision"]),
                "board": _json(database, board["board_json"], {}),
                "updated_at": board["updated_at"],
            })

    canonical_files = {
        "project": "project.json",
        "script": "story/script.md",
        "storyboard": "story/storyboard.md",
        "storyboard_json": "story/storyboard.json",
        "asset_manifest": "assets/manifest.json",
        "qa": "qa/asset-qa.json",
        "asset_board": "board/asset-board.json",
        "timeline": "timeline/timeline.json",
        "workflow": "workflow/graph.json",
    }
    _write_json(root / "storage-manifest.json", {
        "format": "frameflow-project-storage",
        "layout_version": LAYOUT_VERSION,
        "project_id": project_id,
        "revision": revision_value,
        "updated_at": updated_at,
        "root": str(root),
        "canonical_files": canonical_files,
        "asset_count": len(asset_manifest),
        "artifact_count": len(artifact_manifest),
    })
    return {
        "project_id": project_id,
        "revision": revision_value,
        "root": str(root),
        "layout_version": LAYOUT_VERSION,
        "canonical_files": canonical_files,
        "asset_count": len(asset_manifest),
        "artifact_count": len(artifact_manifest),
    }


def sync_project_files(database: Any, data_dir: Path, project_id: str,
                       *, document: dict[str, Any] | None = None,
                       revision: int | None = None, connection: Any | None = None) -> dict[str, Any]:
    """Mirror the current project state into its external project folder."""
    if connection is not None:
        return _sync_with_connection(database, data_dir, project_id, connection, document, revision)
    with database.connect() as owned_connection:
        return _sync_with_connection(database, data_dir, project_id, owned_connection, document, revision)


def sync_all_project_files(database: Any, data_dir: Path) -> dict[str, Any]:
    """Materialize all current projects after a server restart."""
    with database.connect() as connection:
        project_ids = [str(row[0]) for row in connection.execute("SELECT id FROM projects ORDER BY id").fetchall()]
    synced: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for project_id in project_ids:
        try:
            synced.append(sync_project_files(database, data_dir, project_id))
        except Exception as exc:  # pragma: no cover - only reached on external filesystem failures
            errors.append({"project_id": project_id, "message": str(exc)[:1000]})
    return {"layout_version": LAYOUT_VERSION, "synced": synced, "errors": errors}


def describe_project_storage(data_dir: Path, project_id: str, revision: int | None = None) -> dict[str, Any]:
    root = project_root(data_dir, project_id)
    return {
        "project_id": project_id,
        "root": str(root),
        "exists": root.is_dir(),
        "layout_version": LAYOUT_VERSION,
        "revision": revision,
        "directories": [relative for relative in _LAYOUT_DIRECTORIES],
        "canonical_files": {
            "project": "project.json",
            "script": "story/script.md",
            "storyboard": "story/storyboard.md",
            "storyboard_json": "story/storyboard.json",
            "asset_manifest": "assets/manifest.json",
            "qa": "qa/asset-qa.json",
            "asset_board": "board/asset-board.json",
            "timeline": "timeline/timeline.json",
            "workflow": "workflow/graph.json",
        },
    }
