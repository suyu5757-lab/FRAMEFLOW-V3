from __future__ import annotations

import asyncio
import hashlib
from collections import defaultdict, deque
from typing import Any

from .database import Database, utcnow
from .v3 import PAID_NODE_KINDS


class NodeExecutionError(RuntimeError):
    def __init__(self, message: str, kind: str = "retryable", retryable: bool = True) -> None:
        super().__init__(message)
        self.kind = kind
        self.retryable = retryable


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            normalized = str(key).lower()
            if any(secret in normalized for secret in ("api_key", "authorization", "cookie", "password", "secret", "token")):
                result[key] = "[REDACTED]"
            else:
                result[key] = _redact(item)
        return result
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def _fingerprint(database: Database, node: dict[str, Any], upstream: dict[str, Any]) -> str:
    payload = _redact({
        "node_id": node.get("id"),
        "kind": node.get("kind"),
        "version": node.get("version", 1),
        "config": node.get("config") or {},
        "upstream": upstream,
    })
    return hashlib.sha256(database.encode(payload).encode("utf-8")).hexdigest()


def _event(database: Database, run_id: str, event_type: str, detail: dict[str, Any] | None = None, node_id: str | None = None) -> None:
    with database.connect() as connection:
        connection.execute(
            "INSERT INTO workflow_run_events_v3(run_id,node_id,event_type,detail_json,created_at) VALUES(?,?,?,?,?)",
            (run_id, node_id, event_type, database.encode(_redact(detail or {})), utcnow()),
        )


def _run_status(database: Database, run_id: str) -> str | None:
    with database.connect() as connection:
        row = connection.execute("SELECT status FROM workflow_runs_v3 WHERE id=?", (run_id,)).fetchone()
    return row["status"] if row else None


def _set_run(database: Database, run_id: str, status: str, result: dict[str, Any] | None = None, error: dict[str, Any] | None = None) -> None:
    now = utcnow()
    with database.connect() as connection:
        connection.execute(
            "UPDATE workflow_runs_v3 SET status=?,result_json=?,error_json=?,updated_at=? WHERE id=?",
            (status, database.encode(result) if result is not None else None, database.encode(error) if error is not None else None, now, run_id),
        )


def _set_node(
    database: Database,
    run_id: str,
    node_id: str,
    status: str,
    *,
    attempt: int | None = None,
    input_snapshot: dict[str, Any] | None = None,
    output: dict[str, Any] | None = None,
    error: dict[str, Any] | None = None,
) -> None:
    fields = ["status=?", "updated_at=?"]
    values: list[Any] = [status, utcnow()]
    if attempt is not None:
        fields.append("attempt=?")
        values.append(attempt)
    if input_snapshot is not None:
        fields.append("input_snapshot_json=?")
        values.append(database.encode(_redact(input_snapshot)))
    if output is not None:
        fields.append("output_json=?")
        values.append(database.encode(_redact(output)))
    if error is not None:
        fields.append("error_json=?")
        values.append(database.encode(_redact(error)))
    if status in {"running"}:
        fields.append("started_at=COALESCE(started_at,?)")
        values.append(utcnow())
    if status in {"succeeded", "cached", "failed", "blocked", "canceled"}:
        fields.append("finished_at=?")
        values.append(utcnow())
    values.extend([run_id, node_id])
    with database.connect() as connection:
        connection.execute(
            f"UPDATE node_runs_v3 SET {','.join(fields)} WHERE run_id=? AND node_id=?",
            values,
        )


def _load_state(database: Database, run_id: str) -> tuple[dict[str, Any], dict[str, dict[str, Any]], dict[str, str], dict[str, dict[str, Any]]]:
    with database.connect() as connection:
        run = connection.execute("SELECT * FROM workflow_runs_v3 WHERE id=?", (run_id,)).fetchone()
        nodes = connection.execute("SELECT * FROM node_runs_v3 WHERE run_id=? ORDER BY created_at", (run_id,)).fetchall()
    if not run:
        return {}, {}, {}, {}
    graph = database.decode(run["graph_snapshot_json"], {})
    graph_nodes = {str(node["id"]): node for node in graph.get("nodes", [])}
    state = {str(row["node_id"]): row["status"] for row in nodes}
    outputs = {
        str(row["node_id"]): database.decode(row["output_json"], {})
        for row in nodes
        if row["output_json"] is not None
    }
    return {
        "run": dict(run),
        "graph": graph,
        "request": database.decode(run["request_json"], {}),
    }, graph_nodes, state, outputs


