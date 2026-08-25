from __future__ import annotations

import base64
import json
import time
from typing import Any

import httpx

from frameflow.providers import ProviderError, error_from_response


def _auth_headers(profile: dict[str, Any], password: str = "") -> dict[str, str]:
    if not password:
        return {}
    username = str(profile.get("model_config", {}).get("server_username") or "opencode")
    token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {token}"}


async def opencode_request_json(
    profile: dict[str, Any], method: str, path: str, password: str = "", **kwargs: Any
) -> Any:
    headers = dict(kwargs.pop("headers", {}))
    headers.update(_auth_headers(profile, password))
    headers.setdefault("Content-Type", "application/json")
    url = f"{profile['base_url'].rstrip('/')}/{path.lstrip('/')}"
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(300.0, connect=4.0),
            follow_redirects=False,
            trust_env=False,
        ) as client:
            response = await client.request(method, url, headers=headers, **kwargs)
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
        try:
            result = json.loads("\n".join(texts))
            if isinstance(result, dict):
                return result
        except json.JSONDecodeError:
            pass
    error = info.get("error")
    if error:
        raise ProviderError(f"OpenCode 结构化输出失败：{error}", "validation", 502)
    raise ProviderError("OpenCode 未返回结构化输出。", "validation", 502)


async def opencode_structured(
    profile: dict[str, Any], password: str, model_ref: str, instructions: str,
    input_text: str, schema: dict[str, Any], title: str = "FRAMEFLOW"
) -> dict[str, Any]:
    provider_id, model_id = split_model_ref(model_ref)
    session = await opencode_request_json(profile, "POST", "/session", password, json={"title": title})
    if not isinstance(session, dict) or not session.get("id"):
        raise ProviderError("OpenCode 未能创建会话。", "validation", 502)
    body = {
        "model": {"providerID": provider_id, "modelID": model_id},
        "agent": str(profile.get("model_config", {}).get("agent") or "build"),
        "system": instructions,
        "parts": [{"type": "text", "text": input_text}],
        "format": {"type": "json_schema", "schema": schema, "retryCount": 2},
    }
    thinking_strength = str(profile.get("model_config", {}).get("thinking_strength") or "auto").lower()
    if thinking_strength in {"low", "medium", "high", "max"}:
        # OpenCode exposes model-specific reasoning presets through `variant`.
        # `auto` intentionally omits the field so the selected model keeps its
        # own default behavior.
        body["variant"] = thinking_strength
    payload = await opencode_request_json(
        profile, "POST", f"/session/{session['id']}/message", password, json=body
    )
    result = _structured_result(payload)
    result["response_id"] = (payload.get("info") or {}).get("id") if isinstance(payload, dict) else None
    result["model"] = model_ref
    result["opencode_session_id"] = session["id"]
    return result
