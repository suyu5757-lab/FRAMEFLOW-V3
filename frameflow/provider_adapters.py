"""Unified provider contracts for FrameFlow V3.

The legacy provider functions remain available for the existing workflow.  This
module gives the V3 router one small, provider-neutral surface for discovery,
constraints, cost estimation, task control and output normalization.
"""

from __future__ import annotations

import base64
import copy
import json
import time
import uuid
from typing import Any
from urllib.parse import urlencode

import httpx

from .opencode_client import opencode_request_json, opencode_structured
from .jimeng_cli import jimeng_create_task, jimeng_get_task, jimeng_cancel_task, probe_jimeng_cli, validate_video_package
from .providers import (
    ProviderError,
    error_from_response,
    openai_image,
    openai_image_edit,
    openai_speech,
    openai_structured,
    probe_profile,
    request_json,
)


CONTRACT_VERSION = "1.0"
CAPABILITIES = (
    "orchestrator",
    "vision",
    "image",
    "image_edit",
    "video",
    "tts",
    "music",
    "sfx",
    "lip_sync",
    "upscale",
    "upload",
)
LOCAL_PROVIDER_TYPES = {"comfyui", "jimeng_cli"}


CAPABILITY_SPECS: dict[str, dict[str, Any]] = {
    "orchestrator": {
        "input_formats": ["text", "json"],
        "output_types": ["text", "json"],
        "task_mode": "sync",
        "limits": {"max_prompt_chars": 120000},
    },
    "vision": {
        "input_formats": ["text", "image"],
        "output_types": ["text", "json"],
        "task_mode": "sync",
        "limits": {"max_prompt_chars": 120000, "max_images": 16},
    },
    "image": {
        "input_formats": ["text", "image"],
        "output_types": ["image"],
        "task_mode": "sync",
        "limits": {"max_width": 4096, "max_height": 4096, "max_images": 16},
    },
    "image_edit": {
        "input_formats": ["text", "image"],
        "output_types": ["image"],
        "task_mode": "sync",
        "limits": {"max_width": 4096, "max_height": 4096, "max_images": 16},
    },
    "video": {
        "input_formats": ["text", "image", "video"],
        "output_types": ["video", "image"],
        "task_mode": "async",
        "limits": {"max_width": 4096, "max_height": 4096, "max_duration_seconds": 180},
    },
    "tts": {
        "input_formats": ["text"],
        "output_types": ["audio"],
        "task_mode": "sync",
        "limits": {"max_text_chars": 4096},
    },
    "music": {
        "input_formats": ["text", "audio"],
        "output_types": ["audio"],
        "task_mode": "async",
        "limits": {"max_duration_seconds": 600},
    },
    "sfx": {
        "input_formats": ["text", "audio"],
        "output_types": ["audio"],
        "task_mode": "async",
        "limits": {"max_duration_seconds": 60},
    },
    "lip_sync": {
        "input_formats": ["video", "audio"],
        "output_types": ["video"],
        "task_mode": "async",
        "limits": {"max_duration_seconds": 180},
    },
    "upscale": {
        "input_formats": ["image", "video"],
        "output_types": ["image", "video"],
        "task_mode": "async",
        "limits": {"max_width": 8192, "max_height": 8192},
    },
    "upload": {
        "input_formats": ["image", "video", "audio"],
        "output_types": ["asset"],
        "task_mode": "sync",
        "limits": {"max_bytes": 1024**3},
    },
}


DEFAULT_CAPABILITIES = {
    "openai": ["orchestrator", "vision", "image", "image_edit", "tts"],
    "openai_compatible": ["orchestrator"],
    "opencode": ["orchestrator"],
    "jimeng_cli": ["video"],
    "comfyui": ["image", "image_edit", "video", "music", "sfx", "upscale", "lip_sync", "upload"],
}


DEFAULT_RETRY_POLICY = {
    "max_attempts": 3,
    "backoff_seconds": [1, 3, 8],
    "retryable_kinds": ["connection", "timeout", "rate_limit", "server", "retryable"],
    "never_retry_kinds": ["auth", "billing", "configuration", "validation", "request", "canceled"],
}


