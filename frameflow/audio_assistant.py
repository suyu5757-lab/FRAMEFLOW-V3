"""Bounded, provider-neutral preparation helpers for the embedded audio AI.

The audio assistant is deliberately a planning surface.  It may propose voice
profiles, auditions, and dialogue drafts, but it cannot create a Take, an
artifact, a QA result, or a production-ready handoff.  Keeping this compiler
outside ``server.py`` makes the boundary reusable by the API and by tests.
"""

from __future__ import annotations

import hashlib
import json
import re
from copy import deepcopy
from typing import Any

from .providers import ProviderError, validate_minimax_tts_text


AUDIO_ASSISTANT_MODE = "voice-preparation"
AUDIO_ASSISTANT_SKILL_ID = "voice-preparation-assistant"
AUDIO_ASSISTANT_CONTRACT_VERSION = "voice-preparation-v1"

SUPPORTED_AUDIO_ASSISTANT_STATES = {
    "needs_clarification",
    "ready_for_review",
    "blocked",
}
SUPPORTED_AUDIO_ASSISTANT_OPERATIONS = {
    "create_voice_profile_draft",
    "update_voice_profile_draft",
    "create_audition_draft",
    "update_audition_draft",
    "create_dialogue_draft",
    "update_dialogue_draft",
}
AUDIO_ASSISTANT_TARGETS = {"voice_profile", "audition", "dialogue"}
AUDIO_ASSISTANT_RISK = "review_required"

VOICE_FIELDS = {
    "id",
    "name",
    "character_id",
    "role",
    "source_type",
    "provider",
    "model",
    "provider_profile_id",
    "provider_voice_id",
    "provider_voice_name",
    "provider_voice_source",
    "provider_region",
    "locale",
    "language",
    "dialect",
    "language_boost",
    "traits",
    "pronunciation_risks",
    "register",
    "age_range",
    "pitch_energy",
    "breath_noise_profile",
    "logical_asset_id",
    "continuity_anchor",
    "notes",
}
AUDITION_FIELDS = {
    "id",
    "voice_id",
    "voice_candidate_id",
    "character_id",
    "condition",
    "text",
    "source_text",
    "provider_text",
    "text_status",
    "locale",
    "language",
    "dialect",
    "language_boost",
    "provider_region",
    "variant",
    "settings",
    "emotion",
    "instructions",
    "target_duration",
    "notes",
}
DIALOGUE_FIELDS = {
    "id",
    "asset_id",
    "character_id",
    "voice_id",
    "voice_candidate_id",
    "logical_asset_id",
    "shot_ids",
    "text",
    "source_text",
    "provider_text",
    "text_status",
    "locale",
    "language",
    "dialect",
    "language_boost",
    "provider_region",
    "settings",
    "emotion",
    "target_duration",
    "operation",
    "notes",
}

FORBIDDEN_AUDIO_KEYS = {
    "artifact_id",
    "artifactid",
    "qa_run_id",
    "qarunid",
    "qa_decision",
    "qadecision",
    "production_ready",
    "productionready",
    "regulator_registered",
    "regulatorregistered",
    "selected_take_id",
    "selectedtakeid",
    "take_id",
    "takeid",
    "handoff",
    "approved",
    "registered",
    "generated",
}


class AudioPreparationError(ValueError):
    """A deterministic validation error for an audio preparation proposal."""

    def __init__(self, message: str, kind: str = "validation", status_code: int = 422) -> None:
        super().__init__(message)
        self.kind = kind
        self.status_code = status_code


def _text(value: Any, maximum: int = 4000) -> str:
    if value is None:
        return ""
    return str(value).strip()[:maximum]


def _list(value: Any, maximum: int = 32) -> list[Any]:
    if not isinstance(value, list):
        return []
    return value[:maximum]


def _string_list(value: Any, maximum: int = 32) -> list[str]:
    if isinstance(value, str):
        value = [item.strip() for item in value.replace("，", ",").split(",")]
    if not isinstance(value, list):
        return []
    return [_text(item, 180) for item in value if _text(item, 180)][:maximum]


def _record_id(value: Any) -> str:
    return _text(value, 160)


def _stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def audio_document_hash(document: dict[str, Any]) -> str:
    """Hash only the JSON draft; this never includes credentials or paths."""

    return hashlib.sha256(_stable_json(document).encode("utf-8")).hexdigest()


def _catalog_entries(catalog: dict[str, Any] | None) -> tuple[dict[str, dict[str, Any]], str, str]:
    value = catalog if isinstance(catalog, dict) else {}
    status = _text(value.get("status"), 40) or "unavailable"
    region = _text(value.get("region"), 20) or "cn"
    entries: dict[str, dict[str, Any]] = {}
    for item in value.get("voices") if isinstance(value.get("voices"), list) else []:
        if not isinstance(item, dict):
            continue
        voice_id = _text(item.get("voice_id"), 160)
        if voice_id:
            entry = deepcopy(item)
            entry.setdefault("source", "system")
            entries[voice_id] = entry
    return entries, status, region


def validate_system_voice(
    provider_voice_id: Any,
    catalog: dict[str, Any] | None,
    *,
    provider_region: str | None = None,
) -> dict[str, Any]:
    """Return a catalog entry or reject a stale/invented MiniMax voice ID."""

    voice_id = _text(provider_voice_id, 160)
    entries, status, catalog_region = _catalog_entries(catalog)
    if status not in {"live", "cached"}:
        raise AudioPreparationError(
            f"MiniMax 系统音色目录当前为 {status}，不能把文档候选当作可执行音色。",
            "catalog-unavailable",
            409,
        )
    entry = entries.get(voice_id)
    if not entry or _text(entry.get("source"), 40) != "system":
        raise AudioPreparationError(
            f"MiniMax 系统音色 {voice_id or '（空）'} 不在当前实时/缓存目录中。",
            "catalog-stale",
            409,
        )
    requested_region = _text(provider_region, 20)
    if requested_region and requested_region != catalog_region:
        raise AudioPreparationError(
            f"音色区域 {requested_region} 与当前 MiniMax 目录区域 {catalog_region} 不一致。",
            "catalog-stale",
            409,
        )
    return entry


def _language_boost(locale: str, language: str, explicit: Any = None) -> str | None:
    normalized = _text(locale, 40).lower().replace("_", "-")
    base = normalized.split("-", 1)[0]
    mapped = {
        "ja": "Japanese",
        "zh": "Chinese",
        "en": "English",
        "ko": "Korean",
        "fr": "French",
        "de": "German",
        "es": "Spanish",
        "it": "Italian",
        "pt": "Portuguese",
        "ru": "Russian",
        "ar": "Arabic",
        "tr": "Turkish",
        "nl": "Dutch",
        "vi": "Vietnamese",
        "id": "Indonesian",
        "th": "Thai",
        "ms": "Malay",
        "fil": "Filipino",
        "uk": "Ukrainian",
        "pl": "Polish",
        "ro": "Romanian",
        "cs": "Czech",
        "el": "Greek",
        "hu": "Hungarian",
        "sv": "Swedish",
        "da": "Danish",
        "fi": "Finnish",
        "no": "Norwegian",
        "sk": "Slovak",
        "bg": "Bulgarian",
        "hr": "Croatian",
        "ta": "Tamil",
        "te": "Telugu",
        "hi": "Hindi",
        "he": "Hebrew",
        "fa": "Persian",
        "bn": "Bengali",
        "af": "Afrikaans",
        "ca": "Catalan",
        "sr": "Serbian",
    }
    if base in mapped:
        return mapped[base]
    language_value = _text(language, 80)
    if language_value in mapped.values():
        return language_value
    explicit_value = _text(explicit, 80)
    return explicit_value if explicit_value not in {"Chinese", "auto", "Automatic"} else None


