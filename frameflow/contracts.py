"""The live FRAMEFLOW contract bundle used by the Agent workspace.

The workbench already owns the prompt, story, audio and workflow rules.  This
module only publishes those rules as one versioned, hashable read model so an
Agent run can record exactly which rules it used.  It intentionally does not
copy or maintain a second set of production rules.
"""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from typing import Any

from .prompt_design import (
    AUDIO_PROMPT_FIELD_ORDER,
    AUDIO_PROMPT_SCHEMA_VERSION,
    PROMPT_CONTRACT_VERSION,
    PROMPT_FIELD_ORDER,
    PROMPT_WORKFLOW_ID,
    prompt_contract,
    prompt_contract_instructions,
)
from .story import SHOT_DETAIL_FIELDS, SHOT_REQUIRED_FIELDS
from .workflows import WORKFLOWS, workflow_manifest


BUNDLE_VERSION = "1.0"
STORY_CONTRACT_VERSION = "1.0"
WORKFLOW_CONTRACT_VERSION = "1.0"

STORY_VALIDATION_RULES = [
    "shot_id_unique",
    "scene_id_unique",
    "shot_required_fields",
    "shot_duration_positive",
    "scene_references_known",
    "dialogue_duration_fits_shot",
    "continuity_is_explicit_when_state_changes",
    "asset_dependencies_preserved",
    "generator_duration_limit",
]

WORKSPACE_CAPABILITIES = {
    "automatic": [
        "text_analysis",
        "candidate_draft",
        "asset_gap_check",
        "continuity_check",
        "node_orchestration",
        "cost_estimate",
        "audio_voice_preparation",
    ],
    "supervised_apply": [
        "story_draft",
        "prompt_candidate",
        "audio_draft",
        "audio_voice_profile_draft",
        "audio_audition_draft",
        "audio_dialogue_draft",
        "timeline_draft",
        "workflow_patch",
    ],
    "never_execute": [
        "media_generation",
        "audio_generation",
        "voice_clone",
        "voice_design",
        "asset_registration",
        "active_asset_replacement",
        "publish",
        "github_sync",
    ],
}

VOICE_PREPARATION_CONTRACT = {
    "version": "voice-preparation-v1",
    "mode": "voice-preparation",
    "planning_provider": "OpenCode",
    "generation_provider": "MiniMax",
    "allowed_operations": [
        "create_voice_profile_draft",
        "update_voice_profile_draft",
        "create_audition_draft",
        "update_audition_draft",
        "create_dialogue_draft",
        "update_dialogue_draft",
    ],
    "forbidden_operations": [
        "generate_audio",
        "create_take",
        "register_artifact",
        "approve_qa",
        "replace_active_voice",
        "voice_clone",
        "voice_design",
        "speech_to_speech",
    ],
    "allowed_voice_source": ["system-preset"],
    "text_status_before_user_confirmation": ["missing", "candidate", "conflict"],
    "assistant_may_set_confirmed": False,
    "assistant_may_execute_tts": False,
    "assistant_may_write_project": False,
    "max_questions": 3,
    "max_voice_candidates": 3,
    "max_dialogue_candidates": 16,
    "one_dialogue_per_task": True,
    "provider_rules": {
        "models": ["speech-2.8-hd", "speech-2.8-turbo"],
        "formats": ["mp3", "wav", "flac"],
        "speed": {"min": 0.5, "max": 2.0},
        "pitch": {"min": -12, "max": 12},
        "volume": {"min": 0, "max": 10},
        "language_boost_is_locale_derived": True,
        "instructions_is_internal_only": True,
    },
}


def _stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _bundle_hash(bundle: dict[str, Any]) -> str:
    payload = {key: value for key, value in bundle.items() if key != "bundle_hash"}
    return hashlib.sha256(_stable_json(payload).encode("utf-8")).hexdigest()


def contract_bundle() -> dict[str, Any]:
    """Return the current machine-readable contract snapshot.

    The result is rebuilt for every call.  This is deliberate: if a developer
    updates the authoritative prompt/story/audio/workflow modules while the
    server is running, the next Agent request sees the new bundle instead of a
    stale module-level cache.
    """

    workflows = [workflow_manifest(skill_id) for skill_id in WORKFLOWS]
    bundle: dict[str, Any] = {
        "bundle_version": BUNDLE_VERSION,
        "prompt_contract": {
            "version": PROMPT_CONTRACT_VERSION,
            "workflow": PROMPT_WORKFLOW_ID,
            "field_order": list(PROMPT_FIELD_ORDER),
            "contract": prompt_contract("all"),
        },
        "story_contract": {
            "version": STORY_CONTRACT_VERSION,
            "required_shot_fields": list(SHOT_REQUIRED_FIELDS),
            "detail_fields": list(SHOT_DETAIL_FIELDS),
            "validation_rules": list(STORY_VALIDATION_RULES),
        },
        "audio_contract": {
            "version": AUDIO_PROMPT_SCHEMA_VERSION,
            "required_fields": list(AUDIO_PROMPT_FIELD_ORDER),
            "contract": prompt_contract("audio"),
        },
        "voice_preparation_contract": deepcopy(VOICE_PREPARATION_CONTRACT),
        "workflow_contract": {
            "version": WORKFLOW_CONTRACT_VERSION,
            "available_skills": workflows,
        },
        "workspace_capabilities": deepcopy(WORKSPACE_CAPABILITIES),
    }
    bundle["bundle_hash"] = _bundle_hash(bundle)
    return bundle