def _profile_dict(profile: Any) -> dict[str, Any]:
    if isinstance(profile, dict):
        return profile
    return {key: profile[key] for key in profile.keys()}


def _config(profile: Any) -> dict[str, Any]:
    value = _profile_dict(profile).get("model_config")
    return value if isinstance(value, dict) else {}


def _provider_type(profile: Any) -> str:
    return str(_profile_dict(profile).get("provider_type") or "")


def _capabilities(profile: Any, defaults: list[str]) -> list[str]:
    declared = _profile_dict(profile).get("capabilities")
    configured = _config(profile).get("capabilities")
    values = declared if isinstance(declared, list) and declared else configured
    if not isinstance(values, list) or not values:
        values = defaults
    return sorted({str(item) for item in values if str(item) in CAPABILITY_SPECS})


def _merge_limits(profile: Any, capability: str) -> dict[str, Any]:
    spec = copy.deepcopy(CAPABILITY_SPECS.get(capability, {}).get("limits", {}))
    configured = _config(profile).get("limits")
    if isinstance(configured, dict):
        per_capability = configured.get(capability)
        if isinstance(per_capability, dict):
            spec.update(per_capability)
        else:
            spec.update({key: value for key, value in configured.items() if key in spec})
    return spec


def credential_state(profile: Any, credential: str | None = None) -> dict[str, Any]:
    p = _profile_dict(profile)
    provider_type = str(p.get("provider_type") or "")
    configured = bool(credential) or bool(p.get("credential_configured"))
    if provider_type == "jimeng_cli":
        return {"required": False, "configured": configured, "source": "local_cli_profile" if configured else None, "optional": True}
    return {
        "required": provider_type not in LOCAL_PROVIDER_TYPES and provider_type != "opencode",
        "configured": configured,
        "source": "system_credential_store" if configured else None,
        "optional": provider_type in LOCAL_PROVIDER_TYPES or provider_type == "opencode",
    }


def classify_provider_error(error: BaseException) -> dict[str, Any]:
    """Return a stable, UI-safe error contract without leaking request headers."""
    if isinstance(error, ProviderError):
        status = int(error.status_code)
        kind = str(error.kind or "retryable")
        message = str(error)
    elif isinstance(error, (httpx.TimeoutException, TimeoutError)):
        status, kind, message = 504, "timeout", "Provider 请求超时。"
    elif isinstance(error, httpx.RequestError):
        status, kind, message = 502, "connection", "无法连接 Provider。"
    else:
        status, kind, message = 500, "internal", "Provider 适配器执行失败。"
    retryable = kind in DEFAULT_RETRY_POLICY["retryable_kinds"] or status in {408, 425, 429, 500, 502, 503, 504}
    if kind in DEFAULT_RETRY_POLICY["never_retry_kinds"]:
        retryable = False
    return {"status": status, "kind": kind, "message": message, "retryable": retryable}


def _mime_for(capability: str, url: str | None = None) -> str:
    if url:
        lowered = url.lower()
        for suffix, mime in ((".png", "image/png"), (".jpg", "image/jpeg"), (".jpeg", "image/jpeg"),
                             (".webp", "image/webp"), (".mp4", "video/mp4"), (".webm", "video/webm"),
                             (".wav", "audio/wav"), (".mp3", "audio/mpeg"), (".ogg", "audio/ogg")):
            if suffix in lowered:
                return mime
    return {"image": "image/png", "image_edit": "image/png", "video": "video/mp4",
            "tts": "audio/wav", "music": "audio/mpeg", "sfx": "audio/wav",
            "lip_sync": "video/mp4", "upscale": "application/octet-stream"}.get(capability, "application/octet-stream")


def _redact_structured(value: Any) -> Any:
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            normalized = str(key).lower()
            if any(secret in normalized for secret in (
                "api_key", "apikey", "api-key", "authorization", "cookie", "password",
                "secret", "token", "credential_ref", "access_key", "private_key", "bearer",
            )):
                result[key] = "[REDACTED]"
            else:
                result[key] = _redact_structured(item)
        return result
    if isinstance(value, list):
        return [_redact_structured(item) for item in value]
    return value


