from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def idempotency_fingerprint(operation_type: str, payload: dict[str, Any]) -> str:
    envelope = {"operation_type": operation_type, "payload": payload}
    return hashlib.sha256(canonical_json(envelope).encode("utf-8")).hexdigest()


def workflow_run_fingerprint(
    project_id: str,
    graph_revision: int,
    selected_node_ids: list[str],
    graph: dict[str, Any],
    max_parallel: int,
    actor: str = "local-user",
) -> str:
    selected = set(selected_node_ids)
    nodes = sorted(
        (node for node in graph.get("nodes", []) if str(node.get("id")) in selected),
        key=lambda node: str(node.get("id")),
    )
    edges = sorted(
        (
            edge
            for edge in graph.get("edges", [])
            if str(edge.get("source")) in selected and str(edge.get("target")) in selected
        ),
        key=lambda edge: str(edge.get("id")),
    )
    return idempotency_fingerprint(
        "workflow_run",
        {
            "project_id": project_id,
            "graph_revision": graph_revision,
            "selected_node_ids": sorted(selected_node_ids),
            "nodes": nodes,
            "edges": edges,
            "max_parallel": max_parallel,
            "actor": actor,
        },
    )


def render_fingerprint(
    project_id: str,
    timeline_revision: int,
    timeline: dict[str, Any],
    manifest_inputs: list[dict[str, Any]],
    request: dict[str, Any],
    actor: str = "local-user",
) -> str:
    parameters = {
        key: value
        for key, value in request.items()
        if key not in {"confirmed", "timeline", "timeline_revision", "approval_detail"}
    }
    return idempotency_fingerprint(
        "render",
        {
            "project_id": project_id,
            "timeline_revision": timeline_revision,
            "timeline": timeline,
            "inputs": sorted(manifest_inputs, key=lambda item: str(item.get("artifact_id"))),
            "parameters": parameters,
            "actor": actor,
        },
    )