def contract_snapshot(bundle: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return the compact version/hash snapshot persisted on each run."""

    current = bundle or contract_bundle()
    return {
        "bundle_version": current["bundle_version"],
        "bundle_hash": current["bundle_hash"],
        "prompt_contract_version": current["prompt_contract"]["version"],
        "prompt_workflow": current["prompt_contract"]["workflow"],
        "story_contract_version": current["story_contract"]["version"],
        "audio_contract_version": current["audio_contract"]["version"],
        "voice_preparation_contract_version": current["voice_preparation_contract"]["version"],
        "workflow_contract_version": current["workflow_contract"]["version"],
    }


def contract_for(scope: str) -> dict[str, Any]:
    """Return one live contract read model for the public read-only API."""

    bundle = contract_bundle()
    normalized = str(scope or "all").strip().lower()
    if normalized in {"all", "bundle", "contracts"}:
        return bundle
    mapping = {
        "prompt": "prompt_contract",
        "story": "story_contract",
        "audio": "audio_contract",
        "voice-preparation": "voice_preparation_contract",
        "voice_preparation": "voice_preparation_contract",
        "workflow": "workflow_contract",
        "workflows": "workflow_contract",
    }
    key = mapping.get(normalized)
    if key is None:
        raise KeyError(scope)
    return {"scope": normalized, "bundle_hash": bundle["bundle_hash"], **deepcopy(bundle[key])}


def assistant_system_instructions(
    bundle: dict[str, Any] | None = None,
    skill: dict[str, Any] | None = None,
) -> str:
    """Build the backend-owned Agent system instructions from live rules."""

    current = bundle or contract_bundle()
    prompt = current["prompt_contract"]
    story = current["story_contract"]
    audio = current["audio_contract"]
    voice_preparation = current["voice_preparation_contract"]
    capabilities = current["workspace_capabilities"]
    instructions = (
        "你是 FRAMEFLOW V3 桌面工作台内的监督式创作 Agent。"
        "只返回自然语言回复和可审阅的结构化候选/计划，不直接修改项目，不执行图片、音频、视频、渲染、发布或 GitHub 同步。"
        "所有跨工作区修改都必须以 workspace_operations 或候选版本表达，由用户逐项选择后才可应用。"
        "不得覆盖 active 资产、批准版本、历史版本或用户未勾选的字段。不得伪造 QA 已通过、资产已登记、媒体已生成或已发布。"
        "稳定 ID、项目版本、图版本、时间线版本和规范 hash 必须保留；未知事实标记为待确认。回答使用中文。"
        f"当前 FRAMEFLOW Contract Bundle v{current['bundle_version']}，hash={current['bundle_hash']}。"
        f"Prompt Contract v{prompt['version']} / {prompt['workflow']}；字段顺序：{','.join(prompt['field_order'])}。"
        f"Story Contract v{story['version']}；镜头必填字段：{','.join(story['required_shot_fields'])}；"
        f"连续性字段：{','.join(story['detail_fields'])}。"
        f"Audio Contract {audio['version']}；音频字段顺序：{','.join(audio['required_fields'])}。"
        f"声音前置准备 Contract {voice_preparation['version']}；只允许：{','.join(voice_preparation['allowed_operations'])}。"
        f"声音助手禁止执行：{','.join(voice_preparation['forbidden_operations'])}。"
        f"允许的监督式候选范围：{','.join(capabilities['supervised_apply'])}。"
        f"永不执行：{','.join(capabilities['never_execute'])}。"
        "Prompt 候选必须通过后端 normalize_prompt_pack、canonicalize_prompt_output、assess_prompt_pack；"
        "剧本/分镜候选必须符合 StoryDocumentUpdateV3 并通过 story_checks；"
        "音频候选必须使用 MiniMax Speech Web 字段并按镜头拆分，不把资产 ID、QA 或混音说明放进朗读文本。"
        "声音前置准备模式只在声音资产工坊内使用：OpenCode 负责理解与候选草案，MiniMax 只负责用户确认后的实际 TTS；"
        "voice profile、audition 和 dialogue 只能以 draft/candidate 形式回填，不得生成 Take、artifact、QA 或 production-ready 状态。"
        "附件只能按后端标记的 multimodal、extracted_text 或 project_reference 使用；不要输出本地绝对路径、密钥或凭据。"
    )
    instructions += " " + prompt_contract_instructions()
    if skill:
        instructions += (
            f"当前 Skill：{skill.get('skill_id')} v{skill.get('skill_version')}；"
            f"审批策略：{skill.get('approval_policy')}；"
            f"确定性门禁：{','.join(str(item) for item in skill.get('deterministic_gates') or [])}。"
        )
    return instructions


__all__ = [
    "BUNDLE_VERSION",
    "STORY_CONTRACT_VERSION",
    "WORKFLOW_CONTRACT_VERSION",
    "VOICE_PREPARATION_CONTRACT",
    "contract_bundle",
    "contract_for",
    "contract_snapshot",
    "assistant_system_instructions",
]