def normalize_provider_output(
    provider_type: str,
    payload: Any,
    capability: str,
    model: str | None = None,
    provider_task_id: str | None = None,
    status: str = "succeeded",
) -> dict[str, Any]:
    """Normalize common OpenAI/CLI/ComfyUI response shapes into ArtifactRef inputs."""
    outputs: list[dict[str, Any]] = []

    def add_output(kind: str, value: Any, mime_type: str | None = None, **extra: Any) -> None:
        if not value:
            return
        item: dict[str, Any] = {"type": kind, "mime_type": mime_type or _mime_for(capability, str(value) if isinstance(value, str) else None)}
        if isinstance(value, str) and (value.startswith("http://") or value.startswith("https://") or value.startswith("asset://")):
            item["url"] = value
        elif isinstance(value, str):
            item["text"] = value
        else:
            item["data"] = value
        item.update({key: value for key, value in extra.items() if value is not None})
        outputs.append(item)

    def walk(value: Any, preferred_kind: str = "asset") -> None:
        if isinstance(value, list):
            for child in value:
                walk(child, preferred_kind)
            return
        if not isinstance(value, dict):
            return
        if value.get("b64_json"):
            outputs.append({"type": preferred_kind, "mime_type": _mime_for(capability), "data_base64": value["b64_json"]})
            return
        if value.get("data_base64"):
            outputs.append({"type": preferred_kind, "mime_type": _mime_for(capability), "data_base64": value["data_base64"]})
            return
        for key, kind in (("video_url", "video"), ("audio_url", "audio"), ("image_url", "image"), ("url", preferred_kind), ("uri", preferred_kind)):
            candidate = value.get(key)
            if isinstance(candidate, dict):
                candidate = candidate.get("url") or candidate.get("uri")
            if candidate:
                add_output(kind, candidate, value.get("mime_type") or value.get("mimeType"))
                return
        if value.get("output_text") and isinstance(value.get("output_text"), str):
            add_output("text", value["output_text"])
            return
        for key, kind in (("text", "text"), ("content", "text"), ("filename", preferred_kind)):
            if value.get(key) and isinstance(value.get(key), str):
                add_output(kind, value[key], value.get("mime_type") or value.get("mimeType"))
                return
        for key in ("data", "outputs", "output", "parts", "content", "images", "gifs", "audio", "videos"):
            if key in value:
                walk(value[key], "audio" if key == "audio" else "video" if key in {"videos", "gifs"} else preferred_kind)

    walk(payload, "audio" if capability in {"tts", "music", "sfx"} else capability)
    normalized = {
        "provider_type": provider_type,
        "provider_task_id": provider_task_id,
        "model": model,
        "status": status,
        "progress": 100 if status == "succeeded" else 0,
        "outputs": outputs,
        "output_count": len(outputs),
        "has_output": bool(outputs),
    }
    # Structured orchestration results must remain available to the Agent layer;
    # media callers continue to consume the normalized outputs above.
    if capability in {"orchestrator", "vision"} and isinstance(payload, dict):
        normalized["structured"] = _redact_structured(copy.deepcopy(payload))
    return normalized


