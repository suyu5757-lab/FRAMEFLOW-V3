from __future__ import annotations

import base64
import json
import time
from typing import Any, AsyncIterator

import httpx

from .prompt_design import prompt_contract_instructions


class ProviderError(RuntimeError):
    def __init__(self, message: str, kind: str = "retryable", status_code: int = 502) -> None:
        super().__init__(message)
        self.kind = kind
        self.status_code = status_code


MINIMAX_TTS_MODELS = (
    "speech-2.8-hd",
    "speech-2.8-turbo",
    "speech-2.6-hd",
    "speech-2.6-turbo",
    "speech-02-hd",
    "speech-02-turbo",
    "speech-01-hd",
    "speech-01-turbo",
)
MINIMAX_DEFAULT_TTS_MODEL = "speech-2.8-hd"
MINIMAX_TTS_FORMATS = frozenset({"mp3", "wav", "flac"})
MINIMAX_DEFAULT_VOICE_ID = "male-qn-qingse"
MINIMAX_TTS_SPEED_MIN = 0.5
MINIMAX_TTS_SPEED_MAX = 2.0
MINIMAX_TTS_EMOTIONS = frozenset({"happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "whisper", "whipser"})
MINIMAX_TTS_EMOTION_ALIASES = {
    "restrained": "calm",
    "restrained-emotional": "calm",
    "pronunciation-stress": "calm",
    "neutral": "calm",
}


def minimax_api_url(profile: dict[str, Any], path: str) -> str:
    """Build a MiniMax endpoint from either a root URL or a /v1 base URL."""
    base_url = str(profile.get("base_url") or "").rstrip("/")
    clean_path = path.lstrip("/")
    if base_url.endswith("/v1"):
        return f"{base_url}/{clean_path}"
    return f"{base_url}/v1/{clean_path}"


def _minimax_base_response_error(payload: dict[str, Any]) -> None:
    base_resp = payload.get("base_resp")
    if not isinstance(base_resp, dict):
        return
    status_code = base_resp.get("status_code")
    if status_code in (None, "", 0, "0"):
        return
    message = str(base_resp.get("status_msg") or base_resp.get("status_message") or "MiniMax API 请求失败")
    # MiniMax may report an application error in a HTTP 200 response. Keep the
    # error safe for the UI and let the normal Provider error contract classify it.
    raise ProviderError(f"MiniMax API：{message}", "validation", 502)


def _minimax_voice_catalog(payload: dict[str, Any]) -> list[dict[str, Any]]:
    catalog: list[dict[str, Any]] = []
    for source, group in (
        ("system", payload.get("system_voice")),
        ("cloning", payload.get("voice_cloning")),
        ("generation", payload.get("voice_generation")),
    ):
        if not isinstance(group, list):
            continue
        for item in group:
            if isinstance(item, str) and item.strip():
                catalog.append({"voice_id": item.strip(), "source": source, "name": item.strip()})
                continue
            if not isinstance(item, dict):
                continue
            voice_id = item.get("voice_id") or item.get("id")
            if not voice_id:
                continue
            # Return only voice-directory fields. This avoids accidentally
            # carrying provider metadata into the project or browser payload.
            entry = {
                "voice_id": str(voice_id),
                "source": source,
                "name": str(item.get("voice_name") or item.get("name") or voice_id),
            }
            for key in ("description", "language", "gender", "age", "supported_emotion", "created_at"):
                if item.get(key) is not None:
                    entry[key] = item[key]
            catalog.append(entry)
    return catalog[:1000]


def minimax_tts_payload(profile: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    """Translate the provider-neutral speech request into MiniMax T2A v2."""
    config = profile.get("model_config") if isinstance(profile.get("model_config"), dict) else {}
    configured_audio = config.get("audio_setting") if isinstance(config.get("audio_setting"), dict) else {}
    model = str(request.get("model") or config.get("tts_model") or MINIMAX_DEFAULT_TTS_MODEL)
    voice_id = str(request.get("voice") or request.get("voice_id") or config.get("voice_id") or MINIMAX_DEFAULT_VOICE_ID)
    output_format = str(request.get("format") or configured_audio.get("format") or "wav").lower()
    voice_setting: dict[str, Any] = {
        "voice_id": voice_id,
        "speed": request.get("speed", 1.0),
        "vol": request.get("volume", config.get("volume", 1.0)),
        "pitch": request.get("pitch", config.get("pitch", 0)),
    }
    emotion = str(request.get("emotion") or config.get("emotion") or "").strip().lower()
    emotion = MINIMAX_TTS_EMOTION_ALIASES.get(emotion, emotion)
    if emotion in MINIMAX_TTS_EMOTIONS:
        voice_setting["emotion"] = emotion
    audio_setting = {
        "sample_rate": request.get("sample_rate") or configured_audio.get("sample_rate") or 32000,
        "bitrate": request.get("bitrate") or configured_audio.get("bitrate") or 128000,
        "format": output_format,
        "channel": configured_audio.get("channel") or 1,
    }
    payload: dict[str, Any] = {
        "model": model,
        "text": str(request.get("text") or ""),
        "stream": False,
        "voice_setting": voice_setting,
        "audio_setting": audio_setting,
        "output_format": "hex",
        "subtitle_enable": False,
        "aigc_watermark": bool(request.get("aigc_watermark", config.get("aigc_watermark", False))),
    }
    language_boost = str(request.get("language_boost") or config.get("language_boost") or "").strip()
    if language_boost:
        payload["language_boost"] = language_boost
    pronunciation_dict = request.get("pronunciation_dict") or config.get("pronunciation_dict")
    if isinstance(pronunciation_dict, dict) and pronunciation_dict:
        payload["pronunciation_dict"] = pronunciation_dict
    if "subtitle_enable" in config:
        payload["subtitle_enable"] = bool(config["subtitle_enable"])
    return payload


async def minimax_speech(profile: dict[str, Any], api_key: str, request: dict[str, Any]) -> tuple[bytes, dict[str, Any]]:
    payload = await request_json("POST", minimax_api_url(profile, "t2a_v2"), api_key, json=request)
    _minimax_base_response_error(payload)
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    audio_hex = data.get("audio")
    if not isinstance(audio_hex, str) or not audio_hex:
        raise ProviderError("MiniMax TTS 未返回音频数据。", "retryable", 502)
    try:
        audio = bytes.fromhex(audio_hex)
    except ValueError as exc:
        raise ProviderError("MiniMax TTS 返回的音频数据无效。", "validation", 502) from exc
    return audio, {
        "trace_id": payload.get("trace_id"),
        "extra_info": payload.get("extra_info") if isinstance(payload.get("extra_info"), dict) else {},
        "status": data.get("status"),
    }


async def minimax_probe(profile: dict[str, Any], api_key: str) -> dict[str, Any]:
    started = time.perf_counter()
    endpoints = [minimax_api_url(profile, "get_voice")]
    # The official documentation lists api-bj.minimaxi.com as a backup address.
    # Retry it only for the bundled official endpoint and only for transport
    # failures; authentication or API validation errors must be returned as-is.
    if str(profile.get("base_url") or "").rstrip("/") == "https://api.minimax.cn/v1":
        endpoints.append("https://api-bj.minimaxi.com/v1/get_voice")
    payload: dict[str, Any] | None = None
    last_transport_error: httpx.RequestError | None = None
    for endpoint in endpoints:
        try:
            payload = await request_json("POST", endpoint, api_key, timeout_seconds=8, json={"voice_type": "all"})
            break
        except (httpx.TimeoutException, httpx.RequestError) as exc:
            last_transport_error = exc
    if payload is None:
        raise ProviderError("无法连接 MiniMax 音色服务，请检查网络或稍后重试。", "connection", 502) from last_transport_error
    _minimax_base_response_error(payload)
    models = list(MINIMAX_TTS_MODELS)
    model_config = profile.get("model_config") if isinstance(profile.get("model_config"), dict) else {}
    model_catalog = [
        {"id": model, "label": model, "description": "MiniMax 同步 TTS 模型"}
        for model in models
    ]
    configured_model = str(model_config.get("tts_model") or "")
    model_readiness = {model: not configured_model or model == configured_model for model in models}
    return {
        "ok": True,
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "models": models,
        "model_catalog": model_catalog,
        "model_readiness": model_readiness,
        "voices": _minimax_voice_catalog(payload),
        "capabilities": ["tts"],
        "server_version": None,
        "error": None,
        "checked_at": time.time(),
    }


def error_from_response(response: httpx.Response) -> ProviderError:
    try:
        payload = response.json()
        detail = payload.get("error", payload)
        if isinstance(detail, dict):
            message = detail.get("message") or detail.get("code") or json.dumps(detail, ensure_ascii=False)
        else:
            message = str(detail)
    except Exception:
        message = f"上游服务返回 HTTP {response.status_code}"
    if response.status_code in {401, 403}:
        kind = "auth"
    elif response.status_code == 402:
        kind = "billing"
    elif response.status_code in {400, 422}:
        kind = "validation"
    elif response.status_code == 429:
        kind = "rate_limit"
    else:
        kind = "retryable"
    return ProviderError(message, kind, response.status_code)


async def request_json(method: str, url: str, api_key: str, **kwargs: Any) -> dict[str, Any]:
    timeout_seconds = kwargs.pop("timeout_seconds", None)
    headers = dict(kwargs.pop("headers", {}))
    headers["Authorization"] = f"Bearer {api_key}"
    headers.setdefault("Content-Type", "application/json")
    timeout = httpx.Timeout(300.0, connect=20.0)
    if timeout_seconds is not None:
        bounded = max(0.5, float(timeout_seconds))
        timeout = httpx.Timeout(bounded, connect=min(8.0, bounded))
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        response = await client.request(method, url, headers=headers, **kwargs)
    if response.status_code >= 400:
        raise error_from_response(response)
    data = response.json()
    if not isinstance(data, dict):
        raise ProviderError("上游服务返回了非对象 JSON。")
    return data


async def probe_profile(profile: dict[str, Any], api_key: str) -> dict[str, Any]:
    if profile["provider_type"] == "opencode":
        # Local import avoids a module cycle: the OpenCode adapter reuses the
        # common ProviderError/HTTP error classification from this module.
        from frameflow.opencode_client import probe_opencode
        return await probe_opencode(profile, api_key)
    if profile["provider_type"] == "jimeng_cli":
        from frameflow.jimeng_cli import probe_jimeng_cli
        return await probe_jimeng_cli(profile, api_key)
    if profile["provider_type"] == "minimax":
        return await minimax_probe(profile, api_key)
    started = time.perf_counter()
    base_url = profile["base_url"].rstrip("/")
    provider_type = profile["provider_type"]
    capabilities = set(profile.get("capabilities") or [])
    models: list[str] = []
    error: str | None = None
    try:
        payload = await request_json("GET", f"{base_url}/models", api_key)
        models = [str(item.get("id")) for item in payload.get("data", []) if isinstance(item, dict) and item.get("id")]
    except ProviderError as exc:
        raise
    configured_models = profile.get("model_config", {})
    capabilities.add("orchestrator")
    if provider_type == "openai":
        capabilities.update({"image", "tts"})
    model_readiness = {}
    return {
        "ok": error is None,
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "models": models[:500],
        "capabilities": sorted(capabilities),
        "model_readiness": model_readiness,
        "error": error,
        "checked_at": time.time(),
    }


PROJECT_PATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "reply": {"type": "string"},
        "patch": {
            "type": ["object", "null"],
            "properties": {
                "brief": {"type": ["string", "null"]},
                "script": {"type": ["string", "null"]},
                "assets": {"type": ["array", "null"], "items": {"type": "object", "properties": {
                    "id": {"type": "string"}, "name": {"type": "string"}, "type": {"type": "string"},
                    "grade": {"type": "string"}, "status": {"type": "string"}, "note": {"type": "string"},
                    "skill": {"type": "string"}, "version": {"type": "integer"}},
                    "required": ["id", "name", "type", "grade", "status", "note", "skill", "version"], "additionalProperties": False}},
                "shots": {"type": ["array", "null"], "items": {"type": "object", "properties": {
                    "id": {"type": "string"}, "scene": {"type": "string"}, "duration": {"type": "number"},
                    "purpose": {"type": "string"}, "size": {"type": "string"}, "camera": {"type": "string"},
                    "action": {"type": "string"}, "status": {"type": "string"}},
                    "required": ["id", "scene", "duration", "purpose", "size", "camera", "action", "status"], "additionalProperties": False}},
                "imagePrompt": {"type": ["string", "null"]},
            },
            "required": ["brief", "script", "assets", "shots", "imagePrompt"],
            "additionalProperties": False,
        },
        "next_skill": {"type": ["string", "null"]},
        "requires_confirmation": {"type": "boolean"},
    },
    "required": ["reply", "patch", "next_skill", "requires_confirmation"],
    "additionalProperties": False,
}


def deepseek_compatible_schema(value: Any) -> Any:
    """Translate complex nullable unions to DeepSeek's supported anyOf dialect."""
    if isinstance(value, list):
        return [deepseek_compatible_schema(item) for item in value]
    if not isinstance(value, dict):
        return value
    converted = {key: deepseek_compatible_schema(item) for key, item in value.items()}
    schema_types = converted.get("type")
    if isinstance(schema_types, list) and any(item in {"object", "array"} for item in schema_types):
        constraints = {key: item for key, item in converted.items() if key != "type"}
        branches: list[dict[str, Any]] = []
        for schema_type in schema_types:
            branch = {"type": schema_type}
            if schema_type in {"object", "array"}:
                branch.update(constraints)
            branches.append(branch)
        return {"anyOf": branches}
    return converted


def project_patch_schema_for(profile: dict[str, Any]) -> dict[str, Any]:
    if "api.deepseek.com" in str(profile.get("base_url", "")).lower():
        return deepseek_compatible_schema(PROJECT_PATCH_SCHEMA)
    return PROJECT_PATCH_SCHEMA


async def openai_assistant(profile: dict[str, Any], api_key: str, model: str, message: str, context: dict[str, Any], skill: dict[str, Any] | None) -> dict[str, Any]:
    instructions = (
        "你是 FRAMEFLOW 视频工作台内的创作助手。只输出对项目的结构化建议，不执行付费媒体调用，"
        "不批准媒体 QA，不更改稳定 ID。所有新增或修改内容必须放入 patch，用户确认后才会应用。"
        "Prompt QA 不代表执行授权。回答使用中文。"
        + prompt_contract_instructions()
    )
    if skill:
        instructions += f" 当前工作流：{skill['skill_id']} v{skill['skill_version']}；审批策略：{skill['approval_policy']}。"
    body = {
        "model": model,
        "store": False,
        "instructions": instructions,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": message + "\n\n项目上下文：" + json.dumps(context, ensure_ascii=False)}]}],
        "text": {"format": {"type": "json_schema", "name": "frameflow_project_patch", "strict": True, "schema": project_patch_schema_for(profile)}},
    }
    payload = await request_json("POST", f"{profile['base_url'].rstrip('/')}/responses", api_key, json=body)
    output_text = payload.get("output_text")
    if not output_text:
        for item in payload.get("output", []):
            for content in item.get("content", []) if isinstance(item, dict) else []:
                if content.get("type") == "output_text":
                    output_text = content.get("text")
                    break
    if not output_text:
        raise ProviderError("供应商 Responses API 未返回文本内容。")
    try:
        result = json.loads(output_text)
    except json.JSONDecodeError as exc:
        raise ProviderError("供应商返回的结构化结果无法解析。", "validation") from exc
    result["response_id"] = payload.get("id")
    result["model"] = payload.get("model", model)
    return result





STORYBOARD_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "sourceScriptVersionId": {"type": ["string", "null"]},
        "proposedScript": {"type": "string"},
        "structure": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
        "beats": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
        "feasibility": {
            "type": "object",
            "properties": {
                "verdict": {"type": "string"},
                "difficulty": {"type": "string"},
                "strengths": {"type": "array", "items": {"type": "string"}},
                "mainIssues": {"type": "array", "items": {"type": "string"}},
                "requiredChanges": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["verdict", "difficulty"],
            "additionalProperties": True,
        },
        "productionElements": {
            "type": "object",
            "additionalProperties": True,
        },
        "scenes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "string"}, "name": {"type": "string"}},
                "required": ["id", "name"],
                "additionalProperties": True,
            },
        },
        "shots": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "scene": {"type": "string"},
                    "duration": {"type": "number"},
                    "purpose": {"type": "string"},
                    "size": {"type": "string"},
                    "camera": {"type": "string"},
                    "action": {"type": "string"},
                    "visibleEvent": {"type": "string"},
                    "eventConsequence": {"type": "string"},
                    "spatialGeography": {"type": ["string", "object"], "additionalProperties": True},
                    "materialEvidence": {"type": ["string", "object"], "additionalProperties": True},
                    "lightingCausality": {"type": ["string", "object"], "additionalProperties": True},
                    "cameraExecution": {"type": "object", "additionalProperties": True},
                    "atmosphereBehavior": {"type": ["string", "object"], "additionalProperties": True},
                    "continuity": {"type": ["string", "array"], "items": {"type": "string"}},
                    "referenceRoles": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
                    "visualStyle": {"type": "object", "additionalProperties": True},
                    "dialogue": {"type": "string"},
                    "environment": {"type": "string"},
                    "sound": {"type": "string"},
                    "generationMethod": {"type": "string"},
                    "difficulty": {"type": "string"},
                    "risks": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["id", "scene", "duration", "purpose", "size", "camera", "action"],
                "additionalProperties": True,
            },
        },
        "risks": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
        "assetHandoff": {
            "type": "object",
            "properties": {
                "characters": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
                "scenes": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
                "props": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
                "soundRequirements": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
                "assetDependencyDraft": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
            },
            "additionalProperties": True,
        },
        "assumptions": {"type": "array", "items": {"type": "string"}},
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["proposedScript", "feasibility", "productionElements", "scenes", "shots", "risks", "assetHandoff"],
    "additionalProperties": True,
}

