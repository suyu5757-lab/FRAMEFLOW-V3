from __future__ import annotations

from collections import defaultdict
from typing import Any


AUTHORITY_RANK = {
    "absolute": 0,
    "primary": 1,
    "secondary": 2,
    "supporting": 3,
    "negative": 4,
}
ALLOWED_SCOPES = {
    "general", "identity", "face", "costume", "pose", "camera", "lighting",
    "environment", "geometry", "material", "composition", "action", "style",
    "product_structure", "scene_structure",
}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _artifact_version(database: Any, project_id: str, artifact_id: str) -> tuple[str | None, int | None, str | None]:
    with database.connect() as connection:
        artifact = connection.execute(
            "SELECT project_id,sha256 FROM artifacts WHERE id=?", (artifact_id,)
        ).fetchone()
        version = connection.execute(
            "SELECT id,version FROM asset_versions WHERE project_id=? AND artifact_id=? "
            "ORDER BY is_active DESC,version DESC,id DESC LIMIT 1",
            (project_id, artifact_id),
        ).fetchone()
    if not artifact or str(artifact["project_id"] or "") != project_id:
        raise ValueError("artifact_not_in_project")
    return (str(version["id"]) if version else None, int(version["version"]) if version else None, str(artifact["sha256"] or "") or None)


def normalize_reference_authority(
    database: Any, project_id: str, references: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Normalize reference authority and reject ambiguous conflict control.

    A conflict group is intentionally opt-in: independent references may share a
    scope. Once a group is set, exactly one highest-ranked reference must win.
    """
    normalized: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for raw in references:
        item = dict(raw)
        reference_id = _text(item.get("reference_id"))
        scope = _text(item.get("scope") or "general").lower()
        authority = _text(item.get("authority") or "supporting").lower()
        conflict_group = _text(item.get("conflict_group")) or None
        try:
            priority = int(item.get("priority", 100))
        except (TypeError, ValueError):
            priority = 0
        if priority < 1 or priority > 10000:
            errors.append({"reference_id": reference_id, "code": "invalid_priority"})
        if scope not in ALLOWED_SCOPES:
            errors.append({"reference_id": reference_id, "code": "invalid_scope", "scope": scope})
        if authority not in AUTHORITY_RANK:
            errors.append({"reference_id": reference_id, "code": "invalid_authority", "authority": authority})
        if authority == "absolute" and not conflict_group:
            errors.append({"reference_id": reference_id, "code": "absolute_requires_conflict_group"})
        artifact_id = _text(item.get("artifact_id")) or (
            reference_id if _text(item.get("reference_kind") or "artifact") == "artifact" else ""
        )
        effective_version = _text(item.get("effective_version")) or None
        if artifact_id:
            try:
                version_id, _, _ = _artifact_version(database, project_id, artifact_id)
            except ValueError:
                errors.append({"reference_id": reference_id, "code": "reference_artifact_not_in_project", "artifact_id": artifact_id})
            else:
                if effective_version and version_id and effective_version != version_id:
                    errors.append({"reference_id": reference_id, "code": "effective_version_mismatch", "effective_version": effective_version, "current_version_id": version_id})
                effective_version = version_id or effective_version
        item.update({
            "reference_id": reference_id,
            "artifact_id": artifact_id or None,
            "priority": priority,
            "scope": scope,
            "authority": authority,
            "conflict_group": conflict_group,
            "effective_version": effective_version,
        })
        normalized.append(item)

    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for item in normalized:
        if item.get("conflict_group"):
            grouped[(str(item["scope"]), str(item["conflict_group"]))].append(item)
    for (scope, group), items in grouped.items():
        absolutes = [item for item in items if item["authority"] == "absolute"]
        if len(absolutes) > 1:
            errors.append({"code": "multiple_absolute_authorities", "scope": scope, "conflict_group": group, "reference_ids": [item["reference_id"] for item in absolutes]})
        ranked = sorted(items, key=lambda item: (AUTHORITY_RANK[item["authority"]], item["priority"], item["reference_id"]))
        if len(ranked) > 1:
            first, second = ranked[:2]
            if (AUTHORITY_RANK[first["authority"]], first["priority"]) == (AUTHORITY_RANK[second["authority"]], second["priority"]):
                errors.append({"code": "ambiguous_conflict_priority", "scope": scope, "conflict_group": group, "reference_ids": [first["reference_id"], second["reference_id"]]})
    return normalized, errors


def ordered_reference_snapshot(database: Any, project_id: str, references: list[Any]) -> list[dict[str, Any]]:
    """Freeze ordered, resolved reference authority for one generation."""
    ordered = sorted(
        references,
        key=lambda row: (int(row["priority"] or 100), AUTHORITY_RANK.get(str(row["authority"] or "supporting"), 3), str(row["created_at"]), str(row["id"])),
    )
    group_winners: dict[tuple[str, str], str] = {}
    for row in ordered:
        group = _text(row["conflict_group"])
        if group and str(row["authority"] or "supporting") != "negative":
            group_winners.setdefault((_text(row["scope"]) or "general", group), str(row["reference_id"]))
    snapshot: list[dict[str, Any]] = []
    for order, row in enumerate(ordered, start=1):
        artifact_id = _text(row["artifact_id"])
        version_id = _text(row["effective_version"])
        version_number: int | None = None
        artifact_sha: str | None = None
        if artifact_id:
            try:
                resolved_id, resolved_number, artifact_sha = _artifact_version(database, project_id, artifact_id)
            except ValueError:
                resolved_id, resolved_number, artifact_sha = None, None, None
            version_id = version_id or resolved_id or ""
            version_number = resolved_number
        scope = _text(row["scope"]) or "general"
        group = _text(row["conflict_group"]) or None
        snapshot.append({
            "reference_id": row["reference_id"], "reference_kind": row["reference_kind"], "artifact_id": row["artifact_id"],
            "role": row["role"], "source": row["source"], "notes": row["notes"],
            "priority": int(row["priority"] or 100), "scope": scope, "authority": row["authority"],
            "conflict_group": group, "effective_version": version_id or None,
            "artifact_sha256": artifact_sha, "asset_version_id": version_id or None, "asset_version": version_number,
            "order": order, "conflict_winner_reference_id": group_winners.get((scope, group)) if group else None,
        })
    return snapshot