class ProviderAdapter:
    """Small async contract shared by all first-wave provider adapters."""

    adapter_id = "base"
    default_capabilities: list[str] = []

    def __init__(self, profile: Any):
        self.profile = _profile_dict(profile)
        self.provider_type = _provider_type(profile)

    def contract(self) -> dict[str, Any]:
        capabilities = _capabilities(self.profile, self.default_capabilities)
        config = _config(self.profile)
        retry_policy = copy.deepcopy(DEFAULT_RETRY_POLICY)
        if isinstance(config.get("retry_policy"), dict):
            retry_policy.update(config["retry_policy"])
        return {
            "version": CONTRACT_VERSION,
            "adapter": self.adapter_id,
            "provider_type": self.provider_type,
            "capabilities": capabilities,
            "capability_specs": {capability: copy.deepcopy(CAPABILITY_SPECS[capability]) for capability in capabilities},
            "input_limits": {capability: _merge_limits(self.profile, capability) for capability in capabilities},
            "output_types": {capability: CAPABILITY_SPECS[capability]["output_types"] for capability in capabilities},
            "task_modes": {capability: CAPABILITY_SPECS[capability]["task_mode"] for capability in capabilities},
            "retry_policy": retry_policy,
            "credential": credential_state(self.profile),
        }

    def supports(self, capability: str) -> bool:
        return capability in self.contract()["capabilities"]

    def estimate(self, capability: str, request: dict[str, Any] | None = None) -> dict[str, Any]:
        request = request or {}
        config = _config(self.profile)
        pricing = config.get("pricing") if isinstance(config.get("pricing"), dict) else {}
        quantity = max(1, int(request.get("quantity", request.get("count", 1)) or 1))
        duration = float(request.get("duration", request.get("duration_seconds", 0)) or 0)
        cost = float(pricing.get(capability, pricing.get("per_request", config.get("cost_per_request", 0))) or 0)
        per_second = float(pricing.get(f"{capability}_per_second", config.get("cost_per_second", 0)) or 0)
        estimated = max(0.0, (cost + duration * per_second) * quantity)
        return {
            "estimated_cost": round(estimated, 6),
            "currency": str(pricing.get("currency", config.get("currency", "USD"))),
            "quantity": quantity,
            "duration": duration or None,
            "assumptions": ["按当前 Provider 配置的公开估价参数计算", "实际账单以 Provider 返回为准"],
        }

    def validate_request(self, capability: str, request: dict[str, Any] | None = None) -> list[str]:
        request = request or {}
        if not self.supports(capability):
            return [f"Provider 不声明 {capability} 能力"]
        limits = _merge_limits(self.profile, capability)
        issues: list[str] = []
        for field, limit, label in (("width", "max_width", "宽度"), ("height", "max_height", "高度"),
                                     ("duration", "max_duration_seconds", "时长"), ("duration_seconds", "max_duration_seconds", "时长"),
                                     ("prompt_chars", "max_prompt_chars", "Prompt 长度"), ("text_chars", "max_text_chars", "文本长度"),
                                     ("size_bytes", "max_bytes", "文件大小")):
            if field in request and request[field] is not None and limit in limits:
                try:
                    if float(request[field]) > float(limits[limit]):
                        issues.append(f"{label}超过 Provider 限制 {limits[limit]}")
                except (TypeError, ValueError):
                    issues.append(f"{field} 必须是数字")
        return issues

    async def probe(self, credential: str = "") -> dict[str, Any]:
        return {"ok": False, "error": "该 Provider 尚未实现探测", "capabilities": self.contract()["capabilities"]}

    async def submit(self, capability: str, request: dict[str, Any], credential: str = "") -> dict[str, Any]:
        raise ProviderError(f"{self.provider_type} 尚未实现 {capability} 调用。", "configuration", 501)

    async def progress(self, provider_task_id: str, capability: str | None = None, credential: str = "") -> dict[str, Any]:
        return {"status": "succeeded", "progress": 100, "provider_task_id": provider_task_id}

    async def cancel(self, provider_task_id: str, capability: str | None = None, credential: str = "") -> dict[str, Any]:
        return {"supported": False, "canceled": False, "provider_task_id": provider_task_id}

    def normalize(self, payload: Any, capability: str, model: str | None = None, provider_task_id: str | None = None, status: str = "succeeded") -> dict[str, Any]:
        return normalize_provider_output(self.provider_type, payload, capability, model, provider_task_id, status)


