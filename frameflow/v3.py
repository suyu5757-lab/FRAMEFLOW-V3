from __future__ import annotations

from collections import defaultdict, deque
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .database import Database, utcnow
from .production_gate import ProductionArtifactGateError, production_artifact_gate
from .schemas import TimelineClipV3, TimelineDocumentV3, TimelineTrackV3, WorkflowGraphV3


PAID_NODE_KINDS = {
    "image_generation", "image_edit", "video_generation", "speech",
    "music_generation", "sound_effect", "upscale", "lip_sync",
}


def default_graph(project: dict[str, Any]) -> dict[str, Any]:
    """Create a deterministic V3 projection without changing the V2 document."""
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    stages = [
        ("story", "故事与分镜", "story"),
        ("regulator", "资产监管", "asset_regulator"),
        ("assets", "资产生产", "asset_production"),
        ("fusion", "素材融合", "fusion"),
        ("director", "镜头导演", "shot_director"),
        ("audio", "配音与声音", "audio_production"),
        ("generate", "视频生成", "video_generation"),
        ("delivery", "质检与交付", "delivery"),
    ]
    for index, (node_id, label, kind) in enumerate(stages):
        nodes.append({
            "id": node_id,
            "kind": kind,
            "label": label,
            "position": {"x": index * 260.0, "y": 80.0},
            "config": {"legacy_stage": index, "paid": kind in {"video_generation"}},
            "inputs": ["input"] if index else [],
            "outputs": ["output"] if index < len(stages) - 1 else [],
            "status": "idle",
            "version": 1,
            "locked": False,
        })
        if index:
            previous = stages[index - 1][0]
            edges.append({
                "id": f"edge:{previous}:{node_id}",
                "source": previous,
                "target": node_id,
                "source_port": "output",
                "target_port": "input",
                "relation": "execution",
            })
    return {
        "version": 1,
        "template_id": "builtin:professional-video",
        "nodes": nodes,
        "edges": edges,
        "viewport": {"x": 0.0, "y": 0.0, "zoom": 0.75},
        "metadata": {
            "project_id": project.get("id"),
            "project_name": project.get("name"),
            "source": "v2-projection",
        },
    }


def validate_graph(graph: WorkflowGraphV3) -> None:
    node_ids = [node.id for node in graph.nodes]
    if len(node_ids) != len(set(node_ids)):
        raise HTTPException(422, "工作流节点 ID 不能重复。")
    edge_ids = [edge.id for edge in graph.edges]
    if len(edge_ids) != len(set(edge_ids)):
        raise HTTPException(422, "工作流连接 ID 不能重复。")
    known = set(node_ids)
    node_by_id = {node.id: node for node in graph.nodes}
    group_parent: dict[str, str] = {}
    for node in graph.nodes:
        group_id = node.config.get("group_id")
        if group_id is None:
            continue
        if not isinstance(group_id, str) or group_id not in known:
            raise HTTPException(422, f"节点 {node.id} 引用了不存在的分组。")
        if group_id == node.id:
            raise HTTPException(422, "节点不能把自己作为分组父级。")
        if node_by_id[group_id].kind != "group":
            raise HTTPException(422, f"节点 {node.id} 的父级不是分组节点。")
        group_parent[node.id] = group_id
    for node_id in group_parent:
        seen: set[str] = set()
        current = node_id
        while current in group_parent:
            if current in seen:
                raise HTTPException(422, "分组层级不能形成环。")
            seen.add(current)
            current = group_parent[current]
    execution: dict[str, list[str]] = defaultdict(list)
    indegree = {node_id: 0 for node_id in node_ids}
    for edge in graph.edges:
        if edge.source not in known or edge.target not in known:
            raise HTTPException(422, f"连接 {edge.id} 指向不存在的节点。")
        if edge.source == edge.target and edge.relation == "execution":
            raise HTTPException(422, "执行连接不能指向节点自身。")
        if edge.relation == "execution":
            execution[edge.source].append(edge.target)
            indegree[edge.target] += 1
    queue = deque(node_id for node_id, degree in indegree.items() if degree == 0)
    visited = 0
    while queue:
        node_id = queue.popleft()
        visited += 1
        for target in execution[node_id]:
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
    if visited != len(node_ids):
        raise HTTPException(422, "执行连接必须是无环图；请把循环改为参考或注释连接。")


