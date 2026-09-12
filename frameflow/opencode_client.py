from __future__ import annotations

import base64
import json
import os
import re
import time
from pathlib import Path
from typing import Any

import httpx

from frameflow.providers import ProviderError, error_from_response


DEFAULT_OPENCODE_DIRECTORY = Path.home() / ".local" / "share" / "frameflow-opencode-context"
DEFAULT_OPENCODE_MESSAGE_TIMEOUT_SECONDS = 45.0


def _auth_headers(profile: dict[str, Any], password: str = "") -> dict[str, str]:
    if not password:
        return {}
    username = str(profile.get("model_config", {}).get("server_username") or "opencode")
    token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {token}"}


async def opencode_request_json(
    profile: dict[str, Any], method: str, path: str, password: str = "", **kwargs: Any
) -> Any:
    timeout_seconds = kwargs.pop("timeout_seconds", 300.0)
    try:
        timeout_seconds = max(0.5, float(timeout_seconds))
    except (TypeError, ValueError):
        timeout_seconds = 300.0
    headers = dict(kwargs.pop("headers", {}))
    headers.update(_auth_headers(profile, password))
    headers.setdefault("Content-Type", "application/json")
    url = f"{profile['base_url'].rstrip('/')}/{path.lstrip('/')}"
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds, connect=min(4.0, timeout_seconds)),
            follow_redirects=False,
            trust_env=False,
        ) as client:
            response = await client.request(method, url, headers=headers, **kwargs)
    except httpx.TimeoutException as exc:
        raise ProviderError(f"OpenCode Server 响应超时（{timeout_seconds:g} 秒）。", "timeout", 504) from exc
    except httpx.RequestError as exc:
        raise ProviderError(f"无法连接 OpenCode Server：{exc}", "connection", 502) from exc
    if response.status_code >= 400:
        raise error_from_response(response)
    if response.status_code == 204 or not response.content:
        return None
    try:
        return response.json()
    except ValueError as exc:
        raise ProviderError("OpenCode Server 返回了非 JSON 响应。", "validation", 502) from exc


def normalize_opencode_providers(payload: Any) -> tuple[list[dict[str, str]], list[str]]:
    providers = payload.get("all", []) if isinstance(payload, dict) else []
    connected = set(str(item) for item in (payload.get("connected", []) if isinstance(payload, dict) else []))
    catalog: list[dict[str, str]] = []
    for provider in providers if isinstance(providers, list) else []:
        if not isinstance(provider, dict) or not provider.get("id"):
            continue
        provider_id = str(provider["id"])
        # `/provider` includes the full Models.dev registry. Only persist and
        # render providers OpenCode reports as connected; disconnected entries
        # can neither be selected safely nor invoked successfully.
        if provider_id not in connected:
            continue
        provider_name = str(provider.get("name") or provider_id)
        raw_models = provider.get("models") or {}
        if isinstance(raw_models, dict):
            model_items = [(str(key), value) for key, value in raw_models.items()]
        elif isinstance(raw_models, list):
            model_items = [(str(item.get("id")), item) for item in raw_models if isinstance(item, dict) and item.get("id")]
        else:
            model_items = []
        for model_id, model in model_items:
            detail = model if isinstance(model, dict) else {}
            catalog.append({
                "id": f"{provider_id}/{model_id}",
                "provider_id": provider_id,
                "provider_name": provider_name,
                "model_id": model_id,
                "label": str(detail.get("name") or model_id),
                "connected": True,
            })
    catalog.sort(key=lambda item: (not item["connected"], item["provider_name"].lower(), item["label"].lower()))
    return catalog, sorted(connected)


