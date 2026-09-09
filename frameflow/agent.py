"""Supervised Agent planning primitives for FrameFlow V3.

The Agent is deliberately limited to producing a reviewable, versioned patch.
This module contains no project writes and no Provider calls; the API layer is
responsible for persistence, revision checks and invoking the selected adapter.
"""

from __future__ import annotations

import json
from copy import deepcopy
from typing import Any

from .schemas import AgentPatchV3, AgentWorkspaceOperationV3, WorkflowGraphV3
from .prompt_design import canonicalize_prompt_output


AUTOMATIC_ACTIONS = {
    "text_analysis",
    "candidate_draft",
    "asset_gap_check",
    "continuity_check",
    "node_orchestration",
    "cost_estimate",
}
CONFIRMATION_ACTIONS = {
    "paid_media",
    "batch_generation",
    "replace_active_asset",
    "external_sync",
    "publish",
    "final_delivery",
}


ASSISTANT_CONTEXT_VERSION = "bounded-current-state-v1"
ASSISTANT_PROJECT_CONTEXT_DEFAULT_CHARS = 52_000
ASSISTANT_CONTEXT_HISTORY_LIMIT = 4
ASSISTANT_CONTEXT_ASSET_LIMIT = 80
ASSISTANT_CONTEXT_SHOT_LIMIT = 80


def _assistant_clip_text(value: Any, maximum: int) -> str:
    """Keep provider-facing context bounded while making omission explicit."""

    text = str(value or "").replace("\x00", "").strip()
    if maximum <= 0:
        return ""
    if len(text) <= maximum:
        return text
    marker = f"\n[… 已省略 {len(text) - maximum} 个字符；原文仍保留在 FRAMEFLOW 项目中。]"
    if len(marker) >= maximum:
        return text[:maximum]
    return text[: maximum - len(marker)].rstrip() + marker


def _assistant_compact_scalar_list(value: Any, maximum_items: int = 8, item_chars: int = 220) -> list[Any]:
    if not isinstance(value, list):
        return []
    compact: list[Any] = []
    for item in value[:maximum_items]:
        if isinstance(item, (str, int, float, bool)) or item is None:
            compact.append(_assistant_clip_text(item, item_chars) if isinstance(item, str) else item)
    if len(value) > maximum_items:
        compact.append(f"[… 另有 {len(value) - maximum_items} 项]")
    return compact


def _assistant_small_dict(value: Any, maximum: int = 900) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    result: dict[str, Any] = {}
    for key, item in value.items():
        if isinstance(item, (str, int, float, bool)) or item is None:
            result[str(key)] = _assistant_clip_text(item, 260) if isinstance(item, str) else item
        elif isinstance(item, list) and all(isinstance(child, (str, int, float, bool)) or child is None for child in item):
            result[str(key)] = _assistant_compact_scalar_list(item, 6, 150)
        if len(json.dumps(result, ensure_ascii=False)) > maximum:
            result.pop(str(key), None)
            break
    return result or None


def _assistant_asset_context(asset: dict[str, Any], prompt_chars: int = 420) -> dict[str, Any]:
    pack = asset.get("promptPack") if isinstance(asset.get("promptPack"), dict) else {}
    quality = asset.get("promptQuality") if isinstance(asset.get("promptQuality"), dict) else {}
    coverage = quality.get("coverage") if isinstance(quality.get("coverage"), dict) else {}
    fusion = asset.get("fusionPlan") if isinstance(asset.get("fusionPlan"), dict) else {}
    result: dict[str, Any] = {
        "id": asset.get("id"),
        "name": asset.get("name"),
        "type": asset.get("type"),
        "assetClass": asset.get("assetClass"),
        "assetRole": asset.get("assetRole"),
        "grade": asset.get("grade"),
        "required": asset.get("required"),
        "status": asset.get("status"),
        "readiness": asset.get("readiness"),
        "generationStatus": asset.get("generationStatus"),
        "generationChoiceStatus": asset.get("generationChoiceStatus"),
        "promptVersion": asset.get("promptVersion"),
        "promptContractVersion": asset.get("promptContractVersion"),
        "promptWorkflow": asset.get("promptWorkflow"),
        "promptStatus": asset.get("promptStatus"),
        "promptQaDecision": asset.get("promptQaDecision"),
        "regulatorRegistered": asset.get("regulatorRegistered"),
        "activeVersionId": asset.get("activeVersionId"),
        "approvedVersion": asset.get("approvedVersion"),
        "promptRelevantShots": _assistant_compact_scalar_list(asset.get("promptRelevantShots"), 12, 80),
        "shotDependencies": _assistant_compact_scalar_list(asset.get("shotDependencies"), 12, 120),
        "promptExcerpt": _assistant_clip_text(asset.get("prompt"), prompt_chars),
        "promptPack": {
            "schemaVersion": pack.get("schemaVersion"),
            "workflow": pack.get("workflow"),
            "assetType": pack.get("assetType"),
            "promptIntent": _assistant_clip_text(pack.get("promptIntent"), 260),
            "identityAnchor": _assistant_clip_text(pack.get("identityAnchor") or asset.get("identityAnchor"), 680),
            "visibleEvent": _assistant_clip_text(pack.get("visibleEvent"), 300),
            "eventConsequence": _assistant_clip_text(pack.get("eventConsequence"), 300),
            "continuityChecklist": _assistant_compact_scalar_list(pack.get("continuityChecklist"), 6, 180),
            "mustPreserve": _assistant_compact_scalar_list(pack.get("mustPreserve") or asset.get("mustPreserve"), 8, 160),
            "mustAvoid": _assistant_compact_scalar_list(pack.get("mustAvoid") or asset.get("mustAvoid"), 8, 160),
            "suggestedSize": _assistant_clip_text(pack.get("suggestedSize"), 180),
        },
        "promptQuality": {
            "status": quality.get("status"),
            "passed": coverage.get("passed"),
            "total": coverage.get("total"),
            "percent": coverage.get("percent"),
        },
        "assetMetadata": _assistant_small_dict(asset.get("assetMetadata"), 500),
        "fusion": {
            "sourceAssetIds": _assistant_compact_scalar_list(asset.get("fusionSourceAssetIds"), 8, 80),
            "shotId": fusion.get("shotId"),
            "state": asset.get("fusionPromptState"),
            "stale": asset.get("fusionPromptStale"),
        },
    }
    result["references"] = _assistant_compact_scalar_list(asset.get("references"), 8, 100)
    return {key: value for key, value in result.items() if value not in (None, "", [], {})}