def ensure_graph(database: Database, project_id: str) -> dict[str, Any]:
    with database.connect() as connection:
        project = connection.execute(
            "SELECT document_json FROM projects WHERE id=?", (project_id,)
        ).fetchone()
        if not project:
            raise HTTPException(404, "项目不存在。")
        row = connection.execute(
            "SELECT * FROM workflow_graphs WHERE project_id=?", (project_id,)
        ).fetchone()
        if not row:
            graph = default_graph(database.decode(project["document_json"], {}))
            now = utcnow()
            connection.execute(
                "INSERT INTO workflow_graphs(project_id,revision,graph_json,created_at,updated_at) VALUES(?,1,?,?,?)",
                (project_id, database.encode(graph), now, now),
            )
            connection.execute(
                "INSERT INTO workflow_graph_events(project_id,revision,event_type,detail_json,created_at) VALUES(?,1,'created',?,?)",
                (project_id, database.encode({"source": "v2-projection"}), now),
            )
            return {"project_id": project_id, "revision": 1, "graph": graph, "updated_at": now}
        return {
            "project_id": project_id,
            "revision": row["revision"],
            "graph": database.decode(row["graph_json"], {}),
            "updated_at": row["updated_at"],
        }


def save_graph(database: Database, project_id: str, graph: WorkflowGraphV3, expected_revision: int) -> dict[str, Any]:
    validate_graph(graph)
    now = utcnow()
    graph_data = graph.model_dump(mode="json")
    with database.connect() as connection:
        row = connection.execute(
            "SELECT revision FROM workflow_graphs WHERE project_id=?", (project_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "项目工作流图尚未初始化。")
        if row["revision"] != expected_revision:
            raise HTTPException(409, {
                "message": "工作流图已在其他位置更新，请刷新后重试。",
                "expected_revision": expected_revision,
                "current_revision": row["revision"],
            })
        revision = expected_revision + 1
        connection.execute(
            "UPDATE workflow_graphs SET revision=?,graph_json=?,updated_at=? WHERE project_id=?",
            (revision, database.encode(graph_data), now, project_id),
        )
        connection.execute(
            "INSERT INTO workflow_graph_events(project_id,revision,event_type,detail_json,created_at) VALUES(?,?,'updated',?,?)",
            (project_id, revision, database.encode({"node_count": len(graph.nodes), "edge_count": len(graph.edges)}), now),
        )
    return {"project_id": project_id, "revision": revision, "graph": graph_data, "updated_at": now}


def estimate_graph(graph: dict[str, Any], node_ids: list[str] | None = None) -> dict[str, Any]:
    selected = set(select_graph_node_ids(graph, node_ids))
    nodes = [node for node in graph.get("nodes", []) if not selected or node.get("id") in selected]
    paid_nodes: list[dict[str, Any]] = []
    total = 0.0
    currency = "USD"
    for node in nodes:
        config = node.get("config") or {}
        paid = bool(config.get("paid")) or node.get("kind") in PAID_NODE_KINDS
        if not paid:
            continue
        try:
            cost = float(config.get("estimated_cost") or 0)
        except (TypeError, ValueError):
            cost = 0.0
        quantity = config.get("quantity", config.get("count", 1))
        try:
            quantity = max(1, int(quantity))
        except (TypeError, ValueError):
            quantity = 1
        total += max(0.0, cost)
        currency = str(config.get("currency") or currency)
        paid_nodes.append({
            "node_id": node.get("id"),
            "kind": node.get("kind"),
            "estimated_cost": round(max(0.0, cost), 6),
            "currency": currency,
            "provider_profile_id": config.get("provider_profile_id"),
            "model": config.get("model") or config.get("provider_model") or config.get("model_id"),
            "quantity": quantity,
            "resolution": config.get("resolution") or ({"width": config.get("width"), "height": config.get("height")} if config.get("width") or config.get("height") else None),
            "duration": config.get("duration") or config.get("duration_seconds"),
            "seed": config.get("seed"),
            "prompt_version": config.get("prompt_version"),
            "privacy": config.get("privacy", "cloud_allowed"),
        })
    selected_node_ids = [str(node.get("id")) for node in nodes if node.get("id")]
    return {
        "node_count": len(nodes),
        "paid_node_count": len(paid_nodes),
        "paid_nodes": paid_nodes,
        "selected_node_ids": selected_node_ids,
        "impact_node_ids": selected_node_ids,
        "estimated_cost": round(total, 6),
        "currency": currency,
        "requires_confirmation": bool(paid_nodes),
    }


def select_graph_node_ids(graph: dict[str, Any], node_ids: list[str] | None = None) -> list[str]:
    """Return selected nodes plus all execution ancestors needed to run them."""
    all_nodes = graph.get("nodes", [])
    if not node_ids:
        return [str(node.get("id")) for node in all_nodes if node.get("id")]
    known = {str(node.get("id")) for node in all_nodes if node.get("id")}
    selected = {str(node_id) for node_id in node_ids}
    selected &= known
    predecessors: dict[str, set[str]] = defaultdict(set)
    for edge in graph.get("edges", []):
        if edge.get("relation") == "execution" and edge.get("source") in known and edge.get("target") in known:
            predecessors[str(edge["target"])].add(str(edge["source"]))
    pending = deque(selected)
    while pending:
        node_id = pending.popleft()
        for parent in predecessors.get(node_id, set()):
            if parent not in selected:
                selected.add(parent)
                pending.append(parent)
    return [str(node.get("id")) for node in all_nodes if str(node.get("id")) in selected]


def default_timeline(project: dict[str, Any]) -> dict[str, Any]:
    ratio = str(project.get("ratio") or "9:16")
    width, height = (1920, 1080) if ratio == "16:9" else (1080, 1080) if ratio == "1:1" else (1080, 1920)
    document = TimelineDocumentV3(
        width=width,
        height=height,
        duration=float(project.get("duration") or 30),
        tracks=[
            {"id": "video-main", "kind": "video", "name": "主视频", "clips": []},
            {"id": "overlay", "kind": "overlay", "name": "叠加视频", "clips": []},
            {"id": "dialogue", "kind": "dialogue", "name": "对白", "clips": []},
            {"id": "music", "kind": "music", "name": "配乐", "clips": []},
            {"id": "ambience", "kind": "ambience", "name": "环境声", "clips": []},
            {"id": "sfx", "kind": "sfx", "name": "音效", "clips": []},
            {"id": "captions", "kind": "captions", "name": "字幕", "clips": []},
        ],
        metadata={"project_id": project.get("id"), "source": "v3-default"},
    )
    return document.model_dump(mode="json")


def validate_timeline(document: TimelineDocumentV3) -> None:
    """Validate timeline structure before it becomes a new immutable revision."""
    track_ids = [track.id for track in document.tracks]
    if len(track_ids) != len(set(track_ids)):
        raise HTTPException(422, "时间线轨道 ID 不能重复。")
    clip_ids: list[str] = []
    for track in document.tracks:
        for clip in track.clips:
            clip_ids.append(clip.id)
            if clip.start + clip.duration > document.duration + 0.001:
                raise HTTPException(422, f"片段 {clip.id} 超出时间线总时长。")
            if track.kind in {"video", "overlay", "dialogue", "music", "ambience", "sfx"} and not (clip.artifact_id or clip.source):
                raise HTTPException(422, f"媒体片段 {clip.id} 必须指定 artifact_id 或 source。")
    if len(clip_ids) != len(set(clip_ids)):
        raise HTTPException(422, "时间线片段 ID 不能重复。")


def ensure_timeline(database: Database, project_id: str) -> dict[str, Any]:
    with database.connect() as connection:
        project = connection.execute("SELECT document_json FROM projects WHERE id=?", (project_id,)).fetchone()
        if not project:
            raise HTTPException(404, "项目不存在。")
        row = connection.execute("SELECT * FROM timelines_v3 WHERE project_id=?", (project_id,)).fetchone()
        if not row:
            document = default_timeline(database.decode(project["document_json"], {}))
            now = utcnow()
            connection.execute(
                "INSERT INTO timelines_v3(project_id,revision,document_json,created_at,updated_at) VALUES(?,1,?,?,?)",
                (project_id, database.encode(document), now, now),
            )
            connection.execute(
                "INSERT INTO timeline_events_v6(project_id,revision,event_type,detail_json,created_at) VALUES(?,?,?,?,?)",
                (project_id, 1, "created", database.encode({"source": "v3-default"}), now),
            )
            return {"project_id": project_id, "revision": 1, "document": document, "updated_at": now}
        document = TimelineDocumentV3.model_validate(database.decode(row["document_json"], {}))
        validate_timeline(document)
        required_tracks = [
            ("video-main", "video", "主视频"),
            ("overlay", "overlay", "叠加视频"),
            ("dialogue", "dialogue", "对白"),
            ("music", "music", "配乐"),
            ("ambience", "ambience", "环境声"),
            ("sfx", "sfx", "音效"),
            ("captions", "captions", "字幕"),
        ]
        document_data = document.model_dump(mode="json")
        track_by_id = {str(track.get("id")): track for track in document_data.get("tracks", [])}
        required_ids = {track_id for track_id, _, _ in required_tracks}
        ordered_tracks = [track_by_id.get(track_id, {"id": track_id, "kind": kind, "name": name, "clips": []}) for track_id, kind, name in required_tracks]
        ordered_tracks.extend(track for track_id, track in track_by_id.items() if track_id not in required_ids)
        if ordered_tracks != document_data.get("tracks", []):
            document = TimelineDocumentV3.model_validate({**document_data, "tracks": ordered_tracks})
            connection.execute("UPDATE timelines_v3 SET document_json=? WHERE project_id=?", (database.encode(document.model_dump(mode="json")), project_id))
        return {"project_id": project_id, "revision": row["revision"], "document": document.model_dump(mode="json"), "updated_at": row["updated_at"]}


def save_timeline(database: Database, project_id: str, document: TimelineDocumentV3, expected_revision: int) -> dict[str, Any]:
    validate_timeline(document)
    now = utcnow()
    data = document.model_dump(mode="json")
    with database.connect() as connection:
        row = connection.execute("SELECT revision FROM timelines_v3 WHERE project_id=?", (project_id,)).fetchone()
        if not row:
            raise HTTPException(404, "项目时间线尚未初始化。")
        if row["revision"] != expected_revision:
            raise HTTPException(409, {"message": "时间线版本冲突。", "current_revision": row["revision"]})
        revision = expected_revision + 1
        connection.execute(
            "UPDATE timelines_v3 SET revision=?,document_json=?,updated_at=? WHERE project_id=?",
            (revision, database.encode(data), now, project_id),
        )
        connection.execute(
            "INSERT INTO timeline_events_v6(project_id,revision,event_type,detail_json,created_at) VALUES(?,?,?,?,?)",
            (project_id, revision, "updated", database.encode({"track_count": len(document.tracks), "clip_count": sum(len(track.clips) for track in document.tracks)}), now),
        )
    return {"project_id": project_id, "revision": revision, "document": data, "updated_at": now}


def _shot_artifact_id(shot: dict[str, Any]) -> str | None:
    """Read only explicit approved video references from legacy shot documents."""
    for key in ("approvedArtifactId", "videoArtifactId", "artifactId", "artifact_id"):
        value = shot.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for key in ("generation", "approvedGeneration", "video", "output"):
        value = shot.get(key)
        if isinstance(value, dict):
            nested = _shot_artifact_id(value)
            if nested:
                return nested
    return None


def _artifact_metadata_shot_ids(database: Database, row: Any) -> set[str]:
    metadata = database.decode(row["metadata_json"], {}) if row["metadata_json"] else {}
    if not isinstance(metadata, dict):
        return set()
    values: list[Any] = []
    for key in ("shot_id", "shotId"):
        if metadata.get(key):
            values.append(metadata[key])
    for key in ("shot_ids", "shotIds", "relevant_shots"):
        value = metadata.get(key)
        if isinstance(value, list):
            values.extend(value)
        elif isinstance(value, str):
            values.extend(value.replace(",", " ").split())
    return {str(value) for value in values if value}


def _shot_video_artifact_ids(database: Database, project_id: str, shot: dict[str, Any]) -> list[str]:
    explicit = _shot_artifact_id(shot)
    result = [explicit] if explicit else []
    shot_id = str(shot.get("id") or "")
    with database.connect() as connection:
        rows = connection.execute(
            "SELECT id,artifact_type,mime_type,local_path,qa_decision,status,metadata_json FROM artifacts WHERE project_id=? ORDER BY created_at DESC",
            (project_id,),
        ).fetchall()
    for row in rows:
        artifact_type = str(row["artifact_type"] or "").lower()
        mime_type = str(row["mime_type"] or "").lower()
        if not (mime_type.startswith("video/") or artifact_type in {"video", "shot_video", "final_video"}):
            continue
        path = Path(str(row["local_path"] or "")).resolve()
        project_root = (database.path.parent / "projects" / project_id).resolve()
        if not path.is_file() or project_root not in path.parents:
            continue
        status = str(row["status"] or "").lower()
        decision = str(row["qa_decision"] or "").lower()
        if decision not in {"approved", "pending"} and status not in {"approved", "ready", "generated_pending_qa"}:
            continue
        if shot_id in _artifact_metadata_shot_ids(database, row):
            result.append(str(row["id"]))
    return list(dict.fromkeys(result))


def _shot_is_approved(shot: dict[str, Any]) -> bool:
    if shot.get("directorApproved") is True or shot.get("approved") is True:
        return True
    status = str(shot.get("status") or "").lower()
    return status in {"approved", "ready", "generated_pending_qa"}


def _audio_handoff_items(project: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    audio = project.get("audio")
    if not isinstance(audio, dict):
        return {}, []
    items: list[dict[str, Any]] = []
    for key, track_kind in (("dialogues", "dialogue"), ("music_cues", "music"), ("sound_design", "sfx")):
        for item in audio.get(key) or []:
            if not isinstance(item, dict):
                continue
            asset_id = item.get("asset_id") or item.get("assetId")
            if asset_id:
                items.append({"asset_id": str(asset_id), "track_kind": track_kind, "item": item})
    handoff = audio.get("handoff") if isinstance(audio.get("handoff"), dict) else {}
    return handoff, items


def _audio_start_for_item(item: dict[str, Any], video_track: Any) -> float:
    shot_ids = item.get("shot_ids") or item.get("shotIds") or []
    if isinstance(shot_ids, str):
        shot_ids = [shot_ids]
    shot_id_set = {str(value) for value in shot_ids if value}
    if not shot_id_set:
        return 0.0
    starts = [
        float(clip.start)
        for clip in video_track.clips
        if str((clip.metadata or {}).get("shot_id") or "") in shot_id_set
    ]
    return min(starts, default=0.0)


def _audio_duration(item: dict[str, Any], metadata: dict[str, Any], track_kind: str, start: float, timeline_duration: float) -> float:
    values = [
        item.get("target_duration") if track_kind == "dialogue" else item.get("duration"),
        metadata.get("duration"),
        metadata.get("audio_duration"),
    ]
    for value in values:
        try:
            duration = float(value)
        except (TypeError, ValueError):
            continue
        if duration > 0:
            return min(duration, 36000.0)
    if track_kind in {"music", "ambience"} and timeline_duration > start:
        return max(0.25, min(timeline_duration - start, 60.0))
    return 5.0


def assemble_approved_timeline(
    database: Database,
    project_id: str,
    expected_revision: int,
    include_audio: bool = True,
    replace_existing: bool = False,
    projects_root: Path | None = None,
) -> dict[str, Any]:
    """Create the first editable timeline from approved shot and audio references.

    This only writes a new timeline revision. It never changes the source project
    document, active asset pointers, or media files.
    """
    current = ensure_timeline(database, project_id)
    authority_root = projects_root or (database.path.parent / "projects")
    if current["revision"] != expected_revision:
        raise HTTPException(409, {"message": "时间线版本已变化，请刷新后重试。", "current_revision": current["revision"]})
    with database.connect() as connection:
        project_row = connection.execute("SELECT document_json FROM projects WHERE id=?", (project_id,)).fetchone()
        if not project_row:
            raise HTTPException(404, "项目不存在。")
    project = database.decode(project_row["document_json"], {})
    document = TimelineDocumentV3.model_validate(current["document"])
    tracks = [track.model_copy(deep=True) for track in document.tracks]
    video_track = next((track for track in tracks if track.kind == "video"), None)
    if video_track is None:
        from .schemas import TimelineTrackV3
        video_track = TimelineTrackV3(id="video-main", kind="video", name="主视频")
        tracks.insert(0, video_track)
    existing_ids = {clip.artifact_id for clip in video_track.clips if clip.artifact_id}
    if replace_existing:
        video_track.clips = []
        existing_ids = set()
    candidates: list[tuple[dict[str, Any], str]] = []
    missing: list[dict[str, Any]] = []
    added_video_count = 0
    for shot in project.get("shots") or []:
        if not isinstance(shot, dict):
            continue
        if not _shot_is_approved(shot):
            missing.append({"shot_id": shot.get("id"), "reason": "shot_not_approved"})
            continue
        artifact_ids = _shot_video_artifact_ids(database, project_id, shot)
        if artifact_ids:
            candidates.append((shot, artifact_ids[0]))
        else:
            missing.append({"shot_id": shot.get("id"), "reason": "missing_video_artifact"})
    artifact_ids = [artifact_id for _, artifact_id in candidates]
    artifact_rows: dict[str, Any] = {}
    if artifact_ids:
        marks = ",".join("?" for _ in artifact_ids)
        with database.connect() as connection:
            rows = connection.execute(
                f"SELECT id,local_path,mime_type,qa_decision,status FROM artifacts WHERE project_id=? AND id IN ({marks})",
                (project_id, *artifact_ids),
            ).fetchall()
        artifact_rows = {row["id"]: row for row in rows}
    cursor = max((clip.start + clip.duration for clip in video_track.clips), default=0.0)
    for shot, artifact_id in candidates:
        if artifact_id in existing_ids:
            continue
        try:
            authority = production_artifact_gate(database, project_id, artifact_id, authority_root)
        except ProductionArtifactGateError as exc:
            raise HTTPException(409, {"message": "镜头素材未通过生产门禁。", "production_gate": exc.payload()}) from exc
        row = artifact_rows.get(artifact_id)
        if not row or not row["local_path"]:
            missing.append({"shot_id": shot.get("id"), "artifact_id": artifact_id, "reason": "artifact_missing"})
            continue
        if row["qa_decision"] and str(row["qa_decision"]).lower() not in {"approved", "pending"} and str(row["status"]).lower() not in {"approved", "ready", "generated_pending_qa"}:
            missing.append({"shot_id": shot.get("id"), "artifact_id": artifact_id, "reason": "artifact_not_ready"})
            continue
        duration = float(shot.get("duration") or 1)
        clip_id = f"clip:{shot.get('id') or artifact_id}"
        asset_ids = [
            str(item.get("assetId") or item.get("asset_id"))
            for item in shot.get("assetRequirements") or []
            if isinstance(item, dict) and (item.get("assetId") or item.get("asset_id"))
        ]
        video_track.clips.append(TimelineClipV3(
            id=clip_id,
            artifact_id=artifact_id,
            start=round(cursor, 6),
            duration=duration,
            source_in=0,
            speed=1,
            volume=1,
            fade_in=0,
            fade_out=0,
            transition=None,
            metadata={
                "shot_id": shot.get("id"),
                "scene_id": shot.get("scene"),
                "source_role": "approved_shot",
                "asset_ids": asset_ids,
                "readiness": "production",
                "artifact_qa_decision": artifact_rows.get(artifact_id)["qa_decision"] if artifact_rows.get(artifact_id) else None,
                "asset_version_id": authority["asset_version_id"],
                "production_sha256": authority["sha256"],
            },
        ))
        existing_ids.add(artifact_id)
        added_video_count += 1
        cursor += duration
    if cursor > document.duration:
        document.duration = round(cursor, 6)
    document.tracks = tracks
    added_audio_count = 0
    approved_audio_ids: list[str] = []
    if include_audio:
        handoff, audio_items = _audio_handoff_items(project)
        approved_audio_ids = [str(value) for value in handoff.get("approved_asset_ids") or handoff.get("approvedAssetIds") or [] if value]
        if approved_audio_ids and str(handoff.get("status") or "provisional") != "ready":
            missing.append({"reason": "audio_handoff_not_ready", "asset_ids": approved_audio_ids})
        elif approved_audio_ids:
            marks = ",".join("?" for _ in approved_audio_ids)
            with database.connect() as connection:
                audio_rows = connection.execute(
                    f"SELECT id,logical_asset_id,asset_class,asset_role,local_path,mime_type,metadata_json,qa_decision,status FROM artifacts WHERE project_id=? AND logical_asset_id IN ({marks}) AND status='ready' ORDER BY created_at DESC",
                    (project_id, *approved_audio_ids),
                ).fetchall()
            ready_audio_rows: dict[str, Any] = {}
            for row in audio_rows:
                ready_audio_rows.setdefault(str(row["logical_asset_id"]), row)
            item_by_asset = {entry["asset_id"]: entry for entry in audio_items}
            track_map = {track.kind: track for track in tracks}
            for kind, label in (("dialogue", "对白 / 旁白"), ("music", "背景音乐"), ("ambience", "氛围"), ("sfx", "音效")):
                if kind not in track_map:
                    track_map[kind] = TimelineTrackV3(id=f"{kind}-main", kind=kind, name=label)
                    tracks.append(track_map[kind])
            existing_audio_ids = {clip.artifact_id for track in tracks for clip in track.clips if clip.artifact_id}
            for logical_asset_id in approved_audio_ids:
                row = ready_audio_rows.get(logical_asset_id)
                if not row or not row["local_path"]:
                    missing.append({"logical_asset_id": logical_asset_id, "reason": "audio_artifact_not_ready"})
                    continue
                try:
                    authority = production_artifact_gate(database, project_id, str(row["id"]), authority_root)
                except ProductionArtifactGateError as exc:
                    raise HTTPException(409, {"message": "声音素材未通过生产门禁。", "production_gate": exc.payload()}) from exc
                if str(row["id"]) in existing_audio_ids:
                    continue
                metadata = database.decode(row["metadata_json"], {})
                entry = item_by_asset.get(logical_asset_id)
                item = entry["item"] if entry else {}
                track_kind = entry["track_kind"] if entry else "dialogue"
                if str(row["asset_class"] or "") == "music":
                    track_kind = "music"
                elif str(row["asset_class"] or "") == "sfx":
                    track_kind = "ambience" if str(row["asset_role"] or "") in {"ambience", "foley"} else "sfx"
                start = _audio_start_for_item(item, video_track)
                duration = _audio_duration(item, metadata, track_kind, start, document.duration)
                document.duration = max(document.duration, start + duration)
                track_map[track_kind].clips.append(TimelineClipV3(
                    id=f"audio:{row['id']}",
                    artifact_id=str(row["id"]),
                    start=round(start, 6),
                    duration=round(duration, 6),
                    source_in=0,
                    speed=1,
                    volume=1,
                    fade_in=0.15 if track_kind != "dialogue" else 0,
                    fade_out=0.25 if track_kind != "dialogue" else 0,
                    transition=None,
                    metadata={
                        "logical_asset_id": logical_asset_id,
                        "source_role": "approved_audio_asset",
                        "audio_role": row["asset_role"],
                        "readiness": "production",
                        "artifact_qa_decision": row["qa_decision"],
                        "asset_version_id": authority["asset_version_id"],
                        "production_sha256": authority["sha256"],
                    },
                ))
                existing_audio_ids.add(str(row["id"]))
                added_audio_count += 1
    document.tracks = tracks
    added_count = added_video_count + added_audio_count
    data = TimelineDocumentV3.model_validate(document.model_dump(mode="json"))
    result = save_timeline(database, project_id, data, expected_revision)
    with database.connect() as connection:
        connection.execute(
            "INSERT INTO timeline_events_v6(project_id,revision,event_type,detail_json,created_at) VALUES(?,?,?,?,?)",
            (project_id, result["revision"], "assembled", database.encode({"added_clips": added_count, "added_video_clips": added_video_count, "added_audio_clips": added_audio_count, "missing": missing, "include_audio": include_audio}), utcnow()),
        )
    result["assembly"] = {"added_clips": added_count, "added_video_clips": added_video_count, "added_audio_clips": added_audio_count, "missing": missing, "include_audio": include_audio}
    return result
