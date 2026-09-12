from __future__ import annotations

from collections import Counter
import json
import math
import re
from typing import Any


SHOT_REQUIRED_FIELDS = ("id", "scene", "duration", "purpose", "size", "camera", "action")
SHOT_DETAIL_FIELDS = ("composition", "movement", "performance", "dialogue", "narration", "lighting", "color", "style", "firstFrame", "lastFrame", "sound", "continuity")


_SCRIPT_DURATION_PATTERN = re.compile(
    r"(?:视频|影片|项目|成片|总|目标)?\s*(?:时长|长度|片长|duration|runtime)"
    r"\s*[:：=]?\s*(?:约|大约|大致|about|around)?\s*"
    r"(?P<first>\d+(?:\.\d+)?)\s*"
    r"(?:(?P<separator>-|–|—|~|～|至|到)\s*(?P<second>\d+(?:\.\d+)?)\s*)?"
    r"(?P<unit>秒|s|sec(?:ond)?s?)(?=\s|$|[^\w])",
    re.IGNORECASE,
)


_SOURCE_BEAT_LABEL_PATTERN = re.compile(
    r"^(?:时间|时长|画面|摄影|镜头|目的|动作|声音|音效|音乐|对白|台词|旁白|转场|连续性|环境|光线|备注|节拍)\s*[:：]"
)
_SOURCE_BEAT_HEADING_PATTERN = re.compile(
    r"^(?:[#＃\s]*)(?:【\s*)?(?:镜头|shot|scene|场景)\s*[#：:._\-\s]*[A-Za-z0-9_-]*",
    re.IGNORECASE,
)
_SOURCE_BEAT_METADATA_PATTERN = re.compile(
    r"^(?:标题|片名|项目名|总时长|视频时长|影片时长|画幅|比例|格式|语言|平台|镜头数量)\s*[:：]",
    re.IGNORECASE,
)
_SOURCE_BEAT_TIME_ONLY_PATTERN = re.compile(
    r"^(?:\d{1,2}(?:\.\d+)?\s*(?:-|–|—|~|～|至|到)\s*\d{1,2}(?:\.\d+)?\s*秒|\d{1,2}:\d{2}(?:\.\d+)?\s*(?:-|–|—|~|～|至|到)\s*\d{1,2}:\d{2}(?:\.\d+)?)\s*[：:]?$",
    re.IGNORECASE,
)
_SOURCE_BEAT_CLAUSE_PATTERN = re.compile(
    r"(?<=[。！？!?；;])\s*|(?=(?:随后|然后|接着|最后|同时|此时|之后|并且))",
)
_SOURCE_BEAT_QUOTE_PATTERN = re.compile(r"[“\"‘']([^”\"’']+)[”\"’']")
_SOURCE_BEAT_LATIN_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{1,}")
_SOURCE_BEAT_CJK_PATTERN = re.compile(r"[\u3400-\u9fff]{2,}")
_SOURCE_BEAT_STOPWORDS = {
    "然后", "随后", "接着", "同时", "此时", "之后", "镜头", "画面", "动作", "摄影", "目的",
    "声音", "音效", "音乐", "对白", "台词", "旁白", "场景", "角色", "一个", "进行", "完成",
}


def _source_beat_category(text: str) -> str:
    lowered = text.lower()
    if _SOURCE_BEAT_QUOTE_PATTERN.search(text) or re.search(r"(?:对白|台词|旁白|说[:：]|system\b)", lowered):
        return "dialogue"
    if re.search(r"(?:声音|音效|音乐|bgm|sfx|低频|重低频|雨声|风声)", lowered):
        return "sound"
    if re.search(r"(?:切黑|黑场|logo|标志|片尾|转场|cut to|cut\b)", lowered):
        return "transition"
    if re.search(r"(?:镜头|摄影|推进|拉远|环绕|俯拍|仰拍|移向|移动|推近|rack focus|orbit|push|slide|tilt)", lowered):
        return "camera"
    if re.search(r"(?:光|亮|闪|反射|倒影|逆光|能源|发光|散热)", lowered):
        return "visual"
    if re.search(r"(?:触|走|进入|离开|抬|看|启动|关闭|打开|移动|转身|拿起|放下|接触|微笑|说)", lowered):
        return "action"
    return "narrative"


