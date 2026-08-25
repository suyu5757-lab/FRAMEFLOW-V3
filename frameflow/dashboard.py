"""Derived project dashboard state for the FrameFlow V3 home screen.

The dashboard is a read-only projection. It deliberately does not persist a
second set of project or stage statuses; callers provide the current project
document and the latest execution envelopes and this module derives the
display model from them.
"""

from __future__ import annotations

from typing import Any, Iterable

from .asset_audit import asset_readiness
from .story import SHOT_REQUIRED_FIELDS, story_checks, story_document

HOME_STATUSES = (
    "not_started",
    "in_progress",
    "awaiting_confirmation",
    "awaiting_review",
    "ready",
    "completed",
    "blocked",
    "failed",
    "skipped",
)

STAGE_DEFINITIONS = (
    ("story", "故事与分镜", "story"),
    ("regulator", "资产监管", "assets"),
    ("assets", "资产生产", "assets"),
    ("fusion", "素材融合", "assets"),
    ("director", "镜头导演", "canvas"),
    ("audio", "配音与声音", "audio"),
    ("generate", "视频生成", "canvas"),
    ("delivery", "质检与交付", "timeline"),
)


def _text(value: Any) -> str:
    return str(value or "").strip()


def _count(items: Iterable[Any]) -> int:
    return sum(1 for _ in items)


def _task(
    task_id: str,
    category: str,
    title: str,
    reason: str,
    priority: str,
    status: str,
    route: str,
    action: str,
    target_id: str | None = None,
    blocked_by: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "id": task_id,
        "category": category,
        "title": title,
        "reason": reason,
        "priority": priority,
        "status": status,
        "route": route,
        "action": action,
        **({"targetId": target_id} if target_id else {}),
        **({"blockedBy": blocked_by} if blocked_by else {}),
    }


def _latest_status(*envelopes: dict[str, Any] | None) -> str | None:
    for envelope in envelopes:
        if not envelope:
            continue
        status = _text(envelope.get("status"))
        if status:
            return status
    return None


def _asset_items(project: dict[str, Any], asset_library: dict[str, Any] | None) -> list[dict[str, Any]]:
    if isinstance(asset_library, dict) and isinstance(asset_library.get("assets"), list):
        return [item for item in asset_library["assets"] if isinstance(item, dict)]
    items: list[dict[str, Any]] = []
    for raw in project.get("assets", []) or []:
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        item["readiness"] = asset_readiness(raw)
        items.append(item)
    return items


def _story_stage(project: dict[str, Any], story_run: dict[str, Any] | None) -> tuple[dict[str, Any], dict[str, Any]]:
    story = story_document(project)
    checks = story_checks(project)
    shots = [shot for shot in story["shots"] if _text(shot.get("status")) != "deprecated"]
    valid_shots = [shot for shot in shots if all(shot.get(field) not in (None, "", []) for field in SHOT_REQUIRED_FIELDS)]
    run_status = _latest_status(story_run)
    if run_status in {"storyboard_review_required", "regulator_review_required"}:
        status = "awaiting_review"
        reason = "AI 故事或资产总控结果等待审核"
    elif run_status in {"failed", "storyboard_rejected", "regulator_rejected"}:
        status = "failed"
        reason = _text((story_run or {}).get("error")) or "故事工作流需要重试或修订"
    elif not _text(story.get("script")) and not shots:
        status = "not_started"
        reason = "尚未建立脚本和镜头"
    elif checks.get("errors", 0) > 0:
        status = "blocked"
        reason = f"故事检查发现 {checks['errors']} 个错误"
    elif _text(story.get("script")) and shots and len(valid_shots) == len(shots):
        status = "completed"
        reason = f"脚本与 {len(shots)} 个镜头字段完整"
    else:
        status = "in_progress"
        reason = f"镜头字段完整 {len(valid_shots)}/{len(shots) or 1}"
    return {
        "status": status,
        "completed": 1 if status == "completed" else 0,
        "total": 1,
        "reason": reason,
    }, {
        "script_length": len(_text(story.get("script"))),
        "scene_count": len(story.get("scenes", [])),
        "shot_count": len(shots),
        "complete_shots": len(valid_shots),
        "check_errors": int(checks.get("errors", 0)),
        "check_warnings": int(checks.get("warnings", 0)),
        "target_duration": story.get("spec", {}).get("duration", project.get("duration", 0)),
    }