DEFAULT_LOCALE_BY_LANGUAGE = {
    "Chinese": "zh-CN",
    "English": "en-US",
    "Japanese": "ja-JP",
    "Korean": "ko-KR",
    "French": "fr-FR",
    "German": "de-DE",
    "Spanish": "es-ES",
    "Italian": "it-IT",
    "Portuguese": "pt-BR",
    "Russian": "ru-RU",
}


def _language_context(*sources: dict[str, Any] | None) -> dict[str, str]:
    """Return the first complete, non-invented language context from sources.

    A dialogue may inherit a locale from the explicitly selected MiniMax voice
    candidate.  It must never inherit one from a character's nationality or
    silently guess a translation from the user's source-language idea.
    """

    values: dict[str, str] = {}
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key, aliases, limit in (
            ("locale", ("locale",), 40),
            ("language", ("language",), 80),
            ("dialect", ("dialect",), 120),
            ("provider_region", ("provider_region", "providerRegion"), 20),
        ):
            if values.get(key):
                continue
            value = next((_text(source.get(alias), limit) for alias in aliases if _text(source.get(alias), limit)), "")
            if value:
                values[key] = value
    locale = values.get("locale", "")
    language = values.get("language", "") or (_language_boost(locale, "") or "")
    if language:
        values["language"] = language
        values.setdefault("locale", DEFAULT_LOCALE_BY_LANGUAGE.get(language, ""))
    if values.get("language") == "Japanese":
        values.setdefault("dialect", "Standard Japanese")
    return {key: value for key, value in values.items() if value}


def _voice_design_brief_source(proposal: dict[str, Any], user_message: str | None) -> str:
    """Pick a bounded creative brief for the deterministic Voice Design fallback."""

    return _text(
        proposal.get("source_idea")
        or proposal.get("sourceIdea")
        or proposal.get("intent_summary")
        or proposal.get("intentSummary")
        or user_message,
        2400,
    )


def _voice_design_preview_from_request(proposal: dict[str, Any], user_message: str | None) -> str:
    """Recover a real preview line without inventing one when the model omits it."""

    dialogue_rows = proposal.get("dialogue_candidates")
    if not isinstance(dialogue_rows, list):
        dialogue_rows = proposal.get("dialogues") if isinstance(proposal.get("dialogues"), list) else []
    for row in dialogue_rows[:16]:
        if isinstance(row, dict):
            candidate_text = _text(row.get("source_text") or row.get("sourceText") or row.get("text"), 500)
            if candidate_text:
                return candidate_text
    explicit_text = _text(user_message, 2400)
    if explicit_text:
        match = re.search(r"(?:她想说|他想说|它想说|想说|台词(?:是|为)?)\s*[:：]\s*(.+)", explicit_text, flags=re.IGNORECASE | re.DOTALL)
        if match:
            candidate_text = match.group(1).strip().strip('"“”\'')
            if candidate_text:
                return candidate_text[:500]
    return _text(proposal.get("preview_text") or proposal.get("previewText"), 500)


def _voice_design_request_language(value: str | None) -> dict[str, str]:
    """Infer only an explicit language request for display metadata.

    This does not translate text or establish a provider capability.  It only
    prevents a clearly stated language such as Japanese from being rendered as
    "unspecified" in the copy package.
    """

    source = _text(value, 2400)
    if re.search(r"日本|日语|日文|japanese", source, flags=re.IGNORECASE):
        return {"language": "Japanese", "locale": "ja-JP", "dialect": "Standard Japanese"}
    if re.search(r"中文|汉语|普通话|chinese", source, flags=re.IGNORECASE):
        return {"language": "Chinese", "locale": "zh-CN", "dialect": "Mandarin"}
    if re.search(r"英语|英文|english", source, flags=re.IGNORECASE):
        return {"language": "English", "locale": "en-US", "dialect": "General American"}
    if re.search(r"韩语|韩文|korean", source, flags=re.IGNORECASE):
        return {"language": "Korean", "locale": "ko-KR", "dialect": "Standard Korean"}
    return {}


def _voice_design_fallback_prompt(proposal: dict[str, Any], user_message: str | None) -> str:
    """Create a useful MiniMax prompt only when OpenCode omitted voice_design.

    This is intentionally a small safety net, not a replacement for the model's
    creative rewrite.  It preserves the user's intent while turning common
    Chinese descriptors into observable Voice Design language.
    """

    source = _voice_design_brief_source(proposal, user_message)
    if not source:
        return ""
    matching_source = f"{source} {_text(user_message, 2400)}"
    identity: list[str] = []
    qualities: list[str] = []
    avoid: list[str] = []
    if re.search(r"日本|日语|日文|japanese", matching_source, flags=re.IGNORECASE):
        identity.append("Japanese, with natural standard pronunciation")
    if re.search(r"女高中生|高中女生|女学生|年轻女性|少女|female student|young woman", matching_source, flags=re.IGNORECASE):
        identity.append("a young female high-school student")
    elif re.search(r"高中生|学生|student", matching_source, flags=re.IGNORECASE):
        identity.append("a high-school student")
    if re.search(r"甜|sweet", matching_source, flags=re.IGNORECASE):
        qualities.append("sweet")
    if re.search(r"轻柔|柔和|温柔|soft|gentle", matching_source, flags=re.IGNORECASE):
        qualities.append("soft and gentle")
    if re.search(r"活力|朝气|有精神|lively|youthful|energetic", matching_source, flags=re.IGNORECASE):
        qualities.append("youthful and lively, with an energetic baseline")
    if re.search(r"动漫|二次元|anime", matching_source, flags=re.IGNORECASE):
        avoid.append("exaggerated anime-style delivery")
    if re.search(r"尖锐|刺耳|sharp|harsh", matching_source, flags=re.IGNORECASE):
        avoid.append("a sharp or harsh tone")
    if re.search(r"机械|机器人|robotic", matching_source, flags=re.IGNORECASE):
        avoid.append("robotic rhythm")
    if not identity:
        identity.append("an original fictional character voice")
    if not qualities:
        qualities.append("natural, clear, and approachable")
    if not avoid:
        avoid.append("overacting, unnatural pitch jumps, and mechanical timing")
    brief_without_line = re.split(r"(?:她想说|他想说|它想说|想说|台词(?:是|为)?)\s*[:：]", source, maxsplit=1, flags=re.IGNORECASE)[0].strip()
    context_line = f"Character context: {brief_without_line}." if brief_without_line else "Character context: an original fictional role."
    return "\n".join([
        "Create an original fictional voice. Do not imitate any real person, public figure, or copyrighted character.",
        f"Voice identity: {', '.join(identity)}.",
        f"Voice quality: {', '.join(dict.fromkeys(qualities))}.",
        "Delivery: natural conversational pacing, clear articulation, relaxed breath, and a warm close presence.",
        context_line,
        f"Avoid: {', '.join(dict.fromkeys(avoid))}.",
    ])


