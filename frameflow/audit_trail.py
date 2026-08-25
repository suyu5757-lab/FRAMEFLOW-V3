"""Durable, queryable audit trail for user-visible authority mutations.

The existing asset/task/workflow event tables remain useful operational
telemetry. This module provides the narrower, stable contract required for
business mutations: actor, action, target, reason, before/after, result and
timestamp. It deliberately stores redacted JSON snapshots, never credentials
or raw media.
"""

from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime
from typing import Any


DEFAULT_ACTOR = "local-operator"
MAX_QUERY_LIMIT = 200
_SENSITIVE_KEY_PARTS = (
    "secret", "token", "password", "credential", "api_key", "apikey",
    "authorization", "cookie", "raw_binary", "base64", "private_key",
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _is_sensitive_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return any(part in normalized for part in _SENSITIVE_KEY_PARTS)


def redact_snapshot(value: Any, *, key: str = "") -> Any:
    """Return a bounded, JSON-safe snapshot with secret-like fields removed."""
    if key and _is_sensitive_key(key):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(k): redact_snapshot(v, key=str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_snapshot(item) for item in value]
    if isinstance(value, tuple):
        return [redact_snapshot(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _json(database: Any, value: Any) -> str:
    return database.encode(redact_snapshot(value))


def write_event_connection(
    connection: Any,
    database: Any,
    *,
    project_id: str | None,
    actor: str = DEFAULT_ACTOR,
    action: str,
    target_type: str,
    target_id: str,
    reason: str,
    before: Any = None,
    after: Any = None,
    result: str = "success",
    metadata: Any = None,
    created_at: str | None = None,
) -> str:
    values = {
        "actor": actor,
        "action": action,
        "target_type": target_type,
        "target_id": target_id,
        "reason": reason,
        "result": result,
    }
    for field, value in values.items():
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"audit {field} must be a non-empty string")
    event_id = f"AUD_{secrets.token_hex(12)}"
    connection.execute(
        "INSERT INTO audit_events_v16(id,project_id,actor,action,target_type,target_id,reason,before_json,after_json,result,metadata_json,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            event_id,
            project_id,
            actor.strip(),
            action.strip(),
            target_type.strip(),
            target_id.strip(),
            reason.strip(),
            _json(database, {} if before is None else before),
            _json(database, {} if after is None else after),
            result.strip(),
            _json(database, {} if metadata is None else metadata),
            created_at or _now(),
        ),
    )
    return event_id


def record_event(database: Any, **kwargs: Any) -> str:
    with database.connect() as connection:
        return write_event_connection(connection, database, **kwargs)


def list_events(database: Any, project_id: str, limit: int = 100) -> list[dict[str, Any]]:
    bounded_limit = max(1, min(int(limit), MAX_QUERY_LIMIT))
    with database.connect() as connection:
        rows = connection.execute(
            "SELECT id,project_id,actor,action,target_type,target_id,reason,before_json,after_json,result,metadata_json,created_at "
            "FROM audit_events_v16 WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ?",
            (project_id, bounded_limit),
        ).fetchall()
    return [
        {
            "id": row["id"],
            "project_id": row["project_id"],
            "actor": row["actor"],
            "action": row["action"],
            "target_type": row["target_type"],
            "target_id": row["target_id"],
            "reason": row["reason"],
            "before": database.decode(row["before_json"], {}),
            "after": database.decode(row["after_json"], {}),
            "result": row["result"],
            "metadata": database.decode(row["metadata_json"], {}),
            "created_at": row["created_at"],
        }
        for row in rows
    ]