REGULATOR_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "assetExtraction": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
        "assetRequirements": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "shotId": {"type": "string"},
                "assetId": {"type": "string"},
                "assetClass": {"type": "string"},
                "role": {"type": "string"},
                "priority": {"type": "string"},
                "required": {"type": "boolean"},
                "requiredReadiness": {"type": "string"},
            },
            "required": ["shotId", "assetId", "assetClass"],
            "additionalProperties": True,
        }},
        "missingAssetRegister": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
        "dependencies": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
        "routingPlan": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
        "seedanceReadiness": {"type": "object", "additionalProperties": True},
        "nextActions": {"type": "array", "items": {"type": "string"}},
        "assumptions": {"type": "array", "items": {"type": "string"}},
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["assetExtraction", "assetRequirements", "nextActions"],
    "additionalProperties": True,
}

PROMPT_PACK_SCHEMA = {
    "type": "object",
    "properties": {
        "schemaVersion": {"type": "string"},
        "workflow": {"type": "string"},
        "assetType": {"type": "string"},
        "promptIntent": {"type": "string"},
        "referenceRoles": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
        "identityAnchor": {"type": "string"},
        "identityLock": {"type": "string"},
        "visibleEvent": {"type": "string"},
        "eventConsequence": {"type": "string"},
        "spatialGeography": {"type": ["string", "object"], "additionalProperties": True},
        "materialEvidence": {"type": ["string", "object"], "additionalProperties": True},
        "lightingCausality": {"type": ["string", "object"], "additionalProperties": True},
        "cameraExecution": {"type": "object", "additionalProperties": True},
        "atmosphereBehavior": {"type": ["string", "object"], "additionalProperties": True},
        "characterDetails": {"type": "object", "additionalProperties": True},
        "sceneDetails": {"type": "object", "additionalProperties": True},
        "propDetails": {"type": "object", "additionalProperties": True},
        "itemDetails": {"type": "object", "additionalProperties": True},
        "fusionDetails": {"type": "object", "additionalProperties": True},
        "shotPlan": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
        "visualStyle": {"type": "object", "additionalProperties": True},
        "referenceStrategy": {"type": "object", "additionalProperties": True},
        "detailAnchorRegistry": {"type": "object", "additionalProperties": True},
        "continuityChecklist": {"type": "array", "items": {"type": "string"}},
        "mustPreserve": {"type": "array", "items": {"type": "string"}},
        "mustAvoid": {"type": "array", "items": {"type": "string"}},
        "generationNotes": {"type": "string"},
        "suggestedSize": {"type": "string"},
        "negativePrompt": {"type": "array", "items": {"type": "string"}},
        # Keep the schema forwards-compatible with domain-specific fields;
        # the named fields above are the stable contract that the UI audits.
    },
    "required": [
        "schemaVersion", "workflow", "assetType", "promptIntent", "referenceRoles", "identityAnchor", "identityLock", "visibleEvent",
        "spatialGeography", "materialEvidence", "lightingCausality", "cameraExecution", "atmosphereBehavior",
        "characterDetails", "sceneDetails", "propDetails", "fusionDetails", "shotPlan", "visualStyle",
        "referenceStrategy", "detailAnchorRegistry", "continuityChecklist", "mustPreserve", "mustAvoid", "negativePrompt",
        "generationNotes", "suggestedSize",
    ],
    "additionalProperties": True,
}


