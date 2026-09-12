"""Shared prompt contract, normalization, assembly, and QA helpers.

The workbench has several prompt entry points (asset cards, fusion, manual
revisions, and external handoff). They all pass through this module so a
prompt cannot silently switch back to a keyword stack or lose continuity
anchors between stages.

The vocabulary is intentionally compatible with older FrameFlow prompt packs,
while the normalized output follows the SUYU Skill v2 production protocol:
identity -> visible event -> spatial geography -> material evidence ->
lighting causality -> camera execution -> atmosphere/finish -> continuity and
negative controls.
"""
from __future__ import annotations

from copy import deepcopy
import re
from typing import Any, Literal


PROMPT_CONTRACT_VERSION = "2.0"
PROMPT_WORKFLOW_ID = "suyu-skill-v2"
PROMPT_FIELD_ORDER = [
    "promptIntent",
    "referenceStrategy",
    "generationReferenceAssets",
    "identityAnchor",
    "visibleEvent",
    "spatialGeography",
    "materialEvidence",
    "lightingCausality",
    "cameraExecution",
    "atmosphereBehavior",
    "continuityChecklist",
    "mustPreserve",
    "mustAvoid",
    "generationNotes",
]
AUDIO_PROMPT_SCHEMA_VERSION = "minimax-speech-audio-v2"
AUDIO_PROMPT_FIELD_ORDER = [
    "sourceText",
    "providerText",
    "textStatus",
    "voiceSource",
    "voiceIdentity",
    "language",
    "locale",
    "dialect",
    "providerVoiceId",
    "providerVoiceName",
    "providerRegion",
    "performanceDirection",
    "emotion",
    "intensity",
    "pace",
    "pausePlan",
    "pronunciation",
    "provider",
    "model",
    "voiceId",
    "speed",
    "pitch",
    "volume",
    "languageBoost",
    "format",
    "targetDuration",
    "relevantShots",
    "continuityChecklist",
    "mustPreserve",
    "mustAvoid",
]
AUDIO_CONFIRMED_TEXT_STATUSES = {"confirmed", "user-confirmed", "approved", "locked", "final"}

AUDIO_LOCALE_LANGUAGE_BOOSTS = {
    "ja": "Japanese", "ja-jp": "Japanese", "zh": "Chinese", "zh-cn": "Chinese", "zh-tw": "Chinese",
    "en": "English", "en-us": "English", "en-gb": "English", "ko": "Korean", "ko-kr": "Korean",
    "fr": "French", "fr-fr": "French", "de": "German", "de-de": "German", "es": "Spanish", "es-es": "Spanish",
    "it": "Italian", "it-it": "Italian", "pt": "Portuguese", "pt-br": "Portuguese", "pt-pt": "Portuguese",
    "ru": "Russian", "ru-ru": "Russian", "ar": "Arabic", "tr": "Turkish", "nl": "Dutch", "vi": "Vietnamese",
    "id": "Indonesian", "id-id": "Indonesian", "th": "Thai", "th-th": "Thai", "ms": "Malay", "ms-my": "Malay",
    "fil": "Filipino", "fil-ph": "Filipino", "uk": "Ukrainian", "uk-ua": "Ukrainian", "pl": "Polish", "pl-pl": "Polish",
    "ro": "Romanian", "ro-ro": "Romanian", "cs": "Czech", "cs-cz": "Czech", "el": "Greek", "el-gr": "Greek",
    "hu": "Hungarian", "hu-hu": "Hungarian", "sv": "Swedish", "sv-se": "Swedish", "da": "Danish", "da-dk": "Danish",
    "fi": "Finnish", "fi-fi": "Finnish", "no": "Norwegian", "no-no": "Norwegian", "sk": "Slovak", "sk-sk": "Slovak",
    "bg": "Bulgarian", "bg-bg": "Bulgarian", "hr": "Croatian", "hr-hr": "Croatian", "ta": "Tamil", "ta-in": "Tamil",
    "te": "Telugu", "te-in": "Telugu", "hi": "Hindi", "hi-in": "Hindi", "he": "Hebrew", "he-il": "Hebrew",
    "fa": "Persian", "fa-ir": "Persian", "bn": "Bengali", "bn-bd": "Bengali", "af": "Afrikaans", "af-za": "Afrikaans",
    "ca": "Catalan", "ca-es": "Catalan", "sr": "Serbian", "sr-rs": "Serbian",
}


def _audio_language_boost(locale: Any, language: Any, explicit: Any) -> str | None:
    explicit_text = _text(explicit)
    language_text = _text(language)
    normalized_locale = _text(locale).lower().replace("_", "-")
    locale_boost = AUDIO_LOCALE_LANGUAGE_BOOSTS.get(normalized_locale) or AUDIO_LOCALE_LANGUAGE_BOOSTS.get(normalized_locale.split("-", 1)[0])
    if locale_boost:
        return locale_boost
    if language_text == "Japanese" or "日语" in language_text or "日本語" in language_text:
        return "Japanese"
    if language_text == "Chinese" or any(item in language_text for item in ("中文", "汉语", "普通话")):
        return "Chinese"
    if explicit_text and explicit_text not in {"Chinese", "auto", "Auto", "automatic", "Automatic"}:
        return explicit_text
    normalized = language_text.lower().replace("_", "-")
    return AUDIO_LOCALE_LANGUAGE_BOOSTS.get(normalized) or AUDIO_LOCALE_LANGUAGE_BOOSTS.get(normalized.split("-", 1)[0])

PROMPT_SUPPLEMENT_MARKER = "同时满足以下补充制作要求："
PromptCompositionMode = Literal["legacy_supplement", "clean_replace"]

# These markers belong to FrameFlow's internal contract or UI state. They are
# useful in the structured asset record, but they are not image-generator
# instructions and must not leak into a clean replacement prompt.
PROMPT_INTERNAL_MARKERS = (
    "FRAMEFLOW",
    "Prompt Contract",
    "suyu-skill-v2",
    "资产 ID",
    "Prompt QA",
    "Pending",
    "user-confirmation-required",
    "generationStatus",
    "promptPack",
    "promptQuality",
    "同时满足以下补充制作要求",
    "建议尺寸为",
    "quality=",
    "size=",
    "background=",
    "output_format=",
)

PROMPT_CLASS_ALIASES = {
    "environment": "scene",
    "environment_prop": "scene",
    "environment_state": "scene",
    "background": "scene",
    "landscape": "scene",
    "vfx": "prop",
    "weapon_effect": "prop",
    "mechanical_effect": "prop",
    "item": "prop",
    "product": "prop",
    "dialogue": "audio",
    "voice": "audio",
    "mix": "audio",
}

COMMON_REQUIREMENTS = [
    "用自然语言写成可直接执行的 Prompt，不要只堆逗号关键词、权重语法或旧式正负 Prompt 对。",
    "按身份锚点、可见事件、空间地理、材质证据、光线因果、镜头执行、空气/效果、连续性与排除项组织输出。",
    "把不应变化的身份/结构写成可逐镜头复用的 identityAnchor，并把 May vary 与 shot-specific detail 分开。",
    "每个相关镜头都要给出一个明确、可见的动作节拍和至少一个动作或光线造成的物理后果。",
    "材质要写出表面、粗糙度、磨损/湿润状态以及光线、天气或接触如何落在表面上。",
    "镜头至少明确景别、机位/角度、焦段或视角、焦点和景深；只选择一种主光学效果及一种轻微辅助效果。",
    "参考图必须声明控制范围和不控制范围，禁止背景、道具或风格参考污染人物身份与场景结构。",
    "负向约束必须具体到身份漂移、数量错误、肢体/手指错误、接触/透视错误、文字水印和不合理融合等可检查问题。",
]

CHARACTER_REQUIREMENTS = [
    "characterDetails.faceAndExpression：脸型、下颌/颧面、眉眼、眼距或眼神、鼻型、嘴角走势、肤色、少量真实纹理和一个自然微表情。",
    "characterDetails.hairAndHeadSilhouette：颜色、长度、前侧后轮廓、发丝分离、发际线状态和受风/湿气/运动/重力的行为。",
    "characterDetails.bodyPoseAction：年龄印象、身形与比例、重心、肩颈、手部接触、动作节拍和动作质量。",
    "characterDetails.costumeAndMaterials：从头到脚的服装层次、接缝/扣件/织物/金属、配色、局部磨损和固定配件。",
    "characterDetails.detailAndMaterialBehavior：镜头可见的皮肤、发丝、服装或装备细节，以及动作/光线产生的可见变化。",
    "referenceStrategy：结构参考板、参考图角色和中性设计背景；同一角色所有视图的脸、发型、服装和比例必须一致。",
]

SCENE_REQUIREMENTS = [
    "sceneDetails.identityAndPurpose：地点、时间、世界设定边界和叙事功能。",
    "sceneDetails.spatialLayoutAndGeography：空间尺度、地面/天花板/地平线、入口、路径、台阶、消失方向和动作区。",
    "sceneDetails.foregroundMidgroundBackground：前景、中景、背景的代表性元素与受保护的负空间。",
    "sceneDetails.setDressingAndFixedAnchors：两到四个固定地标、陈设、数量、左右与远近关系。",
    "sceneDetails.materialsAndSurfaceState：地面、墙面、金属、玻璃、织物等表面材质、纹理、粗糙度、湿润/磨损和接触证据。",
    "sceneDetails.lightingWeatherAtmosphere：实际光源、光向、软硬、色温、阴影/反射后果，以及雨雾尘风的密度、方向和距离。",
    "sceneDetails.actionBlockingZones 与 propPlacementZones：可走、可站、可触碰、可放置和需要保持空白的区域。",
]

PROP_REQUIREMENTS = [
    "propDetails.objectIdentity：物体类别、功能、轮廓、比例、关键结构和不可替换的识别特征。",
    "propDetails.structureAndFunction：把手、接缝、铰链、按钮、开口、控制件等镜头可见的功能结构。",
    "propDetails.materialAndCondition：材质、表面、颜色/标记策略、磨损、湿润、破损、开启或通电状态。",
    "propDetails.scaleAndInteraction：与手、身体、桌面、地面或建筑的尺度关系、接触点、受力、遮挡和阴影。",
]

FUSION_REQUIREMENTS = [
    "分别锁定角色、道具和场景 identityAnchor，不让输入参考互相污染。",
    "按照角色-道具接触单元，再把单元放入场景的顺序写清握持/穿戴/放置、尺度链、落地接触、遮挡和压力。",
    "明确前景/中景/背景、场景地标、动作节拍、相机裁切、光线、接触阴影、投射阴影、环境光遮蔽和材质响应。",
    "注明该结果是 keyframe、first frame、last frame、multi-frame、interaction reference 还是弱规划参考。",
]

SHOT_REQUIREMENTS = [
    "shotPlan：只保留一个主事件，写清动作节拍、事件后果、景别、机位、焦点、景深和屏幕方向。",
    "分别引用角色、场景、道具的稳定 identityAnchor，并把本镜头可变细节和上一/下一镜头连续性分开。",
    "明确这一镜头中参考图、首帧/尾帧或关键帧的控制范围，不把参考图误当成生成授权。",
    "为动作、材质、天气和光线写出摄影机可见的物理后果，避免只写风格口号。",
]