class OpenAIAdapter(ProviderAdapter):
    adapter_id = "openai"

    async def probe(self, credential: str = "") -> dict[str, Any]:
        result = await probe_profile(self.profile, credential)
        return _merge_probe_contract(self, result, credential)

    async def submit(self, capability: str, request: dict[str, Any], credential: str = "") -> dict[str, Any]:
        issues = self.validate_request(capability, request)
        if issues:
            raise ProviderError("；".join(issues), "validation", 422)
        model = str(request.get("model") or request.get("provider_model") or _config(self.profile).get(f"{capability}_model") or "") or None
        if capability == "image":
            payload = await openai_image(self.profile, credential, str(request.get("prompt") or ""), str(request.get("size") or "1024x1024"), str(request.get("quality") or "medium"))
        elif capability == "image_edit":
            payload = await openai_image_edit(self.profile, credential, model or "gpt-image-2", str(request.get("prompt") or ""), str(request.get("image_data_url") or ""))
        elif capability == "tts":
            data = await openai_speech(self.profile, credential, {"model": model or "gpt-4o-mini-tts", "voice": request.get("voice", "coral"), "input": request.get("text", ""), "response_format": request.get("format", "wav"), "speed": request.get("speed", 1.0)})
            return self.normalize({"data_base64": base64.b64encode(data).decode("ascii")}, capability, model, None, "succeeded")
        elif capability in {"orchestrator", "vision"}:
            schema = request.get("schema")
            if isinstance(schema, dict):
                payload = await openai_structured(self.profile, credential, model or "gpt-5.5", str(request.get("instructions") or ""), str(request.get("input_text") or request.get("prompt") or ""), schema, str(request.get("schema_name") or "frameflow_result"))
            else:
                body = {"model": model or "gpt-5.5", "store": False, "input": request.get("input") or request.get("prompt") or ""}
                payload = await request_json("POST", f"{self.profile['base_url'].rstrip('/')}/responses", credential, json=body)
        else:
            raise ProviderError(f"OpenAI 适配器不支持 {capability}。", "configuration", 422)
        return self.normalize(payload, capability, model, None, "succeeded")


class OpenAICompatibleAdapter(OpenAIAdapter):
    adapter_id = "openai_compatible"
    default_capabilities = ["orchestrator"]


class OpenCodeAdapter(ProviderAdapter):
    adapter_id = "opencode"
    default_capabilities = ["orchestrator"]

    async def probe(self, credential: str = "") -> dict[str, Any]:
        result = await probe_profile(self.profile, credential)
        return _merge_probe_contract(self, result, credential)

    async def submit(self, capability: str, request: dict[str, Any], credential: str = "") -> dict[str, Any]:
        if capability != "orchestrator":
            raise ProviderError("OpenCode 仅支持文本编排能力。", "validation", 422)
        model = str(request.get("model") or request.get("provider_model") or _config(self.profile).get("orchestrator_model") or "")
        schema = request.get("schema") if isinstance(request.get("schema"), dict) else {"type": "object", "additionalProperties": True}
        payload = await opencode_structured(self.profile, credential, model, str(request.get("instructions") or ""), str(request.get("input_text") or request.get("prompt") or ""), schema, str(request.get("schema_name") or "FRAMEFLOW"))
        task_id = payload.get("opencode_session_id") if isinstance(payload, dict) else None
        return self.normalize(payload, capability, model, task_id, "succeeded")

    async def cancel(self, provider_task_id: str, capability: str | None = None, credential: str = "") -> dict[str, Any]:
        await opencode_request_json(self.profile, "POST", f"/session/{provider_task_id}/abort", credential, json={})
        return {"supported": True, "canceled": True, "provider_task_id": provider_task_id}


class JimengCLIAdapter(ProviderAdapter):
    adapter_id = "jimeng_cli"
    default_capabilities = ["video"]

    async def probe(self, credential: str = "") -> dict[str, Any]:
        result = await probe_jimeng_cli(self.profile, credential)
        return _merge_probe_contract(self, result, credential)

    async def submit(self, capability: str, request: dict[str, Any], credential: str = "") -> dict[str, Any]:
        if capability != "video":
            raise ProviderError("即梦 CLI 适配器当前只提交视频任务。", "validation", 422)
        del credential
        package = {"prompt": request.get("prompt", ""), "reference_assets": request.get("reference_assets", []), "provider_model_or_endpoint": request.get("model") or request.get("provider_model") or _config(self.profile).get("model_version"), "duration": request.get("duration", 5), "resolution": request.get("resolution", "720p"), "aspect_ratio": request.get("aspect_ratio", "9:16")}
        issues = validate_video_package(package, self.profile)
        if issues:
            raise ProviderError("；".join(issues), "validation", 422)
        payload = await jimeng_create_task(self.profile, package)
        task_id = payload.get("submit_id")
        return self.normalize(payload, capability, package["provider_model_or_endpoint"], task_id, "queued")

    async def progress(self, provider_task_id: str, capability: str | None = None, credential: str = "") -> dict[str, Any]:
        del credential
        payload = await jimeng_get_task(self.profile, provider_task_id)
        status = str(payload.get("status") or "running")
        return {**self.normalize(payload, capability or "video", None, provider_task_id, status), "progress": 100 if status == "succeeded" else 0}

    async def cancel(self, provider_task_id: str, capability: str | None = None, credential: str = "") -> dict[str, Any]:
        del capability, credential
        return await jimeng_cancel_task(self.profile, provider_task_id)


