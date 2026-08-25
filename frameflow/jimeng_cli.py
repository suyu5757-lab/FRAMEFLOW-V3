"""Local adapter for the official Dreamina (即梦) CLI.

The official integration is a local command-line workflow.  It is deliberately
kept separate from HTTP Provider adapters: login state lives in the CLI's local
profile, generation returns an async ``submit_id``, and ``query_result`` is the
supported way to wait for/download the result.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from .providers import ProviderError


DEFAULT_EXECUTABLE = "dreamina"
DEFAULT_VIDEO_MODEL = "seedance2.0fast"
KNOWN_VIDEO_MODELS = (
    "seedance2.0fast", "seedance2.0", "seedance2.0_vip", "seedance2.0fast_vip",
    "seedance2.0mini", "seedance2.5", "seedance1.5pro", "seedance1.0fast",
)
VIDEO_MODEL_SPECS = {
    "seedance2.0": {"min_duration": 4, "max_duration": 15, "resolutions": {"720p"}, "commands": {"text2video", "image2video", "frames2video"}},
    "seedance2.0fast": {"min_duration": 4, "max_duration": 15, "resolutions": {"720p"}, "commands": {"text2video", "image2video", "frames2video"}},
    "seedance2.0_vip": {"min_duration": 4, "max_duration": 15, "resolutions": {"720p", "1080p", "4k"}, "commands": {"text2video", "image2video", "frames2video"}},
    "seedance2.0fast_vip": {"min_duration": 4, "max_duration": 15, "resolutions": {"720p", "1080p", "4k"}, "commands": {"text2video", "image2video", "frames2video"}},
    "seedance2.0mini": {"min_duration": 4, "max_duration": 15, "resolutions": {"720p"}, "commands": {"text2video", "image2video", "frames2video"}},
    "seedance2.5": {"min_duration": 4, "max_duration": 30, "resolutions": {"480p", "720p", "1080p"}, "commands": {"text2video", "image2video", "frames2video"}},
    "seedance1.5pro": {"min_duration": 5, "max_duration": 12, "resolutions": {"720p"}, "commands": {"image2video", "frames2video"}},
    "seedance1.0fast": {"min_duration": 5, "max_duration": 10, "resolutions": {"720p"}, "commands": {"image2video"}},
}
SUCCESS_STATUSES = {"success", "succeeded", "completed", "complete", "done"}
RUNNING_STATUSES = {"queued", "pending", "processing", "running", "submitted", "in_progress"}
FAILED_STATUSES = {"failed", "failure", "error", "canceled", "cancelled"}


def _config(profile: dict[str, Any]) -> dict[str, Any]:
    value = profile.get("model_config")
    return value if isinstance(value, dict) else {}


def executable_for_profile(profile: dict[str, Any]) -> str:
    configured = str(_config(profile).get("executable") or "").strip()
    return configured or os.environ.get("JIMENG_CLI_PATH", "").strip() or DEFAULT_EXECUTABLE


def _looks_like_shell_command(value: str) -> bool:
    lowered = value.lower().strip()
    if any(operator in value for operator in ("|", "&&", ";", "\r", "\n")):
        return True
    return bool(re.search(r"(?:^|\s)(curl|wget|bash|sh|powershell|pwsh|invoke-webrequest|irm)(?:\s|$)", lowered))


def executable_configuration_error(profile: dict[str, Any]) -> str | None:
    executable = executable_for_profile(profile)
    if _looks_like_shell_command(executable):
        return "CLI 可执行文件字段只能填写 dreamina、dreamina.exe 或完整可执行文件路径，不能填写安装命令；安装命令请在终端单独执行。"
    if not shutil.which(executable) and not Path(executable).is_file():
        return f"未找到即梦 CLI：{executable}。请先安装官方 dreamina CLI，或填写已安装的 dreamina.exe 完整路径；修改 PATH 后需要重启工作台。"
    return None


def _command_parts(profile: dict[str, Any], args: list[str]) -> list[str]:
    executable = executable_for_profile(profile)
    # The official installer may expose a native executable, while npm-based
    # Windows installs can expose a .cmd shim.  Avoid shell=True and still
    # support the latter without allowing arbitrary shell fragments in config.
    resolved = shutil.which(executable) or executable
    if sys.platform == "win32" and Path(resolved).suffix.lower() in {".cmd", ".bat"}:
        command = subprocess.list2cmdline([resolved, *args])
        return [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c", command]
    return [resolved, *args]


def _cli_environment(profile: dict[str, Any]) -> dict[str, str]:
    environment = os.environ.copy()
    cli_home = str(_config(profile).get("home_dir") or environment.get("JIMENG_CLI_HOME") or "").strip()
    if cli_home:
        Path(cli_home).mkdir(parents=True, exist_ok=True)
        environment["USERPROFILE"] = cli_home
        environment["HOME"] = cli_home
    return environment


def _safe_output(value: str, limit: int = 1600) -> str:
    text = value.strip()
    # CLI diagnostics should never put local auth material into API errors.
    text = re.sub(r"(?i)(cookie|token|sessionid|authorization|password)\s*[:=]\s*[^\s,;]+", r"\1=[REDACTED]", text)
    return text[-limit:]


async def run_cli(profile: dict[str, Any], args: list[str], *, timeout: float = 120.0) -> tuple[str, str]:
    configuration_error = executable_configuration_error(profile)
    if configuration_error:
        raise ProviderError(configuration_error, "configuration", 409)
    command = _command_parts(profile, args)
    try:
        # Windows sandboxed hosts can deny asyncio's overlapped pipe handles
        # (WinError 5) even when the executable itself is runnable.  Running
        # the same argument-vector in a worker thread keeps the API async
        # without using shell=True or losing timeout/error handling.
        completed = await asyncio.to_thread(
            subprocess.run,
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=_cli_environment(profile),
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ProviderError(
            f"未找到即梦 CLI：{executable_for_profile(profile)}。请先按官方方式安装 dreamina，并在设置中填写 CLI 路径。",
            "configuration",
            409,
        ) from exc
    except PermissionError as exc:
        raise ProviderError(
            f"无法执行即梦 CLI：{executable_for_profile(profile)}。请确认这里填写的是 dreamina.exe，而不是目录或安装命令；如果使用 Windows 受限环境，请重启工作台后重试。",
            "configuration",
            409,
        ) from exc
    except OSError as exc:
        raise ProviderError(f"无法启动即梦 CLI：{exc}", "configuration", 409) from exc
    except subprocess.TimeoutExpired as exc:
        raise ProviderError("即梦 CLI 执行超时。", "timeout", 504) from exc
    out = (completed.stdout or b"").decode("utf-8", errors="replace")
    err = (completed.stderr or b"").decode("utf-8", errors="replace")
    if completed.returncode:
        detail = _safe_output(err or out) or f"退出码 {completed.returncode}"
        lowered = detail.lower()
        kind = "auth" if any(token in lowered for token in ("login", "auth", "cookie", "session")) else "retryable"
        raise ProviderError(f"即梦 CLI 执行失败：{detail}", kind, 401 if kind == "auth" else 502)
    return out, err


def _json_candidates(text: str) -> list[Any]:
    candidates: list[Any] = []
    for line in reversed([item.strip() for item in text.splitlines() if item.strip()]):
        try:
            candidates.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    # Some CLI versions print a short log prefix before one JSON object.
    for start, char in enumerate(text):
        if char not in "[{":
            continue
        try:
            candidates.append(json.JSONDecoder().raw_decode(text[start:].lstrip())[0])
        except (json.JSONDecodeError, ValueError):
            continue
    return candidates


def _payload(text: str) -> Any:
    values = _json_candidates(text)
    return values[0] if values else {}


def _find_value(value: Any, keys: set[str]) -> Any:
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).lower() in keys and item not in (None, ""):
                return item
        for item in value.values():
            found = _find_value(item, keys)
            if found not in (None, ""):
                return found
    elif isinstance(value, list):
        for item in value:
            found = _find_value(item, keys)
            if found not in (None, ""):
                return found
    return None


def _submit_id(stdout: str, payload: Any) -> str | None:
    value = _find_value(payload, {"submit_id", "submitid", "task_id", "taskid", "job_id", "jobid"})
    if value:
        return str(value)
    match = re.search(r"(?i)(?:submit[_ -]?id|task[_ -]?id|job[_ -]?id)\s*[:=]\s*([A-Za-z0-9_-]+)", stdout)
    return match.group(1) if match else None


def _status(payload: Any, stdout: str = "") -> str:
    value = _find_value(payload, {"gen_status", "status", "state", "task_status", "taskstatus"})
    if value is None:
        match = re.search(r"(?i)\b(success|succeeded|completed|done|running|processing|pending|failed|error|canceled|cancelled)\b", stdout)
        value = match.group(1) if match else "running"
    normalized = str(value).strip().lower().replace("-", "_").replace(" ", "_")
    if normalized in SUCCESS_STATUSES:
        return "succeeded"
    if normalized in FAILED_STATUSES:
        return "failed"
    return "running"


def _configured_models(profile: dict[str, Any]) -> list[str]:
    config = _config(profile)
    values = config.get("models")
    if isinstance(values, list):
        models = [str(item).strip() for item in values if str(item).strip()]
        if models:
            return models[:50]
    configured = str(config.get("model_version") or config.get("default_model") or "").strip()
    return [configured] if configured else list(KNOWN_VIDEO_MODELS)


async def probe_jimeng_cli(profile: dict[str, Any], credential: str = "") -> dict[str, Any]:
    del credential  # Authentication is held by the local CLI profile, not API keys.
    import time

    started = time.perf_counter()
    stdout, stderr = await run_cli(profile, ["user_credit"], timeout=60.0)
    _raise_if_login_required(stdout, stderr)
    payload = _payload(stdout)
    models = _configured_models(profile)
    return {
        "ok": True,
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "models": models,
        "model_catalog": [{"id": model, "label": model, "source": "jimeng-cli"} for model in models],
        "capabilities": ["video"],
        "model_readiness": {model: True for model in models},
        "cli_executable": executable_for_profile(profile),
        "credit_check": "ok" if payload else "responded",
        "error": None,
        "checked_at": time.time(),
    }


def _model_for_package(package: dict[str, Any], profile: dict[str, Any]) -> str:
    model = str(package.get("provider_model_or_endpoint") or package.get("model_version") or _config(profile).get("model_version") or DEFAULT_VIDEO_MODEL).strip()
    return model or DEFAULT_VIDEO_MODEL


def validate_video_package(package: dict[str, Any], profile: dict[str, Any] | None = None) -> list[str]:
    profile = profile or {}
    model = _model_for_package(package, profile).lower()
    spec = VIDEO_MODEL_SPECS.get(model)
    if not spec:
        return [f"即梦 CLI 当前不支持模型 {model}，请从官方 CLI 帮助列出的模型中选择。"]
    duration = package.get("duration", 5)
    try:
        duration_value = int(duration)
    except (TypeError, ValueError):
        return ["时长必须是整数秒。"]
    references = package.get("reference_assets") or []
    command = "text2video" if len(references) == 0 else "image2video" if len(references) == 1 else "frames2video"
    if command not in spec["commands"]:
        return [f"即梦 CLI 模型 {model} 不支持 {command}，请为该模型提供正确的本地素材或更换模型。"]
    if duration_value < spec["min_duration"]:
        return [f"即梦 CLI 模型 {model} 的视频时长最短为 {spec['min_duration']} 秒。"]
    if duration_value > spec["max_duration"]:
        return [f"即梦 CLI 模型 {model} 的单段视频最长为 {spec['max_duration']} 秒。"]
    resolution = str(package.get("resolution") or "720p").lower()
    if resolution not in spec["resolutions"]:
        allowed = "/".join(sorted(spec["resolutions"], key=("480p", "720p", "1080p", "4k").index))
        return [f"即梦 CLI 模型 {model} 当前仅支持 {allowed}。"]
    if len(references) > 2:
        return ["即梦 CLI 的首尾帧模式最多接收两张本地图片。"]
    for reference in references:
        path = Path(str(reference)).expanduser()
        if str(reference).startswith(("http://", "https://", "asset://")):
            return ["即梦 CLI 的 --image/--first/--last 只接受本地文件路径，不能使用 URL 或 asset://。"]
        if not path.is_file():
            return [f"即梦 CLI 引用图片不存在：{path}"]
    return []


def _generation_args(package: dict[str, Any], profile: dict[str, Any]) -> list[str]:
    model = _model_for_package(package, profile)
    prompt = str(package.get("prompt") or "").strip()
    duration = str(package.get("duration") or 5)
    ratio = str(package.get("aspect_ratio") or "9:16")
    references = [str(item) for item in package.get("reference_assets") or []]
    if len(references) == 0:
        command = "text2video"
        args = [f"--prompt={prompt}", f"--duration={duration}", f"--ratio={ratio}", f"--video_resolution={package.get('resolution') or '720p'}"]
    elif len(references) == 1:
        command = "image2video"
        args = [f"--image={references[0]}", f"--prompt={prompt}", f"--duration={duration}", f"--video_resolution={package.get('resolution') or '720p'}"]
    else:
        command = "frames2video"
        args = [f"--first={references[0]}", f"--last={references[1]}", f"--prompt={prompt}", f"--duration={duration}", f"--video_resolution={package.get('resolution') or '720p'}"]
    # model_version is an official CLI option in the current command family;
    # leaving it out remains the safest fallback for profiles that want the
    # CLI's account default.
    if model:
        args.append(f"--model_version={model}")
    return [command, *args]


def _raise_if_login_required(stdout: str, stderr: str = "") -> None:
    combined = f"{stdout}\n{stderr}"
    if re.search(r"未检测到有效登录态|请先执行\s*dreamina\s+login|login required|not logged in|authentication required", combined, re.IGNORECASE):
        raise ProviderError("即梦 CLI 尚未登录，请先执行 dreamina login 或 dreamina login --headless。", "auth", 401)


async def jimeng_user_credit(profile: dict[str, Any]) -> dict[str, Any]:
    stdout, stderr = await run_cli(profile, ["user_credit"], timeout=60.0)
    _raise_if_login_required(stdout, stderr)
    return _payload(stdout)


async def jimeng_create_task(profile: dict[str, Any], package: dict[str, Any]) -> dict[str, Any]:
    issues = validate_video_package(package, profile)
    if issues:
        raise ProviderError("；".join(issues), "validation", 422)
    stdout, _ = await run_cli(profile, _generation_args(package, profile), timeout=120.0)
    payload = _payload(stdout)
    submit_id = _submit_id(stdout, payload)
    if not submit_id:
        raise ProviderError("即梦 CLI 未返回 submit_id，无法继续轮询任务。", "validation", 502)
    return {"submit_id": submit_id, "status": "queued", "model": _model_for_package(package, profile)}


def _find_downloaded_video(download_dir: Path) -> Path | None:
    if not download_dir.is_dir():
        return None
    candidates = [path for path in download_dir.rglob("*") if path.is_file() and path.suffix.lower() in {".mp4", ".mov", ".webm"}]
    return max(candidates, key=lambda path: path.stat().st_mtime) if candidates else None


async def jimeng_get_task(profile: dict[str, Any], submit_id: str, download_dir: Path | None = None) -> dict[str, Any]:
    args = ["query_result", f"--submit_id={submit_id}"]
    if download_dir is not None:
        download_dir.mkdir(parents=True, exist_ok=True)
        args.append(f"--download_dir={download_dir}")
    stdout, stderr = await run_cli(profile, args, timeout=180.0)
    _raise_if_login_required(stdout, stderr)
    payload = _payload(stdout)
    result: dict[str, Any] = {"submit_id": submit_id, "status": _status(payload, stdout)}
    path = _find_downloaded_video(download_dir) if download_dir is not None else None
    if path:
        result["output_path"] = str(path.resolve())
        result["status"] = "succeeded"
    result["provider_payload"] = payload if isinstance(payload, dict) else {}
    return result


async def jimeng_cancel_task(profile: dict[str, Any], submit_id: str) -> dict[str, Any]:
    del profile
    # The official CLI documents query/list operations but no cancellation
    # command.  Do not invent a remote API call; the local task can still stop
    # polling and remain safely marked canceled in FrameFlow.
    return {"supported": False, "canceled": False, "submit_id": submit_id}


def command_preview(profile: dict[str, Any], args: list[str]) -> str:
    return shlex.join(_command_parts(profile, args))
