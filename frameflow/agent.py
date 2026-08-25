"""Supervised Agent planning primitives for FrameFlow V3.

The Agent is deliberately limited to producing a reviewable, versioned patch.
This module contains no project writes and no Provider calls; the API layer is
responsible for persistence, revision checks and invoking the selected adapter.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .schemas import AgentPatchV3, WorkflowGraphV3


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
        # Keep the complete editable document available to the Agent. The
        # compact project_spec above remains the stable contract while this
        # document lets the assistant reason over story, assets and shots.
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
    }
    legacy = (
        ("script", "script", raw_patch.get("script")),
        ("imagePrompt", "prompt", raw_patch.get("imagePrompt")),
        ("brief", "brief", raw_patch.get("brief")),
    )
    for field, kind, content in legacy:
        if content not in (None, ""):
            patch["candidates"].append({"kind": kind, "title": f"Agent {field} 候选", "content": content})
    if raw_patch.get("assets") is not None or raw_patch.get("shots") is not None:
        patch["candidates"].append({
            "kind": "storyboard",
            "title": "Agent 分镜候选",
            "content": {"assets": raw_patch.get("assets") or [], "shots": raw_patch.get("shots") or []},
        })
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