class ComfyUIAdapter(ProviderAdapter):
    adapter_id = "comfyui"
    default_capabilities = DEFAULT_CAPABILITIES["comfyui"]

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        headers = dict(kwargs.pop("headers", {}))
        api_key = str(kwargs.pop("_credential", "") or self.profile.get("api_key") or "")
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        headers.setdefault("Content-Type", "application/json")
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=4.0), follow_redirects=False, trust_env=False) as client:
                response = await client.request(method, f"{self.profile['base_url'].rstrip('/')}/{path.lstrip('/')}", headers=headers, **kwargs)
        except httpx.RequestError as exc:
            raise ProviderError(f"无法连接 ComfyUI：{exc}", "connection", 502) from exc
        if response.status_code >= 400:
            raise error_from_response(response)
        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise ProviderError("ComfyUI 返回了非 JSON 响应。", "validation", 502) from exc

    async def probe(self, credential: str = "") -> dict[str, Any]:
        started = time.perf_counter()
        system = await self._request("GET", "/system_stats", _credential=credential)
        object_info: dict[str, Any] = {}
        try:
            candidate = await self._request("GET", "/object_info", _credential=credential)
            object_info = candidate if isinstance(candidate, dict) else {}
        except ProviderError:
            # Health remains useful when a large object_info response is disabled.
            pass
        config = _config(self.profile)
        configured_models = config.get("models") or config.get("model_catalog") or []
        models = [str(item.get("id") if isinstance(item, dict) else item) for item in configured_models if (item.get("id") if isinstance(item, dict) else item)]
        capabilities = _capabilities(self.profile, self.default_capabilities)
        return _merge_probe_contract(self, {"ok": True, "latency_ms": round((time.perf_counter() - started) * 1000), "models": models[:500], "model_catalog": configured_models[:500] if isinstance(configured_models, list) else [], "capabilities": capabilities, "node_count": len(object_info), "system": system, "error": None, "checked_at": time.time()}, credential)

    async def submit(self, capability: str, request: dict[str, Any], credential: str = "") -> dict[str, Any]:
        issues = self.validate_request(capability, request)
        if issues:
            raise ProviderError("；".join(issues), "validation", 422)
        workflow = request.get("workflow") or request.get("prompt_graph")
        if not isinstance(workflow, dict):
            raise ProviderError("ComfyUI 任务必须提供 workflow JSON。", "validation", 422)
        payload = await self._request("POST", "/prompt", _credential=credential, json={"prompt": workflow, "client_id": request.get("client_id") or str(uuid.uuid4()), "extra_data": request.get("extra_data", {})})
        task_id = payload.get("prompt_id") if isinstance(payload, dict) else None
        return self.normalize(payload, capability, request.get("model"), task_id, "queued")

    async def progress(self, provider_task_id: str, capability: str | None = None, credential: str = "") -> dict[str, Any]:
        payload = await self._request("GET", f"/history/{provider_task_id}", _credential=credential)
        item = payload.get(provider_task_id) if isinstance(payload, dict) else None
        if not isinstance(item, dict):
            return {"provider_task_id": provider_task_id, "status": "running", "progress": 0, "outputs": [], "output_count": 0, "has_output": False}
        status_text = str((item.get("status") or {}).get("status_str") if isinstance(item.get("status"), dict) else item.get("status") or "success").lower()
        status = "succeeded" if status_text in {"success", "succeeded", "completed"} else "failed" if status_text in {"error", "failed"} else "running"
        return {**self.normalize(item, capability or "image", None, provider_task_id, status), "progress": 100 if status == "succeeded" else 0}

    def normalize(self, payload: Any, capability: str, model: str | None = None, provider_task_id: str | None = None, status: str = "succeeded") -> dict[str, Any]:
        result = super().normalize(payload, capability, model, provider_task_id, status)

        def collect(value: Any, bucket: list[dict[str, Any]]) -> None:
            if isinstance(value, dict):
                for key, child in value.items():
                    if key in {"images", "gifs", "videos", "audio"} and isinstance(child, list):
                        output_type = "audio" if key == "audio" else "video" if key in {"gifs", "videos"} else "image"
                        for item in child:
                            if not isinstance(item, dict) or not item.get("filename"):
                                continue
                            query = {"filename": item["filename"], "type": item.get("type", "output")}
                            if item.get("subfolder"):
                                query["subfolder"] = item["subfolder"]
                            bucket.append({"type": output_type, "mime_type": _mime_for(output_type, str(item["filename"])), "url": f"{self.profile['base_url'].rstrip('/')}/view?{urlencode(query)}"})
                    else:
                        collect(child, bucket)
            elif isinstance(value, list):
                for child in value:
                    collect(child, bucket)

        comfy_outputs: list[dict[str, Any]] = []
        if isinstance(payload, dict):
            collect(payload.get("outputs"), comfy_outputs)
        if comfy_outputs:
            result["outputs"] = [*result["outputs"], *comfy_outputs]
            result["output_count"] = len(result["outputs"])
            result["has_output"] = True
        for output in result["outputs"]:
            filename = output.pop("text", None)
            if filename and not output.get("url"):
                output["url"] = f"{self.profile['base_url'].rstrip('/')}/view?{urlencode({'filename': filename, 'type': 'output'})}"
                output["mime_type"] = output.get("mime_type") or _mime_for(capability, filename)
        return result

    async def cancel(self, provider_task_id: str, capability: str | None = None, credential: str = "") -> dict[str, Any]:
        await self._request("POST", "/interrupt", _credential=credential, json={})
        return {"supported": True, "canceled": True, "provider_task_id": provider_task_id}