async def probe_opencode(profile: dict[str, Any], password: str = "") -> dict[str, Any]:
    started = time.perf_counter()
    health = await opencode_request_json(profile, "GET", "/global/health", password)
    if not isinstance(health, dict) or not health.get("healthy"):
        raise ProviderError("OpenCode Server 健康检查未通过。", "connection", 502)
    providers = await opencode_request_json(profile, "GET", "/provider", password)
    catalog, connected = normalize_opencode_providers(providers)
    return {
        "ok": True,
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "models": [item["id"] for item in catalog],
        "model_catalog": catalog,
        "connected_providers": connected,
        "capabilities": ["orchestrator"],
        "model_readiness": {item["id"]: item["connected"] for item in catalog},
        "server_version": str(health.get("version") or "unknown"),
        "error": None,
        "checked_at": time.time(),
    }


def split_model_ref(model_ref: str) -> tuple[str, str]:
    provider_id, separator, model_id = str(model_ref or "").partition("/")
    if not separator or not provider_id or not model_id:
        raise ProviderError("OpenCode 模型必须使用 provider_id/model_id 格式。", "validation", 422)
    return provider_id, model_id


def _opencode_directory(profile: dict[str, Any]) -> str:
    """Return a directory OpenCode can use as a project context.

    OpenCode 1.18 resolves providers relative to the session's directory. A
    session created at ``/`` can list connected providers but cannot resolve
    them when a model is selected through the HTTP API. Prefer an explicit
    profile/env override, then fall back to the FrameFlow checkout itself.
    """
    configured = str(
        profile.get("model_config", {}).get("directory")
        or os.environ.get("FRAMEFLOW_OPENCODE_DIRECTORY", "")
    ).strip()
    directory = Path(configured).expanduser() if configured else DEFAULT_OPENCODE_DIRECTORY
    if not configured:
        # A fresh FrameFlow install should not inherit a macOS-protected
        # Documents/Desktop checkout as the OpenCode session root. The prompt
        # payload already contains the project snapshot, so a dedicated empty
        # context directory is sufficient for structured asset orchestration.
        directory.mkdir(parents=True, exist_ok=True)
    return str(directory.resolve())