def _source_beat_is_metadata(line: str) -> bool:
    clean = line.strip()
    if not clean or _SOURCE_BEAT_TIME_ONLY_PATTERN.match(clean):
        return True
    return bool(_SOURCE_BEAT_METADATA_PATTERN.match(clean))


def _source_beat_content_lines(source: str) -> list[str]:
    lines = [line.strip() for line in str(source or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    blocks: list[list[str]] = []
    current: list[str] = []

    def flush() -> None:
        nonlocal current
        if current:
            blocks.append(current)
            current = []

    for line in lines:
        if not line:
            flush()
            continue
        if _SOURCE_BEAT_METADATA_PATTERN.match(line) and _source_beat_is_metadata(line):
            # Keep narrative that follows an inline duration/title prefix,
            # e.g. ``视频时长：14秒。角色抬眼。``; discard only the metadata
            # sentence itself.
            remainder = re.sub(r"^[^：:]+\s*[:：]", "", line, count=1).strip()
            tail = re.split(r"[。！？!?；;]", remainder, maxsplit=1)
            if len(tail) == 2 and tail[1].strip():
                current.append(tail[1].strip())
            continue
        heading = _SOURCE_BEAT_HEADING_PATTERN.match(line)
        if heading:
            flush()
            remainder = line[heading.end():].lstrip(" ：:.-—–")
            if remainder:
                current.append(remainder)
            continue
        current.append(line)
    flush()

    segments: list[str] = []
    for block in blocks:
        # Labelled storyboard rows are already meaningful atomic beats. Keep
        # them separate so dialogue, sound, camera and transition evidence
        # cannot disappear inside a single summary paragraph.
        if len(block) > 1 or any(_SOURCE_BEAT_LABEL_PATTERN.match(line) for line in block):
            candidates = block
        else:
            candidates = _SOURCE_BEAT_CLAUSE_PATTERN.split(block[0])
        for candidate in candidates:
            clean = re.sub(r"^\s*(?:\d{1,2}(?::\d{2}(?:\.\d+)?)?\s*(?:-|–|—|~|～|至|到)\s*)", "", candidate).strip(" \t-—–")
            if not clean or _source_beat_is_metadata(clean):
                continue
            segments.append(clean)
    if not segments:
        fallback = str(source or "").strip()
        if fallback:
            segments = [fallback]
    return segments


def build_source_beat_ledger(source: str | None) -> list[dict[str, Any]]:
    """Build a stable, backend-facing ledger of content that shots must cover.

    The ledger is intentionally deterministic and conservative. It does not
    ask an AI to decide what the user's source means before the storyboard is
    generated; it only turns visible source rows/sentences into stable IDs so
    the provider must point each shot back to the source it represents.
    """
    segments = _source_beat_content_lines(str(source or ""))
    ledger: list[dict[str, Any]] = []
    for index, segment in enumerate(segments, start=1):
        category = _source_beat_category(segment)
        atomic = category in {"dialogue", "sound", "transition"}
        ledger.append({
            "id": f"B{index:03d}",
            "text": segment,
            "summary": segment[:220],
            "category": category,
            "required": True,
            "atomic": atomic,
        })
    return ledger


def _source_beat_terms(text: str) -> list[str]:
    terms: list[str] = []
    for value in _SOURCE_BEAT_QUOTE_PATTERN.findall(text):
        if value.strip():
            terms.append(value.strip())
    terms.extend(_SOURCE_BEAT_LATIN_PATTERN.findall(text))
    for value in _SOURCE_BEAT_CJK_PATTERN.findall(text):
        clean = value.strip()
        if clean and clean not in _SOURCE_BEAT_STOPWORDS:
            terms.append(clean)
            if len(clean) >= 4:
                terms.extend(clean[index:index + 2] for index in range(0, len(clean) - 1, 2))
    return list(dict.fromkeys(term.lower() for term in terms if len(term.strip()) >= 2))


def _storyboard_search_text(shot: dict[str, Any]) -> str:
    fields = (
        "purpose", "action", "visibleEvent", "eventConsequence", "subjectFocus", "performance",
        "dialogue", "narration", "sound", "camera", "environment", "spatialGeography",
        "materialEvidence", "lightingCausality", "firstFrame", "lastFrame", "continuity",
        "seedancePlan",
    )
    values: list[str] = []
    for field in fields:
        value = shot.get(field)
        if value not in (None, "", []):
            values.append(json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value))
    return " ".join(values).lower()


def storyboard_source_coverage(
    source: str | None,
    result: dict[str, Any] | None,
    normalization_report: dict[str, Any] | None = None,
    ledger: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Report whether the candidate visibly accounts for source beats.

    New provider output should use ``sourceBeatIds``. A small one-beat source
    remains backward compatible with older provider payloads; richer sources
    require explicit mapping or a reliable text match, so a structurally valid
    but content-poor one-shot candidate cannot pass silently.
    """
    source_text = str(source or "")
    source_ledger = list(ledger if ledger is not None else build_source_beat_ledger(source_text))
    shots = [item for item in (result or {}).get("shots", []) if isinstance(item, dict)]
    if not source_ledger:
        return {"status": "not_applicable", "total": 0, "covered": 0, "partial": 0, "missing": 0, "items": []}

    known_ids = {str(item.get("id")) for item in source_ledger if item.get("id")}
    by_beat: dict[str, list[str]] = {beat_id: [] for beat_id in known_ids}
    unknown_mappings: list[dict[str, Any]] = []
    explicit_mapping = False
    for shot in shots:
        raw_ids = shot.get("sourceBeatIds")
        if raw_ids not in (None, "", []):
            explicit_mapping = True
        if isinstance(raw_ids, str):
            raw_ids = re.split(r"[\n,，、]", raw_ids)
        if not isinstance(raw_ids, list):
            raw_ids = []
        shot_id = str(shot.get("id") or "")
        for value in raw_ids:
            beat_id = str(value or "").strip()
            if not beat_id:
                continue
            if beat_id not in known_ids:
                unknown_mappings.append({"shotId": shot_id, "sourceBeatId": beat_id})
            else:
                by_beat[beat_id].append(shot_id)

    search_text = "\n".join(_storyboard_search_text(shot) for shot in shots)
    items: list[dict[str, Any]] = []
    for beat in source_ledger:
        beat_id = str(beat.get("id") or "")
        shot_ids = list(dict.fromkeys(by_beat.get(beat_id, [])))
        category = str(beat.get("category") or "narrative")
        text = str(beat.get("text") or beat.get("summary") or "").strip()
        terms = _source_beat_terms(text)
        exact_quote = [term for term in terms if term in search_text and _SOURCE_BEAT_QUOTE_PATTERN.search(text)]
        lexical_match = [term for term in terms if term in search_text]
        if shot_ids:
            status = "covered"
            reason = "已由候选镜头明确绑定原文节拍。"
            if category in {"dialogue", "sound"} and terms and not exact_quote and not lexical_match:
                status = "partial"
                reason = "镜头声明了节拍关系，但没有找到对应的台词或声音证据。"
        elif len(source_ledger) == 1 and shots:
            # Short legacy scripts often have no provider mapping metadata;
            # keep the existing one-shot workflow usable while richer source
            # packages must prove each beat explicitly.
            status = "covered"
            reason = "单一来源节拍由候选镜头承载。"
            shot_ids = [str(shot.get("id") or "") for shot in shots if shot.get("id")]
        elif not explicit_mapping and lexical_match:
            status = "covered" if len(lexical_match) >= max(1, min(2, len(terms))) else "partial"
            reason = "通过候选镜头文本与原文节拍的可见词证据匹配。"
        else:
            status = "missing"
            reason = "没有候选镜头明确覆盖该原文节拍。"
        items.append({
            "beatId": beat_id,
            "status": status,
            "shotIds": shot_ids,
            "category": category,
            "summary": str(beat.get("summary") or text)[:220],
            "reason": reason,
        })

    dropped = list((normalization_report or {}).get("droppedItems") or [])
    covered = sum(1 for item in items if item["status"] == "covered")
    partial = sum(1 for item in items if item["status"] == "partial")
    missing = sum(1 for item in items if item["status"] == "missing")
    complete = not unknown_mappings and not dropped and missing == 0 and partial == 0
    return {
        "status": "complete" if complete else "incomplete",
        "total": len(items),
        "covered": covered,
        "partial": partial,
        "missing": missing,
        "items": items,
        "unknownMappings": unknown_mappings,
    }


def extract_script_duration(text: str | None) -> dict[str, Any] | None:
    """Extract an explicit duration instruction from source script text.

    StorySpec.duration is intentionally a planning reference. When a script
    itself says ``总时长：约14秒`` or ``视频时长：13–15秒``, the script is the
    authoritative input for a storyboard run. Ranges use their midpoint as the
    planning value while preserving the original range for the UI and audit
    trail. Timecode ranges are not matched because this pattern requires a
    duration label immediately before the number.
    """
    source = str(text or "")
    if not source.strip():
        return None
    match = _SCRIPT_DURATION_PATTERN.search(source)
    if not match:
        return None
    first = float(match.group("first"))
    second_value = match.group("second")
    second = float(second_value) if second_value else first
    minimum = min(first, second)
    maximum = max(first, second)
    target = round((minimum + maximum) / 2, 3)
    raw = match.group(0).strip()
    return {
        "source": "script_explicit",
        "minimum": minimum,
        "maximum": maximum,
        "target": target,
        "raw": raw,
    }


def shot_budget(duration: int, current: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return the shot-count guidance used by the desktop story desk.

    The automatic range is a planning reference, not a hard ceiling.  A user
    can still opt into an explicit manual budget when a production really needs
    a gate, but changing the reference duration must never silently block a
    deliberate storyboard edit.
    """
    current = current or {}
    duration = max(1, int(duration or 30))
    automatic_min = max(3, math.ceil(duration / 10))
    automatic_max = max(3, math.ceil(duration / 7.5))
    manual_values = any(current.get(key) not in (None, "") for key in ("shot_count_min", "shot_count_target", "shot_count_max"))
    requested_source = str(current.get("shot_budget_source") or "").strip().lower()
    source = requested_source if requested_source in {"manual", "automatic"} else ("manual" if manual_values else "automatic")
    enforced = source == "manual"
    minimum = int(current.get("shot_count_min") or automatic_min) if enforced else automatic_min
    maximum = int(current.get("shot_count_max") or automatic_max) if enforced else automatic_max
    if maximum < minimum:
        maximum = minimum
    target = int(current.get("shot_count_target") or round((minimum + maximum) / 2)) if enforced else round((minimum + maximum) / 2)
    target = max(minimum, min(target, maximum))
    mode = str(current.get("shot_budget_mode") or "controlled")
    if enforced and maximum > automatic_max:
        mode = "high_tempo"
    return {
        "shot_count_min": minimum,
        "shot_count_target": target,
        "shot_count_max": maximum,
        "automatic_shot_count_min": automatic_min,
        "automatic_shot_count_max": automatic_max,
        "shot_budget_mode": mode,
        "shot_budget_source": source,
    }


def story_spec(document: dict[str, Any]) -> dict[str, Any]:
    current = document.get("storySpec") if isinstance(document.get("storySpec"), dict) else {}
    reference_duration = int(current.get("duration") or document.get("duration") or 30)
    script_duration = extract_script_duration(document.get("script"))
    duration = int(math.ceil(float(script_duration["target"]))) if script_duration else reference_duration
    budget = shot_budget(duration, current)
    duration_source = "script_explicit" if script_duration else str(current.get("duration_source") or "reference")
    if duration_source not in {"reference", "script_explicit", "storyboard_import"}:
        duration_source = "reference"
    return {
        "workflow_mode": str(current.get("workflow_mode") or "optimize_script_and_storyboard"),
        "creative_goal": str(current.get("creative_goal") or document.get("brief") or ""),
        "audience": str(current.get("audience") or ""),
        "platform": str(current.get("platform") or ""),
        "duration": duration,
        "duration_source": duration_source,
        "script_duration": script_duration,
        "reference_duration": reference_duration,
        "ratio": str(current.get("ratio") or document.get("ratio") or "9:16"),
        "language": str(current.get("language") or "中文"),
        "brand_requirements": list(current.get("brand_requirements") or []),
        "must_preserve": list(current.get("must_preserve") or []),
        "must_avoid": list(current.get("must_avoid") or []),
        "structure": list(current.get("structure") or []),
        "beats": list(current.get("beats") or []),
        "generator_profile": str(current.get("generator_profile") or document.get("generator") or ""),
        **budget,
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
        "asset_handoff_receipt": document.get("assetHandoffReceipt") or document.get("asset_handoff_receipt"),
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
    scene_ledger_fields = (
        "id", "name", "description", "interiorExterior", "timeOfDay", "location",
        "characterIds", "propIds", "narrativeFunction", "emotion", "visualAnchors",
        "spatialGeography", "materialEvidence", "lightingCausality", "soundscape",
        "productionDifficulty", "relevantShots",
    )
    for scene in scenes:
        scene_id = str(scene.get("id") or "未命名场景")
        missing = [field for field in scene_ledger_fields if field not in scene or scene.get(field) is None or (field not in {"characterIds", "propIds", "visualAnchors", "relevantShots"} and scene.get(field) == "")]
        invalid_lists = [field for field in ("characterIds", "propIds", "visualAnchors", "relevantShots") if field in scene and not isinstance(scene.get(field), list)]
        if missing or invalid_lists:
            details = {"missing_fields": missing, "invalid_list_fields": invalid_lists}
            issue("scene_ledger_incomplete", "warning", f"场景 {scene_id} 的场景账本尚未完整，AI 工作流或人工补充后才能作为完整前期规格使用。", details=details)
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
        if shot.get("visibleEvent") in (None, "", []):
            issue("visible_event_missing", "warning", "镜头缺少一个明确的主可见事件。", shot_id)
        if shot.get("eventConsequence") in (None, "", []):
            issue("event_consequence_missing", "warning", "镜头缺少动作、接触、材质、光线或空间的可见后果。", shot_id)
        seedance_plan = shot.get("seedancePlan") or shot.get("seedance_plan")
        if not isinstance(seedance_plan, dict) or not seedance_plan.get("model") or not seedance_plan.get("generationMode"):
            issue("seedance_plan_missing", "warning", "镜头缺少完整 Seedance 生成计划。", shot_id)
        continuity = shot.get("continuity")
        if not isinstance(continuity, dict) or not any(continuity.get(field) for field in ("cutIn", "cutOut", "firstFrame", "lastFrame", "editBridge")):
            issue("continuity_incomplete", "warning", "镜头缺少可审阅的剪辑进出点或首尾帧连续性。", shot_id)
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
            previous_continuity = previous_shot.get("continuity") if isinstance(previous_shot.get("continuity"), dict) else {}
            current_continuity = shot.get("continuity") if isinstance(shot.get("continuity"), dict) else {}
            previous_last = str(previous_shot.get("lastFrame") or previous_continuity.get("lastFrame") or "").strip()
            current_first = str(shot.get("firstFrame") or current_continuity.get("firstFrame") or "").strip()
            if previous_last and current_first and previous_last != current_first and not shot.get("continuity"):
                issue("frame_continuity", "warning", "相邻镜头首帧与前一镜头尾帧描述不一致，需人工确认衔接。", shot_id)
        continuity_for_frame = shot.get("continuity") if isinstance(shot.get("continuity"), dict) else {}
        first_frame = shot.get("firstFrame") or continuity_for_frame.get("firstFrame")
        last_frame = shot.get("lastFrame") or continuity_for_frame.get("lastFrame")
        if first_frame and last_frame and first_frame == last_frame:
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
        plan_model = seedance_plan.get("model") if isinstance(seedance_plan, dict) else ""
        generator = str(shot.get("generator") or shot.get("videoGenerator") or plan_model or document.get("generator") or "").lower()
        try:
            shot_duration = float(shot.get("duration") or 0)
        except (TypeError, ValueError):
            shot_duration = 0
        if "2.0" in generator and shot_duration > 15:
            issue("generator_duration_limit", "error", "当前镜头超过 Seedance 2.0 的 15 秒单镜头限制。", shot_id, {"generator": generator, "duration": shot_duration, "max_duration": 15})
        if "2.5" in generator and shot_duration > 30:
            issue("generator_duration_limit", "error", "当前镜头超过 Seedance 2.5 的 30 秒单次叙事规划上限。", shot_id, {"generator": generator, "duration": shot_duration, "max_duration": 30})
        if shot.get("requiredGenerator") and str(shot.get("requiredGenerator")).lower() not in generator:
            issue("generator_capability_mismatch", "warning", "镜头要求的生成器与项目当前生成器不一致。", shot_id, {"required": shot.get("requiredGenerator"), "actual": generator})
        previous_shot = shot
    if missing_assets:
        # Storyboard completion intentionally precedes asset registration. Keep
        # these references visible so the asset workflow can extract and
        # register them, but do not block the transition from story/shot work
        # into asset production.
        issue("asset_gap", "warning", "镜头引用了待资产生产登记的资产。", details={"missing_assets": missing_assets})

    # The duration entered in StorySpec is a planning reference only.  It is
    # used to suggest a conservative shot-count range, while the actual final
    # runtime is the sum of the reviewed shots.  Automatic guidance must not
    # turn a deliberate edit into a blocking issue.  An explicit manual budget
    # remains available as an intentional production gate.
    reference_duration = float(payload["spec"].get("duration") or document.get("duration") or 0)
    budget = shot_budget(int(reference_duration or 30), payload["spec"])
    enforced = budget["shot_budget_source"] == "manual"
    if enforced and len(shots) > budget["shot_count_max"]:
        issue("shot_budget_exceeded", "error", f"当前 {len(shots)} 个镜头超过已明确设置的手动上限 {budget['shot_count_max']} 个。请合并、删除或提高手动预算后再进入资产生产。", details={"actual": len(shots), **budget})
    elif enforced and len(shots) >= budget["shot_count_max"]:
        issue("shot_budget_near_limit", "warning", f"当前镜头数量已达到已明确设置的手动上限 {budget['shot_count_max']} 个。", details={"actual": len(shots), **budget})
    elif not enforced and len(shots) > budget["shot_count_max"]:
        issue("shot_budget_advisory", "warning", f"当前 {len(shots)} 个镜头高于按参考时长计算的建议范围 {budget['shot_count_max']} 个；参考范围不是上限，不会阻塞继续编辑或进入资产生产。", details={"actual": len(shots), **budget})
    elif not enforced and len(shots) >= budget["shot_count_max"] and shots:
        issue("shot_budget_advisory", "warning", f"当前镜头数量已达到按参考时长计算的建议范围 {budget['shot_count_max']} 个；仍可按叙事需要继续添加。", details={"actual": len(shots), **budget})
    errors = sum(1 for item in issues if item["severity"] == "error")
    warnings = sum(1 for item in issues if item["severity"] == "warning")
    return {
        "ok": errors == 0,
        "errors": errors,
        "warnings": warnings,
        "issues": issues,
        "metrics": {
            "scene_count": len(scenes),
            "shot_count": len(shots),
            "total_duration": round(total_duration, 3),
            # Keep target_duration for API compatibility; expose its meaning
            # explicitly so consumers do not treat it as the final runtime.
            "target_duration": reference_duration,
            "reference_duration": reference_duration,
            "duration_difference": round(total_duration - reference_duration, 3),
            "estimated_dialogue_duration": round(dialogue_duration, 3),
            "shot_budget": budget,
        },
    }