ADAPTER_TYPES: dict[str, type[ProviderAdapter]] = {
    "openai": OpenAIAdapter,
    "openai_compatible": OpenAICompatibleAdapter,
    "opencode": OpenCodeAdapter,
    "jimeng_cli": JimengCLIAdapter,
    "comfyui": ComfyUIAdapter,
}


def adapter_for_profile(profile: Any) -> ProviderAdapter:
    provider_type = _provider_type(profile)
    adapter_type = ADAPTER_TYPES.get(provider_type)
    if adapter_type is None:
        raise ProviderError(f"没有注册 {provider_type or 'unknown'} Provider 适配器。", "configuration", 422)
    return adapter_type(profile)


def provider_contract(profile: Any) -> dict[str, Any]:
    return adapter_for_profile(profile).contract()


def _merge_probe_contract(adapter: ProviderAdapter, result: dict[str, Any], credential: str = "") -> dict[str, Any]:
    contract = adapter.contract()
    merged = dict(result)
    discovered = [str(item) for item in result.get("capabilities", []) if str(item) in CAPABILITY_SPECS]
    if discovered:
        contract["capabilities"] = sorted(set(contract["capabilities"]) | set(discovered))
    merged.update({"adapter": adapter.adapter_id, "contract_version": CONTRACT_VERSION, "credential": credential_state(adapter.profile, credential), "capability_specs": contract["capability_specs"], "input_limits": contract["input_limits"], "output_types": contract["output_types"], "task_modes": contract["task_modes"], "retry_policy": contract["retry_policy"]})
    return merged


# Friendly aliases used by API code and external integrations.
get_provider_adapter = adapter_for_profile
normalize_output = normalize_provider_output