ASSET_PROMPT_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "assets": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "assetClass": {"type": "string"},
                    "name": {"type": "string"},
                    "priority": {"type": "string"},
                    "required": {"type": "boolean"},
                    "targetSkill": {"type": "string"},
                    "relevantShots": {"type": "array", "items": {"type": "string"}},
                    "prompt": {"type": "string"},
                    "promptPack": PROMPT_PACK_SCHEMA,
                    "promptQuality": {"type": "object", "additionalProperties": True},
                    "mustPreserve": {"type": "array", "items": {"type": "string"}},
                    "mustAvoid": {"type": "array", "items": {"type": "string"}},
                    "imageGenerationEligible": {"type": "boolean"},
                },
                "required": ["id", "assetClass", "name", "priority", "required", "targetSkill", "relevantShots", "prompt", "promptPack", "mustPreserve", "mustAvoid", "imageGenerationEligible"],
                "additionalProperties": True,
            },
        },
        "fusionPlans": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "fusionAssetId": {"type": "string"},
                    "shotId": {"type": "string"},
                    "candidateSourceAssetIds": {"type": "array", "items": {"type": "string"}},
                    "shotIntent": {"type": "string"},
                    "requiredRoles": {"type": "array", "items": {"type": "string"}},
                    "continuityConstraints": {"type": "array", "items": {"type": "string"}},
                    "status": {"type": "string"},
                },
                "required": ["fusionAssetId", "shotId", "candidateSourceAssetIds", "shotIntent", "requiredRoles", "continuityConstraints", "status"],
                "additionalProperties": True,
            },
        },
        "missingAssetRegister": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
        "dependencyTable": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
        "routingPlan": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
        "nextActions": {"type": "array", "items": {"type": "string"}},
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["assets", "fusionPlans", "missingAssetRegister", "dependencyTable", "routingPlan", "nextActions", "warnings"],
    "additionalProperties": True,
}