def _numeric(value: Any, default: float, minimum: float, maximum: float, field: str) -> float:
    if value in (None, ""):
        return default
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise AudioPreparationError(f"{field} 必须是数字。") from exc
    if not minimum <= number <= maximum:
        raise AudioPreparationError(f"{field} 必须在 {minimum} 到 {maximum} 之间。")
    return round(number, 4)


def _safe_rank(value: Any, default: int) -> int:
    try:
        rank = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(99, rank))


def _shot_ids(project_document: dict[str, Any]) -> set[str]:
    return {
        _record_id(item.get("id"))
        for item in project_document.get("shots") or []
        if isinstance(item, dict) and _record_id(item.get("id"))
    }


def _focus_value(focus: dict[str, Any] | None, key: str) -> Any:
    return focus.get(key) if isinstance(focus, dict) else None


def build_audio_assistant_context(
    project_document: dict[str, Any],
    audio_document: dict[str, Any],
    story_document: dict[str, Any] | None,
    catalog: dict[str, Any] | None,
    focus: dict[str, Any] | None = None,
    *,
    voice_design_only: bool = False,
) -> dict[str, Any]:
    """Build a bounded audio-first context for OpenCode."""

    focus_value = focus if isinstance(focus, dict) else {}
    focused_shots = _string_list(focus_value.get("shot_ids"), 16)
    all_shot_ids = _shot_ids(project_document)
    focused_shots = [item for item in focused_shots if item in all_shot_ids]
    story = story_document if isinstance(story_document, dict) else project_document
    shots: list[dict[str, Any]] = []
    for shot in story.get("shots") or project_document.get("shots") or []:
        if not isinstance(shot, dict):
            continue
        shot_id = _record_id(shot.get("id"))
        if focused_shots and shot_id not in focused_shots:
            continue
        shots.append({
            key: deepcopy(shot.get(key))
            for key in ("id", "scene", "duration", "purpose", "dialogue", "narration", "speaker", "character_id", "sound")
            if shot.get(key) not in (None, "", [])
        })
    audio = audio_document if isinstance(audio_document, dict) else {}
    voice_rows = audio.get("voices") if isinstance(audio.get("voices"), list) else []
    audition_rows = audio.get("auditions") if isinstance(audio.get("auditions"), list) else []
    dialogue_rows = audio.get("dialogues") if isinstance(audio.get("dialogues"), list) else []
    safe_voice = [{
        key: deepcopy(item.get(key))
        for key in ("id", "name", "character_id", "source_type", "provider", "provider_voice_id", "provider_region", "locale", "language", "dialect", "status", "selected_audition_id")
        if item.get(key) not in (None, "", [])
    } for item in voice_rows if isinstance(item, dict)][:32]
    safe_auditions = [{
        key: deepcopy(item.get(key))
        for key in ("id", "voice_id", "character_id", "condition", "source_text", "text_status", "locale", "language", "provider_region", "status", "artifact_id")
        if item.get(key) not in (None, "", [])
    } for item in audition_rows if isinstance(item, dict)][:64]
    safe_dialogues = [{
        key: deepcopy(item.get(key))
        for key in ("id", "asset_id", "character_id", "voice_id", "shot_ids", "source_text", "text_status", "locale", "language", "dialect", "provider_region", "operation", "execution_status", "selected_take_id")
        if item.get(key) not in (None, "", [])
    } for item in dialogue_rows if isinstance(item, dict)][:64]
    voice_catalog = catalog if isinstance(catalog, dict) else {}
    safe_catalog = [{
        key: deepcopy(item.get(key))
        for key in ("voice_id", "name", "source", "language", "languages", "description", "gender", "age", "supported_emotion", "catalog_source")
        if item.get(key) not in (None, "", [])
    } for item in voice_catalog.get("voices") or [] if isinstance(item, dict)][:240]
    return {
        "mode": AUDIO_ASSISTANT_MODE,
        "contract_version": AUDIO_ASSISTANT_CONTRACT_VERSION,
        "task": "voice-design" if voice_design_only else "audio-preparation",
        "voice_design_only": bool(voice_design_only),
        "focus": {
            "kind": _text(focus_value.get("kind"), 30) or "project",
            "target_id": _record_id(focus_value.get("target_id")) or None,
            "character_id": _record_id(focus_value.get("character_id")) or None,
            "shot_ids": focused_shots,
        },
        "project": {
            "id": _record_id(project_document.get("id")),
            "name": _text(project_document.get("name"), 180),
            "brief": _text(project_document.get("brief"), 1200),
        },
        "shots": shots[:32],
        "voices": safe_voice,
        "auditions": safe_auditions,
        "dialogues": safe_dialogues,
        "minimax": {
            "provider": "minimax",
            "region": _text(voice_catalog.get("region"), 20) or "cn",
            "status": _text(voice_catalog.get("status"), 40) or "unavailable",
            "catalog_source": _text(voice_catalog.get("catalog_source"), 40) or "none",
            "models": [str(item) for item in (voice_catalog.get("models") or [])][:8],
            "voices": safe_catalog,
            "defaults": {"model": "speech-2.8-hd", "format": "wav", "speed": 1.0, "pitch": 0, "volume": 1.0},
        },
        "boundaries": {
            "planning_provider": "OpenCode",
            "generation_provider": "MiniMax",
            "assistant_may_generate_audio": False,
            "assistant_may_write_project": False,
            "assistant_may_set_text_confirmed": False,
            "assistant_may_create_take": False,
            "assistant_may_set_qa_approved": False,
            "assistant_may_use_voice_design_or_clone": False,
            "one_dialogue_per_task": True,
        },
    }


def audio_preparation_result_schema() -> dict[str, Any]:
    """JSON schema passed to OpenCode for the embedded audio conversation."""

    return {
        "type": "object",
        "properties": {
            "reply": {"type": "string"},
            "proposal": {
                "type": "object",
                "description": (
                    "声音准备方案。dialogue_candidates 中的每一项必须是可审阅的完整台词："
                    "source_text、provider_text、language、locale 均为非空；"
                    "若无法形成目标语言台词，请不要输出占位候选，改在 questions 返回一个 required 问题。"
                    "当 audio_preparation_context.voice_design_only=true 时，必须返回一个非空的 voice_design，"
                    "其中 prompt 是可直接粘贴到 MiniMax Voice Design 的音色描述，preview_text 是单独可试听的实际台词；"
                    "此模式不要把系统音色、角色登记、audition、QA 或交接当作当前任务。"
                ),
                "additionalProperties": True,
            },
            "patch": {"type": ["object", "null"], "additionalProperties": True},
            "actions": {"type": "array", "items": {"type": "string"}},
            "next_questions": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
            "requires_confirmation": {"type": "boolean"},
        },
        "required": ["reply", "proposal", "patch", "actions", "next_questions", "requires_confirmation"],
        "additionalProperties": True,
    }