def _asset_stage(project: dict[str, Any], items: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    required = [item for item in items if bool((item.get("readiness") or {}).get("required", str(item.get("grade", "")).startswith(("A", "A+"))))]
    ready = [item for item in required if bool((item.get("readiness") or {}).get("ready"))]
    blocked = [item for item in required if (item.get("readiness") or {}).get("status") == "blocked"]
    missing_required = [item for item in required if not bool((item.get("readiness") or {}).get("ready"))]
    if not items:
        status = "not_started"
        reason = "尚未建立资产清单"
    elif blocked:
        status = "blocked"
        reason = f"{len(blocked)} 个必需资产被阻塞"
    elif missing_required:
        status = "blocked"
        reason = f"{len(missing_required)} 个必需资产尚未达到就绪门"
    elif required and len(ready) == len(required):
        status = "completed"
        reason = f"必需资产 {len(ready)}/{len(required)} 已生产就绪"
    elif required or items:
        status = "in_progress"
        reason = f"必需资产就绪 {len(ready)}/{len(required) or len(items)}"
    else:
        status = "not_started"
        reason = "尚未建立资产清单"
    summary = {
        "total": len(items),
        "ready": sum(1 for item in items if bool((item.get("readiness") or {}).get("ready"))),
        "awaiting_review": sum(1 for item in items if (item.get("readiness") or {}).get("status") in {"partial", "provisional"}),
        "blocked": sum(1 for item in items if (item.get("readiness") or {}).get("status") == "blocked"),
        "missing_required": len(required) - len(ready),
        "required": len(required),
    }
    return {
        "status": status,
        "completed": len(ready),
        "total": len(required) or len(items),
        "reason": reason,
    }, summary


def _domain_assets(items: list[dict[str, Any]], asset_class: str) -> list[dict[str, Any]]:
    return [item for item in items if _text(item.get("assetClass") or item.get("asset_class") or item.get("type")) in {asset_class, {"character": "角色", "scene": "场景", "prop": "道具", "fusion": "融合"}.get(asset_class, asset_class)}]


def _domain_stage(items: list[dict[str, Any]], asset_class: str, label: str) -> dict[str, Any]:
    relevant = _domain_assets(items, asset_class)
    required = [item for item in relevant if bool((item.get("readiness") or {}).get("required", str(item.get("grade", "")).startswith(("A", "A+"))))]
    if not relevant:
        return {"status": "skipped", "completed": 0, "total": 0, "reason": f"没有登记必需的{label}资产"}
    ready = [item for item in required if bool((item.get("readiness") or {}).get("ready"))]
    blocked = [item for item in required if (item.get("readiness") or {}).get("status") == "blocked"]
    if blocked:
        status = "blocked"
        reason = f"{len(blocked)} 个{label}资产阻塞"
    elif required and len(ready) == len(required):
        status = "completed"
        reason = f"{label}资产 {len(ready)}/{len(required)} 已就绪"
    elif required:
        status = "blocked"
        reason = f"{label}资产 {len(ready)}/{len(required)} 已就绪，仍有必需缺口"
    else:
        status = "in_progress" if any(item.get("prompt") or item.get("artifactId") or item.get("filePath") for item in relevant) else "not_started"
        reason = f"{label}资产就绪 {len(ready)}/{len(required) or len(relevant)}"
    return {"status": status, "completed": len(ready), "total": len(required) or len(relevant), "reason": reason}


def _director_stage(project: dict[str, Any], asset_stage: dict[str, Any], fusion_stage: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    shots = [shot for shot in project.get("shots", []) if isinstance(shot, dict) and _text(shot.get("status")) != "deprecated"]
    directed = [shot for shot in shots if bool(shot.get("directorApproved")) and bool(shot.get("directorPackage") or shot.get("directorPackageId") or shot.get("directorApprovedPackage"))]
    if not shots:
        status = "not_started"
        reason = "尚未建立镜头"
    elif asset_stage["status"] in {"not_started", "blocked"} or fusion_stage["status"] in {"not_started", "blocked"}:
        status = "blocked"
        reason = "必需角色、场景、道具或融合资产尚未就绪"
    elif len(directed) == len(shots):
        status = "completed"
        reason = f"{len(directed)} 个镜头已有批准导演包"
    else:
        status = "in_progress" if directed else "not_started"
        reason = f"导演包完成 {len(directed)}/{len(shots)}"
    return {"status": status, "completed": len(directed), "total": len(shots), "reason": reason}, {"shot_count": len(shots), "directed_shots": len(directed)}


def _audio_stage(project: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    audio = project.get("audio") if isinstance(project.get("audio"), dict) else {}
    keys = ("voices", "voiceReferences", "dialogues", "takes", "musicCues", "soundEffects", "ambience")
    entries = [item for key in keys for item in (audio.get(key) or []) if isinstance(item, dict)]
    if not entries and audio.get("required") is not True:
        return {"status": "skipped", "completed": 0, "total": 0, "reason": "本项目没有独立声音制作项"}, {"total": 0, "approved": 0, "blocked": 0}
    approved = [item for item in entries if item.get("status") in {"approved", "ready"} and item.get("qaDecision", "Approved") in {"Approved", None}]
    blocked = [item for item in entries if item.get("status") in {"blocked", "rejected", "pending-consent"} or item.get("consentStatus") in {"pending-consent", "restricted", "rejected"}]
    status = "completed" if entries and len(approved) == len(entries) else "blocked" if blocked else "in_progress" if entries else "not_started"
    reason = f"声音就绪 {len(approved)}/{len(entries)}" if entries else "尚未登记声音制作项"
    return {"status": status, "completed": len(approved), "total": len(entries), "reason": reason}, {"total": len(entries), "approved": len(approved), "blocked": len(blocked)}


def _execution_stage(latest_run: dict[str, Any] | None, director_stage: dict[str, Any], shot_count: int) -> tuple[dict[str, Any], dict[str, Any]]:
    run_status = _latest_status(latest_run)
    if run_status == "awaiting_confirmation":
        status = "awaiting_confirmation"
    elif run_status in {"queued", "running", "paused"}:
        status = "in_progress"
    elif run_status == "failed":
        status = "failed"
    elif director_stage["status"] != "completed":
        status = "blocked" if director_stage["status"] == "blocked" else "not_started"
        return {"status": status, "completed": 0, "total": 1, "reason": "镜头导演包尚未全部批准"}, {"queued": 0, "running": 0, "awaiting_confirmation": 0, "failed": 0, "latest_status": run_status or "none"}
    elif run_status in {"succeeded", "completed"}:
        status = "completed"
    else:
        status = "not_started"
    reason = {"awaiting_confirmation": "付费生成任务等待确认", "in_progress": "视频生成任务正在执行", "failed": "最近一次视频生成失败，可重试", "completed": f"视频生成阶段已完成 {shot_count} 个镜头", "not_started": "尚未创建视频生成运行"}.get(status, "视频生成前置条件未满足")
    return {"status": status, "completed": 1 if status == "completed" else 0, "total": 1, "reason": reason}, {"queued": int(run_status == "queued"), "running": int(run_status in {"running", "paused"}), "awaiting_confirmation": int(run_status == "awaiting_confirmation"), "failed": int(run_status == "failed"), "latest_status": run_status or "none"}


def _delivery_stage(timeline: dict[str, Any] | None, latest_render: dict[str, Any] | None, execution_stage: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    render_status = _latest_status(latest_render)
    if render_status == "awaiting_confirmation":
        status = "awaiting_confirmation"
    elif render_status in {"queued", "running"}:
        status = "in_progress"
    elif render_status == "failed":
        status = "failed"
    elif render_status in {"succeeded", "completed"}:
        status = "completed"
    elif execution_stage["status"] in {"blocked", "in_progress", "awaiting_confirmation", "failed"}:
        status = "blocked" if execution_stage["status"] == "blocked" else "not_started"
    elif execution_stage["status"] == "not_started":
        status = "not_started"
    elif timeline and timeline.get("document", {}).get("tracks"):
        status = "in_progress"
    else:
        status = "not_started"
    reason = {"awaiting_confirmation": "最终渲染等待确认", "in_progress": "时间线或最终渲染正在处理", "failed": "最终交付渲染失败，可重试", "completed": "最终交付已生成", "blocked": "视频生成未完成，暂不能交付", "not_started": "尚未装配最终时间线"}.get(status, "")
    revision = int((timeline or {}).get("revision") or 0)
    return {"status": status, "completed": 1 if status == "completed" else 0, "total": 1, "reason": reason}, {"timeline_revision": revision, "render_status": render_status or "none"}


def _stage_payload(stage_id: str, stage: dict[str, Any], index: int, route: str, next_task_id: str | None = None) -> dict[str, Any]:
    return {
        "id": stage_id,
        "label": dict((item[0], item[1]) for item in STAGE_DEFINITIONS).get(stage_id, stage_id),
        "order": index,
        "status": stage["status"],
        "completed": stage.get("completed", 0),
        "total": stage.get("total", 0),
        "reason": stage.get("reason", ""),
        "route": route,
        **({"next_task_id": next_task_id} if next_task_id else {}),
    }


def _progress(stages: list[dict[str, Any]]) -> dict[str, int]:
    active = [stage for stage in stages if stage["status"] != "skipped"]
    completed = [stage for stage in active if stage["status"] == "completed"]
    return {"completed": len(completed), "total": len(active), "percent": round(len(completed) / len(active) * 100) if active else 0}


def _tasks(
    project: dict[str, Any],
    stages: dict[str, dict[str, Any]],
    items: list[dict[str, Any]],
    latest_story_run: dict[str, Any] | None,
    latest_run: dict[str, Any] | None,
    latest_render: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    story = stages["story"]
    story_run_status = _latest_status(latest_story_run)
    if story["status"] == "awaiting_review":
        out.append(_task("TASK_REVIEW_STORY", "content", "审核故事与分镜", story["reason"], "critical", "awaiting_review", "story", "review_story"))
    elif story["status"] == "failed":
        out.append(_task("TASK_RETRY_STORY", "content", "重试故事工作流", story["reason"], "critical", "failed", "story", "retry_story"))
    elif story["status"] != "completed":
        out.append(_task("TASK_COMPLETE_STORY", "content", "完成故事与分镜", story["reason"], "critical", story["status"], "story", "edit_story"))
    if story["status"] == "completed" and not project.get("assetRegulator", {}).get("auditedAt"):
        out.append(_task("TASK_RUN_REGULATOR", "process", "运行资产审计", "故事与分镜已完成，等待提取和分级资产", "critical", "not_started", "assets", "run_regulator"))
    if story_run_status == "regulator_review_required":
        out.insert(0, _task("TASK_REVIEW_REGULATOR", "process", "审核资产总控结果", "资产清单和依赖等待审核", "critical", "awaiting_review", "assets", "review_regulator"))

    for item in items:
        readiness = item.get("readiness") or {}
        if not readiness.get("required") or readiness.get("ready"):
            continue
        asset_id = _text(item.get("id")) or "asset"
        item_status = _text(readiness.get("status")) or "missing"
        if item_status == "blocked":
            title = f"处理 {asset_id} 阻塞"
            action = "fix_block"
            priority = "critical"
        elif item_status == "partial":
            title = f"补齐 {asset_id} 资产"
            action = "complete_asset"
            priority = "high"
        else:
            title = f"制作 {asset_id} 资产"
            action = "prepare_asset"
            priority = "high"
        out.append(_task(f"TASK_ASSET_{asset_id}", "asset", title, ", ".join(readiness.get("missing", [])) or "必需资产尚未生产就绪", priority, "blocked", "assets", action, asset_id))

    if story["status"] == "completed" and stages["director"]["status"] != "completed" and stages["director"]["status"] != "skipped" and stages["assets"]["status"] not in {"not_started", "blocked"} and stages["fusion"]["status"] not in {"not_started", "blocked"}:
        out.append(_task("TASK_DIRECTOR", "process", "完成镜头导演包", stages["director"]["reason"], "high", stages["director"]["status"], "canvas", "direct_shots"))
    execution = stages["generate"]
    run_status = _latest_status(latest_run)
    if run_status == "awaiting_confirmation":
        out.insert(0, _task("TASK_CONFIRM_GENERATION", "execution", "确认付费视频生成", execution["reason"], "critical", "awaiting_confirmation", "canvas", "confirm_generation", _text((latest_run or {}).get("id"))))
    elif run_status == "failed":
        out.insert(0, _task("TASK_RETRY_GENERATION", "execution", "重试视频生成", execution["reason"], "critical", "failed", "canvas", "retry_generation", _text((latest_run or {}).get("id"))))
    elif execution["status"] not in {"completed", "skipped"} and stages["director"]["status"] == "completed":
        out.append(_task("TASK_RUN_GENERATION", "execution", "启动视频生成", execution["reason"], "high", execution["status"], "canvas", "run_generation"))
    delivery = stages["delivery"]
    if delivery["status"] == "failed":
        out.insert(0, _task("TASK_RETRY_DELIVERY", "delivery", "重试最终交付", delivery["reason"], "critical", "failed", "timeline", "retry_delivery", _text((latest_render or {}).get("id"))))
    elif delivery["status"] == "awaiting_confirmation":
        out.insert(0, _task("TASK_CONFIRM_DELIVERY", "delivery", "确认最终交付", delivery["reason"], "critical", "awaiting_confirmation", "timeline", "confirm_delivery", _text((latest_render or {}).get("id"))))
    elif delivery["status"] not in {"completed", "skipped"} and execution["status"] == "completed":
        out.append(_task("TASK_DELIVER", "delivery", "进入最终质检与交付", delivery["reason"], "normal", delivery["status"], "timeline", "deliver"))
    priority_rank = {"blocked": 0, "awaiting_confirmation": 1, "awaiting_review": 2, "failed": 3}
    return [
        task
        for _, task in sorted(
            enumerate(out),
            key=lambda pair: (priority_rank.get(str(pair[1].get("status")), 4), pair[0]),
        )
    ]


def build_dashboard_snapshot(
    project: dict[str, Any],
    graph: dict[str, Any] | None = None,
    asset_library: dict[str, Any] | None = None,
    latest_story_run: dict[str, Any] | None = None,
    latest_run: dict[str, Any] | None = None,
    timeline: dict[str, Any] | None = None,
    latest_render: dict[str, Any] | None = None,
    recent_activity: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    items = _asset_items(project, asset_library)
    story_stage, content = _story_stage(project, latest_story_run)
    asset_stage, assets = _asset_stage(project, items)
    fusion = _domain_stage(items, "fusion", "融合")
    director, director_metrics = _director_stage(project, asset_stage, fusion)
    audio, audio_metrics = _audio_stage(project)
    regulator = {
        "status": "completed" if project.get("assetRegulator", {}).get("auditedAt") and not project.get("assetRegulator", {}).get("missingA") else "in_progress" if project.get("assetRegulator", {}).get("auditedAt") else "not_started",
        "completed": 1 if project.get("assetRegulator", {}).get("auditedAt") and not project.get("assetRegulator", {}).get("missingA") else 0,
        "total": 1,
        "reason": "资产清单已审计且无 A 级缺口" if project.get("assetRegulator", {}).get("auditedAt") and not project.get("assetRegulator", {}).get("missingA") else "运行资产审计并登记依赖" if not project.get("assetRegulator", {}).get("auditedAt") else "仍有必需资产缺口",
    }
    generate, execution = _execution_stage(latest_run, director, content["shot_count"])
    delivery, delivery_metrics = _delivery_stage(timeline, latest_render, generate)
    stages_by_id = {"story": story_stage, "regulator": regulator, "assets": asset_stage, "fusion": fusion, "director": director, "audio": audio, "generate": generate, "delivery": delivery}
    tasks = _tasks(project, stages_by_id, items, latest_story_run, latest_run, latest_render)
    primary = tasks[0] if tasks else None
    progress = _progress(list(stages_by_id.values()))
    stage_payloads = []
    task_ids = {task.get("action"): task.get("id") for task in tasks}
    def first_task(*actions: str) -> str | None:
        return next((task_ids[action] for action in actions if action in task_ids), None)
    for index, (stage_id, label, route) in enumerate(STAGE_DEFINITIONS, 1):
        stage_actions = {
            "story": ("edit_story", "review_story", "retry_story"),
            "regulator": ("run_regulator", "review_regulator"),
            "assets": ("complete_asset", "prepare_asset", "fix_block"),
            "fusion": ("fix_block",),
            "director": ("direct_shots",),
            "audio": ("audio_qa",),
            "generate": ("confirm_generation", "retry_generation", "run_generation"),
            "delivery": ("confirm_delivery", "retry_delivery", "deliver"),
        }
        stage_payloads.append(_stage_payload(stage_id, stages_by_id[stage_id], index, route, first_task(*stage_actions.get(stage_id, ()))))
    # Count actionable blockers, not every downstream stage that is merely
    # waiting on the same upstream blocker (otherwise one missing asset would
    # appear as four unrelated failures on the home screen).
    blockers = 0
    if story_stage["status"] in {"blocked", "failed"}:
        blockers += max(1, int(content.get("check_errors", 0)))
    if regulator["status"] == "blocked":
        blockers += 1
    if asset_stage["status"] == "blocked":
        blockers += max(1, int(assets.get("missing_required", 0)), int(assets.get("blocked", 0)))
    if fusion["status"] == "blocked":
        blockers += 1
    if audio["status"] == "blocked":
        blockers += max(1, int(audio_metrics.get("blocked", 0)))
    if generate["status"] in {"failed", "blocked"} and (latest_run or {}).get("status") == "failed":
        blockers += 1
    if delivery["status"] in {"failed", "blocked"} and (latest_render or {}).get("status") == "failed":
        blockers += 1
    reviews = sum(1 for stage in stages_by_id.values() if stage["status"] == "awaiting_review") + sum(1 for item in items if (item.get("readiness") or {}).get("status") == "partial")
    status = "blocked" if blockers else "awaiting_review" if reviews else "completed" if progress["total"] and progress["completed"] == progress["total"] else "in_progress" if any(stage["status"] not in {"not_started", "skipped"} for stage in stages_by_id.values()) else "not_started"
    project_summary = {
        "project_id": project.get("id"),
        "name": project.get("name") or "未命名项目",
        "ratio": project.get("ratio"),
        "duration": project.get("duration"),
        "generator": project.get("generator"),
        "status": status,
        "progress": progress,
        "current_stage_id": next((stage["id"] for stage in stage_payloads if stage["status"] not in {"completed", "skipped"}), None),
        "current_stage_label": next((stage["label"] for stage in stage_payloads if stage["status"] not in {"completed", "skipped"}), None),
        "blocker_count": blockers,
        "review_count": reviews,
        "next_task": primary,
        "updated_at": project.get("updated_at") or project.get("updatedAt"),
    }
    return {
        "project": project_summary,
        "stages": stage_payloads,
        "primary_next_task": primary,
        "task_queue": tasks[1:7],
        "metrics": {
            "content": content | director_metrics,
            "assets": assets,
            "execution": execution | {"run_status": execution.get("latest_status", "none")},
            "delivery": delivery_metrics,
        },
        "recent_activity": list(recent_activity or [])[:8],
        "source_revisions": {
            "project": int(project.get("revision") or 0),
            "graph": int((graph or {}).get("revision") or 0),
            "timeline": int((timeline or {}).get("revision") or 0),
        },
    }


def project_home_summary(snapshot: dict[str, Any]) -> dict[str, Any]:
    return snapshot["project"]