FUSION_PROMPT_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "fusionAssetId": {"type": "string"},
        "shotId": {"type": "string"},
        "sourceAssetIds": {"type": "array", "items": {"type": "string"}},
        "prompt": {"type": "string"},
        "promptPack": PROMPT_PACK_SCHEMA,
        "mustPreserve": {"type": "array", "items": {"type": "string"}},
        "mustAvoid": {"type": "array", "items": {"type": "string"}},
        "warnings": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["fusionAssetId", "shotId", "sourceAssetIds", "prompt", "promptPack", "mustPreserve", "mustAvoid", "warnings"],
    "additionalProperties": True,
}


def schema_for(profile: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    if "api.deepseek.com" in str(profile.get("base_url", "")).lower():
        return deepseek_compatible_schema(schema)
    return schema


async def openai_structured(profile: dict[str, Any], api_key: str, model: str, instructions: str,
                            input_text: str, schema: dict[str, Any], name: str) -> dict[str, Any]:
    body = {
        "model": model,
        "store": False,
        "instructions": instructions,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": input_text}]}],
        "text": {"format": {"type": "json_schema", "name": name, "strict": True, "schema": schema_for(profile, schema)}},
    }
    payload = await request_json("POST", f"{profile['base_url'].rstrip('/')}/responses", api_key, json=body)
    output_text = payload.get("output_text")
    if not output_text:
        for item in payload.get("output", []) if isinstance(payload, dict) else []:
            if not isinstance(item, dict):
                continue
            for content in item.get("content", []):
                if isinstance(content, dict) and content.get("type") == "output_text":
                    output_text = content.get("text")
                    break
    if not output_text:
        raise ProviderError("供应商 Responses API 未返回文本内容。")
    try:
        result = json.loads(output_text)
    except json.JSONDecodeError as exc:
        raise ProviderError("供应商返回的结构化结果无法解析。", "validation") from exc
    if not isinstance(result, dict):
        raise ProviderError("供应商返回的结构化结果不是对象。", "validation")
    result["response_id"] = payload.get("id")
    result["model"] = payload.get("model", model)
    return result


async def openai_image(profile: dict[str, Any], api_key: str, prompt: str, size: str, quality: str) -> dict[str, Any]:
    body = {"model": profile.get("model_config", {}).get("image_model", "gpt-image-2"), "prompt": prompt, "size": size, "quality": quality, "output_format": "png"}
    return await request_json("POST", f"{profile['base_url'].rstrip('/')}/images/generations", api_key, json=body)


async def openai_image_edit(profile: dict[str, Any], api_key: str, model: str, prompt: str, image_data_url: str) -> dict[str, Any]:
    body = {"model": model, "store": False, "tools": [{"type": "image_generation"}], "input": [{"role": "user", "content": [{"type": "input_text", "text": prompt}, {"type": "input_image", "image_url": image_data_url}]}]}
    payload = await request_json("POST", f"{profile['base_url'].rstrip('/')}/responses", api_key, json=body)
    for item in payload.get("output", []):
        if isinstance(item, dict) and item.get("type") == "image_generation_call" and item.get("result"):
            return {"b64_json": item["result"], "response_id": payload.get("id"), "model": payload.get("model", model)}
    raise ProviderError("Responses API 未返回编辑后的图片。")


async def openai_speech(profile: dict[str, Any], api_key: str, body: dict[str, Any]) -> bytes:
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=20.0), follow_redirects=False) as client:
        response = await client.post(f"{profile['base_url'].rstrip('/')}/audio/speech", headers=headers, json=body)
    if response.status_code >= 400:
        raise error_from_response(response)
    return response.content