def _parents(graph: dict[str, Any], selected: set[str]) -> dict[str, set[str]]:
    result: dict[str, set[str]] = defaultdict(set)
    for edge in graph.get("edges", []):
        if edge.get("relation") == "execution" and edge.get("source") in selected and edge.get("target") in selected:
            result[str(edge["target"])].add(str(edge["source"]))
    return result


def _topological_ready(state: dict[str, str], parents: dict[str, set[str]]) -> tuple[list[str], list[str]]:
    ready: list[str] = []
    blocked: list[str] = []
    terminal_success = {"succeeded", "cached"}
    terminal_failure = {"failed", "blocked", "canceled"}
    for node_id, status in state.items():
        if status != "pending":
            continue
        upstream = {state.get(parent) for parent in parents.get(node_id, set())}
        if upstream & terminal_failure:
            blocked.append(node_id)
        elif upstream <= terminal_success:
            ready.append(node_id)
    return ready, blocked


def _cached_output(database: Database, project_id: str, run_id: str, node_id: str, fingerprint: str) -> tuple[dict[str, Any] | None, str | None]:
    with database.connect() as connection:
        rows = connection.execute(
            "SELECT nr.input_snapshot_json,nr.output_json,wr.id FROM node_runs_v3 nr JOIN workflow_runs_v3 wr ON wr.id=nr.run_id WHERE wr.project_id=? AND wr.id<>? AND nr.node_id=? AND nr.status IN ('succeeded','cached') ORDER BY nr.updated_at DESC LIMIT 50",
            (project_id, run_id, node_id),
        ).fetchall()
    for row in rows:
        snapshot = database.decode(row["input_snapshot_json"], {})
        if snapshot.get("fingerprint") == fingerprint and row["output_json"] is not None:
            return database.decode(row["output_json"], {}), row["id"]
    return None, None


async def _execute_node(database: Database, node: dict[str, Any], upstream: dict[str, Any]) -> dict[str, Any]:
    config = node.get("config") or {}
    delay = max(0.0, min(float(config.get("sleep_ms", 0) or 0) / 1000, 60.0))
    if delay:
        await asyncio.sleep(delay)
    if config.get("executor") == "fail":
        raise NodeExecutionError(
            str(config.get("error_message") or "节点按配置失败。"),
            str(config.get("error_kind") or "retryable"),
            bool(config.get("retryable", True)),
        )
    if config.get("executor") == "manual":
        raise NodeExecutionError("节点需要人工处理后才能继续。", "manual", False)
    if bool(config.get("paid")) or node.get("kind") in PAID_NODE_KINDS:
        raise NodeExecutionError(
            "付费节点尚未配置可执行的 Provider 调度器；运行已安全停止。",
            "provider_dispatch_required",
            False,
        )
    return {
        "node_id": node.get("id"),
        "kind": node.get("kind"),
        "executor": config.get("executor") or "checkpoint",
        "status": "orchestration_checkpoint",
        "upstream_count": len(upstream),
    }


