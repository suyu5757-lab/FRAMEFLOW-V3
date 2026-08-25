from __future__ import annotations

from collections import Counter
import re
from typing import Any


SHOT_REQUIRED_FIELDS = ("id", "scene", "duration", "purpose", "size", "camera", "action")
SHOT_DETAIL_FIELDS = ("composition", "movement", "performance", "dialogue", "narration", "lighting", "color", "style", "firstFrame", "lastFrame", "sound", "continuity")


def story_spec(document: dict[str, Any]) -> dict[str, Any]:
    current = document.get("storySpec") if isinstance(document.get("storySpec"), dict) else {}
    return {
        "creative_goal": str(current.get("creative_goal") or document.get("brief") or ""),
        "audience": str(current.get("audience") or ""),
        "platform": str(current.get("platform") or ""),
        "duration": int(current.get("duration") or document.get("duration") or 30),
        "ratio": str(current.get("ratio") or document.get("ratio") or "9:16"),
        "language": str(current.get("language") or "中文"),
        "brand_requirements": list(current.get("brand_requirements") or []),
        "must_preserve": list(current.get("must_preserve") or []),
        "must_avoid": list(current.get("must_avoid") or []),
        "structure": list(current.get("structure") or []),
        "beats": list(current.get("beats") or []),
    }


def story_document(document: dict[str, Any]) -> dict[str, Any]:
    shots = [shot for shot in document.get("shots", []) if isinstance(shot, dict)]
    scenes = [scene for scene in document.get("scenes", []) if isinstance(scene, dict)]
    if not scenes:
        seen: set[str] = set()
        scenes = []
        for shot in shots:
            scene_id = str(shot.get("scene") or "").strip()
            if scene_id and scene_id not in seen:
                seen.add(scene_id)
                scenes.append({"id": scene_id, "name": scene_id})
    return {
        "spec": story_spec(document),
        "script": str(document.get("script") or ""),
        "scenes": scenes,
        "shots": shots,
        "script_versions": list(document.get("scriptVersions") or []),
        "storyboard_versions": list(document.get("storyboardVersions") or []),
    }