def _payload_from_provider(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    structured = value.get("structured")
    if isinstance(structured, dict):
        return structured
    return value


def _find_existing(rows: list[Any], record_id: str) -> dict[str, Any] | None:
    for row in rows:
        if isinstance(row, dict) and _record_id(row.get("id")) == record_id:
            return row
    return None


def _contains_forbidden(value: Any, key: str = "") -> bool:
    normalized = str(key).lower().replace("_", "")
    if normalized in FORBIDDEN_AUDIO_KEYS:
        return True
    if isinstance(value, dict):
        return any(_contains_forbidden(child, child_key) for child_key, child in value.items())
    if isinstance(value, list):
        return any(_contains_forbidden(child, key) for child in value)
    return False


def _voice_record(
    item: dict[str, Any],
    catalog_entry: dict[str, Any],
    catalog_region: str,
    focus: dict[str, Any],
    candidate_id: str,
) -> dict[str, Any]:
    locale = _text(item.get("locale"), 40) or ("ja-JP" if _text(catalog_entry.get("language"), 40) == "Japanese" else "")
    language = _text(item.get("language"), 80) or _text(catalog_entry.get("language"), 80)
    provider_voice_id = _text(item.get("provider_voice_id") or item.get("voice_id") or catalog_entry.get("voice_id"), 160)
    provider_voice_name = _text(item.get("provider_voice_name") or item.get("name") or catalog_entry.get("name") or provider_voice_id, 180)
    character_id = _record_id(item.get("character_id")) or _record_id(focus.get("character_id")) or None
    return {
        "candidate_id": candidate_id,
        "name": _text(item.get("name"), 180) or provider_voice_name,
        "character_id": character_id,
        "role": _text(item.get("role"), 40) or "character",
        "source_type": "preset",
        "provider": "minimax",
        "model": _text(item.get("model"), 80) or "speech-2.8-hd",
        "provider_profile_id": _text(item.get("provider_profile_id"), 160) or None,
        "provider_voice_id": provider_voice_id,
        "provider_voice_name": provider_voice_name,
        "provider_voice_source": "system",
        "provider_region": _text(item.get("provider_region"), 20) or catalog_region,
        "locale": locale,
        "language": language,
        "dialect": _text(item.get("dialect"), 120) or ("Standard Japanese" if language == "Japanese" else ""),
        "language_boost": _language_boost(locale, language, item.get("language_boost")),
        "traits": _string_list(item.get("traits"), 16),
        "pronunciation_risks": _string_list(item.get("pronunciation_risks"), 16),
        "register": _text(item.get("register"), 240),
        "age_range": _text(item.get("age_range"), 160),
        "pitch_energy": _text(item.get("pitch_energy"), 240),
        "breath_noise_profile": _text(item.get("breath_noise_profile"), 240),
        "logical_asset_id": _record_id(item.get("logical_asset_id")) or None,
        "continuity_anchor": {
            "locale": locale,
            "language": language,
            "dialect": _text(item.get("dialect"), 120) or ("Standard Japanese" if language == "Japanese" else ""),
            "provider_voice_id": provider_voice_id,
        },
        "consent_status": "not-required",
        "status": "draft",
        "assistant_candidate_id": candidate_id,
        "notes": _text(item.get("notes"), 800),
    }


def _direction(item: dict[str, Any], condition: str) -> dict[str, Any]:
    raw = item.get("direction") if isinstance(item.get("direction"), dict) else item
    speed = _numeric(raw.get("speed"), 1.0, 0.5, 2.0, "speed")
    pitch = _numeric(raw.get("pitch"), 0.0, -12.0, 12.0, "pitch")
    volume = _numeric(raw.get("volume"), 1.0, 0.0, 10.0, "volume")
    return {
        "emotion": _text(raw.get("emotion"), 80) or ("happy" if condition == "emotional" else None),
        "intensity": _text(raw.get("intensity"), 80) or ("medium" if condition == "emotional" else "low"),
        "pace": _text(raw.get("pace"), 120) or "natural",
        "pause_plan": _list(raw.get("pause_plan") or raw.get("pausePlan"), 32),
        "pronunciation": deepcopy(raw.get("pronunciation") if isinstance(raw.get("pronunciation"), dict) else {}),
        "speed": speed,
        "pitch": pitch,
        "volume": volume,
        "sound_tags": _string_list(raw.get("sound_tags") or raw.get("soundTags"), 16),
    }


def _provider_text(item: dict[str, Any], source_text: str, *, require_plain: bool = False) -> str:
    provider_text = _text(item.get("provider_text") or item.get("providerText") or source_text, 9999)
    if not provider_text or provider_text == source_text:
        return provider_text
    if require_plain:
        raise AudioPreparationError("首轮 audition 的 provider_text 必须与 source_text 相同。")
    try:
        validate_minimax_tts_text(provider_text, "speech-2.8-hd")
    except ProviderError as exc:
        raise AudioPreparationError(str(exc), "provider-text-invalid", exc.status_code) from exc
    # Provider controls may be inserted, but the assistant cannot replace the
    # user's line with prose, translations, or stage directions.  Removing
    # only MiniMax's legal controls must leave the same spoken text.
    spoken = re.sub(r"<#[^#]+#>|\([A-Za-z][A-Za-z -]*\)", "", provider_text)
    if re.sub(r"\s+", "", spoken) != re.sub(r"\s+", "", source_text):
        raise AudioPreparationError("provider_text 只能在 source_text 中插入合法 MiniMax 停顿或语气标签。")
    return provider_text


def _audition_record(
    item: dict[str, Any],
    voice: dict[str, Any],
    focus: dict[str, Any],
    candidate_id: str,
) -> dict[str, Any]:
    condition = _text(item.get("condition"), 40) or "neutral"
    if condition not in {"neutral", "emotional", "pronunciation-stress"}:
        raise AudioPreparationError(f"audition condition 不受支持：{condition}")
    source_text = _text(item.get("source_text") or item.get("sourceText") or item.get("text"), 9999)
    provider_text = _provider_text(item, source_text, require_plain=not bool(item.get("allow_provider_controls") or item.get("allowProviderControls")))
    direction = _direction(item, condition)
    return {
        "voice_candidate_id": voice.get("assistant_candidate_id") or voice.get("candidate_id"),
        "voice_id": _record_id(voice.get("id")) or None,
        "character_id": voice.get("character_id"),
        "condition": condition,
        "text": source_text,
        "source_text": source_text,
        "provider_text": provider_text,
        "text_status": "candidate" if source_text else "missing",
        "locale": voice.get("locale") or None,
        "language": voice.get("language") or None,
        "dialect": voice.get("dialect") or None,
        "language_boost": voice.get("language_boost"),
        "provider_region": voice.get("provider_region"),
        "variant": condition,
        "settings": {"speed": direction["speed"], "pitch": direction["pitch"], "volume": direction["volume"], "format": "wav"},
        "emotion": direction["emotion"],
        "instructions": _text(item.get("instructions") or item.get("direction"), 500),
        "target_duration": item.get("target_duration"),
        "status": "user-confirmation-required" if source_text else "planned",
        "assistant_candidate_id": candidate_id,
        "notes": "声音助手草案；未生成、未 QA、未锁定。",
        "direction": direction,
    }


def _dialogue_record(
    item: dict[str, Any],
    focus: dict[str, Any],
    candidate_id: str,
    valid_shots: set[str],
    language_context: dict[str, str] | None = None,
) -> dict[str, Any]:
    source_text = _text(item.get("source_text") or item.get("sourceText") or item.get("text"), 9999)
    provider_text = _provider_text(item, source_text)
    shot_ids = _string_list(item.get("shot_ids") or item.get("shotIds") or focus.get("shot_ids"), 32)
    unknown = [shot_id for shot_id in shot_ids if shot_id not in valid_shots]
    if unknown:
        raise AudioPreparationError(f"对白引用了不存在的镜头：{'、'.join(unknown)}。")
    context = language_context if isinstance(language_context, dict) else {}
    locale = _text(item.get("locale"), 40) or _text(context.get("locale"), 40)
    language = _text(item.get("language"), 80) or _text(context.get("language"), 80) or (_language_boost(locale, "") or "")
    return {
        "character_id": _record_id(item.get("character_id")) or _record_id(focus.get("character_id")) or None,
        "voice_id": _record_id(item.get("voice_id")) or None,
        "voice_candidate_id": _record_id(item.get("voice_candidate_id") or item.get("voiceCandidateId")) or None,
        "shot_ids": shot_ids,
        "text": source_text,
        "source_text": source_text,
        "provider_text": provider_text,
        "text_status": "candidate" if source_text else "missing",
        "locale": locale or None,
        "language": language or None,
        "dialect": _text(item.get("dialect"), 120) or _text(context.get("dialect"), 120) or None,
        "language_boost": _language_boost(locale, language, item.get("language_boost") or item.get("languageBoost")),
        "provider_region": _text(item.get("provider_region") or item.get("providerRegion"), 20) or _text(context.get("provider_region"), 20) or None,
        "settings": {
            "speed": _numeric((item.get("settings") or {}).get("speed") if isinstance(item.get("settings"), dict) else item.get("speed"), 1.0, 0.5, 2.0, "speed"),
            "pitch": _numeric((item.get("settings") or {}).get("pitch") if isinstance(item.get("settings"), dict) else item.get("pitch"), 0.0, -12.0, 12.0, "pitch"),
            "volume": _numeric((item.get("settings") or {}).get("volume") if isinstance(item.get("settings"), dict) else item.get("volume"), 1.0, 0.0, 10.0, "volume"),
            "format": "wav",
        },
        "emotion": _text(item.get("emotion"), 80),
        "target_duration": item.get("target_duration"),
        "operation": "tts",
        "execution_status": "user-confirmation-required" if source_text else "planned",
        "assistant_candidate_id": candidate_id,
        "source_idea": _text(item.get("source_idea") or item.get("sourceIdea"), 1200),
        "notes": _text(item.get("notes"), 800),
    }


def _operation(
    operation_id: str,
    action: str,
    target: str,
    candidate_id: str,
    record: dict[str, Any],
    before: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if action not in SUPPORTED_AUDIO_ASSISTANT_OPERATIONS or target not in AUDIO_ASSISTANT_TARGETS:
        raise AudioPreparationError("声音助手返回了不受支持的草稿操作。")
    return {
        "id": operation_id,
        "workspace": "audio",
        "action": action,
        "target_id": _record_id(record.get("id")) or None,
        "title": {"voice_profile": "人物声音草稿", "audition": "Audition 草稿", "dialogue": "逐句对白草稿"}[target],
        "summary": "只回填声音工坊草稿；不会生成音频、Take 或 QA 结果。",
        "before": deepcopy(before) if before else None,
        "after": deepcopy(record),
        "content": {
            "audio_target": target,
            "candidate_id": candidate_id,
            "record": deepcopy(record),
        },
        "source_attachment_ids": [],
        "source_refs": [],
        "risk": AUDIO_ASSISTANT_RISK,
        "requires_confirmation": True,
    }


def normalize_voice_preparation_result(
    provider_result: Any,
    *,
    project_document: dict[str, Any],
    audio_document: dict[str, Any],
    story_document: dict[str, Any] | None,
    catalog: dict[str, Any] | None,
    focus: dict[str, Any] | None,
    contract_snapshot: dict[str, Any],
    user_message: str | None = None,
    voice_design_only: bool = False,
) -> dict[str, Any]:
    """Normalize and strictly bound one OpenCode preparation response."""

    payload = _payload_from_provider(provider_result)
    proposal = payload.get("proposal") if isinstance(payload.get("proposal"), dict) else payload.get("audio_preparation") if isinstance(payload.get("audio_preparation"), dict) else {}
    if not proposal:
        proposal = {}
    state = _text(proposal.get("state"), 40) or ("needs_clarification" if proposal.get("questions") or proposal.get("next_questions") else "ready_for_review")
    if state not in SUPPORTED_AUDIO_ASSISTANT_STATES:
        state = "ready_for_review"
    focus_value = deepcopy(focus) if isinstance(focus, dict) else {}
    focus_value.setdefault("kind", "project")
    focus_value["shot_ids"] = _string_list(focus_value.get("shot_ids"), 16)
    catalog_entries, catalog_status, catalog_region = _catalog_entries(catalog)
    valid_shots = _shot_ids(project_document)
    stored_voices = audio_document.get("voices") if isinstance(audio_document.get("voices"), list) else []
    stored_auditions = audio_document.get("auditions") if isinstance(audio_document.get("auditions"), list) else []
    stored_dialogues = audio_document.get("dialogues") if isinstance(audio_document.get("dialogues"), list) else []

    raw_voice_design = proposal.get("voice_design") if isinstance(proposal.get("voice_design"), dict) else proposal.get("voiceDesign") if isinstance(proposal.get("voiceDesign"), dict) else None
    voice_design: dict[str, Any] | None = None
    design_prompt = _text(raw_voice_design.get("prompt") or raw_voice_design.get("voice_design_prompt") or raw_voice_design.get("voiceDesignPrompt"), 4000) if raw_voice_design else ""
    design_preview = _text(raw_voice_design.get("preview_text") or raw_voice_design.get("previewText"), 500) if raw_voice_design else ""
    # The primary workbench is deliberately a Voice Design-only conversation.
    # Make the model output contract deterministic at the boundary: if an
    # otherwise valid response omits one of the two copy-ready fields, recover
    # it from the user's brief and an actual requested line rather than showing
    # an empty candidate card or falling back to the production form.
    if voice_design_only:
        design_prompt = design_prompt or _voice_design_fallback_prompt(proposal, user_message)
        design_preview = design_preview or _voice_design_preview_from_request(proposal, user_message)
    if design_prompt and design_preview:
        requested_language = _voice_design_request_language(user_message)
        voice_design = {
            "prompt": design_prompt,
            "preview_text": design_preview,
            "language": _text(raw_voice_design.get("language"), 80) if raw_voice_design else "",
            "locale": _text(raw_voice_design.get("locale"), 40) if raw_voice_design else "",
            "provider_region": _text(raw_voice_design.get("provider_region") or raw_voice_design.get("providerRegion"), 20) if raw_voice_design else "",
            "rationale": _text(raw_voice_design.get("rationale") or raw_voice_design.get("reason"), 700) if raw_voice_design else "",
        }
        voice_design["language"] = voice_design["language"] or requested_language.get("language") or _language_context({"locale": voice_design.get("locale")}).get("language") or None
        voice_design["locale"] = voice_design["locale"] or requested_language.get("locale") or None
        voice_design["dialect"] = requested_language.get("dialect") or None
        voice_design["provider_region"] = voice_design["provider_region"] or catalog_region
        voice_design["rationale"] = voice_design["rationale"] or ("AI 已将原始想法整理为可直接复制到 MiniMax Voice Design 的两段输入。" if voice_design_only else None)

    raw_candidates = proposal.get("voice_candidates") if isinstance(proposal.get("voice_candidates"), list) else proposal.get("voiceCandidates") if isinstance(proposal.get("voiceCandidates"), list) else []
    if not raw_candidates and isinstance(proposal.get("voice_profiles"), list):
        raw_candidates = proposal.get("voice_profiles")
    voice_profiles: list[dict[str, Any]] = []
    voice_candidates: list[dict[str, Any]] = []
    candidate_to_profile: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(raw_candidates[:3], 1):
        if not isinstance(raw, dict):
            continue
        candidate_id = _text(raw.get("candidate_id") or raw.get("candidateId"), 80) or f"voice-candidate-{index}"
        provider_voice_id = _text(raw.get("provider_voice_id") or raw.get("providerVoiceId") or raw.get("voice_id"), 160)
        # A documented fallback catalogue is useful for planning, but it is
        # never an executable source.  Keep those rows visible as references
        # instead of failing the whole conversation when the user's API key
        # or network is temporarily unavailable.
        entry = catalog_entries.get(provider_voice_id)
        if entry is None:
            raise AudioPreparationError(
                f"MiniMax 系统音色 {provider_voice_id or '（空）'} 不在当前目录中。",
                "catalog-stale",
                409,
            )
        entry_source = _text(entry.get("source"), 40) or "system"
        documented_only = catalog_status not in {"live", "cached"}
        if entry_source != "system":
            raise AudioPreparationError(
                f"声音助手只能选择 MiniMax system preset，不能使用 {entry_source} 音色。",
                "catalog-stale",
                409,
            )
        if not documented_only:
            entry = validate_system_voice(provider_voice_id, catalog, provider_region=_text(raw.get("provider_region") or raw.get("providerRegion"), 20) or catalog_region)
        selectable = catalog_status in {"live", "cached"}
        catalog_source = catalog_status if selectable else "documented"
        voice_candidates.append({
            "candidate_id": candidate_id,
            "provider_voice_id": provider_voice_id,
            "provider_voice_name": _text(raw.get("provider_voice_name") or raw.get("providerVoiceName") or entry.get("name") or provider_voice_id, 180),
            "catalog_source": catalog_source,
            "provider_region": catalog_region,
            "language": _text(raw.get("language") or entry.get("language"), 80),
            "locale": _text(raw.get("locale"), 40) or ("ja-JP" if _text(entry.get("language"), 40) == "Japanese" else ""),
            "description": _text(entry.get("description") or raw.get("description"), 500),
            "rationale": _text(raw.get("rationale") or raw.get("reason"), 700),
            "recommendation_rank": _safe_rank(raw.get("recommendation_rank") or raw.get("recommendationRank"), index),
            "selectable": selectable,
        })
        if documented_only:
            continue
        profile_input = raw.get("profile") if isinstance(raw.get("profile"), dict) else raw
        profile = _voice_record(profile_input, entry, catalog_region, focus_value, candidate_id)
        existing_id = _record_id(raw.get("target_id") or raw.get("targetId") or profile_input.get("id"))
        if existing_id:
            profile["id"] = existing_id
        existing = _find_existing(stored_voices, existing_id) if existing_id else None
        if existing and _text(existing.get("status"), 40) == "approved":
            raise AudioPreparationError(f"已批准的声音 profile {existing_id} 不能由声音助手覆盖。", "protected-state", 409)
        candidate_to_profile[candidate_id] = profile
        voice_profiles.append(profile)

    raw_dialogues = proposal.get("dialogue_candidates") if isinstance(proposal.get("dialogue_candidates"), list) else proposal.get("dialogues") if isinstance(proposal.get("dialogues"), list) else []
    dialogue_candidates: list[dict[str, Any]] = []
    dialogue_operations: list[dict[str, Any]] = []
    incomplete_dialogue_count = 0
    dialogue_context_hint: dict[str, str] = _language_context(voice_design)
    for index, raw in enumerate(raw_dialogues[:16], 1):
        if not isinstance(raw, dict):
            continue
        candidate_id = _text(raw.get("candidate_id") or raw.get("candidateId"), 80) or f"dialogue-candidate-{index}"
        source_text = _text(raw.get("source_text") or raw.get("sourceText") or raw.get("text"), 9999)
        if not source_text:
            # A candidate ID is not a dialogue.  Keeping an empty row visible
            # makes it look selectable and lets an empty operation leak into
            # the workbench.  Ask for the smallest missing input instead.
            incomplete_dialogue_count += 1
            continue
        requested_voice_candidate_id = _record_id(raw.get("voice_candidate_id") or raw.get("voiceCandidateId"))
        selected_voice = candidate_to_profile.get(requested_voice_candidate_id)
        if selected_voice is None and len(candidate_to_profile) == 1:
            selected_voice = next(iter(candidate_to_profile.values()))
        context_hint = _language_context(raw, selected_voice, voice_design)
        if context_hint:
            dialogue_context_hint = context_hint
        record = _dialogue_record(raw, focus_value, candidate_id, valid_shots, context_hint)
        if not record.get("language") or not record.get("locale"):
            # We may fill language metadata only from a selected voice, an
            # explicit provider value, or a Voice Design package.  The text
            # itself does not establish a safe target locale.
            incomplete_dialogue_count += 1
            continue
        if not record.get("voice_id") and not record.get("voice_candidate_id") and len(candidate_to_profile) == 1:
            # With one proposed voice there is no ambiguity: bind the line to
            # that candidate so applying the selected operations fills the
            # dialogue form instead of leaving a preventable orphan draft.
            record["voice_candidate_id"] = next(iter(candidate_to_profile))
        target_id = _record_id(raw.get("target_id") or raw.get("targetId") or record.get("id"))
        if target_id:
            record["id"] = target_id
        existing = _find_existing(stored_dialogues, target_id) if target_id else None
        if existing and _text(existing.get("execution_status"), 60) in {"approved", "generated-pending-qa"}:
            raise AudioPreparationError(f"已有对白 {target_id} 处于受保护或已生成状态，不能覆盖。", "protected-state", 409)
        dialogue_candidates.append({
            "candidate_id": candidate_id,
            "source_idea": _text(raw.get("source_idea") or raw.get("sourceIdea"), 1200),
            "meaning_cn": _text(raw.get("meaning_cn") or raw.get("meaningCn"), 700),
            **deepcopy(record),
        })
        dialogue_operations.append(_operation(
            f"OP_AUDIO_DIALOGUE_{index:03d}",
            "update_dialogue_draft" if target_id else "create_dialogue_draft",
            "dialogue",
            candidate_id,
            record,
            existing,
        ))

    raw_auditions = proposal.get("audition_matrix") if isinstance(proposal.get("audition_matrix"), list) else proposal.get("auditions") if isinstance(proposal.get("auditions"), list) else []
    audition_matrix: list[dict[str, Any]] = []
    audition_operations: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_auditions[:24], 1):
        if not isinstance(raw, dict):
            continue
        voice_candidate_id = _text(raw.get("voice_candidate_id") or raw.get("voiceCandidateId") or raw.get("candidate_id") or raw.get("candidateId"), 80)
        voice = candidate_to_profile.get(voice_candidate_id)
        if voice is None and voice_profiles:
            voice = voice_profiles[0]
        if voice is None:
            if catalog_status not in {"live", "cached"}:
                # A documented catalogue can still support a comparison plan,
                # but it must remain visibly reference-only and must not create
                # an executable audition operation without a saved profile.
                language = _text(raw.get("language"), 80) or "Japanese"
                locale = _text(raw.get("locale"), 40) or ("ja-JP" if language == "Japanese" else "")
                voice = {
                    "assistant_candidate_id": voice_candidate_id or "documented-reference",
                    "candidate_id": voice_candidate_id or "documented-reference",
                    "character_id": _record_id(raw.get("character_id")) or _record_id(focus_value.get("character_id")) or None,
                    "locale": locale,
                    "language": language,
                    "dialect": _text(raw.get("dialect"), 120) or ("Standard Japanese" if language == "Japanese" else ""),
                    "language_boost": _language_boost(locale, language, raw.get("language_boost")),
                    "provider_region": catalog_region,
                }
            else:
                raise AudioPreparationError("audition 没有关联可用的系统音色候选。")
        candidate_id = _text(raw.get("audition_candidate_id") or raw.get("auditionCandidateId"), 80) or f"audition-candidate-{index}"
        record = _audition_record(raw, voice, focus_value, candidate_id)
        target_id = _record_id(raw.get("target_id") or raw.get("targetId") or record.get("id"))
        if target_id:
            record["id"] = target_id
        existing = _find_existing(stored_auditions, target_id) if target_id else None
        if existing and (_text(existing.get("status"), 60) == "approved" or existing.get("artifact_id")):
            raise AudioPreparationError(f"已有 audition {target_id} 处于受保护或已生成状态，不能覆盖。", "protected-state", 409)
        if catalog_status not in {"live", "cached"}:
            record["status"] = "planned"
            record["notes"] = "目录仅为 documented 参考；修复 MiniMax 凭据/网络并刷新后才能应用或生成。"
        audition_matrix.append({"candidate_id": candidate_id, **deepcopy(record)})
        if catalog_status not in {"live", "cached"}:
            continue
        audition_operations.append(_operation(
            f"OP_AUDIO_AUDITION_{index:03d}",
            "update_audition_draft" if target_id else "create_audition_draft",
            "audition",
            candidate_id,
            record,
            existing,
        ))

    # If OpenCode supplied profiles but no audition matrix, create the three
    # standard preparation rows for each selected profile.  This is still a
    # draft-only operation and does not create a billable request.
    if voice_profiles and dialogue_candidates and not audition_operations:
        default_text = _text((dialogue_candidates[0] if dialogue_candidates else {}).get("source_text"), 9999)
        conditions = ("neutral", "emotional", "pronunciation-stress")
        for voice_index, voice in enumerate(voice_profiles, 1):
            for condition in conditions:
                index = (voice_index - 1) * 3 + len([item for item in audition_operations if item.get("content", {}).get("candidate_id", "").startswith("audition-candidate-")]) + 1
                candidate_id = f"audition-candidate-{voice_index}-{condition}"
                record = _audition_record({"condition": condition, "source_text": default_text, "provider_text": default_text}, voice, focus_value, candidate_id)
                audition_matrix.append({"candidate_id": candidate_id, **deepcopy(record)})
                audition_operations.append(_operation(f"OP_AUDIO_AUDITION_{len(audition_operations) + 1:03d}", "create_audition_draft", "audition", candidate_id, record))

    operations = []
    for index, profile in enumerate(voice_profiles, 1):
        target_id = _record_id(profile.get("id"))
        existing = _find_existing(stored_voices, target_id) if target_id else None
        operations.append(_operation(
            f"OP_AUDIO_VOICE_{index:03d}",
            "update_voice_profile_draft" if target_id else "create_voice_profile_draft",
            "voice_profile",
            _text(profile.get("assistant_candidate_id"), 80) or f"voice-candidate-{index}",
            profile,
            existing,
        ))
    operations.extend(audition_operations)
    operations.extend(dialogue_operations)
    for operation in operations:
        if _contains_forbidden(operation):
            raise AudioPreparationError("声音助手候选包含不允许的生成、登记或 QA 状态。")

    questions = proposal.get("questions") if isinstance(proposal.get("questions"), list) else proposal.get("next_questions") if isinstance(proposal.get("next_questions"), list) else []
    questions = [{
        "id": _text(item.get("id"), 80) or f"question-{index}",
        "question": _text(item.get("question") or item.get("text"), 500),
        "reason": _text(item.get("reason"), 500),
        "required": bool(item.get("required", True)),
        "options": _string_list(item.get("options"), 8),
    } for index, item in enumerate(questions[:3], 1) if isinstance(item, dict) and _text(item.get("question") or item.get("text"), 500)]
    blockers = _string_list(proposal.get("blockers") or proposal.get("blocked_reasons"), 16)
    if catalog_status not in {"live", "cached"}:
        blockers.append("MiniMax 系统音色目录不可执行；需要先修复凭据或网络并刷新目录。")
    if not dialogue_candidates:
        language_hint = dialogue_context_hint.get("language") or "目标"
        locale_hint = dialogue_context_hint.get("locale") or "未指定 locale"
        blockers.append("尚未形成可审阅的逐句对白候选；请确认目标语言和实际台词。")
        if not any(item.get("id") == "target-dialogue-required" for item in questions):
            questions.append({
                "id": "target-dialogue-required",
                "question": f"请补全要用 {language_hint}（{locale_hint}）朗读的实际台词。可以直接给出目标语言文本，或明确让我先提供翻译候选。",
                "reason": "当前候选缺少可朗读文本或语言/locale，不能回填、试听或复制到 MiniMax。",
                "required": True,
                "options": ["直接提供目标语言台词", "请先给出翻译候选"],
            })
    requested_model = _text((proposal.get("preflight") or {}).get("model") if isinstance(proposal.get("preflight"), dict) else "", 80) or "speech-2.8-hd"
    if requested_model not in {"speech-2.8-hd", "speech-2.8-turbo"}:
        requested_model = "speech-2.8-hd"
    preflight = {
        "provider": "minimax",
        "model": requested_model,
        "provider_region": catalog_region,
        "language_boost": (dialogue_candidates[0].get("language_boost") if dialogue_candidates else voice_profiles[0].get("language_boost") if voice_profiles else None),
        "format": "wav",
        "text_chars": sum(len(_text(item.get("provider_text"), 9999)) for item in dialogue_candidates),
        "planned_count": len(dialogue_candidates) + len(audition_matrix),
        "requires_text_confirmation": True,
        "requires_cost_confirmation": True,
        "can_generate": False,
        "blockers": list(dict.fromkeys(blockers)),
    }
    if not dialogue_candidates and state != "blocked":
        state = "needs_clarification"
    elif state == "ready_for_review" and blockers:
        state = "blocked" if any("不可执行" in item or "不存在" in item for item in blockers) else state
    normalized_proposal = {
        "proposal_version": AUDIO_ASSISTANT_CONTRACT_VERSION,
        "mode": AUDIO_ASSISTANT_MODE,
        "state": state,
        "source_idea": _text(proposal.get("source_idea") or proposal.get("sourceIdea"), 2000),
        "intent_summary": _text(proposal.get("intent_summary") or proposal.get("intentSummary") or proposal.get("summary"), 2000),
        "focus": focus_value,
        "questions": questions,
        "voice_candidates": voice_candidates,
        "voice_profiles": voice_profiles,
        "voice_design": voice_design,
        "dialogue_candidates": dialogue_candidates,
        "audition_matrix": audition_matrix,
        "preflight": preflight,
        "checks": [
            {"code": "catalog", "status": "pass" if catalog_status in {"live", "cached"} else "blocked", "message": f"MiniMax 系统音色目录：{catalog_status}"},
            {"code": "target_dialogue", "status": "pass" if dialogue_candidates else "blocked", "message": "目标语言台词已形成候选" if dialogue_candidates else f"已拦截 {incomplete_dialogue_count or len(raw_dialogues)} 条不完整台词候选"},
            {"code": "text_confirmation", "status": "warning", "message": "台词仍需用户确认"},
        ],
        "operation_ids": [str(item["id"]) for item in operations],
        "contract_snapshot": deepcopy(contract_snapshot),
    }
    patch = {
        "version": 1,
        "base_project_revision": 1,
        "base_graph_revision": 1,
        "actions": ["audio_preparation"],
        "requires_confirmation": True,
        "notes": "声音助手只产生声音工坊草稿候选，不执行 MiniMax TTS。",
        "workspace_operations": operations,
    }
    return {
        "reply": _text(payload.get("reply") or payload.get("message"), 12000) or "已形成声音工坊可审阅的前置准备草案。",
        "proposal": normalized_proposal,
        "patch": patch,
        "actions": ["audio_preparation"],
        "next_skill": "voice-controller",
        "requires_confirmation": True,
    }


def _next_id(prefix: str, records: list[Any]) -> str:
    used = {_record_id(item.get("id")) for item in records if isinstance(item, dict)}
    index = 1
    while f"{prefix}{index:03d}" in used:
        index += 1
    return f"{prefix}{index:03d}"


def _safe_record(record: dict[str, Any], allowed: set[str]) -> dict[str, Any]:
    if _contains_forbidden(record):
        raise AudioPreparationError("声音草稿包含受保护字段。")
    return {key: deepcopy(value) for key, value in record.items() if key in allowed}


def _merge_record(rows: list[dict[str, Any]], record: dict[str, Any], allowed: set[str], *, prefix: str, default_status: str) -> tuple[list[dict[str, Any]], str, bool]:
    cleaned = _safe_record(record, allowed)
    record_id = _record_id(cleaned.get("id"))
    if record_id:
        current = next((item for item in rows if _record_id(item.get("id")) == record_id), None)
        if current is not None:
            if _text(current.get("status") or current.get("execution_status"), 80) in {"approved", "generated-pending-qa"}:
                raise AudioPreparationError(f"已存在的 {record_id} 处于受保护状态。", "protected-state", 409)
            current.update(cleaned)
            return rows, record_id, False
    record_id = _next_id(prefix, rows)
    cleaned["id"] = record_id
    rows.append(cleaned)
    return rows, record_id, True


def apply_audio_preparation_operations(
    document: dict[str, Any],
    operations: list[dict[str, Any]],
    selected_operation_ids: set[str],
) -> tuple[dict[str, Any], dict[str, str], list[str]]:
    """Apply only bounded audio draft operations to a copy of the document."""

    result = deepcopy(document)
    result["version"] = max(2, int(result.get("version") or 1))
    result["schema_version"] = "minimax-speech-audio-v2"
    result["schemaVersion"] = "minimax-speech-audio-v2"
    result.setdefault("voices", [])
    result.setdefault("auditions", [])
    result.setdefault("dialogues", [])
    result.setdefault("takes", [])
    id_map: dict[str, str] = {}
    applied: list[str] = []
    selected = [item for item in operations if _record_id(item.get("id")) in selected_operation_ids]
    if not selected:
        raise AudioPreparationError("没有选择可应用的声音草稿操作。")

    # Voice IDs must be allocated first so dialogue/audition references can
    # use candidate_id without the model inventing a stable project ID.
    ordered = [item for item in selected if isinstance(item.get("content"), dict) and item["content"].get("audio_target") == "voice_profile"]
    ordered += [item for item in selected if item not in ordered]
    for operation in ordered:
        content = operation.get("content") if isinstance(operation.get("content"), dict) else {}
        target = _text(content.get("audio_target"), 40)
        candidate_id = _text(content.get("candidate_id"), 100)
        record = content.get("record") if isinstance(content.get("record"), dict) else operation.get("after") if isinstance(operation.get("after"), dict) else {}
        if target == "voice_profile":
            record = _safe_record(record, VOICE_FIELDS)
            record["source_type"] = "preset"
            record["provider"] = "minimax"
            record["provider_voice_source"] = "system"
            record["consent_status"] = "not-required"
            record["status"] = "draft"
            if record.get("provider_voice_id"):
                record["continuity_anchor"] = {
                    **(record.get("continuity_anchor") if isinstance(record.get("continuity_anchor"), dict) else {}),
                    "provider_voice_id": record["provider_voice_id"],
                }
            result["voices"], new_id, _ = _merge_record(result["voices"], record, VOICE_FIELDS, prefix="V", default_status="draft")
            if candidate_id:
                id_map[candidate_id] = new_id
            applied.append(_record_id(operation.get("id")))

    for operation in ordered:
        content = operation.get("content") if isinstance(operation.get("content"), dict) else {}
        target = _text(content.get("audio_target"), 40)
        if target == "voice_profile":
            continue
        candidate_id = _text(content.get("candidate_id"), 100)
        record = content.get("record") if isinstance(content.get("record"), dict) else operation.get("after") if isinstance(operation.get("after"), dict) else {}
        if target == "audition":
            record = _safe_record(record, AUDITION_FIELDS)
            voice_candidate_id = _text(record.get("voice_candidate_id"), 100)
            if voice_candidate_id and voice_candidate_id not in id_map and not _record_id(record.get("voice_id")):
                raise AudioPreparationError("试听草稿依赖人物声音候选，请同时选择对应的声音 profile 操作。")
            record["voice_id"] = id_map.get(voice_candidate_id, _record_id(record.get("voice_id")) or None)
            record.pop("voice_candidate_id", None)
            record["text_status"] = "candidate" if _text(record.get("source_text") or record.get("text")) else "missing"
            record["status"] = "user-confirmation-required" if record["text_status"] == "candidate" else "planned"
            record.pop("artifact_id", None)
            record.pop("qa_run_id", None)
            result["auditions"], _, _ = _merge_record(result["auditions"], record, AUDITION_FIELDS, prefix="AUD", default_status="planned")
        elif target == "dialogue":
            record = _safe_record(record, DIALOGUE_FIELDS)
            voice_candidate_id = _text(record.get("voice_candidate_id"), 100)
            if voice_candidate_id and voice_candidate_id not in id_map and not _record_id(record.get("voice_id")):
                raise AudioPreparationError("对白草稿依赖人物声音候选，请同时选择对应的声音 profile 操作。")
            record["voice_id"] = id_map.get(voice_candidate_id, _record_id(record.get("voice_id")) or None)
            record.pop("voice_candidate_id", None)
            record["text_status"] = "candidate" if _text(record.get("source_text") or record.get("text")) else "missing"
            record["execution_status"] = "user-confirmation-required" if record["text_status"] == "candidate" else "planned"
            record["operation"] = "tts"
            record.pop("artifact_id", None)
            record.pop("qa_run_id", None)
            record.pop("selected_take_id", None)
            result["dialogues"], _, _ = _merge_record(result["dialogues"], record, DIALOGUE_FIELDS, prefix="DLG", default_status="planned")
        else:
            raise AudioPreparationError("声音助手尝试应用未知的目标类型。")
        applied.append(_record_id(operation.get("id")))
    return result, id_map, applied


__all__ = [
    "AUDIO_ASSISTANT_CONTRACT_VERSION",
    "AUDIO_ASSISTANT_MODE",
    "AUDIO_ASSISTANT_SKILL_ID",
    "AUDIO_ASSISTANT_RISK",
    "AudioPreparationError",
    "apply_audio_preparation_operations",
    "audio_document_hash",
    "audio_preparation_result_schema",
    "build_audio_assistant_context",
    "normalize_voice_preparation_result",
    "validate_system_voice",
]