async def _execute_one(
    database: Database,
    run_id: str,
    project_id: str,
    node: dict[str, Any],
    upstream: dict[str, Any],
) -> bool:
    node_id = str(node["id"])
    snapshot = {"node": node, "upstream": upstream}
    fingerprint = _fingerprint(database, node, upstream)
    snapshot["fingerprint"] = fingerprint
    cached, source_run_id = _cached_output(database, project_id, run_id, node_id, fingerprint)
    if cached is not None:
        _set_node(database, run_id, node_id, "cached", input_snapshot=snapshot, output=cached)
        _event(database, run_id, "node_cached", {"source_run_id": source_run_id, "fingerprint": fingerprint}, node_id)
        return True

    config = node.get("config") or {}
    max_attempts = max(1, min(int(config.get("max_attempts", 1) or 1), 5))
    for attempt in range(1, max_attempts + 1):
        _set_node(database, run_id, node_id, "running", attempt=attempt, input_snapshot=snapshot)
        _event(database, run_id, "node_started", {"attempt": attempt, "fingerprint": fingerprint}, node_id)
        try:
            output = await _execute_node(database, node, upstream)
        except NodeExecutionError as exc:
            error = {"kind": exc.kind, "message": str(exc), "retryable": exc.retryable, "attempt": attempt}
            if exc.retryable and attempt < max_attempts:
                _set_node(database, run_id, node_id, "pending", attempt=attempt, input_snapshot=snapshot, error=error)
                _event(database, run_id, "node_retry_scheduled", error, node_id)
                continue
            _set_node(database, run_id, node_id, "failed", attempt=attempt, input_snapshot=snapshot, error=error)
            _event(database, run_id, "node_failed", error, node_id)
            return False
        except Exception as exc:  # pragma: no cover - defensive boundary for executor plugins
            error = {"kind": "retryable", "message": str(exc), "retryable": True, "attempt": attempt}
            if attempt < max_attempts:
                _set_node(database, run_id, node_id, "pending", attempt=attempt, input_snapshot=snapshot, error=error)
                _event(database, run_id, "node_retry_scheduled", error, node_id)
                continue
            _set_node(database, run_id, node_id, "failed", attempt=attempt, input_snapshot=snapshot, error=error)
            _event(database, run_id, "node_failed", error, node_id)
            return False
        if isinstance(output, dict):
            output = {**output, "_node_fingerprint": fingerprint}
        else:
            output = {"value": output, "_node_fingerprint": fingerprint}
        _set_node(database, run_id, node_id, "succeeded", attempt=attempt, input_snapshot=snapshot, output=output)
        _event(database, run_id, "node_succeeded", {"attempt": attempt, "fingerprint": fingerprint}, node_id)
        return True
    return False


async def execute_v3_run(database: Database, run_id: str) -> None:
    state_payload, graph_nodes, state, outputs = _load_state(database, run_id)
    if not state_payload:
        return
    run = state_payload["run"]
    if run["status"] not in {"queued", "running"}:
        return
    estimate = database.decode(run["estimate_json"], {})
    request = state_payload["request"]
    if estimate.get("requires_confirmation") and not request.get("confirmed"):
        _set_run(database, run_id, "awaiting_confirmation", error={"kind": "approval_required", "message": "付费节点尚未获得确认。"})
        _event(database, run_id, "approval_required", {"reason": "paid_generation"})
        return

    _set_run(database, run_id, "running")
    _event(database, run_id, "run_started", {"max_parallel": request.get("max_parallel", 3)})
    selected = set(state)
    parents = _parents(state_payload["graph"], selected)
    max_parallel = max(1, min(int(request.get("max_parallel", 3) or 3), 12))

    while True:
        current_status = _run_status(database, run_id)
        if current_status in {"paused", "canceled"}:
            with database.connect() as connection:
                connection.execute(
                    "UPDATE node_runs_v3 SET status='canceled',finished_at=?,updated_at=? WHERE run_id=? AND status IN ('pending','running')",
                    (utcnow(), utcnow(), run_id),
                )
            _event(database, run_id, "run_interrupted", {"status": current_status})
            return
        _, _, state, outputs = _load_state(database, run_id)
        if not state:
            _set_run(database, run_id, "failed", error={"kind": "runtime", "message": "运行节点快照不存在。"})
            return
        if all(status in {"succeeded", "cached"} for status in state.values()):
            result = {"nodes": {node_id: status for node_id, status in state.items()}, "completed_count": len(state)}
            _set_run(database, run_id, "succeeded", result=result)
            _event(database, run_id, "run_succeeded", result)
            return
        if any(status in {"failed", "blocked", "canceled"} for status in state.values()):
            error = {"kind": "node_failed", "message": "一个或多个节点未能完成。", "nodes": {node_id: status for node_id, status in state.items()}}
            _set_run(database, run_id, "failed", error=error)
            _event(database, run_id, "run_failed", error)
            return

        ready, blocked = _topological_ready(state, parents)
        if blocked:
            for node_id in blocked:
                _set_node(database, run_id, node_id, "blocked", error={"kind": "dependency_failed", "message": "上游节点未完成。"})
                _event(database, run_id, "node_blocked", {"kind": "dependency_failed"}, node_id)
            continue
        if not ready:
            error = {"kind": "graph_deadlock", "message": "工作流图没有可执行节点。"}
            _set_run(database, run_id, "failed", error=error)
            _event(database, run_id, "run_failed", error)
            return

        batch = ready[:max_parallel]
        await asyncio.gather(*[
            _execute_one(
                database,
                run_id,
                str(run["project_id"]),
                graph_nodes[node_id],
                {parent: outputs.get(parent, {}) for parent in parents.get(node_id, set())},
            )
            for node_id in batch
        ])