AUDIO_REQUIREMENTS = [
    "audioDetails.sourceText：只放这一条实际要朗读的对白/旁白文本；不要放资产 ID、镜头说明、QA、合同或混音说明。",
    "audioDetails.textStatus：明确标记 missing / candidate / conflict / confirmed；没有 confirmed 时不得把候选台词当作最终生成文本。",
    "audioDetails.voiceIdentity 与 performanceDirection：用可听见的行为描述音色和表演，例如音域、投射距离、能量、气息、咬字、重音、句尾和停顿。",
    "audioDetails.language、dialect、emotion、pace、pausePlan、pronunciation：把语言、情绪、语速、停顿和发音风险分开记录；不要用‘电影感’等不可验证形容词替代它们。",
    "audioDetails.providerSettings：MiniMax Web 只需要文本框、音色、情绪、语速、音调和音量；provider、model、voiceId、镜头和 QA 只作为外部控制/交接元数据。",
    "声音资产不使用视觉资产的空间、材质、光线、摄影机或建议尺寸模板；环境声、对白干声和音效必须按分轨/混音约束记录。",
    "同一资产如果对应多个镜头，必须为每个镜头分别确认唯一文本；不能把不同镜头的对白拼成一段再生成。",
]

PROMPT_KEY_LABELS = {
    "foreground": "前景", "midground": "中景", "background": "背景", "shotId": "镜头", "shotPurpose": "镜头目的",
    "framing": "景别", "size": "景别", "camera": "机位", "focus": "焦点", "depthOfField": "景深", "depth": "景深",
    "action": "动作", "actionBeat": "动作节拍", "visibleEvent": "可见事件", "continuity": "连续性", "screenDirection": "屏幕方向",
    "faceAndExpression": "脸部与表情", "hairAndHeadSilhouette": "发型与头部轮廓", "costumeAndMaterials": "服装与材质",
    "detailAndMaterialBehavior": "细节与材质行为", "bodyPoseAction": "身体比例与动作", "visibleMoment": "可见瞬间",
    "identityAndPurpose": "地点与功能", "spatialLayoutAndGeography": "空间布局与地理", "foregroundMidgroundBackground": "前中后景",
    "setDressingAndFixedAnchors": "陈设与固定锚点", "materialsAndSurfaceState": "材质与表面状态", "detailEvidenceAndAtmosphere": "细节证据与空气",
    "lightingWeatherAtmosphere": "光线天气与空气", "actionBlockingZones": "动作阻挡区", "propPlacementZones": "道具预留区",
    "objectIdentity": "物体身份", "silhouetteAndProportions": "轮廓与比例", "structureAndFunction": "结构与功能",
    "materialAndCondition": "材质与状态", "colorMarkingsAndLabelPolicy": "颜色标记与文字策略", "scaleAndInteraction": "尺度与交互",
    "fusionModule": "融合模块", "shotUsage": "镜头用途", "seedanceReferenceRole": "Seedance 参考用途", "characterIdentityLock": "角色身份锁",
    "itemIdentityLock": "道具身份锁", "sceneIdentityLock": "场景身份锁", "interactionAndContact": "交互与接触", "placementScaleAndCamera": "位置尺度与摄影机",
    "lightingShadowsAndMaterialIntegration": "光影与材质整合", "compositionAndDepth": "构图与景深", "motionContinuityNotes": "运动连续性",
    "stableIdentityAnchors": "稳定身份锚点", "shotSpecificDetail": "本镜头细节", "optionalIncidentalDetail": "可选偶发细节", "mayVary": "允许变化",
    "role": "参考角色", "controls": "控制范围", "mustNotControl": "不控制范围", "referenceId": "参考 ID", "medium": "媒介", "style": "风格", "lighting": "光线",
    "audioDetails": "声音制作字段", "sourceText": "朗读文本", "textStatus": "文本状态", "voiceIdentity": "声音身份", "language": "语言", "dialect": "方言/口音",
    "performanceDirection": "表演方向", "emotion": "情绪", "intensity": "强度", "pace": "语速", "pausePlan": "停顿计划", "pronunciation": "发音标注",
    "provider": "Provider", "model": "模型", "voiceId": "音色 ID", "speed": "语速参数", "pitch": "音调参数", "volume": "音量参数", "languageBoost": "语言增强",
    "format": "格式", "targetDuration": "目标时长", "relevantShots": "关联镜头", "stems": "分轨", "distance": "投射距离", "breath": "气息",
}


def canonical_asset_class(asset_class: str | None) -> str:
    value = str(asset_class or "unknown").strip().lower()
    return PROMPT_CLASS_ALIASES.get(value, value)


def _value_at_path(value: Any, path: str) -> Any:
    current = value
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _has_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, set)):
        return any(_has_value(item) for item in value)
    if isinstance(value, dict):
        return any(_has_value(item) for item in value.values())
    return True


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return "；".join(item for item in (_text(item) for item in value) if item)
    if isinstance(value, dict):
        return "；".join(
            f"{key}：{render_prompt_value(item)}"
            for key, item in value.items()
            if _has_value(item)
        )
    return str(value).strip()


def _first(value: dict[str, Any], *paths: str, default: Any = None) -> Any:
    for path in paths:
        found = _value_at_path(value, path)
        if _has_value(found):
            return found
    return default


def _clean_list(value: Any) -> list[str]:
    if value is None:
        return []
    values = value if isinstance(value, list) else [value]
    result: list[str] = []
    for item in values:
        rendered = _text(item)
        if rendered and rendered not in result:
            result.append(rendered)
    return result


def _visible_prompt_constraints(value: Any, composition_mode: PromptCompositionMode) -> list[str]:
    """Keep structured constraints while hiding workbench-only metadata.

    Stable IDs and gate labels belong in the asset record and version history,
    not in the prose sent to an image model. In particular, an inherited
    ``mustPreserve`` item such as ``C001 原始资产 ID`` must not make a clean
    replacement fail its natural-language boundary check.
    """

    values = _clean_list(value)
    if composition_mode != "clean_replace":
        return values
    return [
        item for item in values
        if not any(marker in item for marker in PROMPT_INTERNAL_MARKERS)
    ]


def _copy_object(value: Any) -> dict[str, Any]:
    return deepcopy(value) if isinstance(value, dict) else {}


def _normalize_generation_reference_assets(value: Any) -> list[dict[str, Any]]:
    """Normalize image-agent reference assets into an explicit prompt field."""
    values = value if isinstance(value, list) else [value]
    result: list[dict[str, Any]] = []
    seen: set[str] = set()

    def visit(item: Any) -> None:
        if isinstance(item, list):
            for child in item:
                visit(child)
            return
        if isinstance(item, str):
            asset_id = item.strip()
            if asset_id and asset_id not in seen:
                seen.add(asset_id)
                result.append({"assetId": asset_id, "name": asset_id})
            return
        if not isinstance(item, dict):
            return
        asset_id = str(
            item.get("assetId")
            or item.get("asset_id")
            or item.get("referenceId")
            or item.get("reference_id")
            or item.get("logicalAssetId")
            or item.get("logical_asset_id")
            or item.get("id")
            or ""
        ).strip()
        if asset_id:
            if asset_id not in seen:
                seen.add(asset_id)
                entry = deepcopy(item)
                entry["assetId"] = asset_id
                entry.setdefault("name", item.get("label") or asset_id)
                result.append(entry)
            return
        for key in ("items", "roles", "references", "referenceRoles", "reference_roles", "generationReferenceAssets", "generation_reference_assets"):
            visit(item.get(key))

    visit(values)
    return result


def _merge_detail(raw: dict[str, Any], aliases: dict[str, tuple[str, ...]], root: dict[str, Any] | None = None) -> dict[str, Any]:
    result = _copy_object(raw)
    for canonical, paths in aliases.items():
        if _has_value(result.get(canonical)):
            continue
        value = _first({"root": raw}, *(f"root.{path}" for path in paths))
        if not _has_value(value) and isinstance(root, dict):
            value = _first({"root": root}, *(f"root.{path}" for path in paths))
        if _has_value(value):
            result[canonical] = deepcopy(value)
    return result


