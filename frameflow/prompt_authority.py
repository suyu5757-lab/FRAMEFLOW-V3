from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any


APPROVED_STATUS = "prompt_qa_approved"
SUPERSEDED_STATUS = "superseded"


@dataclass(frozen=True)
class PromptAuthorityError(Exception):
    code: str
    message: str
    details: dict[str, Any]

    def __str__(self) -> str:
        return self.message

    def payload(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "details": self.details}


def prompt_sha256(prompt: str) -> str:
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def approve_prompt_version(
    database: Any,
    prompt_version_id: str,
    *,
    approval_source: str | None = None,
    approved_artifact_id: str | None = None,
    approval_reason: str | None = None,
    approved_at: str | None = None,
) -> Any:
    """Atomically make one Prompt the only approved authority for its asset."""
    from .database import utcnow

    with database.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT * FROM prompt_versions WHERE id=?", (prompt_version_id,)).fetchone()
        if not row:
            raise PromptAuthorityError("prompt_version_missing", "Prompt 版本不存在。", {"prompt_version_id": prompt_version_id})
        connection.execute(
            "UPDATE prompt_versions SET status=? "
            "WHERE project_id=? AND logical_asset_id=? AND id<>? AND status=?",
            (SUPERSEDED_STATUS, row["project_id"], row["logical_asset_id"], prompt_version_id, APPROVED_STATUS),
        )
        updates = ["status=?"]
        parameters: list[Any] = [APPROVED_STATUS]
        if approval_source is not None:
            updates.append("approval_source=?")
            parameters.append(approval_source)
        if approved_artifact_id is not None:
            updates.append("approved_artifact_id=?")
            parameters.append(approved_artifact_id)
        if approval_reason is not None:
            updates.append("approval_reason=?")
            parameters.append(approval_reason)
        # A manually approved or registration-linked Prompt always gets a
        # durable approval timestamp.  Existing timestamps remain stable when
        # the same approval is submitted idempotently.
        updates.append("approved_at=COALESCE(approved_at,?)")
        parameters.append(approved_at or utcnow())
        parameters.append(prompt_version_id)
        connection.execute(f"UPDATE prompt_versions SET {', '.join(updates)} WHERE id=?", tuple(parameters))
        approved_count = int(connection.execute(
            "SELECT COUNT(*) FROM prompt_versions WHERE project_id=? AND logical_asset_id=? AND status=?",
            (row["project_id"], row["logical_asset_id"], APPROVED_STATUS),
        ).fetchone()[0])
        if approved_count != 1:
            raise PromptAuthorityError(
                "approved_prompt_ambiguous",
                "逻辑资产必须且只能有一个 Current Approved Prompt。",
                {"project_id": row["project_id"], "logical_asset_id": row["logical_asset_id"], "approved_count": approved_count},
            )
        return connection.execute("SELECT * FROM prompt_versions WHERE id=?", (prompt_version_id,)).fetchone()


def canonical_approved_prompt(
    database: Any,
    project_id: str,
    logical_asset_id: str,
    prompt_version_id: str,
) -> dict[str, Any]:
    with database.connect() as connection:
        rows = connection.execute(
            "SELECT * FROM prompt_versions WHERE project_id=? AND logical_asset_id=? AND status=? ORDER BY version DESC",
            (project_id, logical_asset_id, APPROVED_STATUS),
        ).fetchall()
    if len(rows) != 1:
        raise PromptAuthorityError(
            "approved_prompt_ambiguous",
            "逻辑资产没有唯一的 Current Approved Prompt。",
            {"project_id": project_id, "logical_asset_id": logical_asset_id, "approved_count": len(rows)},
        )
    row = rows[0]
    if str(row["id"]) != prompt_version_id:
        raise PromptAuthorityError(
            "prompt_version_not_current",
            "请求的 Prompt 版本不是当前 Approved 权威。",
            {
                "requested_prompt_version_id": prompt_version_id,
                "current_prompt_version_id": row["id"],
                "logical_asset_id": logical_asset_id,
            },
        )
    prompt = str(row["prompt"])
    return {
        "id": str(row["id"]),
        "project_id": str(row["project_id"]),
        "logical_asset_id": str(row["logical_asset_id"]),
        "asset_class": str(row["asset_class"]),
        "version": int(row["version"]),
        "status": str(row["status"]),
        "prompt": prompt,
        "prompt_sha256": prompt_sha256(prompt),
    }