def _structured_result(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ProviderError("OpenCode 返回了无效的消息对象。", "validation", 502)
    info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
    # OpenCode 1.18 returns `structured`; current SDK docs expose the same
    # value as `structured_output`. Accept both so server/SDK revisions remain
    # interoperable.
    structured = info.get("structured") or info.get("structured_output") or info.get("structuredOutput")
    if isinstance(structured, dict):
        return structured
    texts = [
        str(part.get("text"))
        for part in payload.get("parts", [])
        if isinstance(part, dict) and part.get("type") == "text" and part.get("text")
    ]
    if texts:
        raw_text = "\n".join(texts).strip()
        candidates = [raw_text]
        if raw_text.startswith("```"):
            fenced = raw_text.split("\n", 1)[1] if "\n" in raw_text else raw_text[3:]
            if fenced.endswith("```"):
                fenced = fenced[:-3].rstrip()
            candidates.append(fenced)
        # Text fallback responses occasionally include one short sentence
        # before the JSON object. Decode the first complete object without
        # accepting arbitrary prose as a structured result.
        object_start = raw_text.find("{")
        if object_start > 0:
            try:
                decoded, end = json.JSONDecoder().raw_decode(raw_text[object_start:])
                if isinstance(decoded, dict) and not raw_text[object_start + end:].strip():
                    return decoded
            except json.JSONDecodeError:
                pass
        for candidate in candidates:
            try:
                result = json.loads(candidate)
                if isinstance(result, dict):
                    return result
            except json.JSONDecodeError:
                continue
    error = info.get("error")
    if error:
        message = f"OpenCode 结构化输出失败：{error}"
        normalized = message.lower()
        if re.search(r"monthly usage limit|usage limit|quota|insufficient\s+(?:api\s*)?(?:balance|credit|quota)|payment required|billing", normalized):
            raise ProviderError(message, "billing", 402)
        if re.search(r"rate limit|rate_limit|too many requests|try again later", normalized):
            raise ProviderError(message, "rate_limit", 429)
        if re.search(r"unauthori[sz]ed|authentication|invalid (?:api )?key|api key.*(?:invalid|expired)", normalized):
            raise ProviderError(message, "auth", 401)
        raise ProviderError(message, "validation", 502)
    raise ProviderError("OpenCode 未返回结构化输出。", "validation", 502)


async def opencode_structured(
    profile: dict[str, Any], password: str, model_ref: str, instructions: str,
    input_text: str, schema: dict[str, Any], title: str = "FRAMEFLOW"
) -> dict[str, Any]:
    provider_id, model_id = split_model_ref(model_ref)
    directory = _opencode_directory(profile)
    thinking_strength = str(profile.get("model_config", {}).get("thinking_strength") or "auto").lower()
    session_model: dict[str, str] = {"id": model_id, "providerID": provider_id}
    if thinking_strength in {"low", "medium", "high", "max"}:
        # OpenCode resolves the model/variant in the session context. Passing
        # it only on the message request makes 1.18.x look for a model under
        # the wrong project context and return ProviderModelNotFoundError.
        session_model["variant"] = thinking_strength
    try:
        session = await opencode_request_json(
            profile,
            "POST",
            "/session",
            password,
            params={"directory": directory},
            json={"title": title, "agent": str(profile.get("model_config", {}).get("agent") or "build"), "model": session_model},
        )
    except ProviderError as exc:
        raise ProviderError(f"OpenCode 创建会话失败（directory={directory}）：{exc}", exc.kind, exc.status_code) from exc
    if not isinstance(session, dict) or not session.get("id"):
        raise ProviderError("OpenCode 未能创建会话。", "validation", 502)
    # OpenCode 1.18.29's HTTP message endpoint currently rejects the native
    # json_schema envelope for the large FrameFlow contracts with
    # ``Expected OutputFormatJsonSchema``. Sending the same contract request
    # as strict JSON text is the supported compatibility path: the local
    # parser below, followed by FrameFlow's schema/coverage gates, remains the
    # authoritative validator. This also avoids waiting for a native-schema
    # request that can never reach the model.
    schema_text = json.dumps(schema, ensure_ascii=False, separators=(",", ":"))
    body = {
        "system": (
            f"{instructions}\n\n"
            "请只返回一个完整、合法的 JSON 对象，严格符合下方任务约定的字段结构；"
            "不要使用 Markdown 代码围栏、解释文字、自然语言前后缀或补丁格式。\n"
            f"JSON Schema（仅用于约束输出，不要把 schema 本身作为结果返回）：{schema_text}"
        ),
        "parts": [{"type": "text", "text": input_text}],
        # Omit ``format`` intentionally. OpenCode 1.18.29's public message
        # endpoint rejects both the object and string spellings of its text
        # format, while its internal model defaults an omitted value to plain
        # text. FrameFlow parses and validates that text locally.
    }
    output_mode = "text_json"
    configured_timeout = profile.get("model_config", {}).get("message_timeout_seconds")
    try:
        message_timeout = max(10.0, min(300.0, float(configured_timeout or DEFAULT_OPENCODE_MESSAGE_TIMEOUT_SECONDS)))
    except (TypeError, ValueError):
        message_timeout = DEFAULT_OPENCODE_MESSAGE_TIMEOUT_SECONDS
    try:
        payload = await opencode_request_json(
            profile,
            "POST",
            f"/session/{session['id']}/message",
            password,
            params={"directory": directory},
            timeout_seconds=message_timeout,
            json=body,
        )
    except ProviderError as exc:
        if exc.kind == "timeout":
            try:
                await opencode_request_json(
                    profile,
                    "POST",
                    f"/session/{session['id']}/abort",
                    password,
                    params={"directory": directory},
                    timeout_seconds=5.0,
                    json={},
                )
            except ProviderError:
                pass
        raise ProviderError(f"OpenCode JSON 文本消息失败（directory={directory}）：{exc}", exc.kind, exc.status_code) from exc
    result = _structured_result(payload)
    result["response_id"] = (payload.get("info") or {}).get("id") if isinstance(payload, dict) else None
    result["model"] = model_ref
    result["opencode_session_id"] = session["id"]
    result["opencode_output_mode"] = output_mode
    return result