def _context_shots(context: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(context, dict):
        return []
    shots = context.get("shots") or context.get("relevant_shots") or []
    return [item for item in shots if isinstance(item, dict)]


def _shot_plan(value: Any, context: dict[str, Any] | None) -> list[dict[str, Any]]:
    if isinstance(value, list):
        result = [deepcopy(item) for item in value if isinstance(item, dict)]
    else:
        result = []
    if result:
        return result
    for shot in _context_shots(context):
        shot_id = shot.get("id") or shot.get("shotId") or shot.get("shot_id")
        if not shot_id:
            continue
        result.append({
            "shotId": str(shot_id),
            "shotPurpose": shot.get("purpose") or shot.get("shotPurpose") or "",
            "framing": shot.get("size") or shot.get("framing") or "",
            "camera": shot.get("camera") or "",
            "focus": shot.get("focus") or shot.get("scene") or "",
            "actionBeat": shot.get("action") or shot.get("actionBeat") or "",
            "screenDirection": shot.get("screenDirection") or "",
            "continuity": shot.get("continuity") or shot.get("lastFrame") or shot.get("firstFrame") or "",
        })
    return result


def _spoken_text(value: Any) -> str:
    """Read only an explicit spoken-text value, never a generic metadata object."""

    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("text", "content", "line", "spokenText", "spoken_text", "transcript"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
        return ""
    if isinstance(value, list):
        parts = [_spoken_text(item) for item in value]
        return "\n".join(item for item in parts if item)
    return ""


def _audio_first(source: dict[str, Any], raw_audio: dict[str, Any], *keys: str) -> Any:
    nested = _first({"audioDetails": raw_audio}, *(f"audioDetails.{key}" for key in keys))
    if _has_value(nested):
        return nested
    return _first(source, *keys)


def _audio_text_status(value: Any, source_text: str) -> str:
    if isinstance(value, bool):
        return "confirmed" if value and source_text else "candidate" if source_text else "missing"
    raw = str(value or "").strip().lower().replace("_", "-").replace(" ", "-")
    aliases = {
        "user-confirmed-text": "confirmed",
        "confirmed-text": "confirmed",
        "finalized": "final",
        "provisional": "candidate",
        "pending": "candidate",
        "user-confirmation-required": "candidate",
        "needs-confirmation": "candidate",
    }
    normalized = aliases.get(raw, raw)
    if normalized in AUDIO_CONFIRMED_TEXT_STATUSES:
        return "confirmed" if source_text else "missing"
    if normalized in {"candidate", "conflict", "missing"}:
        return normalized if normalized != "candidate" or source_text else "missing"
    return "candidate" if source_text else "missing"


def _looks_like_audio_metadata(value: str) -> bool:
    """Guard against treating a persisted FrameFlow contract as dialogue."""

    text = str(value or "").strip()
    if not text:
        return False
    markers = (
        "FRAMEFLOW",
        "Prompt Contract",
        "可直接执行的自然语言 Prompt",
        "资产身份/生产规格",
        "同时满足以下补充制作要求",
        "连续性检查",
        "必须保留",
        "必须避免",
        "生成说明",
        "执行边界",
        "不制作最终音频",
        "镜头依赖",
        "MiniMax Speech 2.8 Web：",
        "等待用户确认",
        "待用户确认",
        "当前台词为空",
    )
    return len(text) > 240 or any(marker in text for marker in markers)


def _normalize_audio_details(source: dict[str, Any], raw_audio: dict[str, Any], identity: str, *, enabled: bool) -> dict[str, Any]:
    if not enabled:
        return {}
    source_text = _spoken_text(_audio_first(
        source,
        raw_audio,
        "sourceText",
        "source_text",
        "spokenText",
        "spoken_text",
        "dialogueText",
        "dialogue_text",
        "line",
        "transcript",
        "text",
    ))
    provider_text = _spoken_text(_audio_first(source, raw_audio, "providerText", "provider_text", "providerInput", "provider_input")) or source_text
    status_value = _audio_first(source, raw_audio, "textStatus", "text_status", "dialogueStatus", "dialogue_status", "sourceTextStatus")
    details = deepcopy(raw_audio)
    details["schemaVersion"] = AUDIO_PROMPT_SCHEMA_VERSION
    details["operation"] = _text(_audio_first(source, raw_audio, "operation", "audioOperation", "audio_operation")) or "tts"
    details["sourceText"] = source_text
    details["providerText"] = provider_text
    details["textStatus"] = _audio_text_status(status_value, source_text)

    def set_if_missing(key: str, value: Any) -> None:
        if not _has_value(details.get(key)) and _has_value(value):
            details[key] = deepcopy(value)

    set_if_missing("voiceSource", _audio_first(source, raw_audio, "voiceSource", "voice_source", "sourceType", "source_type") or "system-preset")
    set_if_missing("voiceIdentity", _audio_first(source, raw_audio, "voiceIdentity", "voice_identity", "voiceProfile", "voice_profile", "voiceTraits", "voice_traits") or identity)
    set_if_missing("language", _audio_first(source, raw_audio, "language", "lang"))
    set_if_missing("locale", _audio_first(source, raw_audio, "locale", "languageLocale", "language_locale"))
    set_if_missing("dialect", _audio_first(source, raw_audio, "dialect", "accent"))
    set_if_missing("performanceDirection", _audio_first(source, raw_audio, "performanceDirection", "performance_direction", "voiceDirection", "voice_direction", "instructions", "delivery", "direction"))
    set_if_missing("emotion", _audio_first(source, raw_audio, "emotion", "mood"))
    set_if_missing("intensity", _audio_first(source, raw_audio, "intensity", "energy"))
    set_if_missing("pace", _audio_first(source, raw_audio, "pace", "register", "speechRate", "speech_rate"))
    set_if_missing("pausePlan", _audio_first(source, raw_audio, "pausePlan", "pause_plan", "pauses", "pause"))
    set_if_missing("pronunciation", _audio_first(source, raw_audio, "pronunciation", "pronunciationDict", "pronunciation_dict", "pronunciationNotes", "pronunciation_notes"))
    set_if_missing("soundTags", _audio_first(source, raw_audio, "soundTags", "sound_tags", "interjections", "nonVerbal", "non_verbal"))
    set_if_missing("distance", _audio_first(source, raw_audio, "distance", "projectionDistance", "projection_distance"))
    set_if_missing("targetDuration", _audio_first(source, raw_audio, "targetDuration", "target_duration", "duration"))
    set_if_missing("provider", _audio_first(source, raw_audio, "provider") or "minimax")
    set_if_missing("model", _audio_first(source, raw_audio, "model") or "speech-2.8-hd")
    set_if_missing("voiceId", _audio_first(source, raw_audio, "voiceId", "voice_id", "providerVoiceId", "provider_voice_id"))
    set_if_missing("providerVoiceId", _audio_first(source, raw_audio, "providerVoiceId", "provider_voice_id", "voiceId", "voice_id"))
    set_if_missing("providerVoiceName", _audio_first(source, raw_audio, "providerVoiceName", "provider_voice_name"))
    set_if_missing("providerRegion", _audio_first(source, raw_audio, "providerRegion", "provider_region", "region") or "cn")
    set_if_missing("speed", _audio_first(source, raw_audio, "speed") if _has_value(_audio_first(source, raw_audio, "speed")) else 1.0)
    set_if_missing("pitch", _audio_first(source, raw_audio, "pitch") if _has_value(_audio_first(source, raw_audio, "pitch")) else 0)
    set_if_missing("volume", _audio_first(source, raw_audio, "volume", "vol") if _has_value(_audio_first(source, raw_audio, "volume", "vol")) else 1.0)
    if not _has_value(details.get("languageBoost")):
        details["languageBoost"] = _audio_language_boost(details.get("locale"), details.get("language"), _audio_first(source, raw_audio, "languageBoost", "language_boost"))
    set_if_missing("format", _audio_first(source, raw_audio, "format", "audioFormat", "audio_format") or "wav")
    set_if_missing("sampleRate", _audio_first(source, raw_audio, "sampleRate", "sample_rate"))
    set_if_missing("bitrate", _audio_first(source, raw_audio, "bitrate"))
    set_if_missing("channel", _audio_first(source, raw_audio, "channel", "channels"))
    set_if_missing("stems", _audio_first(source, raw_audio, "stems", "tracks", "mixStems", "mix_stems"))
    return details


def normalize_prompt_pack(
    asset_class: str | None,
    prompt_pack: Any = None,
    *,
    identity_anchor: Any = None,
    must_preserve: Any = None,
    must_avoid: Any = None,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Normalize old, new, or partially authored packs to one stable shape."""

    cls = canonical_asset_class(asset_class)
    source = _copy_object(prompt_pack)
    raw_character = _copy_object(source.get("characterDetails"))
    raw_scene = _copy_object(source.get("sceneDetails"))
    raw_prop = _copy_object(source.get("propDetails") or source.get("itemDetails"))
    raw_fusion = _copy_object(source.get("fusionDetails"))

    character = _merge_detail(raw_character, {
        "faceAndExpression": ("faceAndExpression", "faceExpression", "face", "face_identity"),
        "hairAndHeadSilhouette": ("hairAndHeadSilhouette", "hairSilhouette", "hair", "headSilhouette"),
        "costumeAndMaterials": ("costumeAndMaterials", "wardrobeMaterial", "wardrobe", "costume", "materials"),
        "detailAndMaterialBehavior": ("detailAndMaterialBehavior", "characterDetail", "microExpressions", "materialBehavior"),
        "bodyPoseAction": ("bodyPoseAction", "bodyAndPosture", "poseAction", "body", "action"),
        "visibleMoment": ("visibleMoment", "visibleEvent", "event", "actionBeat"),
        "backgroundContext": ("backgroundContext", "sceneContext", "background"),
        "stableAnchors": ("stableAnchors", "identityAnchor", "identity"),
        "mayVary": ("mayVary", "variableDetails", "optionalDetails"),
    }, root=source if cls == "character" else None)
    scene = _merge_detail(raw_scene, {
        "identityAndPurpose": ("identityAndPurpose", "locationAndFunction", "location", "sceneIdentity"),
        "spatialLayoutAndGeography": ("spatialLayoutAndGeography", "geography", "layout", "spatialLayout"),
        "foregroundMidgroundBackground": ("foregroundMidgroundBackground", "foreground", "midground", "background", "depthLayers"),
        "setDressingAndFixedAnchors": ("setDressingAndFixedAnchors", "propsAndSetDressing", "props", "landmarks", "fixedAnchors"),
        "materialsAndSurfaceState": ("materialsAndSurfaceState", "surfacesAndMaterials", "surfaceMaterials", "materials", "surfaceState"),
        "detailEvidenceAndAtmosphere": ("detailEvidenceAndAtmosphere", "sceneDetailEvidence", "atmosphereBehavior"),
        "lightingWeatherAtmosphere": ("lightingWeatherAtmosphere", "lightingAndAtmosphere", "lightingAtmosphere", "lighting", "weather"),
        "actionBlockingZones": ("actionBlockingZones", "actionSpace", "blocking", "blockingMap"),
        "propPlacementZones": ("propPlacementZones", "propPlacement", "placementZones"),
        "continuityLocks": ("continuityLocks", "continuityAnchors", "continuity"),
        "stableAnchors": ("stableAnchors", "continuityAnchors", "landmarks"),
        "mayVary": ("mayVary", "variableDetails", "optionalDetails"),
    }, root=source if cls == "scene" else None)
    prop = _merge_detail(raw_prop, {
        "objectIdentity": ("objectIdentity", "identity", "identityAnchor", "category", "function"),
        "silhouetteAndProportions": ("silhouetteAndProportions", "silhouette", "proportions"),
        "structureAndFunction": ("structureAndFunction", "structure", "functionalDetails"),
        "materialAndCondition": ("materialAndCondition", "materials", "materialFinish", "condition", "state"),
        "detailAndMaterialBehavior": ("detailAndMaterialBehavior", "detailEvidence", "materialBehavior"),
        "colorMarkingsAndLabelPolicy": ("colorMarkingsAndLabelPolicy", "color", "markings", "labelPolicy"),
        "scaleAndInteraction": ("scaleAndInteraction", "scale", "interaction", "contact"),
        "mayVary": ("mayVary", "variableDetails", "optionalDetails"),
    }, root=source if cls == "prop" else None)
    fusion = _merge_detail(raw_fusion, {
        "fusionModule": ("fusionModule", "module"),
        "shotUsage": ("shotUsage", "usage", "shot_usage"),
        "seedanceReferenceRole": ("seedanceReferenceRole", "referenceRole", "seedance_role"),
        "styleAndLightingAuthority": ("styleAndLightingAuthority", "styleAuthority", "lightingAuthority"),
        "characterIdentityLock": ("characterIdentityLock", "characterLock"),
        "itemIdentityLock": ("itemIdentityLock", "propIdentityLock", "itemLock"),
        "sceneIdentityLock": ("sceneIdentityLock", "sceneLock"),
        "characterDetailAndMaterialBehavior": ("characterDetailAndMaterialBehavior", "characterDetail"),
        "sceneDetailAndAtmosphere": ("sceneDetailAndAtmosphere", "sceneDetail", "sceneDetailEvidence"),
        "interactionAndContact": ("interactionAndContact", "interaction", "contact"),
        "placementScaleAndCamera": ("placementScaleAndCamera", "placement", "scale", "camera"),
        "lightingShadowsAndMaterialIntegration": ("lightingShadowsAndMaterialIntegration", "lightingIntegration", "shadows", "materialIntegration"),
        "compositionAndDepth": ("compositionAndDepth", "composition", "depth", "occlusion"),
        "motionContinuityNotes": ("motionContinuityNotes", "motionContinuity", "continuity"),
    }, root=source if cls == "fusion" else None)

    identity = _text(identity_anchor) or _text(_first(source, "identityAnchor", "identityLock", "identity", "identity_anchors"))
    raw_audio = _copy_object(source.get("audioDetails") or source.get("audio_details"))
    audio = _normalize_audio_details(source, raw_audio, identity, enabled=cls == "audio" or bool(raw_audio))
    preserve = _clean_list(must_preserve) or _clean_list(_first(source, "mustPreserve", "preserve"))
    avoid = _clean_list(must_avoid) or _clean_list(_first(source, "mustAvoid", "negativePrompt", "avoid"))
    references = _copy_object(_first(source, "referenceStrategy", "reference_strategy"))
    reference_roles = _first(source, "referenceRoles", "referenceImageRoles", "reference_image_roles")
    if _has_value(reference_roles) and not _has_value(references.get("roles")):
        references["roles"] = deepcopy(reference_roles)
    context_references = context.get("references") if isinstance(context, dict) else None
    if _has_value(context_references) and not _has_value(references.get("roles")):
        references["roles"] = deepcopy(context_references)
    if not references:
        references = {"status": "no_reference_assets"}
    if not _has_value(references.get("preserve")) and _has_value(_first(source, "referencePreserve")):
        references["preserve"] = deepcopy(_first(source, "referencePreserve"))
    if not _has_value(references.get("change")) and _has_value(_first(source, "referenceChange", "allowedChanges")):
        references["change"] = deepcopy(_first(source, "referenceChange", "allowedChanges"))
    generation_reference_assets = _normalize_generation_reference_assets(
        _first(
            source,
            "generationReferenceAssets",
            "generation_reference_assets",
            "referenceAssetIds",
            "reference_asset_ids",
            "imageReferenceAssets",
            "image_reference_assets",
        )
        or references.get("roles")
        or references.get("references")
    )

    visual_style_source = _first(source, "visualStyle", "style")
    visual_style = _copy_object(visual_style_source)
    if not visual_style and _has_value(visual_style_source):
        visual_style = {"style": deepcopy(visual_style_source)}
    if not visual_style and _has_value(_first(source, "lighting", "renderingStyle")):
        visual_style = {"lighting": deepcopy(_first(source, "lighting")), "style": deepcopy(_first(source, "renderingStyle"))}
    continuity = _clean_list(_first(source, "continuityChecklist", "continuity", "continuityLocks"))
    detail_registry = _copy_object(_first(source, "detailAnchorRegistry", "detailAnchors", "anchorRegistry"))
    if identity and not _has_value(detail_registry.get("stableIdentityAnchors")):
        detail_registry["stableIdentityAnchors"] = identity
    if _has_value(_first(source, "shotSpecificDetail", "shot_specific_detail")):
        detail_registry.setdefault("shotSpecificDetail", deepcopy(_first(source, "shotSpecificDetail", "shot_specific_detail")))
    if _has_value(_first(source, "optionalDetails", "optionalDetail")):
        detail_registry.setdefault("optionalIncidentalDetail", deepcopy(_first(source, "optionalDetails", "optionalDetail")))
    if _has_value(_first(source, "mayVary", "variableDetails")):
        detail_registry.setdefault("mayVary", deepcopy(_first(source, "mayVary", "variableDetails")))

    visible_event = _first(source, "visibleEvent", "event", "actionBeat", "bodyAction")
    if not _has_value(visible_event):
        visible_event = _first(character, "visibleMoment", "bodyPoseAction") if cls == "character" else _first(scene, "detailEvidenceAndAtmosphere") if cls == "scene" else _first(prop, "materialAndCondition")

    result = deepcopy(source)
    result.update({
        "schemaVersion": PROMPT_CONTRACT_VERSION,
        "workflow": PROMPT_WORKFLOW_ID,
        "assetType": cls,
        "promptIntent": _text(_first(source, "promptIntent", "intent", "purpose", "generationGoal")),
        "identityAnchor": identity,
        "identityLock": _text(_first(source, "identityLock", "identityAnchor", "identity")) or identity,
        "visibleEvent": _text(visible_event),
        "spatialGeography": deepcopy(_first(source, "spatialGeography", "geography", "spatialLayout", "layout") or (scene.get("spatialLayoutAndGeography") if cls == "scene" else "")),
        "materialEvidence": deepcopy(_first(source, "materialEvidence", "materials", "surfaceMaterials") or (scene.get("materialsAndSurfaceState") if cls == "scene" else prop.get("materialAndCondition") if cls == "prop" else "")),
        "lightingCausality": deepcopy(_first(source, "lightingCausality", "lighting", "lightingAtmosphere") or (scene.get("lightingWeatherAtmosphere") if cls == "scene" else "")),
        "cameraExecution": deepcopy(_first(source, "cameraExecution", "camera", "compositionCamera") or {}),
        "atmosphereBehavior": deepcopy(_first(source, "atmosphereBehavior", "atmosphere", "weather") or (scene.get("detailEvidenceAndAtmosphere") if cls == "scene" else "")),
        "characterDetails": character,
        "sceneDetails": scene,
        "propDetails": prop,
        "itemDetails": prop,
        "fusionDetails": fusion,
        "audioDetails": audio,
        "shotPlan": _shot_plan(_first(source, "shotPlan", "shots", "shot_plan"), context),
        "visualStyle": visual_style,
        "referenceStrategy": references,
        "generationReferenceAssets": generation_reference_assets,
        "detailAnchorRegistry": detail_registry,
        "continuityChecklist": continuity,
        "mustPreserve": preserve,
        "mustAvoid": avoid,
        "negativePrompt": avoid,
        "generationNotes": _text(_first(source, "generationNotes", "notes", "generation_notes")),
        "suggestedSize": _text(_first(source, "suggestedSize", "size", "suggested_size")),
    })
    return result


def prompt_contract(asset_class: str | None = None) -> dict[str, Any]:
    """Return JSON-serialisable instructions for the prompt-writing model."""

    selected = canonical_asset_class(asset_class or "all")
    class_requirements: dict[str, list[str]] = {
        "character": CHARACTER_REQUIREMENTS,
        "scene": SCENE_REQUIREMENTS,
        "prop": PROP_REQUIREMENTS,
        "fusion": FUSION_REQUIREMENTS,
        "shot": SHOT_REQUIREMENTS,
        "audio": AUDIO_REQUIREMENTS,
    }
    selected_requirements = class_requirements if selected == "all" else {selected: class_requirements.get(selected, [])}
    return {
        "version": PROMPT_CONTRACT_VERSION,
        "workflow": PROMPT_WORKFLOW_ID,
        "asset_class": selected,
        "field_order": list(AUDIO_PROMPT_FIELD_ORDER if selected == "audio" else PROMPT_FIELD_ORDER),
        "common_requirements": list(COMMON_REQUIREMENTS),
        "class_requirements": selected_requirements,
        "qa_gate": [
            "specificity: 细节是否具体、可定位、可验证",
            "visibility: 当前景别是否能看见这些细节",
            "causality: 动作、材质、光线、天气是否产生可见后果",
            "priority: 身份、动作、空间是否早于装饰",
            "continuity: 稳定锚点是否重复而没有漂移",
            "reference_roles: 每个参考是否声明控制与不控制范围",
            "control: Must avoid 是否针对真实失败而不是泛化质量口号",
        ],
        "prompt_pack_shape": {
            "schemaVersion": PROMPT_CONTRACT_VERSION,
            "workflow": PROMPT_WORKFLOW_ID,
            "promptIntent": "一句话说明这张图/这个镜头要解决什么生产目标",
            "referenceStrategy": "每个 @Image/@Video/@Audio 的控制范围和禁止控制范围",
            "referenceRoles": "每个参考资产的显式角色、控制范围和不控制范围；无参考时为空数组",
            "generationReferenceAssets": "图片生成 Agent 必须提供的参考图资产 ID 清单；只表达参考图输入，不自动构成生产审核门禁",
            "identityAnchor": "一段可逐镜头原样复用的身份/结构锚点",
            "visibleEvent": "一个当前可见的主事件及其物理后果",
            "eventConsequence": "动作、接触、材质或光线造成的可见后果",
            "characterDetails": "角色资产填充；非角色资产可为空对象",
            "sceneDetails": "场景资产填充；非场景资产可为空对象",
            "propDetails": "道具/物体资产填充；非道具资产可为空对象",
            "fusionDetails": "融合资产填充；非融合资产可为空对象",
            "shotPlan": "每个 relevantShots 至少一个镜头动作/构图/连续性对象",
            "visualStyle": "媒介、调色、光线、景深和主/辅光学效果",
            "continuityChecklist": "可在 QA 时逐项检查的连续性条件",
            "mustPreserve": "稳定身份、空间、材质和方向锚点",
            "negativePrompt": "明确且可检查的排除项",
            "generationNotes": "背景边界、尺寸和生成注意事项",
            "suggestedSize": "建议输出尺寸或画幅",
            "audioDetails": {
                "schemaVersion": AUDIO_PROMPT_SCHEMA_VERSION,
                "sourceText": "用户确认的原始台词，不含控制标签、资产/镜头/QA/合同说明",
                "providerText": "实际发送给 MiniMax 的文本，可含合法停顿或 Speech 2.8 语气标签",
                "textStatus": "missing | candidate | conflict | confirmed",
                "voiceSource": "system-preset（默认）| design | clone",
                "locale": "BCP-47 语言地区，例如 ja-JP",
                "voiceIdentity": "声音身份与可听见的表演行为",
                "performanceDirection": "情绪、能量、投射距离、咬字、重音、句尾和呼吸",
                "pausePlan": "可转换为 MiniMax <#x#> 停顿标记的停顿计划",
                "pronunciation": "中文多音字、专名、数字和发音覆写",
                "providerSettings": "MiniMax Web/API 的模型、音色、区域、情绪、速度、音调、音量等设置",
                "frameflowMetadata": "镜头、分轨、QA、授权和交接信息，只留在工作台",
            },
        },
    }


def prompt_contract_instructions(*, fusion: bool = False) -> str:
    """Return the shared SUYU Skill v2 instructions appended to providers."""

    character_sheet_rule = (
        "角色首轮默认只规划一张结构参考板：同一张合成图包含面部/上半身身份特写，以及同一角色的正面、侧面、背面全身结构视图；"
        "使用白色、米白或中性浅灰背景，稳定光线，无动作姿态，不把生活场景当作 DES 角色资产。"
        if not fusion else
        "融合阶段不重新生成角色设定板；直接复用已连接角色的 identityAnchor、服装、材质、装备和比例。"
    )
    return (
        f"本次使用 FRAMEFLOW Prompt Contract v{PROMPT_CONTRACT_VERSION} / {PROMPT_WORKFLOW_ID}。"
        "所有视觉 Prompt 必须使用自然语言，不使用 tag stack、权重语法、数字优先级或旧式正负 Prompt 对。"
        "请严格按‘身份锚点 → 可见事件 → 空间地理 → 材质证据 → 光线因果 → 镜头执行 → 空气与克制效果 → 连续性与排除项’组织。"
        "每个重要细节都要回答：它是什么、位于哪里、什么状态或行为让摄影机看见它。"
        "每张输出同时提供 promptPack 与 copy-ready natural-language prompt；字段是规划控制，最终 prompt 必须是有因果关系的连贯 prose，不能只是字段名列表。"
        "promptPack 至少包含 schemaVersion、workflow、promptIntent、referenceStrategy、identityAnchor、visibleEvent、characterDetails、"
        "sceneDetails、propDetails、fusionDetails、shotPlan、visualStyle、continuityChecklist、mustPreserve、mustAvoid、generationNotes 和 suggestedSize；"
        "非适用类别的对象填空对象，但不能省略稳定合同字段。"
        "角色必须具体写脸型/下颌/眉眼/眼神/少量真实纹理或轻微不对称、发型前侧后轮廓与运动规则、身体比例/重心/手部、从头到脚服装层次和材质、"
        "静态表情与镜头可见的微表情；不要用‘漂亮、真实、有气质’代替身份控制。"
        + character_sheet_rule +
        "场景必须写地点功能、尺度与地理、前中后景、两到四个固定地标、陈设与负空间、表面状态、实际光源及其阴影/反射后果、"
        "雨雾尘风等空气行为、动作/阻挡区和道具预留区；场景阶段不直接融合角色或道具。"
        "道具必须写对象类别、轮廓比例、功能结构、材质与状态、颜色/标记策略、尺度参照和接触/交互；A 级道具需要走 video-prop-design-director。"
        "融合必须分别保留角色、道具和场景的 identityAnchor，先建立角色-道具接触单元，再放入场景，明确尺度链、接触压力、遮挡、落地、阴影、环境光遮蔽和材质响应。"
        "每个镜头只选一个主事件；光学效果最多一个主效果加一个克制辅助效果，不能遮挡脸、手、建筑、道具接触或主动作。"
        "参考图必须声明角色：例如某张图只控制脸部身份，另一张只控制服装材质或场景布局；禁止背景、道具和风格参考污染无关区域。"
        "稳定锚点、shot-specific detail、May vary 和 optional/incidental detail 必须分开；未知事实标记为 optional，不得擅自发明连续性事实。"
        "Prompt QA 通过不等于生成授权；所有新版本都保持 user-confirmation-required，生成前仍要由用户选择 Codex imagegen、外部 ChatGPT 或暂不生成。"
        "你不生成图片，不调用图片服务，不宣称 Prompt QA 或图片 QA 已通过。"
        "如果 assetClass 是 audio，必须切换到 MiniMax Speech Web 的声音格式：不要输出视觉 Prompt，不要填写空间/材质/光线/摄影机/建议尺寸来代替声音字段。"
        "audioDetails 必须明确 sourceText、providerText、textStatus、voiceSource、voiceIdentity、language、locale、dialect、performanceDirection、emotion、intensity、pace、pausePlan、pronunciation、"
        "provider、model、voiceId、providerVoiceId、providerRegion、speed、pitch、volume、languageBoost、targetDuration、relevantShots、continuityChecklist、mustPreserve 和 mustAvoid。"
        "prompt 字段只允许放实际朗读文本；若台词是 candidate、conflict 或 missing，prompt 不得伪装成可执行文本，必须在 audioDetails 中保留候选与阻塞原因。"
        "MiniMax Web 文本框不应接收资产 ID、合同版本、QA、授权、环境声或混音说明；这些内容只能作为工作台元数据和复制包中的‘不要粘贴’部分。"
    )


def render_prompt_value(value: Any) -> str:
    """Render a structured value into compact prose without JSON syntax."""

    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return "、".join(item for item in (render_prompt_value(item) for item in value) if item)
    if isinstance(value, dict):
        parts: list[str] = []
        for key, item in value.items():
            rendered = render_prompt_value(item)
            if rendered:
                label = PROMPT_KEY_LABELS.get(str(key), str(key))
                parts.append(f"{label}为{rendered}")
        return "；".join(parts)
    return str(value).strip()


def _sentence(value: Any, prefix: str = "") -> str:
    rendered = render_prompt_value(value)
    if not rendered:
        return ""
    if prefix and not rendered.startswith(prefix):
        rendered = prefix + rendered
    return rendered.rstrip("。；") + "。"


def _unique_texts(values: list[Any]) -> list[str]:
    result: list[str] = []
    for value in values:
        rendered = _text(value)
        if rendered and rendered not in result:
            result.append(rendered)
    return result


def _reference_prose(strategy: dict[str, Any]) -> str:
    roles = strategy.get("roles") or strategy.get("references") or []
    rendered = render_prompt_value(roles)
    if not rendered:
        return ""
    return _sentence(rendered, "参考图角色保持明确：")


def _shot_prose(plan: list[dict[str, Any]]) -> tuple[str, str, str]:
    event: list[str] = []
    camera: list[str] = []
    continuity: list[str] = []
    for shot in plan:
        shot_id = shot.get("shotId") or shot.get("shot_id") or shot.get("id")
        tag = f"镜头 {shot_id} " if shot_id else "镜头 "
        action = render_prompt_value(shot.get("actionBeat") or shot.get("action") or shot.get("visibleEvent"))
        if action:
            event.append(f"{tag}可见动作是{action}")
        camera_value = render_prompt_value({
            "景别": shot.get("framing") or shot.get("size"),
            "机位": shot.get("camera"),
            "焦点": shot.get("focus"),
            "景深": shot.get("depthOfField") or shot.get("depth"),
        })
        if camera_value:
            camera.append(f"{tag}{camera_value}")
        continuity_value = render_prompt_value(shot.get("continuity") or shot.get("continuityCheckpoint") or shot.get("screenDirection"))
        if continuity_value:
            continuity.append(f"{tag}连续性检查为{continuity_value}")
    return "；".join(event), "；".join(camera), "；".join(continuity)


def _structured_content(pack: dict[str, Any]) -> bool:
    ignored = {"schemaVersion", "workflow", "assetType", "promptQuality"}
    for key, value in pack.items():
        if key in ignored:
            continue
        # Normalization always emits this sentinel for assets without
        # references. It is metadata, not prompt content, and must not turn a
        # legacy plain Prompt into a new paragraph merely because it was
        # passed through the compiler.
        if key == "referenceStrategy" and value == {"status": "no_reference_assets"}:
            continue
        if _has_value(value):
            return True
    return False


def prompt_pack_has_generation_fields(asset_class: str | None, prompt_pack: Any) -> bool:
    """Return whether a pack contains enough authored content for a replacement.

    A provider can satisfy the JSON schema with empty strings and empty objects.
    That is structurally valid JSON but it is not a usable full rewrite. This
    check intentionally looks for the semantic fields that make a prompt a
    complete image-generation brief instead of silently falling back to the
    previous natural-language prompt.
    """

    cls = canonical_asset_class(asset_class)
    pack = normalize_prompt_pack(cls, prompt_pack)
    common = [
        pack.get("promptIntent"),
        pack.get("visibleEvent"),
        pack.get("cameraExecution"),
        pack.get("visualStyle"),
        pack.get("continuityChecklist"),
        pack.get("mustAvoid"),
    ]
    class_fields: dict[str, tuple[str, ...]] = {
        "character": (
            "faceAndExpression",
            "hairAndHeadSilhouette",
            "costumeAndMaterials",
            "bodyPoseAction",
        ),
        "scene": (
            "identityAndPurpose",
            "spatialLayoutAndGeography",
            "foregroundMidgroundBackground",
            "materialsAndSurfaceState",
            "lightingWeatherAtmosphere",
        ),
        "prop": (
            "objectIdentity",
            "silhouetteAndProportions",
            "structureAndFunction",
            "materialAndCondition",
            "scaleAndInteraction",
        ),
        "fusion": (
            "characterIdentityLock",
            "itemIdentityLock",
            "sceneIdentityLock",
            "interactionAndContact",
            "placementScaleAndCamera",
        ),
    }
    detail_group = pack.get({
        "character": "characterDetails",
        "scene": "sceneDetails",
        "prop": "propDetails",
        "fusion": "fusionDetails",
    }.get(cls, ""), {})
    detail_values = [detail_group.get(key) for key in class_fields.get(cls, ())] if isinstance(detail_group, dict) else []
    authored_common = sum(1 for value in common if _has_value(value))
    authored_details = sum(1 for value in detail_values if _has_value(value))
    # Keep the threshold deliberately small: the provider's structured output
    # still owns the final detail density, while this prevents an empty pack
    # from being mistaken for a complete replacement.
    return authored_common >= 3 and authored_details >= 2


def validate_clean_prompt(prompt: str, previous_prompt: str = "") -> list[str]:
    """Validate the user-facing natural-language prompt boundary."""

    text = str(prompt or "").strip()
    issues: list[str] = []
    for marker in PROMPT_INTERNAL_MARKERS:
        if marker in text:
            issues.append(f"clean Prompt 不得包含内部标记：{marker}")
    if PROMPT_SUPPLEMENT_MARKER in text:
        issues.append("clean Prompt 不得追加补充制作段落")
    paragraphs = [re.sub(r"\s+", "", item) for item in re.split(r"\n\s*\n", text) if item.strip()]
    seen: set[str] = set()
    for paragraph in paragraphs:
        if len(paragraph) >= 32 and paragraph in seen:
            issues.append("clean Prompt 包含重复段落")
            break
        seen.add(paragraph)

    # A character structure sheet cannot be both a static neutral board and a
    # shot-action brief. Treat positive action wording as a conflict only when
    # it is not immediately negated by the surrounding Chinese constraint.
    def positive_phrase(phrase: str) -> bool:
        for match in re.finditer(re.escape(phrase), text):
            prefix = text[max(0, match.start() - 4):match.start()]
            if not re.search(r"(?:不|无|禁止|避免|不得|不要|未|没有)[^。；，,]{0,4}$", prefix):
                return True
        return False

    if "结构参考板" in text and any(
        positive_phrase(phrase)
        for phrase in ("触碰机甲", "接触机甲", "抬眼", "嘴角上扬", "出击", "说‘走吧", "说\"走吧")
    ):
        issues.append("clean Prompt 同时包含静态结构参考板和镜头级机甲动作")
    normalized_new = re.sub(r"\s+", "", text)
    normalized_previous = re.sub(r"\s+", "", str(previous_prompt or "").strip())
    if len(normalized_previous) >= 160 and normalized_new.startswith(normalized_previous):
        issues.append("clean Prompt 仍以旧 Prompt 全文开头，未形成完整替换稿")
    if len(text) > 6000:
        issues.append("clean Prompt 超过 6000 个字符，请删除重复合同和泛化说明")
    return list(dict.fromkeys(issues))


def _audio_context_candidates(context: dict[str, Any] | None) -> list[dict[str, str]]:
    candidates: list[dict[str, str]] = []
    for shot in _context_shots(context):
        shot_id = str(shot.get("id") or shot.get("shotId") or shot.get("shot_id") or "").strip()
        raw_dialogue = _first(shot, "dialogue", "dialogues", "narration", "voiceover", "voice_over", "line", "lines")
        spoken = _spoken_text(raw_dialogue)
        if not spoken:
            continue
        kind = "旁白" if _has_value(_first(shot, "narration", "voiceover", "voice_over")) else "对白"
        candidates.append({"shotId": shot_id, "kind": kind, "text": spoken})
    return candidates


def build_audio_prompt_package(
    prompt_pack: Any,
    fallback_prompt: str = "",
    *,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a MiniMax Speech Web copy package without mixing in production metadata."""

    pack = normalize_prompt_pack("audio", prompt_pack, context=context)
    details = pack.get("audioDetails") if isinstance(pack.get("audioDetails"), dict) else {}
    source_text = _spoken_text(details.get("sourceText"))
    provider_text = _spoken_text(details.get("providerText")) or source_text
    fallback = str(fallback_prompt or "").strip()
    if not source_text and fallback and not _looks_like_audio_metadata(fallback):
        source_text = fallback
        provider_text = fallback
        text_status = "candidate"
    else:
        text_status = _audio_text_status(details.get("textStatus"), source_text)

    candidates = _audio_context_candidates(context)
    unique_candidate_texts: list[str] = []
    for candidate in candidates:
        text = candidate["text"]
        if text not in unique_candidate_texts:
            unique_candidate_texts.append(text)
    context_shot_ids = [str(shot.get("id") or shot.get("shotId") or shot.get("shot_id") or "").strip() for shot in _context_shots(context)]
    context_shot_ids = [shot_id for shot_id in context_shot_ids if shot_id]
    direction_parts = [
        _text(details.get("voiceIdentity")),
        _text(details.get("language")),
        _text(details.get("dialect")),
        _text(details.get("performanceDirection")),
        f"情绪为{_text(details.get('emotion'))}" if _has_value(details.get("emotion")) else "",
        f"强度为{_text(details.get('intensity'))}" if _has_value(details.get("intensity")) else "",
        f"语速为{_text(details.get('pace'))}" if _has_value(details.get("pace")) else "",
        f"投射距离为{_text(details.get('distance'))}" if _has_value(details.get("distance")) else "",
    ]
    direction = "；".join(item for item in direction_parts if item)
    settings = {
        "provider": _text(details.get("provider")) or "minimax",
        "model": _text(details.get("model")) or "speech-2.8-hd",
        "voiceId": _text(details.get("providerVoiceId")) or _text(details.get("voiceId")) or "在 MiniMax Web 中选择固定系统音色",
        "voiceName": _text(details.get("providerVoiceName")) or "以实际试听结果为准",
        "region": _text(details.get("providerRegion")) or "cn",
        "languageBoost": _text(details.get("languageBoost")) or "自动识别（未发送固定语言增强）",
        "emotion": _text(details.get("emotion")) or "留空（先建立基础音色基线）",
        "speed": _text(details.get("speed")) or "1.0",
        "pitch": _text(details.get("pitch")) or "0",
        "volume": _text(details.get("volume")) or "1.0",
        "format": _text(details.get("format")) or "按 Web 下载选项；工作台归档默认 wav",
    }
    warnings: list[str] = []
    if text_status != "confirmed":
        warnings.append("朗读文本尚未标记为 confirmed；请先确认每个镜头的唯一台词，再复制到 MiniMax Web。")
    if len(unique_candidate_texts) > 1:
        warnings.append("关联镜头存在多条不同文本；必须拆成多次生成，不能拼成一段。")
    if len(context_shot_ids) > len(candidates) and candidates:
        warnings.append("部分关联镜头没有明确朗读文本；请逐镜头确认台词或明确该镜头无对白。")
    if text_status == "conflict":
        warnings.append("当前文本存在镜头/台词冲突，暂不提供可复制的朗读文本。")
    return {
        "schemaVersion": AUDIO_PROMPT_SCHEMA_VERSION,
        "provider": "minimax",
        "operation": _text(details.get("operation")) or "tts",
        "sourceText": source_text,
        "providerText": provider_text,
        "copyText": provider_text if provider_text and text_status in AUDIO_CONFIRMED_TEXT_STATUSES else "",
        "candidateText": provider_text if provider_text and text_status not in AUDIO_CONFIRMED_TEXT_STATUSES else "",
        "textStatus": text_status,
        "direction": direction,
        "settings": settings,
        "pausePlan": deepcopy(details.get("pausePlan")) if _has_value(details.get("pausePlan")) else [],
        "pronunciation": deepcopy(details.get("pronunciation")) if _has_value(details.get("pronunciation")) else {},
        "soundTags": deepcopy(details.get("soundTags")) if _has_value(details.get("soundTags")) else [],
        "targetDuration": details.get("targetDuration"),
        "relevantShots": deepcopy(details.get("relevantShots")) if _has_value(details.get("relevantShots")) else context_shot_ids,
        "candidates": candidates,
        "continuity": _clean_list(pack.get("continuityChecklist")),
        "mustPreserve": _clean_list(pack.get("mustPreserve")),
        "mustAvoid": _clean_list(pack.get("mustAvoid")),
        "warnings": warnings,
    }


def _build_audio_prompt_text(prompt_pack: dict[str, Any], fallback_prompt: str = "", *, context: dict[str, Any] | None = None) -> str:
    package = build_audio_prompt_package(prompt_pack, fallback_prompt, context=context)
    if package.get("copyText"):
        return str(package["copyText"])
    candidate = str(package.get("candidateText") or "").strip()
    if candidate:
        return f"MiniMax Speech 2.8 Web：候选朗读文本待用户确认：{candidate}"
    return "MiniMax Speech 2.8 Web：尚未确认唯一朗读文本，暂不生成。"


def _build_clean_visual_prompt(
    asset_class: str,
    pack: dict[str, Any],
    fallback_prompt: str = "",
    *,
    context: dict[str, Any] | None = None,
) -> str:
    """Compile a replacement prompt in the model-facing order.

    The legacy compiler mirrors the historical SUYU field order. A new
    replacement has a stricter image-model-facing order so an operator's
    revision is rewritten into one coherent brief instead of being appended
    to the previous prose.
    """

    del context  # The normalized pack already contains the relevant context.
    fallback = str(fallback_prompt or "").strip()
    if not _structured_content(pack):
        return fallback

    plan = pack.get("shotPlan") if isinstance(pack.get("shotPlan"), list) else []
    shot_event, shot_camera, shot_continuity = _shot_prose(plan)
    paragraphs: list[str] = []

    def add(value: Any, prefix: str = "") -> None:
        sentence = _sentence(value, prefix)
        if sentence:
            paragraphs.append(sentence)

    # 1. Production goal.
    add(pack.get("promptIntent"), "这张图/这个镜头的生产目标是：")

    # 2. Subject and stable identity.
    reference = _reference_prose(pack.get("referenceStrategy") or {})
    if reference:
        paragraphs.append(reference)
    reference_assets = _normalize_generation_reference_assets(pack.get("generationReferenceAssets"))
    reference_asset_ids = list(dict.fromkeys(
        str(item.get("assetId") or item.get("asset_id") or "").strip()
        for item in reference_assets
        if str(item.get("assetId") or item.get("asset_id") or "").strip()
    ))
    if reference_asset_ids:
        add("、".join(reference_asset_ids), "生成时使用这些参考图资产：")

    identity_parts: list[Any] = [_text(pack.get("identityAnchor")), _text(pack.get("identityLock"))]
    if asset_class == "character":
        identity_parts.append(_text(pack.get("characterDetails", {}).get("identityAndPurpose")))
    elif asset_class == "scene":
        identity_parts.append(_text(pack.get("sceneDetails", {}).get("identityAndPurpose")))
    elif asset_class == "prop":
        identity_parts.append(_text(pack.get("propDetails", {}).get("objectIdentity")))
    elif asset_class == "fusion":
        identity_parts.extend([
            _text(pack.get("fusionDetails", {}).get("characterIdentityLock")),
            _text(pack.get("fusionDetails", {}).get("itemIdentityLock")),
            _text(pack.get("fusionDetails", {}).get("sceneIdentityLock")),
        ])
    identity_text = "；".join(_unique_texts(identity_parts))
    if identity_text:
        add(identity_text, "主体与稳定身份保持不变：")
    preserve = _visible_prompt_constraints(pack.get("mustPreserve"), "clean_replace")
    if preserve:
        add("、".join(preserve), "稳定约束必须保留：")

    # 3. Appearance, costume, and material evidence. Keep each authored
    # attribute in one section rather than repeating costume text later.
    appearance_parts: list[Any] = []
    material_parts: list[Any] = [_text(pack.get("materialEvidence"))]
    if asset_class == "character":
        details = pack.get("characterDetails") if isinstance(pack.get("characterDetails"), dict) else {}
        appearance_parts.extend([
            _text(details.get("faceAndExpression")),
            _text(details.get("hairAndHeadSilhouette")),
            _text(details.get("bodyPoseAction")),
        ])
        material_parts.extend([
            _text(details.get("costumeAndMaterials")),
            _text(details.get("detailAndMaterialBehavior")),
        ])
    elif asset_class == "scene":
        details = pack.get("sceneDetails") if isinstance(pack.get("sceneDetails"), dict) else {}
        appearance_parts.extend([
            _text(details.get("foregroundMidgroundBackground")),
            _text(details.get("setDressingAndFixedAnchors")),
        ])
        material_parts.extend([
            _text(details.get("materialsAndSurfaceState")),
            _text(details.get("detailEvidenceAndAtmosphere")),
        ])
    elif asset_class == "prop":
        details = pack.get("propDetails") if isinstance(pack.get("propDetails"), dict) else {}
        appearance_parts.extend([
            _text(details.get("silhouetteAndProportions")),
            _text(details.get("structureAndFunction")),
        ])
        material_parts.extend([
            _text(details.get("materialAndCondition")),
            _text(details.get("detailAndMaterialBehavior")),
        ])
    elif asset_class == "fusion":
        details = pack.get("fusionDetails") if isinstance(pack.get("fusionDetails"), dict) else {}
        appearance_parts.extend([
            _text(details.get("interactionAndContact")),
            _text(details.get("placementScaleAndCamera")),
        ])
        material_parts.extend([
            _text(details.get("lightingShadowsAndMaterialIntegration")),
            _text(details.get("characterDetailAndMaterialBehavior")),
            _text(details.get("sceneDetailAndAtmosphere")),
        ])
    appearance_text = "；".join(_unique_texts(appearance_parts))
    if appearance_text:
        add(appearance_text, "外貌、结构与姿态为：")
    material_text = "；".join(_unique_texts(material_parts))
    if material_text:
        add(material_text, "服装、材质与可见表面证据为：")

    # 4. One visible event or static state.
    event_parts = [_text(pack.get("visibleEvent")), _text(pack.get("eventConsequence"))]
    if not _has_value(event_parts):
        event_parts.append(shot_event)
    if asset_class == "character":
        event_parts.append(_text(pack.get("characterDetails", {}).get("visibleMoment")))
    if asset_class == "fusion":
        event_parts.append(_text(pack.get("fusionDetails", {}).get("interactionAndContact")))
    event = "；".join(_unique_texts(event_parts))
    if event:
        add(event, "当前画面只发生一个主事件或静态状态：")

    # 5. Spatial composition and camera execution.
    spatial_parts = [_text(pack.get("spatialGeography"))]
    if asset_class == "scene":
        details = pack.get("sceneDetails") if isinstance(pack.get("sceneDetails"), dict) else {}
        spatial_parts.extend([
            _text(details.get("spatialLayoutAndGeography")),
            _text(details.get("actionBlockingZones")),
            _text(details.get("propPlacementZones")),
        ])
    elif asset_class == "character":
        spatial_parts.append(_text(pack.get("characterDetails", {}).get("backgroundContext")))
    elif asset_class == "fusion":
        details = pack.get("fusionDetails") if isinstance(pack.get("fusionDetails"), dict) else {}
        spatial_parts.append(_text(details.get("compositionAndDepth")))
    spatial_text = "；".join(_unique_texts(spatial_parts))
    camera = _text(pack.get("cameraExecution")) or shot_camera
    composition_text = "；".join(item for item in (spatial_text, camera) if item)
    if composition_text:
        add(composition_text, "构图、空间关系与摄影机执行为：")

    # 6. Lighting, background, and rendering.
    lighting = _text(pack.get("lightingCausality"))
    if asset_class == "scene":
        lighting = lighting or _text(pack.get("sceneDetails", {}).get("lightingWeatherAtmosphere"))
    if asset_class == "fusion":
        lighting = lighting or _text(pack.get("fusionDetails", {}).get("styleAndLightingAuthority"))
    style = _text(pack.get("visualStyle"))
    atmosphere = _text(pack.get("atmosphereBehavior"))
    light_text = "；".join(item for item in (lighting, style, atmosphere) if item)
    if light_text:
        add(light_text, "光线、背景与渲染必须让上述证据清楚可见：")

    # 7. Continuity.
    continuity = _clean_list(pack.get("continuityChecklist"))
    if shot_continuity:
        continuity.append(shot_continuity)
    detail_registry = pack.get("detailAnchorRegistry") if isinstance(pack.get("detailAnchorRegistry"), dict) else {}
    if _has_value(detail_registry.get("mayVary")):
        continuity.append(f"允许变化：{render_prompt_value(detail_registry['mayVary'])}")
    if continuity:
        add("；".join(dict.fromkeys(continuity)), "连续性检查：")

    # 8. Must avoid. Keep metadata-only constraints in the structured pack.
    avoid = _visible_prompt_constraints(pack.get("mustAvoid") or pack.get("negativePrompt"), "clean_replace")
    if avoid:
        add("、".join(avoid), "必须避免：")

    compiled = "\n\n".join(item for item in paragraphs if item).strip()
    return compiled or fallback


def build_natural_language_prompt(
    asset_class: str | None,
    prompt_pack: Any,
    fallback_prompt: str = "",
    *,
    context: dict[str, Any] | None = None,
    composition_mode: PromptCompositionMode = "legacy_supplement",
) -> str:
    """Compile a normalized pack into a copy-ready, action-centred prompt."""

    cls = canonical_asset_class(asset_class)
    pack = normalize_prompt_pack(cls, prompt_pack, context=context)
    fallback = str(fallback_prompt or "").strip()
    if not _structured_content(pack):
        return fallback
    if cls == "audio":
        return _build_audio_prompt_text(pack, fallback, context=context)
    if composition_mode == "clean_replace":
        if not prompt_pack_has_generation_fields(cls, pack):
            return fallback
        return _build_clean_visual_prompt(cls, pack, fallback, context=context)

    plan = pack.get("shotPlan") if isinstance(pack.get("shotPlan"), list) else []
    shot_event, shot_camera, shot_continuity = _shot_prose(plan)
    paragraphs: list[str] = []
    intent = _text(pack.get("promptIntent"))
    if intent:
        paragraphs.append(_sentence(intent, "这张图/这个镜头的生产目标是："))
    reference = _reference_prose(pack.get("referenceStrategy") or {})
    if reference:
        paragraphs.append(reference)
    reference_assets = _normalize_generation_reference_assets(pack.get("generationReferenceAssets"))
    reference_asset_ids = [str(item.get("assetId") or item.get("asset_id") or "").strip() for item in reference_assets]
    reference_asset_ids = list(dict.fromkeys(item for item in reference_asset_ids if item))
    if reference_asset_ids:
        paragraphs.append(_sentence("、".join(reference_asset_ids), "图片生成时需要提供的参考图资产："))

    identity_parts: list[Any] = [_text(pack.get("identityAnchor")), _text(pack.get("identityLock"))]
    if cls == "character":
        identity_parts.extend([
            _text(pack.get("characterDetails", {}).get("faceAndExpression")),
            _text(pack.get("characterDetails", {}).get("hairAndHeadSilhouette")),
            _text(pack.get("characterDetails", {}).get("costumeAndMaterials")),
            _text(pack.get("characterDetails", {}).get("bodyPoseAction")),
        ])
    elif cls == "scene":
        identity_parts.extend([
            _text(pack.get("sceneDetails", {}).get("identityAndPurpose")),
            _text(pack.get("sceneDetails", {}).get("setDressingAndFixedAnchors")),
        ])
    elif cls == "prop":
        identity_parts.extend([
            _text(pack.get("propDetails", {}).get("objectIdentity")),
            _text(pack.get("propDetails", {}).get("silhouetteAndProportions")),
            _text(pack.get("propDetails", {}).get("structureAndFunction")),
        ])
    elif cls == "fusion":
        identity_parts.extend([
            _text(pack.get("fusionDetails", {}).get("characterIdentityLock")),
            _text(pack.get("fusionDetails", {}).get("itemIdentityLock")),
            _text(pack.get("fusionDetails", {}).get("sceneIdentityLock")),
        ])
    identity_text = "；".join(_unique_texts(identity_parts))
    if identity_text:
        paragraphs.append(_sentence(identity_text, "保持以下身份与结构锚点不变："))

    event_parts = [_text(pack.get("visibleEvent")), _text(pack.get("eventConsequence"))]
    if not _has_value(event_parts):
        event_parts.append(shot_event)
    if cls == "character":
        event_parts.append(_text(pack.get("characterDetails", {}).get("visibleMoment")))
    if cls == "fusion":
        event_parts.append(_text(pack.get("fusionDetails", {}).get("interactionAndContact")))
    event = "；".join(_unique_texts(event_parts))
    if event:
        paragraphs.append(_sentence(event, "此刻画面中只发生一个主事件："))

    spatial_parts = [_text(pack.get("spatialGeography"))]
    if cls == "scene":
        spatial_parts.extend([
            _text(pack.get("sceneDetails", {}).get("spatialLayoutAndGeography")),
            _text(pack.get("sceneDetails", {}).get("foregroundMidgroundBackground")),
            _text(pack.get("sceneDetails", {}).get("actionBlockingZones")),
            _text(pack.get("sceneDetails", {}).get("propPlacementZones")),
        ])
    elif cls == "character":
        spatial_parts.append(_text(pack.get("characterDetails", {}).get("backgroundContext")))
    elif cls == "fusion":
        spatial_parts.extend([
            _text(pack.get("fusionDetails", {}).get("placementScaleAndCamera")),
            _text(pack.get("fusionDetails", {}).get("compositionAndDepth")),
        ])
    spatial_text = "；".join(_unique_texts(spatial_parts))
    if spatial_text:
        paragraphs.append(_sentence(spatial_text, "空间关系与地理保持清晰："))

    material_parts = [_text(pack.get("materialEvidence"))]
    if cls == "character":
        material_parts.extend([
            _text(pack.get("characterDetails", {}).get("detailAndMaterialBehavior")),
            _text(pack.get("characterDetails", {}).get("costumeAndMaterials")),
        ])
    elif cls == "scene":
        material_parts.extend([
            _text(pack.get("sceneDetails", {}).get("materialsAndSurfaceState")),
            _text(pack.get("sceneDetails", {}).get("detailEvidenceAndAtmosphere")),
        ])
    elif cls == "prop":
        material_parts.extend([
            _text(pack.get("propDetails", {}).get("materialAndCondition")),
            _text(pack.get("propDetails", {}).get("detailAndMaterialBehavior")),
        ])
    elif cls == "fusion":
        material_parts.extend([
            _text(pack.get("fusionDetails", {}).get("characterDetailAndMaterialBehavior")),
            _text(pack.get("fusionDetails", {}).get("sceneDetailAndAtmosphere")),
            _text(pack.get("fusionDetails", {}).get("lightingShadowsAndMaterialIntegration")),
        ])
    material_text = "；".join(_unique_texts(material_parts))
    if material_text:
        paragraphs.append(_sentence(material_text, "材质证据与表面状态表现为："))

    lighting = _text(pack.get("lightingCausality"))
    if cls == "scene":
        lighting = lighting or _text(pack.get("sceneDetails", {}).get("lightingWeatherAtmosphere"))
    if cls == "fusion":
        lighting = lighting or _text(pack.get("fusionDetails", {}).get("styleAndLightingAuthority"))
    if lighting:
        paragraphs.append(_sentence(lighting, "光线必须有明确来源、方向、色温和可见后果："))

    camera = _text(pack.get("cameraExecution")) or shot_camera
    if camera:
        paragraphs.append(_sentence(camera, "摄影机执行为："))

    style = _text(pack.get("visualStyle"))
    if style:
        paragraphs.append(_sentence(style, "视觉媒介与渲染克制为："))

    atmosphere = _text(pack.get("atmosphereBehavior"))
    if atmosphere:
        paragraphs.append(_sentence(atmosphere, "空气、天气和克制的视觉效果表现为："))

    continuity = _clean_list(pack.get("continuityChecklist"))
    if shot_continuity:
        continuity.append(shot_continuity)
    detail_registry = pack.get("detailAnchorRegistry") if isinstance(pack.get("detailAnchorRegistry"), dict) else {}
    if _has_value(detail_registry.get("mayVary")):
        continuity.append(f"允许变化：{render_prompt_value(detail_registry['mayVary'])}")
    if continuity:
        paragraphs.append(_sentence("；".join(continuity), "连续性检查："))

    preserve = _visible_prompt_constraints(pack.get("mustPreserve"), composition_mode)
    if preserve:
        paragraphs.append(_sentence("、".join(preserve), "必须保留："))
    avoid = _visible_prompt_constraints(pack.get("mustAvoid") or pack.get("negativePrompt"), composition_mode)
    if avoid:
        paragraphs.append(_sentence("、".join(avoid), "必须避免："))
    notes = _text(pack.get("generationNotes"))
    size = _text(pack.get("suggestedSize"))
    if notes or (size and composition_mode == "legacy_supplement"):
        tail = "；".join(item for item in [notes, f"建议尺寸为{size}" if size and composition_mode == "legacy_supplement" else ""] if item)
        paragraphs.append(_sentence(tail, "生成说明："))

    compiled = "\n\n".join(item for item in paragraphs if item)
    if fallback:
        if composition_mode == "clean_replace":
            # In a clean replacement, the provider's structured pack is the
            # source of truth. If it is too empty to compile a usable prompt,
            # keep the provider's new prose as the draft; never append it to
            # the previous prompt or emit the legacy supplement marker.
            if not prompt_pack_has_generation_fields(cls, pack):
                return fallback.strip()
            return compiled.strip() or fallback.strip()
        # ``prompt`` is persisted as the final natural-language output.  The
        # asset-library read path also canonicalizes that value, so treating
        # the whole persisted prompt as a fresh fallback makes every read
        # append another copy of the already compiled prompt.  Strip only
        # exact leading compiler layers and retain the user-authored tail.
        supplement = fallback
        while compiled and supplement.startswith(compiled):
            supplement = supplement[len(compiled):].strip()
            if supplement.startswith(PROMPT_SUPPLEMENT_MARKER):
                supplement = supplement[len(PROMPT_SUPPLEMENT_MARKER):].strip()
                continue
            break
        if supplement and supplement != compiled:
            compiled = f"{compiled}\n\n{PROMPT_SUPPLEMENT_MARKER}{supplement}" if compiled else supplement
    return compiled.strip()


def canonicalize_prompt_output(
    asset_class: str | None,
    prompt_pack: Any,
    prompt: str,
    *,
    identity_anchor: Any = None,
    must_preserve: Any = None,
    must_avoid: Any = None,
    context: dict[str, Any] | None = None,
    composition_mode: PromptCompositionMode = "legacy_supplement",
    previous_prompt: str = "",
    strict_clean: bool = False,
) -> dict[str, Any]:
    """Return the one canonical prompt representation used by persistence."""

    cls = canonical_asset_class(asset_class)
    pack = normalize_prompt_pack(
        cls,
        prompt_pack,
        identity_anchor=identity_anchor,
        must_preserve=must_preserve,
        must_avoid=must_avoid,
        context=context,
    )
    if composition_mode == "clean_replace" and strict_clean and not prompt_pack_has_generation_fields(cls, prompt_pack):
        raise ValueError("Prompt Pack 未形成完整的新稿，不能进入 clean_replace 重写。")
    compiled = build_natural_language_prompt(cls, pack, prompt, context=context, composition_mode=composition_mode)
    if composition_mode == "clean_replace" and strict_clean:
        issues = validate_clean_prompt(compiled, previous_prompt)
        if issues:
            raise ValueError("；".join(issues))
    return {
        "prompt": compiled,
        "promptPack": pack,
        "promptQuality": assess_prompt_pack(cls, pack, compiled),
        "promptContractVersion": PROMPT_CONTRACT_VERSION,
        "promptWorkflow": PROMPT_WORKFLOW_ID,
        "promptFieldOrder": list(AUDIO_PROMPT_FIELD_ORDER if cls == "audio" else PROMPT_FIELD_ORDER),
    }


def _coverage_item(label: str, paths: tuple[str, ...], prompt_pack: dict[str, Any], prompt: str) -> dict[str, Any]:
    present = any(_has_value(_value_at_path(prompt_pack, path)) for path in paths)
    if label == "参考板策略" and _value_at_path(prompt_pack, "referenceStrategy.status") == "no_reference_assets":
        present = False
    # Audio fields are intentionally separated from the copy-ready status
    # string. Do not infer a real spoken text, language, or pronunciation
    # field merely because the status message contains “朗读文本” or “待确认”.
    if not present and any(path.startswith("audioDetails.") for path in paths):
        return {"label": label, "present": False, "paths": list(paths)}
    if not present:
        lowered_prompt = prompt.lower()
        aliases = {
            "人物身份锚点": ("身份", "角色"),
            "资产身份/结构锚点": ("身份", "结构", "轮廓"),
            "面部细节": ("脸", "面孔", "眉眼", "眼神", "下颌"),
            "发型轮廓": ("发型", "头发", "发丝"),
            "身体与表演": ("身形", "动作", "姿态", "手势", "重心"),
            "服装与材质": ("服装", "装甲", "材质", "衣料", "织物"),
            "场景地理与分层": ("前景", "中景", "背景", "空间布局", "平台", "街道", "地理"),
            "陈设与地标": ("陈设", "护栏", "地标", "道具", "固定"),
            "材质表面": ("表面", "地面", "金属", "玻璃", "湿润", "磨损"),
            "光线与空气": ("光线", "光源", "雾", "天气", "空气", "反射", "阴影"),
            "动作空间": ("动作区", "落脚", "接触", "空间轴", "阻挡"),
            "镜头与动作": ("镜头", "机位", "焦段", "构图", "动作", "景别"),
            "视觉渲染": ("光线", "色彩", "景深", "渲染", "光学", "媒介"),
            "连续性锚点": ("连续", "保持", "一致", "轴线", "不漂移"),
            "负向约束": ("禁止", "避免", "不得", "不要", "无可读文字"),
            "参考图角色": ("参考图", "@image", "控制范围"),
            "可见事件/因果": ("事件", "因为", "导致", "留下", "造成"),
            "角色/道具/场景分离锚点": ("角色身份", "道具身份", "场景身份"),
            "接触与尺度链": ("接触", "尺度", "落地", "握持", "遮挡"),
            "融合光影与遮挡": ("阴影", "光线", "遮挡", "环境光遮蔽"),
            "视频参考用途": ("keyframe", "first frame", "last frame", "multi-frame", "参考用途"),
            "结构与材质": ("结构", "轮廓", "材质", "功能"),
            "使用状态与尺度": ("状态", "尺度", "交互", "接触"),
            "朗读文本": ("朗读文本", "对白", "旁白", "台词"),
            "文本状态": ("confirmed", "candidate", "conflict", "missing", "待用户确认"),
            "声音身份与演绎": ("声音身份", "音色", "咬字", "气息", "投射", "低沉", "冷峻"),
            "语言与方言": ("普通话", "中文", "方言", "口音", "语言"),
            "情绪与节奏": ("情绪", "强度", "语速", "节奏", "停顿"),
            "停顿与发音": ("停顿", "发音", "多音字", "拼音", "pronunciation"),
            "音频连续性": ("音频连续", "口型", "对白时长", "关联镜头", "分轨"),
            "音频负向约束": ("不要朗读", "不可朗读", "覆盖对白", "吞字", "擅自补写"),
        }
        present = any(alias in lowered_prompt for alias in aliases.get(label, ()))
    return {"label": label, "present": present, "paths": list(paths)}


def assess_prompt_pack(asset_class: str, prompt_pack: Any, prompt: str = "") -> dict[str, Any]:
    """Return an advisory coverage report for the shared prompt workflow."""

    asset_class = canonical_asset_class(asset_class)
    pack = normalize_prompt_pack(asset_class, prompt_pack)
    if asset_class == "audio":
        required = [
            ("朗读文本", ("audioDetails.sourceText",)),
            ("文本状态", ("audioDetails.textStatus",)),
            ("声音身份与演绎", ("audioDetails.voiceIdentity", "audioDetails.performanceDirection")),
            ("语言与方言", ("audioDetails.language", "audioDetails.dialect")),
            ("情绪与节奏", ("audioDetails.emotion", "audioDetails.intensity", "audioDetails.pace")),
            ("停顿与发音", ("audioDetails.pausePlan", "audioDetails.pronunciation")),
            ("音频连续性", ("continuityChecklist", "audioDetails.relevantShots")),
            ("音频负向约束", ("mustAvoid", "negativePrompt")),
        ]
    else:
        common = [
            ("人物身份锚点" if asset_class == "character" else "资产身份/结构锚点", ("identityAnchor", "identity", "identity_anchors")),
            ("可见事件/因果", ("visibleEvent", "shotPlan", "camera", "poseAction", "action")),
            ("镜头与动作", ("shotPlan", "cameraExecution", "camera", "poseAction", "action")),
            ("视觉渲染", ("visualStyle", "lightingCausality", "lighting", "style")),
            ("连续性锚点", ("continuityChecklist", "detailAnchorRegistry", "continuity")),
            ("负向约束", ("negativePrompt", "mustAvoid")),
            ("参考图角色", ("referenceStrategy", "referenceRoles", "references")),
        ]
        if asset_class == "character":
            required = common + [
                ("面部细节", ("characterDetails.faceAndExpression", "characterDetails.face", "faceExpression", "face")),
                ("发型轮廓", ("characterDetails.hairAndHeadSilhouette", "characterDetails.hair", "hairSilhouette", "hair")),
                ("身体与表演", ("characterDetails.bodyPoseAction", "characterDetails.bodyAndPosture", "characterDetails.expressionAndPerformance", "poseAction")),
                ("服装与材质", ("characterDetails.costumeAndMaterials", "characterDetails.wardrobe", "wardrobeMaterial", "wardrobe", "materials")),
                ("参考板策略", ("characterDetails.referenceSheet", "referenceStrategy", "referencePlan")),
            ]
        elif asset_class == "scene":
            required = common + [
                ("场景地理与分层", ("sceneDetails.spatialLayoutAndGeography", "sceneDetails.foregroundMidgroundBackground", "layout", "spatialLayout", "geography")),
                ("陈设与地标", ("sceneDetails.setDressingAndFixedAnchors", "sceneDetails.propsAndSetDressing", "propsAndSetDressing", "props", "landmarks")),
                ("材质表面", ("sceneDetails.materialsAndSurfaceState", "surfaceMaterials", "materials")),
                ("光线与空气", ("sceneDetails.lightingWeatherAtmosphere", "sceneDetails.detailEvidenceAndAtmosphere", "lightingAtmosphere", "lighting")),
                ("动作空间", ("sceneDetails.actionBlockingZones", "sceneDetails.actionSpace", "actionSpace", "blocking")),
            ]
        elif asset_class == "fusion":
            required = common + [
                ("角色/道具/场景分离锚点", ("fusionDetails.characterIdentityLock", "fusionDetails.itemIdentityLock", "fusionDetails.sceneIdentityLock")),
                ("接触与尺度链", ("fusionDetails.interactionAndContact", "fusionDetails.placementScaleAndCamera", "interaction", "scale")),
                ("融合光影与遮挡", ("fusionDetails.lightingShadowsAndMaterialIntegration", "fusionDetails.compositionAndDepth", "lighting", "occlusion")),
                ("视频参考用途", ("fusionDetails.shotUsage", "fusionDetails.seedanceReferenceRole", "shotUsage")),
            ]
        elif asset_class == "shot":
            required = common + [
                ("镜头事件与后果", ("visibleEvent", "shotPlan", "eventConsequence", "action")),
                ("镜头执行", ("cameraExecution", "shotPlan", "camera")),
                ("角色/场景连续性", ("identityAnchor", "continuityChecklist", "detailAnchorRegistry")),
            ]
        else:
            required = common + [
                ("结构与材质", ("propDetails.objectIdentity", "propDetails.silhouetteAndProportions", "propDetails.structureAndFunction", "structure", "materials", "assetSpec", "productionSpec")),
                ("使用状态与尺度", ("propDetails.materialAndCondition", "propDetails.scaleAndInteraction", "usageState", "interaction", "state", "poseAction")),
            ]
    checks = [_coverage_item(label, paths, pack, prompt) for label, paths in required]
    passed = sum(1 for item in checks if item["present"])
    missing = [item["label"] for item in checks if not item["present"]]
    return {
        "schema_version": PROMPT_CONTRACT_VERSION,
        "workflow": PROMPT_WORKFLOW_ID,
        "status": "ready" if not missing else "needs-detail",
        "coverage": {"passed": passed, "total": len(checks), "percent": round(passed / len(checks) * 100) if checks else 0},
        "checks": checks,
        "missing": missing,
        "qa_gate": {
            "specificity": not ("面部细节" in missing or "场景地理与分层" in missing or "结构与材质" in missing or "声音身份与演绎" in missing),
            "visibility": ("镜头与动作" not in missing) if asset_class != "audio" else "朗读文本" not in missing,
            "causality": ("可见事件/因果" not in missing and ("光线与空气" not in missing if asset_class == "scene" else True)) if asset_class != "audio" else "情绪与节奏" not in missing,
            "continuity": ("连续性锚点" not in missing) if asset_class != "audio" else "音频连续性" not in missing,
            "reference_roles": "参考图角色" not in missing if asset_class != "audio" else True,
        },
    }


__all__ = [
    "PROMPT_CONTRACT_VERSION",
    "PROMPT_WORKFLOW_ID",
    "PROMPT_FIELD_ORDER",
    "AUDIO_PROMPT_SCHEMA_VERSION",
    "AUDIO_PROMPT_FIELD_ORDER",
    "PROMPT_CLASS_ALIASES",
    "canonical_asset_class",
    "prompt_contract",
    "prompt_contract_instructions",
    "normalize_prompt_pack",
    "build_natural_language_prompt",
    "build_audio_prompt_package",
    "canonicalize_prompt_output",
    "assess_prompt_pack",
    "render_prompt_value",
]