def story_checks(document: dict[str, Any]) -> dict[str, Any]:
    payload = story_document(document)
    shots = payload["shots"]
    scenes = payload["scenes"]
    assets = {str(asset.get("id")): asset for asset in document.get("assets", []) if isinstance(asset, dict) and asset.get("id")}
    issues: list[dict[str, Any]] = []

    def issue(code: str, severity: str, message: str, shot_id: str | None = None, details: dict[str, Any] | None = None) -> None:
        item: dict[str, Any] = {"code": code, "severity": severity, "message": message}
        if shot_id:
            item["shot_id"] = shot_id
        if details:
            item["details"] = details
        issues.append(item)

    ids = [str(shot.get("id") or "") for shot in shots]
    for shot_id, count in Counter(ids).items():
        if not shot_id:
            issue("shot_id_missing", "error", "镜头缺少稳定 ID。")
        elif count > 1:
            issue("shot_id_duplicate", "error", f"镜头 ID {shot_id} 重复。", shot_id)

    scene_ids = {str(scene.get("id")) for scene in scenes if scene.get("id")}
    for scene_id, count in Counter(str(scene.get("id") or "") for scene in scenes).items():
        if scene_id and count > 1:
            issue("scene_id_duplicate", "error", f"场次 ID {scene_id} 重复。")
    total_duration = 0.0
    dialogue_duration = 0.0
    missing_assets: list[dict[str, Any]] = []
    previous_shot: dict[str, Any] | None = None
    continuity_fields = {
        "wardrobe": "服装",
        "hair": "发型",
        "weather": "天气",
        "time": "时间",
        "propState": "道具状态",
        "environmentState": "环境状态",
    }
    for shot in shots:
        shot_id = str(shot.get("id") or "") or None
        for field in SHOT_REQUIRED_FIELDS:
            if shot.get(field) in (None, "", []):
                issue("shot_field_missing", "error", f"镜头缺少必填字段 {field}。", shot_id, {"field": field})
        try:
            duration = float(shot.get("duration") or 0)
            if duration <= 0:
                issue("shot_duration_invalid", "error", "镜头时长必须大于 0。", shot_id)
            total_duration += max(0.0, duration)
            if duration < 0.5 or duration > 20:
                issue("shot_pace_extreme", "warning", "镜头时长可能导致节奏过快或过慢。", shot_id)
        except (TypeError, ValueError):
            issue("shot_duration_invalid", "error", "镜头时长不是有效数字。", shot_id)
        scene_id = str(shot.get("scene") or "")
        if scene_ids and scene_id not in scene_ids:
            issue("scene_reference_missing", "warning", f"镜头引用的场次 {scene_id} 未登记。", shot_id)
        for field in SHOT_DETAIL_FIELDS:
            if shot.get(field) in (None, "", []):
                issue("shot_detail_missing", "warning", f"镜头缺少连续性/生成细节 {field}。", shot_id, {"field": field})
        dialogue = str(shot.get("dialogue") or shot.get("narration") or "").strip()
        if dialogue:
            tokens = len(dialogue.split()) if re.search(r"\s", dialogue) else len(dialogue)
            estimated = round(tokens / (2.5 if not re.search(r"\s", dialogue) else 2.2), 3)
            dialogue_duration += estimated
            if float(shot.get("duration") or 0) and estimated > float(shot.get("duration") or 0) + 0.25:
                issue("dialogue_overrun", "error", "对白/旁白估算时长超过镜头时长。", shot_id, {"estimated_dialogue_duration": estimated})
        if previous_shot and previous_shot.get("scene") == shot.get("scene"):
            previous_axis = previous_shot.get("axis") or previous_shot.get("eyeLine")
            current_axis = shot.get("axis") or shot.get("eyeLine")
            if previous_axis and current_axis and previous_axis != current_axis and not shot.get("continuity"):
                issue("axis_continuity", "warning", "同场次镜头轴线/视线发生变化但未说明衔接。", shot_id)
            for field, label in continuity_fields.items():
                previous_value = previous_shot.get(field)
                current_value = shot.get(field)
                if previous_value not in (None, "", []) and current_value not in (None, "", []) and previous_value != current_value and not shot.get("continuity"):
                    issue("state_continuity", "warning", f"同场次镜头的{label}状态发生变化但未说明衔接。", shot_id, {"field": field})
            previous_last = str(previous_shot.get("lastFrame") or "").strip()
            current_first = str(shot.get("firstFrame") or "").strip()
            if previous_last and current_first and previous_last != current_first and not shot.get("continuity"):
                issue("frame_continuity", "warning", "相邻镜头首帧与前一镜头尾帧描述不一致，需人工确认衔接。", shot_id)
        if shot.get("firstFrame") and shot.get("lastFrame") and shot.get("firstFrame") == shot.get("lastFrame"):
            issue("frame_transition_unclear", "warning", "首帧与尾帧完全相同，无法确认镜头衔接意图。", shot_id)
        requirements = shot.get("assetRequirements") or shot.get("asset_requirements") or []
        if not requirements:
            issue("asset_requirements_missing", "warning", "镜头尚未登记角色、场景或道具依赖。", shot_id)
        for requirement in requirements:
            if not isinstance(requirement, dict):
                continue
            asset_id = str(requirement.get("assetId") or requirement.get("asset_id") or "")
            if asset_id and asset_id not in assets:
                missing_assets.append({"shot_id": shot_id, "asset_id": asset_id})
        referenced_asset_ids = []
        for key in ("characterIds", "character_ids", "propIds", "prop_ids"):
            values = shot.get(key) or []
            referenced_asset_ids.extend(values if isinstance(values, list) else [values])
        for key in ("sceneAssetId", "scene_asset_id", "fusionAssetId", "fusion_asset_id"):
            if shot.get(key):
                referenced_asset_ids.append(shot[key])
        for asset_id in referenced_asset_ids:
            asset_key = str(asset_id)
            if asset_key and asset_key not in assets and not any(item["shot_id"] == shot_id and item["asset_id"] == asset_key for item in missing_assets):
                missing_assets.append({"shot_id": shot_id, "asset_id": asset_key})
        generator = str(shot.get("generator") or shot.get("videoGenerator") or document.get("generator") or "").lower()
        try:
            shot_duration = float(shot.get("duration") or 0)
        except (TypeError, ValueError):
            shot_duration = 0
        if "2.0" in generator and shot_duration > 15:
            issue("generator_duration_limit", "error", "当前镜头超过 Seedance 2.0 的 15 秒单镜头限制。", shot_id, {"generator": generator, "duration": shot_duration, "max_duration": 15})
        if shot.get("requiredGenerator") and str(shot.get("requiredGenerator")).lower() not in generator:
            issue("generator_capability_mismatch", "warning", "镜头要求的生成器与项目当前生成器不一致。", shot_id, {"required": shot.get("requiredGenerator"), "actual": generator})
        previous_shot = shot
    if missing_assets:
        issue("asset_gap", "error", "镜头引用了尚未登记的资产。", details={"missing_assets": missing_assets})

    target_duration = float(payload["spec"].get("duration") or document.get("duration") or 0)
    if shots and target_duration > 0 and abs(total_duration - target_duration) > max(1.0, target_duration * 0.1):
        issue("duration_mismatch", "warning", "镜头总时长与项目目标时长偏差超过 10%。", details={"target": target_duration, "actual": round(total_duration, 3)})

    errors = sum(1 for item in issues if item["severity"] == "error")
    warnings = sum(1 for item in issues if item["severity"] == "warning")
    return {
        "ok": errors == 0,
        "errors": errors,
        "warnings": warnings,
        "issues": issues,
        "metrics": {"scene_count": len(scenes), "shot_count": len(shots), "total_duration": round(total_duration, 3), "target_duration": target_duration, "estimated_dialogue_duration": round(dialogue_duration, 3)},
    }