def _assistant_shot_context(shot: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key in ("id", "scene", "duration", "purpose", "size", "camera", "action", "dialogue", "narration", "environment", "sound", "generationMethod", "difficulty", "status"):
        if key in shot and shot[key] not in (None, "", []):
            value = shot[key]
            if isinstance(value, str):
                value = _assistant_clip_text(value, 900 if key in {"action", "camera", "purpose"} else 420)
            result[key] = value
    requirements: list[dict[str, Any]] = []
    for item in shot.get("assetRequirements") or []:
        if not isinstance(item, dict):
            continue
        requirements.append({key: item.get(key) for key in ("assetId", "assetClass", "role", "priority", "required", "requiredReadiness") if item.get(key) not in (None, "")})
    if requirements:
        result["assetRequirements"] = requirements[:16]
    if shot.get("risks"):
        result["risks"] = _assistant_compact_scalar_list(shot.get("risks"), 6, 180)
    return result


def _assistant_history_context(value: Any, limit: int = ASSISTANT_CONTEXT_HISTORY_LIMIT) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    preferred = ("id", "version", "parentId", "status", "createdAt", "updatedAt", "acceptedAt", "assetId", "assetIds", "shotId", "projectRevision", "storyRevision", "boardRevision", "promptVersion", "promptContractVersion", "skillId", "step", "reason", "note")
    result: list[dict[str, Any]] = []
    for item in value[-limit:]:
        if not isinstance(item, dict):
            continue
        summary: dict[str, Any] = {}
        for key in preferred:
            if key not in item or item[key] in (None, "", []):
                continue
            child = item[key]
            if isinstance(child, str):
                child = _assistant_clip_text(child, 320)
            elif isinstance(child, list):
                child = _assistant_compact_scalar_list(child, 8, 100)
            elif isinstance(child, dict):
                child = _assistant_small_dict(child, 500)
            summary[key] = child
        if summary:
            result.append(summary)
    return result


def compact_project_for_assistant(project: dict[str, Any], maximum: int = ASSISTANT_PROJECT_CONTEXT_DEFAULT_CHARS) -> dict[str, Any]:
    """Build a bounded, current-state project view for Provider input.

    Project JSON remains the source of truth and is never changed here.  Large
    historical runs, version bodies and duplicate Prompt prose are represented
    by summaries; current story/shot fields, stable asset IDs and QA/status
    gates remain available to the Agent.
    """

    raw_assets = [item for item in (project.get("assets") or []) if isinstance(item, dict)]
    raw_shots = [item for item in (project.get("shots") or []) if isinstance(item, dict)]
    raw_scenes = [item for item in (project.get("scenes") or []) if isinstance(item, dict)]
    compact: dict[str, Any] = {
        "contextMode": ASSISTANT_CONTEXT_VERSION,
        "id": project.get("id"),
        "name": project.get("name"),
        "brief": _assistant_clip_text(project.get("brief"), 2600),
        "ratio": project.get("ratio"),
        "duration": project.get("duration"),
        "generator": project.get("generator"),
        "stage": project.get("stage"),
        "productionStatus": project.get("productionStatus"),
        "lifecycleStatus": project.get("lifecycleStatus"),
        "storySpec": _assistant_small_dict(project.get("storySpec"), 1800) or {},
        "script": _assistant_clip_text(project.get("script"), 9000),
        "scenes": [{key: _assistant_clip_text(item.get(key), 500) if isinstance(item.get(key), str) else item.get(key) for key in ("id", "name", "location", "time", "duration", "visualGoal", "characters", "props", "environment") if item.get(key) not in (None, "", [])} for item in raw_scenes[:ASSISTANT_CONTEXT_SHOT_LIMIT]],
        "shots": [_assistant_shot_context(item) for item in raw_shots[:ASSISTANT_CONTEXT_SHOT_LIMIT]],
        "assets": [_assistant_asset_context(item) for item in raw_assets[:ASSISTANT_CONTEXT_ASSET_LIMIT]],
        "assetCount": len(raw_assets),
        "shotCount": len(raw_shots),
        "audio": _assistant_small_dict(project.get("audio"), 1800) or {},
        "assetRegulator": _assistant_small_dict(project.get("assetRegulator"), 1800) or {},
        "history": {
            "scriptVersions": _assistant_history_context(project.get("scriptVersions")),
            "storyboardVersions": _assistant_history_context(project.get("storyboardVersions")),
            "assetPromptRuns": _assistant_history_context(project.get("assetPromptRuns")),
            "fusionPromptRuns": _assistant_history_context(project.get("fusionPromptRuns")),
            "generations": _assistant_history_context(project.get("generations")),
            "seedancePackages": _assistant_history_context(project.get("seedancePackages")),
            "storyWorkflowRuns": _assistant_history_context(project.get("storyWorkflowRuns")),
        },
        "omittedSections": ["undoStack", "full_version_bodies", "full_asset_prompt_runs", "full_storyboard_versions"],
    }
    compact["omittedAssetCount"] = max(0, len(raw_assets) - ASSISTANT_CONTEXT_ASSET_LIMIT)
    compact["omittedShotCount"] = max(0, len(raw_shots) - ASSISTANT_CONTEXT_SHOT_LIMIT)

    if len(json.dumps(compact, ensure_ascii=False)) > maximum:
        compact["assets"] = [{key: item.get(key) for key in ("id", "name", "assetClass", "grade", "status", "readiness", "generationStatus", "promptVersion", "promptQaDecision", "regulatorRegistered") if item.get(key) not in (None, "", [])} for item in compact["assets"]]
        compact["shots"] = [{key: item.get(key) for key in ("id", "scene", "duration", "purpose", "size", "camera", "action", "status") if item.get(key) not in (None, "", [])} for item in compact["shots"]]
        compact["history"] = {key: {"count": len(project.get(key, []) or []), "latest": value} for key, value in compact["history"].items()}
        compact["script"] = _assistant_clip_text(project.get("script"), 5000)
    if len(json.dumps(compact, ensure_ascii=False)) > maximum:
        compact["assets"] = compact["assets"][:40]
        compact["shots"] = compact["shots"][:40]
        compact["scenes"] = compact["scenes"][:20]
        compact["contextWarning"] = "当前项目状态超过 Provider 上下文预算，已按稳定 ID、当前镜头和状态优先保留；完整内容仍在本地项目中。"
    if len(json.dumps(compact, ensure_ascii=False)) > maximum:
        compact = {
            "contextMode": ASSISTANT_CONTEXT_VERSION,
            "id": project.get("id"),
            "name": project.get("name"),
            "brief": _assistant_clip_text(project.get("brief"), 1200),
            "ratio": project.get("ratio"),
            "duration": project.get("duration"),
            "generator": project.get("generator"),
            "stage": project.get("stage"),
            "productionStatus": project.get("productionStatus"),
            "lifecycleStatus": project.get("lifecycleStatus"),
            "script": _assistant_clip_text(project.get("script"), 2400),
            "assetIndex": [{key: item.get(key) for key in ("id", "name", "assetClass", "grade", "status", "readiness", "promptVersion") if item.get(key) not in (None, "", [])} for item in raw_assets[:40]],
            "shotIndex": [{key: item.get(key) for key in ("id", "scene", "duration", "purpose", "size", "status") if item.get(key) not in (None, "", [])} for item in raw_shots[:40]],
            "assetCount": len(raw_assets),
            "shotCount": len(raw_shots),
            "historyCounts": {key: len(project.get(key, []) or []) for key in ("scriptVersions", "storyboardVersions", "assetPromptRuns", "fusionPromptRuns", "generations", "seedancePackages", "storyWorkflowRuns")},
            "contextWarning": "当前项目状态超过 Provider 上下文预算，已按项目身份、稳定资产 ID、镜头索引和版本计数保留；完整内容仍在本地项目中。",
        }
    return compact


PAID_NODE_KINDS = {
    "image_generation", "image_edit", "video_generation", "speech",
    "music_generation", "sound_effect", "upscale", "lip_sync",
}


AGENT_RESULT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "patch": {
            "type": ["object", "null"],
            "properties": {
                "version": {"type": "integer"},
                "base_project_revision": {"type": "integer"},
                "base_graph_revision": {"type": "integer"},
                "add_nodes": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
                "modify_nodes": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
                "remove_node_ids": {"type": "array", "items": {"type": "string"}},
                "add_edges": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
                "modify_edges": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
                "remove_edge_ids": {"type": "array", "items": {"type": "string"}},
                "candidates": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
                "suggested_run_node_ids": {"type": "array", "items": {"type": "string"}},
                "suggested_approval_gates": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
                "actions": {"type": "array", "items": {"type": "string"}},
                "requires_confirmation": {"type": "boolean"},
                "unsupported_operations": {"type": "array", "items": {"type": "string"}},
                "notes": {"type": "string"},
                "workspace_operations": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
                # Legacy assistant fields are accepted and converted to candidates.
                "brief": {"type": ["string", "null"]},
                "script": {"type": ["string", "null"]},
                "assets": {"type": ["array", "null"], "items": {"type": "object", "additionalProperties": True}},
                "shots": {"type": ["array", "null"], "items": {"type": "object", "additionalProperties": True}},
                "imagePrompt": {"type": ["string", "null"]},
            },
            "additionalProperties": True,
        },
        "actions": {"type": "array", "items": {"type": "string"}},
        "next_skill": {"type": ["string", "null"]},
        "requires_confirmation": {"type": "boolean"},
    },
    "required": ["reply", "patch", "actions", "next_skill", "requires_confirmation"],
    "additionalProperties": True,
}


def redact(value: Any) -> Any:
    """Redact credential-shaped fields before snapshots are persisted or returned."""
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            normalized = str(key).lower()
            if any(secret in normalized for secret in (
                "api_key", "apikey", "api-key", "authorization", "cookie", "password",
                "secret", "token", "credential_ref", "access_key", "private_key", "bearer",
            )):
                result[key] = "[REDACTED]"
            else:
                result[key] = redact(item)
        return result
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def build_input_snapshot(
    project: dict[str, Any],
    graph: dict[str, Any],
    message: str,
    selected_node_ids: list[str],
    context: dict[str, Any] | None = None,
    cost_boundary: dict[str, Any] | None = None,
    project_revision: int = 1,
    graph_revision: int = 1,
    skill_manifest: dict[str, Any] | None = None,
    skill_catalog: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build the complete Agent input contract without including credentials."""
    known = {str(node.get("id")): node for node in graph.get("nodes", []) if node.get("id")}
    selected = [known[node_id] for node_id in selected_node_ids if node_id in known]
    approved_assets = []
    for asset in project.get("assets", []) or []:
        if not isinstance(asset, dict):
            continue
        if asset.get("status") in {"approved", "ready"} and (
            asset.get("qaDecision") == "Approved" or asset.get("regulatorRegistered") is True
        ):
            approved_assets.append(asset)
    return redact({
        "message": message,
        "selected_node_ids": selected_node_ids,
        "selected_nodes": selected,
        "project_spec": {
            "id": project.get("id"),
            "name": project.get("name"),
            "brief": project.get("brief", ""),
            "ratio": project.get("ratio"),
            "duration": project.get("duration"),
            "generator": project.get("generator"),
            "storySpec": project.get("storySpec", {}),
        },
        # The caller may provide either the complete editable document or the
        # bounded current-state view used by the desktop Assistant. The
        # compact project_spec remains the stable contract in both cases.
        "project_document": project,
        "video_skill": skill_manifest or {},
        "video_skill_chain": skill_catalog or [],
        "approved_assets": approved_assets,
        "workflow_state": {
            "graph_revision": graph_revision,
            "project_revision": project_revision,
            "project_stage": project.get("stage", 0),
            "nodes": [
                {"id": node.get("id"), "kind": node.get("kind"), "label": node.get("label"), "status": node.get("status"), "version": node.get("version")}
                for node in graph.get("nodes", [])
            ],
        },
        "execution_boundaries": {
            "automatic": sorted(AUTOMATIC_ACTIONS),
            "confirmation_required": sorted(CONFIRMATION_ACTIONS),
            "agent_never_executes_media": True,
            "agent_never_replaces_active_asset": True,
        },
        "cost_boundary": cost_boundary or {},
        "context": context or {},
    })


def _payload_from_provider(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    structured = value.get("structured")
    if isinstance(structured, dict):
        return structured
    outputs = value.get("outputs")
    if isinstance(outputs, list):
        for output in outputs:
            if not isinstance(output, dict):
                continue
            candidate = output.get("data")
            if isinstance(candidate, dict):
                return candidate
            text = output.get("text") or output.get("output_text")
            if isinstance(text, str):
                import json
                try:
                    decoded = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if isinstance(decoded, dict):
                    return decoded
    return value


def normalize_agent_patch(
    provider_result: Any,
    base_project_revision: int,
    base_graph_revision: int,
    contract_snapshot: dict[str, Any] | None = None,
    attachment_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Normalize a Provider result and legacy assistant patch to the V3 shape."""
    payload = redact(_payload_from_provider(provider_result))
    raw_patch = payload.get("patch") if isinstance(payload.get("patch"), dict) else payload
    raw_patch = dict(raw_patch or {})
    patch: dict[str, Any] = {
        "version": int(raw_patch.get("version") or 1),
        "base_project_revision": base_project_revision,
        "base_graph_revision": base_graph_revision,
        "add_nodes": raw_patch.get("add_nodes", raw_patch.get("nodes_added", [])) or [],
        "modify_nodes": raw_patch.get("modify_nodes", raw_patch.get("nodes_modified", [])) or [],
        "remove_node_ids": raw_patch.get("remove_node_ids", raw_patch.get("nodes_removed", [])) or [],
        "add_edges": raw_patch.get("add_edges", raw_patch.get("edges_added", [])) or [],
        "modify_edges": raw_patch.get("modify_edges", raw_patch.get("edges_modified", [])) or [],
        "remove_edge_ids": raw_patch.get("remove_edge_ids", raw_patch.get("edges_removed", [])) or [],
        "candidates": list(raw_patch.get("candidates") or []),
        "suggested_run_node_ids": raw_patch.get("suggested_run_node_ids", raw_patch.get("run_node_ids", [])) or [],
        "suggested_approval_gates": list(raw_patch.get("suggested_approval_gates") or []),
        "actions": list(raw_patch.get("actions") or payload.get("actions") or []),
        "requires_confirmation": bool(raw_patch.get("requires_confirmation", payload.get("requires_confirmation", False))),
        "unsupported_operations": list(raw_patch.get("unsupported_operations") or []),
        "notes": str(raw_patch.get("notes") or ""),
        "workspace_operations": list(raw_patch.get("workspace_operations") or []),
    }
    legacy = (
        ("script", "script", raw_patch.get("script")),
        ("imagePrompt", "prompt", raw_patch.get("imagePrompt")),
        ("brief", "brief", raw_patch.get("brief")),
    )
    for field, kind, content in legacy:
        if content not in (None, ""):
            if field == "imagePrompt":
                compiled = canonicalize_prompt_output("unknown", {}, str(content))
                patch["candidates"].append({
                    "kind": kind,
                    "title": f"Agent {field} 候选",
                    "content": {"prompt": compiled["prompt"], "promptPack": compiled["promptPack"]},
                    "metadata": {"promptContractVersion": compiled["promptContractVersion"], "promptWorkflow": compiled["promptWorkflow"], "promptFieldOrder": compiled["promptFieldOrder"]},
                })
            else:
                patch["candidates"].append({"kind": kind, "title": f"Agent {field} 候选", "content": content})
    if raw_patch.get("assets") is not None or raw_patch.get("shots") is not None:
        patch["candidates"].append({
            "kind": "storyboard",
            "title": "Agent 分镜候选",
            "content": {"assets": raw_patch.get("assets") or [], "shots": raw_patch.get("shots") or []},
        })
    snapshot = dict(contract_snapshot or {})
    source_ids = [str(item) for item in (attachment_ids or []) if str(item).strip()]
    operations: list[dict[str, Any]] = []
    for index, raw_operation in enumerate(patch["workspace_operations"]):
        if not isinstance(raw_operation, dict):
            continue
        operation = dict(raw_operation)
        kind = str(operation.get("workspace") or "story").strip().lower()
        if kind not in {"story", "assets", "audio", "timeline", "workflow"}:
            kind = "story"
        operation["workspace"] = kind
        operation["id"] = str(operation.get("id") or f"OP_AGENT_{index + 1:03d}")[:160]
        operation.setdefault("title", "Agent 工作台候选")
        operation.setdefault("summary", "")
        operation.setdefault("risk", "safe_draft")
        operation.setdefault("requires_confirmation", False)
        operation.setdefault("source_attachment_ids", source_ids)
        operation.setdefault("source_refs", [])
        operation["contract_snapshot"] = {**snapshot, **(operation.get("contract_snapshot") or {})}
        operations.append(operation)
    for index, candidate in enumerate(patch["candidates"]):
        candidate_data = candidate if isinstance(candidate, dict) else {}
        candidate_kind = str(candidate_data.get("kind") or "brief")
        workspace = {
            "script": "story", "storyboard": "story", "brief": "story",
            "prompt": "assets", "asset_metadata": "assets", "audio": "audio",
            "timeline": "timeline",
        }.get(candidate_kind, "story")
        candidate_id = str(candidate_data.get("id") or f"OP_CANDIDATE_{index + 1:03d}")
        if any(str(item.get("id")) == candidate_id for item in operations):
            continue
        content = candidate_data.get("content")
        operations.append({
            "id": candidate_id,
            "workspace": workspace,
            "action": "candidate_draft",
            "target_id": candidate_data.get("target_id"),
            "title": candidate_data.get("title") or "Agent 候选",
            "summary": f"{candidate_kind} 候选，等待逐项审阅",
            "before": None,
            "after": content,
            "content": content,
            "source_attachment_ids": source_ids,
            "source_refs": [],
            "contract_snapshot": snapshot,
            "risk": "safe_draft",
            "requires_confirmation": bool(candidate_data.get("replace_active")),
        })
    patch["workspace_operations"] = operations
    actions = set(str(item) for item in patch["actions"])
    if patch["candidates"]:
        actions.add("candidate_draft")
    if patch["add_nodes"] or patch["modify_nodes"] or patch["add_edges"] or patch["modify_edges"]:
        actions.add("node_orchestration")
    patch["actions"] = sorted(actions)
    return {
        "reply": str(payload.get("reply") or payload.get("message") or "已生成 Agent 结构化计划。"),
        "patch": AgentPatchV3.model_validate(patch).model_dump(mode="json"),
        "actions": sorted(actions),
        "next_skill": payload.get("next_skill"),
        "requires_confirmation": patch["requires_confirmation"],
        "provider_response_id": payload.get("response_id"),
        "provider_model": payload.get("model"),
    }


def ensure_workspace_operations(
    patch: AgentPatchV3,
    graph: dict[str, Any],
    contract_snapshot: dict[str, Any] | None = None,
    attachment_ids: list[str] | None = None,
) -> AgentPatchV3:
    """Attach deterministic operation IDs to graph changes for item-level review."""

    snapshot = dict(contract_snapshot or {})
    source_ids = [str(item) for item in (attachment_ids or []) if str(item).strip()]
    operations = [operation.model_dump(mode="json") for operation in patch.workspace_operations]
    existing_ids = {str(item.get("id")) for item in operations}
    nodes = {str(node.get("id")): node for node in graph.get("nodes", []) if node.get("id")}
    edges = {str(edge.get("id")): edge for edge in graph.get("edges", []) if edge.get("id")}

    def add(operation: dict[str, Any]) -> None:
        if operation["id"] in existing_ids:
            return
        operations.append(operation)
        existing_ids.add(operation["id"])

    for node in patch.add_nodes:
        add({
            "id": f"OP_WORKFLOW_ADD_NODE_{node.id}", "workspace": "workflow", "action": "add_node",
            "target_id": node.id, "title": f"新增工作流节点 · {node.label or node.id}",
            "summary": "新增节点，应用前仍需检查工作流门禁。", "before": None, "after": node.model_dump(mode="json"),
            "content": node.model_dump(mode="json"), "source_attachment_ids": source_ids, "source_refs": [],
            "contract_snapshot": snapshot, "risk": "review_required", "requires_confirmation": False,
        })
    for change in patch.modify_nodes:
        before = nodes.get(change.node_id)
        after = deepcopy(before) if before else None
        if isinstance(after, dict):
            after.update(_change_fields(change.model_dump(mode="json", exclude_none=True)))
        add({
            "id": f"OP_WORKFLOW_MODIFY_NODE_{change.node_id}", "workspace": "workflow", "action": "modify_node",
            "target_id": change.node_id, "title": f"修改工作流节点 · {change.node_id}",
            "summary": "修改节点字段。", "before": before, "after": after,
            "content": after, "source_attachment_ids": source_ids, "source_refs": [],
            "contract_snapshot": snapshot, "risk": "review_required", "requires_confirmation": False,
        })
    for node_id in patch.remove_node_ids:
        add({
            "id": f"OP_WORKFLOW_REMOVE_NODE_{node_id}", "workspace": "workflow", "action": "remove_node",
            "target_id": node_id, "title": f"删除工作流节点 · {node_id}", "summary": "删除节点及其连接。",
            "before": nodes.get(node_id), "after": None, "content": None, "source_attachment_ids": source_ids,
            "source_refs": [], "contract_snapshot": snapshot, "risk": "blocked", "requires_confirmation": True,
        })
    for edge in patch.add_edges:
        add({
            "id": f"OP_WORKFLOW_ADD_EDGE_{edge.id}", "workspace": "workflow", "action": "add_edge",
            "target_id": edge.id, "title": f"新增工作流连接 · {edge.id}", "summary": "新增工作流连接。",
            "before": None, "after": edge.model_dump(mode="json"), "content": edge.model_dump(mode="json"),
            "source_attachment_ids": source_ids, "source_refs": [], "contract_snapshot": snapshot,
            "risk": "review_required", "requires_confirmation": False,
        })
    for change in patch.modify_edges:
        before = edges.get(change.edge_id)
        after = deepcopy(before) if before else None
        if isinstance(after, dict):
            after.update(_change_fields(change.model_dump(mode="json", exclude_none=True)))
        add({
            "id": f"OP_WORKFLOW_MODIFY_EDGE_{change.edge_id}", "workspace": "workflow", "action": "modify_edge",
            "target_id": change.edge_id, "title": f"修改工作流连接 · {change.edge_id}", "summary": "修改连接字段。",
            "before": before, "after": after, "content": after, "source_attachment_ids": source_ids,
            "source_refs": [], "contract_snapshot": snapshot, "risk": "review_required", "requires_confirmation": False,
        })
    for edge_id in patch.remove_edge_ids:
        add({
            "id": f"OP_WORKFLOW_REMOVE_EDGE_{edge_id}", "workspace": "workflow", "action": "remove_edge",
            "target_id": edge_id, "title": f"删除工作流连接 · {edge_id}", "summary": "删除工作流连接。",
            "before": edges.get(edge_id), "after": None, "content": None, "source_attachment_ids": source_ids,
            "source_refs": [], "contract_snapshot": snapshot, "risk": "blocked", "requires_confirmation": True,
        })
    return patch.model_copy(update={"workspace_operations": [AgentWorkspaceOperationV3.model_validate(item) for item in operations]})


def _change_fields(change: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in change.items() if key not in {"node_id", "edge_id"} and value is not None}


def apply_patch_to_graph(graph: dict[str, Any], patch: AgentPatchV3) -> dict[str, Any]:
    """Apply only graph operations; candidates and execution suggestions remain external."""
    result = deepcopy(graph)
    nodes = {str(node["id"]): node for node in result.get("nodes", [])}
    edges = {str(edge["id"]): edge for edge in result.get("edges", [])}
    for node in patch.add_nodes:
        if node.id in nodes:
            raise ValueError(f"节点 {node.id} 已存在，不能重复新增。")
        nodes[node.id] = node.model_dump(mode="json")
    for change in patch.modify_nodes:
        node = nodes.get(change.node_id)
        if node is None:
            raise ValueError(f"修改节点 {change.node_id} 不存在。")
        if node.get("locked"):
            raise ValueError(f"节点 {change.node_id} 已锁定，不能由 Agent 修改。")
        node.update(_change_fields(change.model_dump(mode="json", exclude_none=True)))
    for node_id in patch.remove_node_ids:
        node = nodes.get(node_id)
        if node is None:
            raise ValueError(f"删除节点 {node_id} 不存在。")
        if node.get("locked"):
            raise ValueError(f"节点 {node_id} 已锁定，不能由 Agent 删除。")
        del nodes[node_id]
    for edge in patch.add_edges:
        if edge.id in edges:
            raise ValueError(f"连接 {edge.id} 已存在，不能重复新增。")
        edges[edge.id] = edge.model_dump(mode="json")
    for change in patch.modify_edges:
        edge = edges.get(change.edge_id)
        if edge is None:
            raise ValueError(f"修改连接 {change.edge_id} 不存在。")
        edge.update(_change_fields(change.model_dump(mode="json", exclude_none=True)))
    for edge_id in patch.remove_edge_ids:
        if edge_id not in edges:
            raise ValueError(f"删除连接 {edge_id} 不存在。")
        del edges[edge_id]
    removed = set(patch.remove_node_ids)
    edges = {edge_id: edge for edge_id, edge in edges.items() if edge.get("source") not in removed and edge.get("target") not in removed}
    result["nodes"] = list(nodes.values())
    result["edges"] = list(edges.values())
    # Import lazily to keep this module independent from the API module.
    from .v3 import validate_graph
    validate_graph(WorkflowGraphV3.model_validate(result))
    return result


def patch_preview(graph: dict[str, Any], patch: AgentPatchV3) -> dict[str, Any]:
    original_nodes = {str(node["id"]): node for node in graph.get("nodes", [])}
    original_edges = {str(edge["id"]): edge for edge in graph.get("edges", [])}
    proposed = apply_patch_to_graph(graph, patch)
    proposed_nodes = {str(node["id"]): node for node in proposed.get("nodes", [])}
    added = [proposed_nodes[node_id] for node_id in proposed_nodes.keys() - original_nodes.keys()]
    removed = [original_nodes[node_id] for node_id in original_nodes.keys() - proposed_nodes.keys()]
    modified: list[dict[str, Any]] = []
    touched = set(patch.remove_node_ids)
    for change in patch.modify_nodes:
        touched.add(change.node_id)
        before = original_nodes.get(change.node_id)
        after = proposed_nodes.get(change.node_id)
        if before is not None and after is not None:
            fields = sorted(key for key in set(before) | set(after) if before.get(key) != after.get(key))
            modified.append({"id": change.node_id, "fields": fields, "before": before, "after": after})
    preserved = [node for node_id, node in original_nodes.items() if node_id not in touched and node_id in proposed_nodes]
    proposed_edges = {str(edge["id"]): edge for edge in proposed.get("edges", [])}
    added_edges = [edge for edge_id, edge in proposed_edges.items() if edge_id not in original_edges]
    removed_edges = [edge for edge_id, edge in original_edges.items() if edge_id not in proposed_edges]
    modified_edges: list[dict[str, Any]] = []
    for change in patch.modify_edges:
        before = original_edges.get(change.edge_id)
        after = proposed_edges.get(change.edge_id)
        if before is not None and after is not None:
            fields = sorted(key for key in set(before) | set(after) if before.get(key) != after.get(key))
            modified_edges.append({"id": change.edge_id, "fields": fields, "before": before, "after": after})
    paid_ids = []
    batch_ids = []
    potential_cost = 0.0
    currency = "USD"
    for node in proposed.get("nodes", []):
        config = node.get("config") or {}
        if bool(config.get("paid")) or node.get("kind") in PAID_NODE_KINDS:
            node_id = str(node.get("id"))
            if node_id in set(patch.suggested_run_node_ids) or node_id in {item.get("id") for item in added} or node_id in {item.node_id for item in patch.modify_nodes}:
                paid_ids.append(node_id)
                try:
                    quantity = max(1, int(config.get("quantity", config.get("count", 1)) or 1))
                except (TypeError, ValueError):
                    quantity = 1
                if quantity > 1:
                    batch_ids.append(node_id)
                try:
                    potential_cost += max(0.0, float(config.get("estimated_cost") or 0)) * quantity
                except (TypeError, ValueError):
                    pass
                currency = str(config.get("currency") or currency)
    candidate_preview = [
        {"kind": candidate.kind, "title": candidate.title, "target_id": candidate.target_id, "replace_active": candidate.replace_active, "requires_confirmation": candidate.replace_active}
        for candidate in patch.candidates
    ]
    gates = [gate.model_dump(mode="json") for gate in patch.suggested_approval_gates]
    if paid_ids and not any(gate.get("reason") == "paid_media" for gate in gates):
        gates.append({"reason": "paid_media", "node_ids": paid_ids, "detail": {"message": "付费媒体节点只能在单独运行确认后执行。"}})
    if batch_ids and not any(gate.get("reason") == "batch_generation" for gate in gates):
        gates.append({"reason": "batch_generation", "node_ids": batch_ids, "detail": {"message": "批量生成必须单独确认。"}})
    if any(candidate.replace_active for candidate in patch.candidates) and not any(gate.get("reason") == "replace_active_asset" for gate in gates):
        gates.append({"reason": "replace_active_asset", "node_ids": [], "detail": {"message": "替换 active 资产必须单独确认。"}})
    unknown_actions = sorted(set(patch.actions) - AUTOMATIC_ACTIONS - CONFIRMATION_ACTIONS)
    confirmation_actions = (set(patch.actions) & CONFIRMATION_ACTIONS) | {gate["reason"] for gate in gates}
    requires_confirmation = bool(patch.requires_confirmation or confirmation_actions or unknown_actions)
    return {
        "added": {"nodes": added, "edges": added_edges},
        "modified": {"nodes": modified, "edges": modified_edges},
        "deleted": {"nodes": removed, "edges": removed_edges},
        "preserved": {"nodes": preserved, "node_count": len(preserved)},
        "candidates": candidate_preview,
        "workspace_operations": [
            {
                "id": operation.id,
                "workspace": operation.workspace,
                "action": operation.action,
                "target_id": operation.target_id,
                "title": operation.title,
                "summary": operation.summary,
                "before": operation.before,
                "after": operation.after,
                "source_attachment_ids": operation.source_attachment_ids,
                "source_refs": operation.source_refs,
                "contract_snapshot": operation.contract_snapshot,
                "risk": operation.risk,
                "requires_confirmation": operation.requires_confirmation,
            }
            for operation in patch.workspace_operations
        ],
        "suggested_run_node_ids": list(patch.suggested_run_node_ids),
        "approval_gates": gates,
        "potential_cost": round(potential_cost, 6),
        "currency": currency,
        "requires_confirmation": requires_confirmation,
        "automatic_actions": sorted(set(patch.actions) & AUTOMATIC_ACTIONS),
        "confirmation_actions": sorted(confirmation_actions),
        "unsupported_operations": list(patch.unsupported_operations),
        "graph": proposed,
    }
