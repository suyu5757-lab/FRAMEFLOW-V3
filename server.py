"""FRAMEFLOW V3 local-first FastAPI server."""
from __future__ import annotations

import asyncio, base64, difflib, hashlib, ipaddress, json, mimetypes, os, re, secrets, shutil, sqlite3, sys, tempfile, threading, time, urllib.request, wave, webbrowser
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote
from zipfile import ZipFile

import uvicorn
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.openapi.utils import get_openapi
from starlette.middleware.trustedhost import TrustedHostMiddleware

from frameflow import asset_audit, audit_trail
from frameflow.agent import AGENT_RESULT_SCHEMA, apply_patch_to_graph, build_input_snapshot, normalize_agent_patch, patch_preview, redact
from frameflow.database import Database, SCHEMA_VERSION, utcnow
from frameflow.data_integrity import scan_data_integrity
from frameflow.dashboard import build_dashboard_snapshot, project_home_summary
from frameflow.media import create_proxy, download_provider_artifact, find_binary, media_info, render_timeline, render_video, safe_project_path, sha256_file
from frameflow.maintenance import ACTIVE_RUN_STATUSES, audit_database, active_project_runs, delete_project_records, derive_story_asset_links
from frameflow.jimeng_cli import DEFAULT_VIDEO_MODEL, jimeng_create_task, jimeng_get_task, jimeng_user_credit, validate_video_package
from frameflow.idempotency import render_fingerprint, workflow_run_fingerprint
from frameflow.opencode_client import opencode_structured
from frameflow.provider_adapters import CAPABILITIES, adapter_for_profile, credential_state, provider_contract
from frameflow.production_gate import ProductionArtifactGateError, production_artifact_gate
from frameflow.prompt_authority import PromptAuthorityError, approve_prompt_version, canonical_approved_prompt, prompt_sha256
from frameflow.reference_authority import normalize_reference_authority, ordered_reference_snapshot
from frameflow.recovery import RecoveryError, apply_recovery_plan, create_recovery_preview, create_verified_backup, export_project, recovery_scan
from frameflow.providers import ASSET_PROMPT_OUTPUT_SCHEMA, FUSION_PROMPT_OUTPUT_SCHEMA, PROJECT_PATCH_SCHEMA, REGULATOR_OUTPUT_SCHEMA, STORYBOARD_OUTPUT_SCHEMA, ProviderError, openai_assistant, openai_image, openai_image_edit, openai_speech, openai_structured, probe_profile
from frameflow.runtime import execute_v3_run
from frameflow.schemas import AgentPatchPreviewV3, AgentPlanCreateV3, AgentPlanDecisionV3, AgentPatchV3, ArtifactLineageCreateV3, ArtifactMapRequest, ArtifactRegisterRequest, AssetAssignmentV3, AssetBoardSyncV3, AssetBoardUpdateV3, AssetComparisonCreate, AssetComparisonReview, AssetCreateV3, AssetDuplicateV3, AssetImageGenerate, AssetManualProductionApproval, AssetMetadataUpdate, AssetPromptRunCreate, AssetReferenceRole, AssistantRequest, BackupCreateV3, CapabilityBinding, CredentialImport, CredentialWrite, FusionPromptRunCreate, ImageEdit, ImageGenerate, ProjectCreateV3, ProjectImport, ProjectMetadataUpdate, PromptCreateRequest, PromptQADecision, PromptRebuildRequest, PromptReviseRequest, ProviderProfileCreate, ProviderProfileUpdate, ProviderRoutePreviewV3, ProxyCreateV3, QADecisionSubmit, QARunCreate, RecoveryApplyV3, RecoveryPreviewV3, RenderCreateV3, RenderDecisionV3, RenderEstimateV3, RenderRequest, ResolutionRequest, RunDecisionV3, SeedancePackageCreate, SpeechGenerate, StoryDocumentUpdateV3, StoryOptimizationCreate, StoryRollbackV3, StoryboardAcceptRequest, TaskCreate, TimelineAssemblyRequestV3, TimelinePreviewRequestV3, TimelineUpdateV3, WorkflowGraphUpdateV3, WorkflowRunCreate, WorkflowRunCreateV3, WorkflowRunEstimateV3, WorkflowTemplateApplyV3, WorkflowTemplateCreateV3
from frameflow.secrets_store import SecretStoreError, delete_secret, get_secret, mask_secret, set_secret
from frameflow.v3 import assemble_approved_timeline, default_graph, ensure_graph, ensure_timeline, estimate_graph, save_graph, save_timeline, select_graph_node_ids, validate_graph
from frameflow.workflows import WORKFLOWS, evaluate_project_gates, workflow_manifest
from frameflow.story import story_checks, story_document
from frameflow.upload_storage import UploadTooLarge, cleanup_file, cleanup_staged_upload, finalize_staged_upload, stage_upload

ROOT=Path(__file__).resolve().parent; DATA_DIR=ROOT/"data"; DEFAULT_DATA_DIR=DATA_DIR; GENERATED_DIR=ROOT/"generated"; STUDIO_DIST=ROOT/"web"/"dist"; GENERATED_AUDIO_DIR=GENERATED_DIR/"audio"; REFERENCE_AUDIO_DIR=GENERATED_AUDIO_DIR/"references"
DB_PATH=Path(os.environ.get("FRAMEFLOW_DB_PATH", DATA_DIR/"frameflow.db")); os.environ.setdefault("JIMENG_CLI_HOME", str(DATA_DIR/"dreamina-home")); MAX_UPLOAD=1024**3; MAX_AUDIO_UPLOAD=25*1024**2
DEFAULT_BIND_HOST="127.0.0.1"; DEFAULT_BIND_PORT=8787; LOOPBACK_BIND_HOSTS={"127.0.0.1","localhost","::1"}
STATIC_FILES={"/":"web/dist/index.html","/index.html":"web/dist/index.html"}
ALLOWED_TTS_MODELS={"gpt-4o-mini-tts","gpt-4o-mini-tts-2025-12-15"}; ALLOWED_TTS_VOICES={"alloy","ash","ballad","coral","echo","fable","onyx","nova","sage","shimmer","verse","marin","cedar"}
ORCHESTRATOR_MODEL_OPTIONS=[
    {"id":"gpt-5.6-sol","label":"GPT-5.6 Sol","description":"旗舰能力，适合复杂创作编排"},
    {"id":"gpt-5.6-terra","label":"GPT-5.6 Terra（推荐）","description":"能力、速度与成本的平衡档"},
    {"id":"gpt-5.6-luna","label":"GPT-5.6 Luna","description":"高频、成本敏感的轻量编排"},
    {"id":"gpt-5.5","label":"GPT-5.5（兼容）","description":"保留既有 GPT-5.5 工作流"},
    {"id":"gpt-5.4","label":"GPT-5.4（兼容）","description":"保留既有 GPT-5.4 工作流"},
    {"id":"gpt-5.4-mini","label":"GPT-5.4 mini（兼容）","description":"保留原工作台默认配置"},
]
ALLOWED_ORCHESTRATOR_MODELS={item["id"] for item in ORCHESTRATOR_MODEL_OPTIONS}; DEFAULT_ORCHESTRATOR_MODEL="gpt-5.6-terra"
DEEPSEEK_MODEL_OPTIONS=[{"id":"deepseek-v4-flash","label":"DeepSeek V4 Flash（推荐测试）","description":"响应更快，适合日常编排"},{"id":"deepseek-v4-pro","label":"DeepSeek V4 Pro","description":"复杂创作与高质量编排"}]
ALLOWED_DEEPSEEK_MODELS={item["id"] for item in DEEPSEEK_MODEL_OPTIONS}
JIMENG_VIDEO_MODEL_OPTIONS=[
    {"id":"seedance2.0fast","label":"seedance2.0fast","description":"文生/图生/首尾帧 · 4–15 秒 · 720p"},
    {"id":"seedance2.0","label":"seedance2.0","description":"文生/图生/首尾帧 · 4–15 秒 · 720p"},
    {"id":"seedance2.0_vip","label":"seedance2.0_vip","description":"VIP · 4–15 秒 · 720p/1080p/4K"},
    {"id":"seedance2.0fast_vip","label":"seedance2.0fast_vip","description":"VIP · 4–15 秒 · 720p/1080p/4K"},
    {"id":"seedance2.0mini","label":"seedance2.0mini","description":"文生/图生/首尾帧 · 4–15 秒 · 720p"},
    {"id":"seedance2.5","label":"seedance2.5","description":"VIP · 4–30 秒 · 480p/720p/1080p"},
    {"id":"seedance1.5pro","label":"seedance1.5pro","description":"图生/首尾帧 · 5–12 秒 · 720p"},
    {"id":"seedance1.0fast","label":"seedance1.0fast","description":"仅图生 · 5–10 秒 · 720p"},
]
JIMENG_VIDEO_MODEL_IDS=[item["id"] for item in JIMENG_VIDEO_MODEL_OPTIONS]
PROVIDER_PRESETS={
    "deepseek":{"id":"deepseek-default","provider_type":"openai_compatible","display_name":"DeepSeek","base_url":"https://api.deepseek.com","model_config":{},"capabilities":["orchestrator"],"enabled":True,"model_options":DEEPSEEK_MODEL_OPTIONS},
    "opencode":{"id":"opencode-default","provider_type":"opencode","display_name":"OpenCode Go Plan Agent","base_url":"http://127.0.0.1:4096","model_config":{"server_username":"opencode","agent":"build","preferred_provider_id":"opencode-go","product":"go_plan"},"capabilities":["orchestrator"],"enabled":True,"model_options":[]},
    "comfyui":{"id":"comfyui-default","provider_type":"comfyui","display_name":"ComfyUI 本地 API","base_url":"http://127.0.0.1:8188","model_config":{"models":[],"capabilities":["image","image_edit","video","music","sfx","upscale","lip_sync","upload"]},"capabilities":["image","image_edit","video","music","sfx","upscale","lip_sync","upload"],"enabled":True,"model_options":[]},
    "jimeng":{"id":"jimeng-default","provider_type":"jimeng_cli","display_name":"即梦 CLI（本机）","base_url":"cli://dreamina","model_config":{"executable":"dreamina","model_version":"seedance2.0fast","models":JIMENG_VIDEO_MODEL_IDS},"capabilities":["video"],"enabled":True,"model_options":JIMENG_VIDEO_MODEL_OPTIONS},
}
AUTO_ROUTING_PROVIDER_PRIORITY={
    "orchestrator": ["opencode", "openai", "openai_compatible"],
    "vision": ["openai", "openai_compatible", "opencode", "comfyui"],
    "image": ["openai", "comfyui"],
    "image_edit": ["openai", "comfyui"],
    "video": ["jimeng_cli", "comfyui"],
    "tts": ["openai"],
    "music": ["comfyui"],
    "sfx": ["comfyui"],
    "lip_sync": ["comfyui"],
    "upscale": ["comfyui"],
    "upload": ["comfyui"],
}
OPENCODE_GO_MODEL_IDS={
    "grok-4.5", "glm-5.3", "glm-5.2", "glm-5.1", "gpt-5.6-luna", "kimi-k3", "kimi-k2.7-code",
    "kimi-k2.6", "mimo-v2.5-pro", "mimo-v2.5", "qwen3.8-max", "qwen3.7-max", "qwen3.7-plus",
    "qwen3.6-plus", "minimax-m3", "minimax-m2.7", "muse-spark-1.2-contributor", "deepseek-v4-pro",
    "deepseek-v4-flash", "hy3",
}
TRANSITIONS={"draft":{"validated","canceled"},"validated":{"awaiting_confirmation","queued","canceled"},"awaiting_confirmation":{"queued","canceled"},"queued":{"running","canceled","failed","blocked"},"running":{"succeeded","generated_pending_qa","failed","blocked","canceled"},"succeeded":{"generated_pending_qa","approved"},"generated_pending_qa":{"approved","revision_required"},"revision_required":{"queued","blocked","canceled"},"blocked":{"queued","canceled"},"failed":{"queued","canceled"},"approved":set(),"canceled":set()}
V3_RUNTIME_TASKS:dict[str,asyncio.Task[Any]]={}
V3_RENDER_TASKS:dict[str,asyncio.Task[Any]]={}

def classify_bind_host(host:str)->str:
    normalized=host.strip().lower().strip("[]")
    if normalized in LOOPBACK_BIND_HOSTS:return "loopback"
    try:address=ipaddress.ip_address(normalized)
    except ValueError:return "unsupported"
    return "unsupported_loopback" if address.is_loopback else "non_loopback"

def ensure_loopback_bind(host:str)->str:
    normalized=host.strip().lower().strip("[]")
    if classify_bind_host(normalized)!="loopback":
        raise RuntimeError(f"FRAMEFLOW supports loopback-only binding ({', '.join(sorted(LOOPBACK_BIND_HOSTS))}); non-loopback host {host!r} is rejected because application authentication is not configured.")
    return normalized

def requested_bind_host(argv:list[str]|None=None, environment:dict[str,str]|None=None)->str:
    args=sys.argv if argv is None else argv
    env=os.environ if environment is None else environment
    configured=str(env.get("FRAMEFLOW_BIND_HOST") or "").strip()
    if configured:return configured
    for index,arg in enumerate(args):
        if arg=="--host":
            if index+1>=len(args):raise RuntimeError("--host requires a bind address.")
            return args[index+1]
        if arg.startswith("--host="):return arg.split("=",1)[1]
    return DEFAULT_BIND_HOST

def _jimeng_executable_config_error(model_config:dict[str,Any]) -> str | None:
    executable=str(model_config.get("executable") or "").strip()
    if not executable:return None
    lowered=executable.lower()
    if any(operator in executable for operator in ("|","&&",";","\r","\n")) or re.search(r"(?:^|\s)(curl|wget|bash|sh|powershell|pwsh|invoke-webrequest|irm)(?:\s|$)",lowered):
        return "即梦 CLI 的可执行文件只能填写 dreamina、dreamina.exe 或完整路径，不能填写安装命令。"
    return None

def _migrate_legacy_video_profiles(database:Database, now:str) -> None:
    """Move old HTTP video profiles to the local official CLI boundary.

    Existing projects keep their media and package history.  Only the provider
    route is migrated, so a restart cannot accidentally send new work to the
    retired HTTP integration.
    """
    cli_config = {"executable": "dreamina", "model_version": "seedance2.0fast", "models": JIMENG_VIDEO_MODEL_IDS}
    with database.connect() as c:
        legacy = c.execute("SELECT * FROM provider_profiles WHERE provider_type='volcengine_ark'").fetchall()
        for row in legacy:
            target_id = "jimeng-default" if row["id"] == "ark-default" else row["id"]
            target = c.execute("SELECT id FROM provider_profiles WHERE id=?", (target_id,)).fetchone()
            if row["id"] == "ark-default" and not target:
                c.execute("INSERT INTO provider_profiles(id,provider_type,display_name,base_url,credential_ref,model_config_json,capabilities_json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", ("jimeng-default", "jimeng_cli", "即梦 CLI（本机）", "cli://dreamina", "provider:jimeng-default", database.encode(cli_config), database.encode(["video"]), row["enabled"], row["created_at"], now))
                c.execute("UPDATE capability_bindings SET provider_profile_id=?,model=? WHERE provider_profile_id=? AND capability='video'", ("jimeng-default", DEFAULT_VIDEO_MODEL, row["id"]))
                c.execute("DELETE FROM capability_bindings WHERE provider_profile_id=? AND capability='upload'", (row["id"],))
                c.execute("UPDATE tasks SET provider_profile_id=? WHERE provider_profile_id=? AND status IN ('draft','validated','awaiting_confirmation')", ("jimeng-default", row["id"]))
                c.execute("DELETE FROM provider_profiles WHERE id=?", (row["id"],))
                continue
            if target and target_id != row["id"]:
                c.execute("UPDATE capability_bindings SET provider_profile_id=?,model=? WHERE provider_profile_id=? AND capability='video'", (target_id, DEFAULT_VIDEO_MODEL, row["id"]))
                c.execute("UPDATE tasks SET provider_profile_id=? WHERE provider_profile_id=? AND status IN ('draft','validated','awaiting_confirmation')", (target_id, row["id"]))
                c.execute("DELETE FROM provider_profiles WHERE id=?", (row["id"],))
                continue
            c.execute("UPDATE provider_profiles SET provider_type='jimeng_cli',display_name=?,base_url='cli://dreamina',credential_ref=?,model_config_json=?,capabilities_json=?,updated_at=? WHERE id=?", ("即梦 CLI（本机）", f"provider:{target_id}", database.encode(cli_config), database.encode(["video"]), now, row["id"]))
            c.execute("UPDATE capability_bindings SET provider_profile_id=?,model=? WHERE provider_profile_id=? AND capability='video'", (row["id"], DEFAULT_VIDEO_MODEL, row["id"]))
            c.execute("DELETE FROM capability_bindings WHERE provider_profile_id=? AND capability='upload'", (row["id"],))


def seed_defaults(database:Database)->None:
    now=utcnow(); _migrate_legacy_video_profiles(database, now); profiles=[("openai-default","openai","OpenAI","https://api.openai.com/v1","provider:openai-default",{"orchestrator_model":DEFAULT_ORCHESTRATOR_MODEL,"image_model":"gpt-image-2","tts_model":"gpt-4o-mini-tts"},["orchestrator","image","tts"]),("jimeng-default","jimeng_cli","即梦 CLI（本机）","cli://dreamina","provider:jimeng-default",{"executable":"dreamina","model_version":DEFAULT_VIDEO_MODEL,"models":JIMENG_VIDEO_MODEL_IDS},["video"]),("opencode-default","opencode","OpenCode Go Plan Agent","http://127.0.0.1:4096","provider:opencode-default",{"server_username":"opencode","agent":"build","preferred_provider_id":"opencode-go","product":"go_plan"},["orchestrator"])]
    with database.connect() as c:
        for p in profiles:c.execute("INSERT OR IGNORE INTO provider_profiles(id,provider_type,display_name,base_url,credential_ref,model_config_json,capabilities_json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?)",(*p[:5],database.encode(p[5]),database.encode(p[6]),now,now))
        for row in c.execute("SELECT id,model_config_json FROM provider_profiles WHERE provider_type='jimeng_cli'").fetchall():
            config=database.decode(row["model_config_json"],{})
            if isinstance(config,dict) and _jimeng_executable_config_error(config):
                config["executable"]="dreamina"
                c.execute("UPDATE provider_profiles SET model_config_json=?,updated_at=? WHERE id=?",(database.encode(config),now,row["id"]))
            if row["id"] == "jimeng-default" and isinstance(config,dict):
                config["models"] = JIMENG_VIDEO_MODEL_IDS
                if str(config.get("model_version") or "").strip() not in JIMENG_VIDEO_MODEL_IDS:
                    config["model_version"] = DEFAULT_VIDEO_MODEL
                c.execute("UPDATE provider_profiles SET model_config_json=?,updated_at=? WHERE id=?",(database.encode(config),now,row["id"]))
        for cap,pid,model in [("orchestrator","openai-default",DEFAULT_ORCHESTRATOR_MODEL),("image","openai-default","gpt-image-2"),("tts","openai-default","gpt-4o-mini-tts"),("video","jimeng-default",DEFAULT_VIDEO_MODEL)]:c.execute("INSERT OR IGNORE INTO capability_bindings(capability,provider_profile_id,model,updated_at) VALUES(?,?,?,?)",(cap,pid,model,now))
        c.execute("UPDATE capability_bindings SET model=?,updated_at=? WHERE capability='video' AND provider_profile_id='jimeng-default'",(DEFAULT_VIDEO_MODEL,now))


def ensure_daily_startup_backup(database:Database)->dict[str,Any]|None:
    if Path(database.path).resolve()!=(DEFAULT_DATA_DIR/"frameflow.db").resolve():return None
    today=datetime.now(UTC).date().isoformat()
    with database.connect() as connection:
        existing=connection.execute("SELECT id FROM backup_records_v11 WHERE status='verified' AND created_at LIKE ? ORDER BY created_at DESC LIMIT 1",(f"{today}%",)).fetchone()
    if existing:return {"id":existing["id"],"status":"already_verified_today"}
    return create_verified_backup(database,DEFAULT_DATA_DIR,DEFAULT_DATA_DIR/"safety-backups")

@asynccontextmanager
async def lifespan(application:FastAPI):
    global DATA_DIR, GENERATED_DIR, GENERATED_AUDIO_DIR, REFERENCE_AUDIO_DIR
    ensure_loopback_bind(requested_bind_host())
    if Path(DB_PATH).resolve() != (DEFAULT_DATA_DIR / "frameflow.db").resolve():
        runtime_root = Path(tempfile.gettempdir()) / f"frameflow-runtime-{Path(DB_PATH).stem}"
        DATA_DIR = runtime_root
        GENERATED_DIR = runtime_root / "generated"
        GENERATED_AUDIO_DIR = GENERATED_DIR / "audio"
        REFERENCE_AUDIO_DIR = GENERATED_AUDIO_DIR / "references"
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        os.environ["JIMENG_CLI_HOME"] = str(runtime_root / "dreamina-home")
    application.state.db=Database(DB_PATH); seed_defaults(application.state.db); ensure_daily_startup_backup(application.state.db); await resume_tasks(application); await resume_v3_runs(application); await resume_v3_renders(application); yield

app=FastAPI(title="FRAMEFLOW V3",version="3.0.0",lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])


@app.middleware("http")
async def local_security_boundary(request: Request, call_next):
    """Local-only CSRF/Origin boundary plus browser-safe response headers.

    The supported deployment is a single-user HTTP service bound to loopback.
    Native clients and command-line tools do not send Origin, while browsers
    that do send it must be one of the loopback origins. This avoids adding a
    fake authentication layer while preventing a foreign web page from issuing
    state-changing localhost requests.
    """
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("origin")
        expected_origin = f"{request.url.scheme}://{request.url.netloc}"
        if origin and origin.rstrip("/") != expected_origin:
            return JSONResponse(status_code=403, content={"detail": "跨域状态修改请求被本机 Origin 策略拒绝。"})
    response = await call_next(request)
    response.headers.setdefault("Content-Security-Policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' http://127.0.0.1:8787 http://localhost:8787; style-src 'self' 'unsafe-inline'; script-src 'self'")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Cross-Origin-Resource-Policy", "same-origin")
    return response


def _v3_openapi() -> dict[str, Any]:
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(title=app.title, version=app.version, description="FrameFlow V3 API", routes=app.routes)
    schema["paths"] = {
        path: value for path, value in schema.get("paths", {}).items()
        if path.startswith("/api/v2/") or path in {"/api/health", "/api/system/doctor"}
    }
    app.openapi_schema = schema
    return schema


app.openapi = _v3_openapi

def error_category(status:int)->str:
    if status==409:return "conflict"
    if status in {400,422}:return "validation"
    if 400<=status<500:return "request"
    return "internal"

def structured_error(status:int,code:str,category:str,message:str,details:Any=None,retryable:bool=False)->JSONResponse:
    return JSONResponse(status_code=status,content={"code":code,"category":category,"message":message,"details":details if details is not None else {},"retryable":retryable,"error":message})

def provider_error_retryable(status:int,kind:str)->bool:
    if kind in {"auth","billing","configuration","conflict","validation"}:return False
    return status in {408,425,429,500,502,503,504}

def failure_kind_for_status(status:int)->str:
    if status in {401,403}:return "auth"
    if status==402:return "billing"
    if status==409:return "configuration"
    if status in {400,422}:return "validation"
    if status==429:return "rate_limit"
    if 400<=status<500:return "request"
    return "retryable"

def classify_failure(exc:Exception)->tuple[int,str,bool,dict[str,Any]]:
    status=getattr(exc,"status_code",None)
    if not isinstance(status,int):status=500
    kind=getattr(exc,"kind",None)
    if not isinstance(kind,str) or not kind:kind=failure_kind_for_status(status)
    client_status=status if 400<=status<500 else 502
    return client_status,kind,provider_error_retryable(status,kind),{"message":str(exc),"kind":kind,"status":status}

@app.exception_handler(RequestValidationError)
async def validation_error(_:Request,exc:RequestValidationError):
    return JSONResponse(status_code=422,content={"code":"validation_error","category":"validation","message":"请求字段无效。","details":jsonable_encoder(exc.errors()),"retryable":False,"error":"请求字段无效。"})
@app.exception_handler(ProviderError)
async def provider_error(_:Request,exc:ProviderError):
    return JSONResponse(status_code=exc.status_code,content={"code":"provider_error","category":exc.kind,"message":str(exc),"details":{},"retryable":provider_error_retryable(exc.status_code,exc.kind),"error":str(exc),"error_kind":exc.kind})
@app.exception_handler(HTTPException)
async def http_exception_handler(_:Request,exc:HTTPException):
    detail=exc.detail
    message=detail.get("message","请求失败") if isinstance(detail,dict) else (str(detail) if detail else "请求失败")
    return JSONResponse(status_code=exc.status_code,content={"code":"http_error","category":error_category(exc.status_code),"message":message,"details":detail if isinstance(detail,dict) else {},"retryable":exc.status_code>=500,"error":message,"detail":detail})
@app.exception_handler(Exception)
async def unhandled_error(_:Request,exc:Exception):
    return JSONResponse(status_code=500,content={"code":"internal_error","category":"internal","message":"服务器内部错误。","details":{},"retryable":True,"error":"服务器内部错误。"})


@app.middleware("http")
async def v3_only_gateway(request: Request, call_next):
    """Retire the pre-V3 public surface while keeping internal helpers callable."""
    path = request.url.path
    allowed = path.startswith("/api/v2/") or path in {"/api/health", "/api/system/doctor"} or path.startswith("/api/project-files/") or path.startswith("/generated/")
    if path.startswith("/api/") and not allowed:
        return JSONResponse(status_code=410, content={"code": "legacy_api_retired", "message": "旧版接口已在 FrameFlow V3 中退役，请使用 /api/v2。", "retryable": False})
    return await call_next(request)

def db(request:Request)->Database:return request.app.state.db


def schedule_v3_run(application:FastAPI,run_id:str)->None:
    existing=V3_RUNTIME_TASKS.get(run_id)
    if existing and not existing.done():
        return
    task=asyncio.create_task(execute_v3_run(application.state.db,run_id))
    V3_RUNTIME_TASKS[run_id]=task

    def cleanup(completed:asyncio.Task[Any])->None:
        if V3_RUNTIME_TASKS.get(run_id) is completed:
            V3_RUNTIME_TASKS.pop(run_id,None)
        if not completed.cancelled():
            completed.exception()

    task.add_done_callback(cleanup)


async def resume_v3_runs(application:FastAPI)->None:
    database:Database=application.state.db
    with database.connect() as connection:
        rows=connection.execute("SELECT id FROM workflow_runs_v3 WHERE status IN ('queued','running') ORDER BY created_at").fetchall()
    for row in rows:schedule_v3_run(application,row["id"])


def schedule_v3_render(application:FastAPI, render_id: str) -> None:
    existing = V3_RENDER_TASKS.get(render_id)
    if existing and not existing.done():
        return
    task = asyncio.create_task(run_v3_render_task(application, render_id))
    V3_RENDER_TASKS[render_id] = task

    def cleanup(completed: asyncio.Task[Any]) -> None:
        if V3_RENDER_TASKS.get(render_id) is completed:
            V3_RENDER_TASKS.pop(render_id, None)
        if not completed.cancelled():
            completed.exception()

    task.add_done_callback(cleanup)


async def resume_v3_renders(application: FastAPI) -> None:
    database: Database = application.state.db
    with database.connect() as connection:
        rows = connection.execute("SELECT id FROM render_jobs_v6 WHERE status IN ('queued','running') ORDER BY created_at").fetchall()
    for row in rows:
        schedule_v3_render(application, row["id"])


def provider_environment(profile:dict[str,Any]|sqlite3.Row)->str:
    if profile["provider_type"]=="jimeng_cli":return ""
    if profile["provider_type"]=="opencode":return "OPENCODE_SERVER_PASSWORD"
    if profile["provider_type"]=="comfyui":return "COMFYUI_API_KEY"
    if "api.deepseek.com" in str(profile["base_url"]).lower():return "DEEPSEEK_API_KEY"
    return "OPENAI_API_KEY"
def row_profile(database:Database,row:sqlite3.Row)->dict[str,Any]:
    last_health=database.decode(row["last_health_json"],None)
    secret=get_secret(row["credential_ref"],provider_environment(row)) if row["provider_type"]!="jimeng_cli" else None
    cli_configured=row["provider_type"]=="jimeng_cli" and isinstance(last_health,dict) and last_health.get("ok") is True
    return {"id":row["id"],"provider_type":row["provider_type"],"display_name":row["display_name"],"base_url":row["base_url"],"credential_ref":row["credential_ref"],"credential_configured":bool(secret) or cli_configured,"credential_mask":"即梦 CLI 本机登录态" if cli_configured else mask_secret(secret),"model_config":database.decode(row["model_config_json"],{}),"capabilities":database.decode(row["capabilities_json"],[]),"enabled":bool(row["enabled"]),"last_health":last_health,"updated_at":row["updated_at"]}
def public_profile(profile:dict[str,Any])->dict[str,Any]:return {k:v for k,v in profile.items() if k!="credential_ref"}
def get_profile(database:Database,pid:str)->dict[str,Any]:
    with database.connect() as c:row=c.execute("SELECT * FROM provider_profiles WHERE id=?",(pid,)).fetchone()
    if not row:raise HTTPException(404,"供应商配置不存在。")
    return row_profile(database,row)
def validate_orchestrator_model(profile:dict[str,Any],model:str|None)->None:
    if not model:return
    if profile["provider_type"]=="openai":
        if model not in ALLOWED_ORCHESTRATOR_MODELS:raise HTTPException(422,"编排模型不在可选列表中，请从设置页下拉框选择。")
        detected=set((profile.get("last_health") or {}).get("models") or [])
        if detected and model not in detected:raise HTTPException(422,"当前 OpenAI 账号未探测到该编排模型，请重新检测后选择可用项。")
    elif profile["provider_type"] in {"openai_compatible","opencode"}:
        detected=set((profile.get("last_health") or {}).get("models") or [])
        if profile["provider_type"]=="opencode":
            if "/" not in model:raise HTTPException(422,"OpenCode 模型必须使用 provider_id/model_id 格式。")
            model_id=model.split("/",1)[1].lower().removesuffix("-free")
            # OpenCode Go's official catalog is broader than the connected
            # `/provider` registry in some Server releases. Accept those
            # documented Go models so the Settings page can configure them;
            # the next real run still reports any upstream availability error.
            if model_id in OPENCODE_GO_MODEL_IDS:
                return
            if not detected:raise HTTPException(422,"请先检测 OpenCode Server，再选择已连接提供商下的模型。")
            if model not in detected:raise HTTPException(422,"该模型不在 OpenCode 最近探测到的模型目录中。")
            readiness=(profile.get("last_health") or {}).get("model_readiness") or {}
            if readiness.get(model) is False:raise HTTPException(422,"该 OpenCode 模型所属提供商尚未连接。")
            return
        if "api.deepseek.com" in str(profile.get("base_url","")).lower() and model in ALLOWED_DEEPSEEK_MODELS:
            if detected and model not in detected:raise HTTPException(422,"当前 DeepSeek 账号未探测到该模型，请选择账号可用项。")
            return
        if not detected:raise HTTPException(422,"请先检测 OpenAI-compatible 接口，再从探测到的模型中选择。")
        if model not in detected:raise HTTPException(422,"编排模型不在该接口最近探测到的模型列表中。")
def validate_profile_model_config(profile:dict[str,Any],config:dict[str,Any])->None:
    validate_orchestrator_model(profile,config.get("orchestrator_model"))
def get_profile_secret(profile:dict[str,Any])->str:
    if profile["provider_type"]=="jimeng_cli":return ""
    value=get_secret(profile["credential_ref"],provider_environment(profile))
    if not value and profile["provider_type"] not in {"opencode","comfyui"}:raise ProviderError("该供应商尚未配置 API 密钥。","configuration",409)
    # OpenCode Server authentication is optional unless its operator enabled
    # OPENCODE_SERVER_PASSWORD.
    if not value and profile["provider_type"] in {"opencode","comfyui"}:return ""
    return value
def resolve_profile(database:Database,capability:str,requested:str|None=None):
    if requested:return get_profile(database,requested),None
    with database.connect() as c:b=c.execute("SELECT * FROM capability_bindings WHERE capability=?",(capability,)).fetchone()
    if not b:raise HTTPException(409,f"尚未设置 {capability} 默认供应商。")
    return get_profile(database,b["provider_profile_id"]),b["model"]

def task_payload(database:Database,row:sqlite3.Row)->dict[str,Any]:return {"id":row["id"],"project_id":row["project_id"],"task_type":row["task_type"],"status":row["status"],"provider_profile_id":row["provider_profile_id"],"provider_model":row["provider_model"],"request":database.decode(row["request_json"],{}),"result":database.decode(row["result_json"],None),"error_kind":row["error_kind"],"error_message":row["error_message"],"paid":bool(row["paid"]),"confirmed_at":row["confirmed_at"],"provider_task_id":row["provider_task_id"],"attempts":row["attempts"],"created_at":row["created_at"],"updated_at":row["updated_at"]}
def create_task_record(database:Database,payload:TaskCreate)->dict[str,Any]:
    tid=f"TASK_{secrets.token_hex(8)}"; status="awaiting_confirmation" if payload.paid else "queued"; now=utcnow()
    with database.connect() as c:
        c.execute("INSERT INTO tasks(id,project_id,task_type,status,provider_profile_id,provider_model,request_json,paid,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",(tid,payload.project_id,payload.task_type,status,payload.provider_profile_id,payload.provider_model,database.encode(payload.request),int(payload.paid),now,now)); c.execute("INSERT INTO task_events(task_id,from_status,to_status,detail_json,created_at) VALUES(?,NULL,?,'{}',?)",(tid,status,now)); row=c.execute("SELECT * FROM tasks WHERE id=?",(tid,)).fetchone()
    return task_payload(database,row)
def transition(database:Database,tid:str,status:str,detail:dict|None=None,force=False)->None:
    with database.connect() as c:
        row=c.execute("SELECT status FROM tasks WHERE id=?",(tid,)).fetchone()
        if not row:raise HTTPException(404,"任务不存在。")
        old=row["status"]
        if not force and status not in TRANSITIONS.get(old,set()):raise HTTPException(409,f"任务不能从 {old} 转为 {status}。")
        c.execute("UPDATE tasks SET status=?,updated_at=? WHERE id=?",(status,utcnow(),tid)); c.execute("INSERT INTO task_events(task_id,from_status,to_status,detail_json,created_at) VALUES(?,?,?,?,?)",(tid,old,status,database.encode(detail or {}),utcnow()))

def _effective_capabilities(database: Database) -> dict[str, dict[str, Any]]:
    """Return capability readiness from the current binding and last probe."""
    with database.connect() as connection:
        bindings = {row["capability"]: dict(row) for row in connection.execute("SELECT * FROM capability_bindings").fetchall()}
        profiles = {row["id"]: row_profile(database, row) for row in connection.execute("SELECT * FROM provider_profiles").fetchall()}
    result: dict[str, dict[str, Any]] = {}
    for capability in CAPABILITIES:
        binding = bindings.get(capability)
        profile = profiles.get(str(binding.get("provider_profile_id"))) if binding else None
        health = profile.get("last_health") if profile else None
        healthy = bool(profile and profile.get("enabled") and isinstance(health, dict) and health.get("ok") is True)
        model = str(binding.get("model") or "") if binding else ""
        models = [str(item) for item in (health or {}).get("models", []) if item]
        model_ready = not model or not models or model in models
        ready = healthy and model_ready
        result[capability] = {
            "ready": ready,
            "status": "ready" if ready else "not_ready",
            "provider_profile_id": profile.get("id") if profile else None,
            "provider": profile.get("display_name") if profile else None,
            "model": model or None,
            "health": health.get("ok") if isinstance(health, dict) else None,
            "reason": None if ready else ("unbound" if not binding else "provider_unhealthy_or_model_unavailable"),
        }
    return result


@app.get("/api/health")
async def health(request:Request):
    database = db(request)
    capabilities = _effective_capabilities(database)
    effective = {key: bool(value["ready"]) for key, value in capabilities.items()}
    required_ready = effective.get("orchestrator", False)
    media_ready = any(effective.get(key, False) for key in ("image", "video", "tts", "music", "sfx"))
    status = "ready" if required_ready and media_ready else "degraded" if required_ready or media_ready else "not_ready"
    openai = None
    try:
        openai = get_profile(database, "openai-default")
    except HTTPException:
        pass
    return {
        "status": status,
        "ok": status != "not_ready",
        "ready": status == "ready",
        "degraded": status == "degraded",
        "version": app.version,
        "schema_version": SCHEMA_VERSION,
        "openai_configured": bool(openai and openai["credential_configured"]),
        "audio": bool(effective.get("tts") or effective.get("music") or effective.get("sfx")),
        "images": bool(effective.get("image") or effective.get("image_edit")),
        "seedance": bool(effective.get("video")),
        "capabilities": capabilities,
    }
@app.get("/api/system/doctor")
async def doctor(request:Request):
    try:import keyring; keyring_ok=not keyring.get_keyring().__class__.__module__.startswith("keyring.backends.fail")
    except Exception:keyring_ok=False
    frontend_ok = (STUDIO_DIST / "index.html").exists()
    return {"ok":bool(find_binary("ffmpeg") and find_binary("ffprobe") and frontend_ok),"ffmpeg":find_binary("ffmpeg"),"ffprobe":find_binary("ffprobe"),"frontend_dist":str(STUDIO_DIST),"frontend_ready":frontend_ok,"database":str(db(request).path),"keyring_available":keyring_ok,"disk_free_bytes":shutil.disk_usage(ROOT).free}


@app.get("/api/v2/system/data-audit")
async def data_audit_v3(request:Request):
    return scan_data_integrity(db(request),DATA_DIR)


def _recovery_http_error(exc:RecoveryError)->HTTPException:
    status=404 if exc.code in {"project_missing","source_directory_missing","recovery_plan_missing"} else 409
    return HTTPException(status,{"message":exc.message,"recovery":exc.payload()})


@app.post("/api/v2/system/backups")
async def create_backup_v3(body:BackupCreateV3,request:Request):
    database=db(request)
    if body.project_id:
        with database.connect() as connection:
            if not connection.execute("SELECT 1 FROM projects WHERE id=?",(body.project_id,)).fetchone():raise HTTPException(404,"项目不存在。")
    try:return create_verified_backup(database,DATA_DIR,DATA_DIR/"safety-backups",body.project_id)
    except RecoveryError as exc:raise _recovery_http_error(exc) from exc


@app.post("/api/v2/projects/{project_id}/export")
async def export_project_v3(project_id:str,request:Request):
    try:return export_project(db(request),DATA_DIR,DATA_DIR/"exports",project_id)
    except RecoveryError as exc:raise _recovery_http_error(exc) from exc


@app.get("/api/v2/recovery/scan")
async def recovery_scan_v3(request:Request):
    return recovery_scan(db(request),DATA_DIR)


@app.post("/api/v2/recovery/preview")
async def recovery_preview_v3(body:RecoveryPreviewV3,request:Request):
    try:return create_recovery_preview(db(request),DATA_DIR,body.source_project_id,body.proposed_name)
    except RecoveryError as exc:raise _recovery_http_error(exc) from exc


@app.post("/api/v2/recovery/apply")
async def recovery_apply_v3(body:RecoveryApplyV3,request:Request):
    try:return apply_recovery_plan(db(request),DATA_DIR,body.preview_id,body.manifest_sha256,body.confirmed)
    except RecoveryError as exc:raise _recovery_http_error(exc) from exc


@app.post("/api/v2/projects/{project_id}/maintenance/repair-asset-links")
async def repair_asset_links_v3(project_id: str, request: Request):
    """Repair explicit story/asset relationships without changing readiness."""
    database = db(request)
    now = utcnow()
    with database.connect() as connection:
        project = connection.execute("SELECT document_json,revision FROM projects WHERE id=?", (project_id,)).fetchone()
        if not project:
            raise HTTPException(404, "项目不存在。")
        board_row = connection.execute("SELECT * FROM asset_boards_v7 WHERE project_id=?", (project_id,)).fetchone()
        artifact_rows = connection.execute("SELECT * FROM artifacts WHERE project_id=? ORDER BY created_at DESC", (project_id,)).fetchall()
        current_document = database.decode(project["document_json"], {})
        derived = derive_story_asset_links(current_document, artifact_rows)
        next_project_revision = int(project["revision"]) + (1 if derived["added"] else 0)
        previous_board = database.decode(board_row["board_json"], {}) if board_row else None
        next_board = _validate_asset_board(_asset_board_from_document(database, project_id, derived["document"], next_project_revision, previous_board, artifact_rows))
        current_board_revision = int(board_row["revision"]) if board_row else 0
        next_board_revision = current_board_revision + 1 if board_row else 1
        if derived["added"]:
            connection.execute("UPDATE projects SET document_json=?,revision=?,updated_at=? WHERE id=?", (database.encode(derived["document"]), next_project_revision, now, project_id))
        if board_row:
            connection.execute("UPDATE asset_boards_v7 SET revision=?,board_json=?,updated_at=? WHERE project_id=?", (next_board_revision, database.encode(next_board), now, project_id))
        else:
            connection.execute("INSERT INTO asset_boards_v7(project_id,revision,board_json,created_at,updated_at) VALUES(?,?,?,?,?)", (project_id, next_board_revision, database.encode(next_board), now, now))
        connection.execute("DELETE FROM asset_dependencies_v4 WHERE project_id=? AND relation='shot_dependency'", (project_id,))
        assets = {str(item.get("id")): item for item in derived["document"].get("assets", []) if isinstance(item, dict) and item.get("id")}
        for shot in derived["document"].get("shots", []):
            if not isinstance(shot, dict) or not shot.get("id"):
                continue
            for requirement in shot.get("assetRequirements") or []:
                if not isinstance(requirement, dict):
                    continue
                asset_id = str(requirement.get("assetId") or "")
                if asset_id not in assets:
                    continue
                connection.execute("INSERT OR IGNORE INTO asset_dependencies_v4(id,project_id,logical_asset_id,dependency_asset_id,shot_id,relation,role,required,created_at) VALUES(?,?,?,?,?,?,?,?,?)", (asset_audit.new_id("DEP"), project_id, asset_id, asset_id, str(shot["id"]), "shot_dependency", requirement.get("role") or "asset reference", int(bool(requirement.get("required", True))), now))
    asset_audit.record_event(database, project_id, None, None, "asset_links_pending", "asset_links_repaired", {"added": len(derived["added"]), "unresolved": len(derived["unresolved"]), "board_revision": next_board_revision})
    return {"ok": True, "project_id": project_id, "project_revision": next_project_revision, "board_revision": next_board_revision, "added": derived["added"], "unresolved": derived["unresolved"], "checks": story_checks(derived["document"])}

@app.get("/api/projects")
async def list_projects(request:Request):
    database=db(request)
    with database.connect() as c:rows=c.execute("SELECT * FROM projects ORDER BY updated_at DESC").fetchall()
    return {"projects":[{"document":database.decode(r["document_json"]),"revision":r["revision"],"updated_at":r["updated_at"]} for r in rows]}
@app.get("/api/projects/{project_id}")
async def read_project(project_id:str,request:Request):
    database=db(request)
    with database.connect() as c:r=c.execute("SELECT * FROM projects WHERE id=?",(project_id,)).fetchone()
    if not r:raise HTTPException(404,"项目不存在。")
    return {"document":database.decode(r["document_json"]),"revision":r["revision"],"updated_at":r["updated_at"]}
@app.put("/api/projects/{project_id}")
async def save_project(project_id:str,body:ProjectImport,request:Request):
    if body.document.id!=project_id:raise HTTPException(409,"项目 ID 与路径不一致。")
    database=db(request); doc=body.document.model_dump(); now=utcnow()
    with database.connect() as c:
        current=c.execute("SELECT revision,document_json FROM projects WHERE id=?",(project_id,)).fetchone()
    if current:
        if body.expected_revision is not None and current["revision"]!=body.expected_revision:raise HTTPException(409,{"message":"项目已有更新。","current_revision":current["revision"],"current_document":database.decode(current["document_json"])})
        rev=current["revision"]+1
        with database.connect() as c:c.execute("UPDATE projects SET name=?,document_json=?,revision=?,updated_at=?,lifecycle_status=? WHERE id=?",(body.document.name,database.encode(doc),rev,now,body.document.lifecycleStatus,project_id))
    else:
        rev=1
        try:_insert_project_with_directory(database,project_id,body.document.name,doc,rev,body.document.createdAt or now,now,body.document.lifecycleStatus)
        except (sqlite3.IntegrityError,FileExistsError) as exc:raise HTTPException(409,"项目 ID 或项目目录已存在，未写入任何数据。") from exc
    return {"ok":True,"revision":rev,"updated_at":now,"lifecycle_status":body.document.lifecycleStatus}
@app.post("/api/projects/import/preview")
async def preview_import(body:ProjectImport,request:Request):
    database=db(request)
    with database.connect() as c:r=c.execute("SELECT revision FROM projects WHERE id=?",(body.document.id,)).fetchone()
    return {"valid":True,"project_id":body.document.id,"name":body.document.name,"conflict":bool(r),"current_revision":r["revision"] if r else None,"counts":{"assets":len(body.document.assets),"shots":len(body.document.shots),"generations":len(body.document.generations)}}
@app.post("/api/projects/import")
async def import_project(body:ProjectImport,request:Request):return await save_project(body.document.id,body,request)

@app.delete("/api/v2/projects/{project_id}")
@app.delete("/api/projects/{project_id}")
async def delete_project(project_id:str,request:Request):
    database=db(request)
    with database.connect() as c:
        row=c.execute("SELECT id,name,document_json,lifecycle_status FROM projects WHERE id=?",(project_id,)).fetchone()
        if not row:raise HTTPException(404,"项目不存在。")
        count=c.execute("SELECT COUNT(*) AS n FROM projects").fetchone()["n"]
        if count<=1:raise HTTPException(409,"至少保留一个项目，无法删除最后一个项目。")
    active={key:value for key,value in active_project_runs(database,project_id).items() if value}
    if active:raise HTTPException(409,{"message":"该项目存在运行中、排队中、等待确认或渲染中的任务，请先取消后再删除。","active_runs":active})
    project_before=database.decode(row["document_json"],{})
    counts=delete_project_records(
        database,project_id,
        audit_event={
            "action":"project_deleted", "target_type":"project", "target_id":project_id,
            "reason":"project_deleted", "before":{"id":project_id,"name":row["name"],"lifecycleStatus":row["lifecycle_status"],"document":project_before}, "after":{},
        },
    )
    return {"ok":True,"project_id":project_id,"project_files_preserved":True,"deleted_records":counts}

@app.get("/api/provider-profiles")
async def list_profiles(request:Request):
    database=db(request)
    with database.connect() as c:rows=c.execute("SELECT * FROM provider_profiles ORDER BY created_at").fetchall()
    return {"profiles":[public_profile(row_profile(database,r)) for r in rows]}
@app.get("/api/provider-presets")
async def provider_presets():return {"presets":[{"preset_id":key,**value} for key,value in PROVIDER_PRESETS.items()]}
@app.post("/api/provider-profiles/from-preset/{preset_id}")
async def add_profile_from_preset(preset_id:str,request:Request):
    preset=PROVIDER_PRESETS.get(preset_id)
    if not preset:raise HTTPException(404,"供应商预设不存在。")
    return await add_profile(ProviderProfileCreate(**{k:v for k,v in preset.items() if k!="model_options"}),request)
@app.get("/api/settings/orchestrator-model-options")
async def orchestrator_model_options():return {"default":DEFAULT_ORCHESTRATOR_MODEL,"models":ORCHESTRATOR_MODEL_OPTIONS}
@app.post("/api/provider-profiles")
async def add_profile(body:ProviderProfileCreate,request:Request):
    database=db(request); pid=body.id or f"provider-{secrets.token_hex(5)}"; now=utcnow()
    if body.provider_type=="openai_compatible" and any(x!="orchestrator" for x in body.capabilities):raise HTTPException(422,"OpenAI-compatible 配置在当前版本只支持文本编排能力。")
    if body.provider_type=="opencode" and any(x!="orchestrator" for x in body.capabilities):raise HTTPException(422,"OpenCode 接入点仅承载文本编排 Agent；媒体能力仍由独立供应商提供。")
    if body.provider_type=="jimeng_cli" and any(x!="video" for x in body.capabilities):raise HTTPException(422,"即梦 CLI 当前只承载视频生成能力。")
    if body.provider_type=="jimeng_cli" and (_jimeng_executable_config_error(body.model_settings) or ""):
        raise HTTPException(422,_jimeng_executable_config_error(body.model_settings))
    validate_profile_model_config({"provider_type":body.provider_type,"last_health":None},body.model_settings)
    try:
        with database.connect() as c:c.execute("INSERT INTO provider_profiles(id,provider_type,display_name,base_url,credential_ref,model_config_json,capabilities_json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",(pid,body.provider_type,body.display_name,body.base_url,f"provider:{pid}",database.encode(body.model_settings),database.encode(body.capabilities),int(body.enabled),now,now))
    except sqlite3.IntegrityError as exc:raise HTTPException(409,"供应商配置 ID 已存在。") from exc
    return public_profile(get_profile(database,pid))
@app.patch("/api/provider-profiles/{pid}")
async def update_profile(pid:str,body:ProviderProfileUpdate,request:Request):
    database=db(request); current=get_profile(database,pid); values=body.model_dump(exclude_unset=True,by_alias=True)
    if current["provider_type"]=="openai_compatible" and "capabilities" in values and any(x!="orchestrator" for x in values["capabilities"]):raise HTTPException(422,"OpenAI-compatible 配置在当前版本只支持文本编排能力。")
    if current["provider_type"]=="opencode" and "capabilities" in values and any(x!="orchestrator" for x in values["capabilities"]):raise HTTPException(422,"OpenCode 接入点仅承载文本编排 Agent。")
    if current["provider_type"]=="jimeng_cli" and "capabilities" in values and any(x!="video" for x in values["capabilities"]):raise HTTPException(422,"即梦 CLI 当前只承载视频生成能力。")
    if current["provider_type"]=="jimeng_cli" and "model_config" in values and _jimeng_executable_config_error(values["model_config"]):raise HTTPException(422,_jimeng_executable_config_error(values["model_config"]))
    if "model_config" in values:validate_profile_model_config(current,values["model_config"])
    if "base_url" in values:ProviderProfileCreate(provider_type=current["provider_type"],display_name=current["display_name"],base_url=values["base_url"])
    cols={"display_name":"display_name","base_url":"base_url","model_config":"model_config_json","capabilities":"capabilities_json","enabled":"enabled"}; sets=[]; params=[]
    for k,v in values.items():sets.append(f"{cols[k]}=?"); params.append(database.encode(v) if k in {"model_config","capabilities"} else int(v) if k=="enabled" else v)
    if sets:
        with database.connect() as c:
            c.execute(f"UPDATE provider_profiles SET {','.join(sets)},updated_at=? WHERE id=?",(*params,utcnow(),pid))
            selected=(values.get("model_config") or {}).get("orchestrator_model")
            if selected:c.execute("UPDATE capability_bindings SET model=?,updated_at=? WHERE capability='orchestrator' AND provider_profile_id=?",(selected,utcnow(),pid))
            # Saving an OpenCode main model is also the user's explicit choice
            # for the orchestrator route. Keep the separate routing surface in
            # sync so the next run uses the model just selected in Settings.
            if current["provider_type"] == "opencode" and selected and values.get("enabled", current["enabled"]):
                c.execute("INSERT INTO capability_bindings(capability,provider_profile_id,model,updated_at) VALUES('orchestrator',?,?,?) ON CONFLICT(capability) DO UPDATE SET provider_profile_id=excluded.provider_profile_id,model=excluded.model,updated_at=excluded.updated_at",(pid,selected,utcnow()))
    return public_profile(get_profile(database,pid))
@app.delete("/api/provider-profiles/{pid}")
async def remove_profile(pid:str,request:Request):
    if pid in {"openai-default","jimeng-default","opencode-default"}:raise HTTPException(409,"默认配置不能删除。")
    database=db(request); profile=get_profile(database,pid)
    with database.connect() as c:
        if c.execute("SELECT 1 FROM capability_bindings WHERE provider_profile_id=?",(pid,)).fetchone():raise HTTPException(409,"该配置仍是默认能力绑定。")
        c.execute("DELETE FROM provider_profiles WHERE id=?",(pid,))
    try:delete_secret(profile["credential_ref"])
    except SecretStoreError:pass
    return {"ok":True}
@app.post("/api/provider-profiles/{pid}/credential")
async def write_credential(pid:str,body:CredentialWrite,request:Request):
    profile=get_profile(db(request),pid)
    try:set_secret(profile["credential_ref"],body.api_key)
    except Exception as exc:raise HTTPException(503,f"无法写入系统凭据库：{exc}") from exc
    return {"ok":True,"credential_configured":True,"credential_mask":mask_secret(body.api_key)}
@app.post("/api/provider-profiles/{pid}/credential/import")
async def import_credential(pid:str,body:CredentialImport,request:Request):
    value=os.environ.get(body.environment_variable,"")
    if not value:raise HTTPException(404,f"环境变量 {body.environment_variable} 未设置。")
    return await write_credential(pid,CredentialWrite(api_key=value),request)
@app.delete("/api/provider-profiles/{pid}/credential")
async def clear_credential(pid:str,request:Request):delete_secret(get_profile(db(request),pid)["credential_ref"]); return {"ok":True}
@app.post("/api/provider-profiles/{pid}/probe")
async def probe(pid:str,request:Request):
    database=db(request); profile=get_profile(database,pid); adapter=adapter_for_profile(profile); result=await adapter.probe(get_profile_secret(profile))
    with database.connect() as c:c.execute("UPDATE provider_profiles SET last_health_json=?,capabilities_json=?,updated_at=? WHERE id=?",(database.encode(result),database.encode(result["capabilities"]),utcnow(),pid))
    return result
@app.get("/api/provider-profiles/{pid}/models")
async def models(pid:str,request:Request):
    result=await probe(pid,request); return {"models":result["models"],"model_readiness":result["model_readiness"]}
@app.get("/api/settings/capability-bindings")
async def get_bindings(request:Request):
    with db(request).connect() as c:rows=c.execute("SELECT * FROM capability_bindings ORDER BY capability").fetchall()
    return {"bindings":[dict(r) for r in rows]}
@app.put("/api/settings/capability-bindings")
async def put_binding(body:CapabilityBinding,request:Request):
    database=db(request); profile=get_profile(database,body.provider_profile_id)
    if body.capability not in profile["capabilities"]:raise HTTPException(409,"该供应商未通过所选能力探测。")
    if body.capability=="orchestrator":validate_orchestrator_model(profile,body.model)
    with database.connect() as c:c.execute("INSERT INTO capability_bindings(capability,provider_profile_id,model,updated_at) VALUES(?,?,?,?) ON CONFLICT(capability) DO UPDATE SET provider_profile_id=excluded.provider_profile_id,model=excluded.model,updated_at=excluded.updated_at",(body.capability,body.provider_profile_id,body.model,utcnow()))
    return {"ok":True}

@app.get("/api/v2/workflows")
async def workflows():return {"workflows":[workflow_manifest(s) for s in WORKFLOWS]}
@app.post("/api/workflow-runs")
async def workflow_run(body:WorkflowRunCreate,request:Request):
    database=db(request)
    try:manifest=workflow_manifest(body.skill_id)
    except KeyError as exc:raise HTTPException(404,"工作流不存在。") from exc
    pdata=await read_project(body.project_id,request); gates=evaluate_project_gates(pdata["document"],body.skill_id); rid=f"RUN_{secrets.token_hex(8)}"; status="validated" if gates["allowed"] else "blocked"
    with database.connect() as c:c.execute("INSERT INTO workflow_runs(id,project_id,skill_id,skill_version,status,input_json,gate_result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",(rid,body.project_id,body.skill_id,manifest["skill_version"],status,database.encode(body.input),database.encode(gates),utcnow(),utcnow()))
    return {"id":rid,"status":status,"manifest":manifest,"gates":gates}


# ---------------------------------------------------------------------------
# V3 graph, supervised runtime, provider catalog, lineage and timeline APIs.
# ---------------------------------------------------------------------------

@app.get("/api/v2/projects")
async def list_projects_v3(request:Request, include_archived: bool = False):
    database = db(request)
    with database.connect() as connection:
        query = "SELECT * FROM projects"
        if not include_archived:
            query += " WHERE lifecycle_status='active'"
        rows = connection.execute(query + " ORDER BY updated_at DESC").fetchall()
    items = []
    for row in rows:
        document = database.decode(row["document_json"], {})
        document.setdefault("productionStatus", "in_progress")
        document["lifecycleStatus"] = row["lifecycle_status"]
        items.append({"document": document, "revision": row["revision"], "updated_at": row["updated_at"], "lifecycle_status": row["lifecycle_status"]})
    items.sort(key=lambda item: item["document"].get("sortOrder", 10**9) if isinstance(item["document"].get("sortOrder", 10**9), (int, float)) else 10**9)
    return {"projects": items}


def _project_storage_integrity(database: Database, project_id: str | None = None) -> dict[str, Any]:
    """Read-only check for project rows, storage folders and artifact ownership.

    Orphan folders are reported for recovery/import; this endpoint never binds
    them automatically and never promotes their files to production assets.
    """
    return scan_data_integrity(database,DATA_DIR,project_id)


@app.get("/api/v2/projects/integrity")
async def project_storage_integrity(request: Request):
    return _project_storage_integrity(db(request))


@app.get("/api/v2/projects/{project_id}/integrity")
async def project_storage_integrity_detail(project_id: str, request: Request):
    database = db(request)
    with database.connect() as connection:
        if not connection.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
            raise HTTPException(404, "项目不存在；孤立目录必须先走项目导入流程。")
    return _project_storage_integrity(database, project_id)


def _insert_project_with_directory(database:Database,project_id:str,name:str,document:dict[str,Any],revision:int,created_at:str,updated_at:str,lifecycle_status:str="active",audit_event:dict[str,Any]|None=None)->None:
    projects_root=(DATA_DIR/"projects").resolve();projects_root.mkdir(parents=True,exist_ok=True)
    project_root=(projects_root/project_id).resolve()
    if project_root.parent!=projects_root:raise HTTPException(422,"项目 ID 不能形成嵌套路径。")
    created_directory=False
    try:
        with database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute("SELECT 1 FROM projects WHERE id=?",(project_id,)).fetchone():
                raise sqlite3.IntegrityError("project already exists")
            if project_root.exists():
                raise FileExistsError(str(project_root))
            connection.execute("INSERT INTO projects(id,name,document_json,revision,created_at,updated_at,lifecycle_status) VALUES(?,?,?,?,?,?,?)",(project_id,name,database.encode(document),revision,created_at,updated_at,lifecycle_status))
            project_root.mkdir()
            created_directory=True
            if audit_event:
                audit_trail.write_event_connection(connection,database,project_id=project_id,**audit_event)
    except Exception:
        if created_directory and project_root.is_dir() and not any(project_root.iterdir()):
            project_root.rmdir()
        raise


@app.post("/api/v2/projects", status_code=201)
async def create_project_v3(body:ProjectCreateV3,request:Request):
    database = db(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "项目名称不能为空。")
    now = utcnow()
    project_id = f"PRJ_{secrets.token_hex(6).upper()}"
    with database.connect() as connection:
        rows = connection.execute("SELECT document_json FROM projects").fetchall()
        sort_orders = []
        for row in rows:
            document = database.decode(row["document_json"], {})
            value = document.get("sortOrder") if isinstance(document, dict) else None
            if isinstance(value, (int, float)):
                sort_orders.append(int(value))
        document = {
            "id": project_id,
            "name": name,
            "ratio": body.ratio,
            "duration": body.duration,
            "generator": body.generator,
            "brief": body.brief.strip(),
            "stage": 0,
            "sortOrder": max(sort_orders, default=-1) + 1,
            "productionStatus": "in_progress",
            "lifecycleStatus": "active",
            "createdAt": now,
            "script": "",
            "assets": [],
            "shots": [],
            "audio": {},
            "assetRegulator": {},
            "generations": [],
            "imagePrompt": None,
            "seedancePackages": [],
            "providerOverrides": {},
            "undoStack": [],
            "scriptVersions": [],
            "storyboardVersions": [],
            "storyWorkflowRuns": [],
        }
    try:
        _insert_project_with_directory(
            database,project_id,name,document,1,now,now,
            audit_event={
                "action":"project_created", "target_type":"project", "target_id":project_id,
                "reason":"project_created", "before":{},
                "after":{"id":project_id,"name":name,"ratio":body.ratio,"duration":body.duration,"brief":body.brief.strip()},
            },
        )
    except (sqlite3.IntegrityError,FileExistsError) as exc:raise HTTPException(409,"项目 ID 或项目目录已存在，未写入任何数据。") from exc
    return {"ok": True, "document": document, "revision": 1, "updated_at": now, "lifecycle_status": "active"}


def _dashboard_latest_run(database:Database, project_id:str)->dict[str,Any]|None:
    with database.connect() as c:
        row=c.execute("SELECT * FROM workflow_runs_v3 WHERE project_id=? ORDER BY created_at DESC LIMIT 1",(project_id,)).fetchone()
    return _run_v3_payload(database,row) if row else None


def _dashboard_latest_story_run(database:Database, project_id:str)->dict[str,Any]|None:
    with database.connect() as c:
        row=c.execute("SELECT * FROM story_workflow_chains WHERE project_id=? ORDER BY created_at DESC LIMIT 1",(project_id,)).fetchone()
    return story_chain_payload(database,row) if row else None


def _dashboard_latest_render(database:Database, project_id:str)->dict[str,Any]|None:
    with database.connect() as c:
        row=c.execute("SELECT * FROM render_jobs_v6 WHERE project_id=? ORDER BY created_at DESC LIMIT 1",(project_id,)).fetchone()
    if not row:return None
    return {
        "id":row["id"], "project_id":row["project_id"], "timeline_revision":row["timeline_revision"],
        "status":row["status"], "result":database.decode(row["result_json"],None),
        "error":database.decode(row["error_json"],None), "created_at":row["created_at"], "updated_at":row["updated_at"],
    }


def _dashboard_graph(database:Database, project_id:str)->dict[str,Any]|None:
    with database.connect() as c:
        row=c.execute("SELECT revision,graph_json,updated_at FROM workflow_graphs WHERE project_id=?",(project_id,)).fetchone()
    if not row:return None
    return {"project_id":project_id,"revision":row["revision"],"graph":database.decode(row["graph_json"],{}),"updated_at":row["updated_at"]}


def _dashboard_timeline(database:Database, project_id:str)->dict[str,Any]|None:
    # Dashboard is a projection endpoint. Do not call ensure_timeline here:
    # that helper creates the default timeline on read and would make a GET
    # mutate project state. A missing timeline is represented as None.
    with database.connect() as c:
        row=c.execute("SELECT * FROM timelines_v3 WHERE project_id=?",(project_id,)).fetchone()
    if not row:return None
    return {"project_id":project_id,"revision":row["revision"],"document":database.decode(row["document_json"],{}),"updated_at":row["updated_at"]}


def _dashboard_activity(database:Database, project_id:str)->list[dict[str,Any]]:
    activity=[]
    with database.connect() as c:
        story=c.execute("SELECT id,status,updated_at FROM story_workflow_chains WHERE project_id=? ORDER BY updated_at DESC LIMIT 3",(project_id,)).fetchall()
        runs=c.execute("SELECT id,status,updated_at FROM workflow_runs_v3 WHERE project_id=? ORDER BY updated_at DESC LIMIT 3",(project_id,)).fetchall()
        renders=c.execute("SELECT id,status,updated_at FROM render_jobs_v6 WHERE project_id=? ORDER BY updated_at DESC LIMIT 3",(project_id,)).fetchall()
    for row in story:
        activity.append({"id":row["id"],"type":"story_run","label":f"故事工作流 · {row['status']}","status":"awaiting_review" if row["status"] in {"storyboard_review_required","regulator_review_required"} else "failed" if row["status"]=="failed" else "completed" if row["status"]=="succeeded" else "in_progress","created_at":row["updated_at"]})
    for row in runs:
        activity.append({"id":row["id"],"type":"workflow_run","label":f"视频工作流 · {row['status']}","status":"awaiting_confirmation" if row["status"]=="awaiting_confirmation" else "failed" if row["status"]=="failed" else "completed" if row["status"] in {"succeeded","completed"} else "in_progress","created_at":row["updated_at"]})
    for row in renders:
        activity.append({"id":row["id"],"type":"render","label":f"交付渲染 · {row['status']}","status":"awaiting_confirmation" if row["status"]=="awaiting_confirmation" else "failed" if row["status"]=="failed" else "completed" if row["status"] in {"succeeded","completed"} else "in_progress","created_at":row["updated_at"]})
    return sorted(activity,key=lambda item:item["created_at"],reverse=True)[:8]


def _dashboard_snapshot(database:Database, row:Any, detail:bool=False)->dict[str,Any]:
    document=database.decode(row["document_json"],{})
    project={**document,"lifecycleStatus":row["lifecycle_status"],"revision":row["revision"],"updated_at":row["updated_at"]}
    graph=_dashboard_graph(database,row["id"])
    latest_story=_dashboard_latest_story_run(database,row["id"])
    latest_run=_dashboard_latest_run(database,row["id"])
    timeline=_dashboard_timeline(database,row["id"]) if detail else None
    latest_render=_dashboard_latest_render(database,row["id"])
    library=_library_payload(database,row["id"],document) if detail else None
    snapshot=build_dashboard_snapshot(project,graph,library,latest_story,latest_run,timeline,latest_render,_dashboard_activity(database,row["id"]))
    return snapshot


@app.get("/api/v2/dashboard")
async def dashboard_v3(request:Request,project_id:str|None=None,include_archived: bool = False):
    database=db(request)
    with database.connect() as c:
        query = "SELECT * FROM projects"
        if not include_archived:
            query += " WHERE lifecycle_status='active'"
        rows=c.execute(query + " ORDER BY updated_at DESC").fetchall()
    if project_id and not any(row["id"]==project_id for row in rows):
        raise HTTPException(404,"项目不存在。")
    selected=None
    summaries=[]
    for row in rows:
        snapshot=_dashboard_snapshot(database,row,detail=bool(project_id and row["id"]==project_id))
        summaries.append(project_home_summary(snapshot))
        if project_id and row["id"]==project_id:selected=snapshot
    return {"generated_at":utcnow(),"projects":summaries,"selected_project":selected}


@app.get("/api/v2/projects/{project_id}")
async def read_project_v3(project_id:str,request:Request):
    database = db(request)
    with database.connect() as connection:
        row = connection.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    if not row:
        raise HTTPException(404, "项目不存在。")
    document = database.decode(row["document_json"], {})
    document["lifecycleStatus"] = row["lifecycle_status"]
    return {"document": document, "revision": row["revision"], "updated_at": row["updated_at"], "lifecycle_status": row["lifecycle_status"]}


@app.get("/api/v2/projects/{project_id}/audit-events")
async def project_audit_events_v3(project_id:str,request:Request,limit:int=100):
    if limit < 1 or limit > audit_trail.MAX_QUERY_LIMIT:
        raise HTTPException(422,f"limit 必须在 1 到 {audit_trail.MAX_QUERY_LIMIT} 之间。")
    database=db(request)
    with database.connect() as connection:
        project_exists=bool(connection.execute("SELECT 1 FROM projects WHERE id=?",(project_id,)).fetchone())
    return {"project_id":project_id,"project_exists":project_exists,"durable":True,"events":audit_trail.list_events(database,project_id,limit)}


@app.put("/api/v2/projects/{project_id}")
async def save_project_v3(project_id:str,body:ProjectImport,request:Request):
    return await save_project(project_id, body, request)


@app.patch("/api/v2/projects/{project_id}")
async def update_project_metadata_v3(project_id:str,body:ProjectMetadataUpdate,request:Request):
    database = db(request)
    with database.connect() as connection:
        current = connection.execute("SELECT revision, document_json FROM projects WHERE id=?", (project_id,)).fetchone()
        if not current:
            raise HTTPException(404, "项目不存在。")
        if current["revision"] != body.expected_revision:
            raise HTTPException(409, {"message": "项目已有更新，请刷新后重试。", "current_revision": current["revision"]})
        before = database.decode(current["document_json"], {})
        document = database.decode(current["document_json"], {})
        updates = body.model_dump(exclude={"expected_revision", "lifecycleStatus"}, exclude_none=True)
        document.update(updates)
        now = utcnow()
        revision = current["revision"] + 1
        current_lifecycle = connection.execute("SELECT lifecycle_status FROM projects WHERE id=?", (project_id,)).fetchone()[0]
        lifecycle_status = body.lifecycleStatus or current_lifecycle
        connection.execute("UPDATE projects SET name=?, document_json=?, revision=?, lifecycle_status=?, updated_at=? WHERE id=?", (document.get("name", "未命名项目"), database.encode(document), revision, lifecycle_status, now, project_id))
        audit_trail.write_event_connection(
            connection, database, project_id=project_id, action="project_updated", target_type="project",
            target_id=project_id, reason="project_metadata_updated",
            before={"name":before.get("name"),"brief":before.get("brief"),"ratio":before.get("ratio"),"duration":before.get("duration"),"lifecycleStatus":current_lifecycle},
            after={"name":document.get("name"),"brief":document.get("brief"),"ratio":document.get("ratio"),"duration":document.get("duration"),"lifecycleStatus":lifecycle_status},
            created_at=now,
        )
    document["lifecycleStatus"] = lifecycle_status
    return {"ok": True, "document": document, "revision": revision, "updated_at": now, "lifecycle_status": lifecycle_status}

@app.get("/api/v2/projects/{project_id}/graph")
async def read_graph_v3(project_id:str,request:Request):
    return ensure_graph(db(request),project_id)


@app.put("/api/v2/projects/{project_id}/graph")
async def write_graph_v3(project_id:str,body:WorkflowGraphUpdateV3,request:Request):
    ensure_graph(db(request),project_id)
    return save_graph(db(request),project_id,body.graph,body.expected_revision)


@app.get("/api/v2/workflow-templates")
async def workflow_templates_v3(request:Request):
    database=db(request)
    builtin={
        "id":"builtin:professional-video","name":"专业 AI 视频全流程","description":"故事、资产、融合、镜头、声音、生成与交付的监督式工作流。",
        "category":"film","version":1,"builtin":True,"graph":default_graph({"id":"template","name":"专业 AI 视频全流程"}),
    }
    with database.connect() as c:
        rows=c.execute("SELECT * FROM workflow_templates_v3 ORDER BY builtin DESC,name").fetchall()
    custom=[{"id":r["id"],"name":r["name"],"description":r["description"],"category":r["category"],"version":r["version"],"builtin":bool(r["builtin"]),"graph":database.decode(r["graph_json"],{})} for r in rows]
    return {"templates":[builtin,*custom]}


@app.post("/api/v2/workflow-templates")
async def create_workflow_template_v3(body:WorkflowTemplateCreateV3,request:Request):
    validate_graph(body.graph)
    database=db(request); template_id=body.id or f"TPL_{secrets.token_hex(8)}"; now=utcnow()
    graph=body.graph.model_dump(mode="json")
    graph["template_id"]=template_id
    with database.connect() as c:
        try:
            c.execute("INSERT INTO workflow_templates_v3(id,name,description,category,version,graph_json,builtin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",(template_id,body.name,body.description,body.category,1,database.encode(graph),0,now,now))
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409,"工作流模板 ID 已存在。") from exc
    return {"id":template_id,"name":body.name,"description":body.description,"category":body.category,"version":1,"builtin":False,"graph":graph,"created_at":now,"updated_at":now}


@app.post("/api/v2/projects/{project_id}/apply-template")
async def apply_workflow_template_v3(project_id:str,body:WorkflowTemplateApplyV3,request:Request):
    database=db(request); current=ensure_graph(database,project_id)
    if body.expected_revision!=current["revision"]:
        raise HTTPException(409,{"message":"工作流图版本已变化，请刷新后重试。","current_revision":current["revision"]})
    if body.template_id=="builtin:professional-video":
        with database.connect() as c:
            row=c.execute("SELECT document_json FROM projects WHERE id=?",(project_id,)).fetchone()
        if not row: raise HTTPException(404,"项目不存在。")
        graph=default_graph(database.decode(row["document_json"],{}))
    else:
        with database.connect() as c: row=c.execute("SELECT graph_json FROM workflow_templates_v3 WHERE id=? AND builtin=0",(body.template_id,)).fetchone()
        if not row: raise HTTPException(404,"工作流模板不存在。")
        graph=database.decode(row["graph_json"],{})
        graph["template_id"]=body.template_id
    validated=WorkflowGraphUpdateV3.model_validate({"graph":graph,"expected_revision":body.expected_revision}).graph
    return save_graph(database,project_id,validated,body.expected_revision)


@app.post("/api/v2/runs/estimate")
async def estimate_run_v3(body:WorkflowRunEstimateV3,request:Request):
    graph=ensure_graph(db(request),body.project_id)
    known={n.get("id") for n in graph["graph"].get("nodes",[])}; missing=[node_id for node_id in body.node_ids if node_id not in known]
    if missing: raise HTTPException(422,{"message":"估价包含不存在的节点。","missing":missing})
    selected=select_graph_node_ids(graph["graph"],body.node_ids)
    return {"project_id":body.project_id,"graph_revision":graph["revision"],"selected_node_ids":selected,"estimate":estimate_graph(graph["graph"],selected)}


def _run_v3_payload(database:Database,row:sqlite3.Row)->dict[str,Any]:
    with database.connect() as connection:
        pending_gate=connection.execute("SELECT id FROM approval_gates_v3 WHERE run_id=? AND status='pending' ORDER BY created_at LIMIT 1",(row["id"],)).fetchone()
    return {
        "id":row["id"],"project_id":row["project_id"],"graph_revision":row["graph_revision"],"status":row["status"],
        "request":database.decode(row["request_json"],{}),"estimate":database.decode(row["estimate_json"],{}),
        "result":database.decode(row["result_json"],None),"error":database.decode(row["error_json"],None),
        "idempotency_fingerprint":row["idempotency_fingerprint"],"approval_token":pending_gate["id"] if pending_gate else None,
        "created_at":row["created_at"],"updated_at":row["updated_at"],
    }


def _get_run_v3(database:Database,run_id:str)->sqlite3.Row:
    with database.connect() as c:row=c.execute("SELECT * FROM workflow_runs_v3 WHERE id=?",(run_id,)).fetchone()
    if not row:raise HTTPException(404,"V3 工作流运行不存在。")
    return row


def _run_event_v3(database:Database,run_id:str,event_type:str,detail:dict[str,Any]|None=None,node_id:str|None=None)->None:
    with database.connect() as c:c.execute("INSERT INTO workflow_run_events_v3(run_id,node_id,event_type,detail_json,created_at) VALUES(?,?,?,?,?)",(run_id,node_id,event_type,database.encode(detail or {}),utcnow()))


@app.post("/api/v2/runs")
async def create_run_v3(body:WorkflowRunCreateV3,request:Request):
    database=db(request); graph=ensure_graph(database,body.project_id)
    if body.graph_revision is not None and body.graph_revision!=graph["revision"]:
        raise HTTPException(409,{"message":"工作流图版本已变化。","current_revision":graph["revision"]})
    known={n.get("id") for n in graph["graph"].get("nodes",[])}
    missing=[node_id for node_id in body.node_ids if node_id not in known]
    if missing:raise HTTPException(422,{"message":"运行包含不存在的节点。","missing":missing})
    selected_node_ids=select_graph_node_ids(graph["graph"],body.node_ids)
    estimate=estimate_graph(graph["graph"],selected_node_ids); needs_approval=estimate["requires_confirmation"] and not body.confirmed
    status="awaiting_confirmation" if needs_approval else "queued"; run_id=f"V3RUN_{secrets.token_hex(8)}"; now=utcnow()
    selected=set(selected_node_ids); nodes=[n for n in graph["graph"].get("nodes",[]) if n.get("id") in selected]
    run_request=body.model_dump(mode="json")
    run_request["selected_node_ids"]=selected_node_ids
    run_request["approval_required"]=needs_approval
    fingerprint=workflow_run_fingerprint(body.project_id,graph["revision"],selected_node_ids,graph["graph"],body.max_parallel)
    created=False
    with database.connect() as c:
        c.execute("BEGIN IMMEDIATE")
        existing=c.execute("SELECT id FROM workflow_runs_v3 WHERE idempotency_fingerprint=? AND status IN ('awaiting_confirmation','queued','running','paused') ORDER BY created_at LIMIT 1",(fingerprint,)).fetchone()
        if existing:
            run_id=str(existing["id"])
        else:
            created=True
            c.execute("INSERT INTO workflow_runs_v3(id,project_id,graph_revision,status,request_json,graph_snapshot_json,estimate_json,idempotency_fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",(run_id,body.project_id,graph["revision"],status,database.encode(run_request),database.encode(graph["graph"]),database.encode(estimate),fingerprint,now,now))
            for node in nodes:
                c.execute("INSERT INTO node_runs_v3(id,run_id,node_id,status,input_snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",(f"NR_{secrets.token_hex(8)}",run_id,node["id"],"pending",database.encode(node),now,now))
            if needs_approval:
                c.execute("INSERT INTO approval_gates_v3(id,run_id,reason,status,estimate_json,created_at) VALUES(?,?,'paid_generation','pending',?,?)",(f"GATE_{secrets.token_hex(8)}",run_id,database.encode(estimate),now))
            c.execute("INSERT INTO workflow_run_events_v3(run_id,event_type,detail_json,created_at) VALUES(?,?,?,?)",(run_id,"created",database.encode({"status":status,"node_count":len(nodes),"idempotency_fingerprint":fingerprint}),now))
    if created and status=="queued":schedule_v3_run(request.app,run_id)
    payload=_run_v3_payload(database,_get_run_v3(database,run_id));payload["idempotent_replay"]=not created
    return payload


@app.get("/api/v2/runs/{run_id}")
async def read_run_v3(run_id:str,request:Request):
    database=db(request); row=_get_run_v3(database,run_id)
    with database.connect() as c:
        nodes=c.execute("SELECT node_id,status,attempt,output_json,error_json,started_at,finished_at FROM node_runs_v3 WHERE run_id=? ORDER BY created_at",(run_id,)).fetchall()
        gates=c.execute("SELECT id,node_id,reason,status,estimate_json,decision_detail_json,decided_at,created_at FROM approval_gates_v3 WHERE run_id=? ORDER BY created_at",(run_id,)).fetchall()
    payload=_run_v3_payload(database,row)
    payload["nodes"]=[{"node_id":n["node_id"],"status":n["status"],"attempt":n["attempt"],"output":database.decode(n["output_json"],None),"error":database.decode(n["error_json"],None),"started_at":n["started_at"],"finished_at":n["finished_at"]} for n in nodes]
    payload["approval_gates"]=[{"id":g["id"],"node_id":g["node_id"],"reason":g["reason"],"status":g["status"],"estimate":database.decode(g["estimate_json"],{}),"decision_detail":database.decode(g["decision_detail_json"],{}),"decided_at":g["decided_at"],"created_at":g["created_at"]} for g in gates]
    return payload


@app.post("/api/v2/runs/{run_id}/approve")
async def approve_run_v3(run_id:str,body:RunDecisionV3,request:Request):
    database=db(request); now=utcnow(); approved=False
    with database.connect() as c:
        c.execute("BEGIN IMMEDIATE")
        row=c.execute("SELECT * FROM workflow_runs_v3 WHERE id=?",(run_id,)).fetchone()
        if not row:raise HTTPException(404,"V3 工作流运行不存在。")
        if row["status"]!="awaiting_confirmation":raise HTTPException(409,"当前运行不在等待确认状态。")
        gate=c.execute("SELECT id FROM approval_gates_v3 WHERE run_id=? AND status='pending' ORDER BY created_at LIMIT 1",(run_id,)).fetchone()
        if not gate:raise HTTPException(409,"审批令牌不存在或已被消费。")
        run_request=database.decode(row["request_json"],{});run_request["confirmed"]=True
        gate_update=c.execute("UPDATE approval_gates_v3 SET status='approved',decision_detail_json=?,decided_at=?,approval_consumed_at=? WHERE id=? AND status='pending'",(database.encode(body.detail),now,now,gate["id"]))
        run_update=c.execute("UPDATE workflow_runs_v3 SET status='queued',request_json=?,error_json=NULL,updated_at=? WHERE id=? AND status='awaiting_confirmation'",(database.encode(run_request),now,run_id))
        approved=gate_update.rowcount==1 and run_update.rowcount==1
    if not approved:raise HTTPException(409,"审批令牌不存在或已被消费。")
    _run_event_v3(database,run_id,"approved",body.detail)
    schedule_v3_run(request.app,run_id)
    return _run_v3_payload(database,_get_run_v3(database,run_id))


async def _change_run_status_v3(run_id:str,target:str,allowed:set[str],request:Request):
    database=db(request); row=_get_run_v3(database,run_id)
    if row["status"] not in allowed:raise HTTPException(409,f"运行不能从 {row['status']} 转为 {target}。")
    with database.connect() as c:c.execute("UPDATE workflow_runs_v3 SET status=?,updated_at=? WHERE id=?",(target,utcnow(),run_id))
    _run_event_v3(database,run_id,target,{"from":row["status"]})
    return _run_v3_payload(database,_get_run_v3(database,run_id))


@app.post("/api/v2/runs/{run_id}/pause")
async def pause_run_v3(run_id:str,request:Request):return await _change_run_status_v3(run_id,"paused",{"queued","running"},request)
@app.post("/api/v2/runs/{run_id}/resume")
async def resume_run_v3(run_id:str,request:Request):
    database=db(request); row=_get_run_v3(database,run_id)
    if row["status"] not in {"paused","failed"}:raise HTTPException(409,f"运行不能从 {row['status']} 转为 queued。")
    now=utcnow()
    with database.connect() as c:
        c.execute("UPDATE node_runs_v3 SET status='pending',error_json=NULL,started_at=NULL,finished_at=NULL,updated_at=? WHERE run_id=? AND status IN ('failed','blocked','canceled','running')",(now,run_id))
        c.execute("UPDATE workflow_runs_v3 SET status='queued',error_json=NULL,updated_at=? WHERE id=?",(now,run_id))
    _run_event_v3(database,run_id,"resumed",{"from":row["status"]})
    schedule_v3_run(request.app,run_id)
    return _run_v3_payload(database,_get_run_v3(database,run_id))
@app.post("/api/v2/runs/{run_id}/cancel")
async def cancel_run_v3(run_id:str,request:Request):return await _change_run_status_v3(run_id,"canceled",{"awaiting_confirmation","queued","running","paused","failed"},request)


@app.get("/api/v2/runs/{run_id}/events")
async def run_events_v3(run_id:str,request:Request):
    database=db(request); _get_run_v3(database,run_id)
    async def stream():
        with database.connect() as c:rows=c.execute("SELECT id,node_id,event_type,detail_json,created_at FROM workflow_run_events_v3 WHERE run_id=? ORDER BY id",(run_id,)).fetchall()
        for row in rows:
            payload={"id":row["id"],"node_id":row["node_id"],"event":row["event_type"],"detail":database.decode(row["detail_json"],{}),"created_at":row["created_at"]}
            yield f"event: {row['event_type']}\ndata: {json.dumps(payload,ensure_ascii=False)}\n\n"
        yield "event: snapshot_complete\ndata: {}\n\n"
    return StreamingResponse(stream(),media_type="text/event-stream",headers={"Cache-Control":"no-cache"})


def _agent_plan_payload(database:Database,row:sqlite3.Row)->dict[str,Any]:
    with database.connect() as c:
        candidates=c.execute("SELECT id,kind,target_id,version,status,content_json,metadata_json,created_at,accepted_at FROM agent_candidate_versions_v5 WHERE plan_id=? ORDER BY created_at",(row["id"],)).fetchall()
    decision=database.decode(row["decision_json"],{})
    return {
        "id":row["id"],"project_id":row["project_id"],"status":row["status"],"message":row["message"],
        "skill_id":row["skill_id"],"provider_profile_id":row["provider_profile_id"],"provider_model":row["provider_model"],
        "base_project_revision":row["base_project_revision"],"base_graph_revision":row["base_graph_revision"],
        "input_snapshot":database.decode(row["input_snapshot_json"],{}),
        "patch":database.decode(row["patch_json"],{}),"preview":database.decode(row["preview_json"],{}),
        "reply":decision.get("reply",""),"next_skill":decision.get("next_skill"),
        "decision":{key:value for key,value in decision.items() if key not in {"reply","next_skill"}},
        "error":database.decode(row["error_json"],None),
        "candidates":[{"id":item["id"],"kind":item["kind"],"target_id":item["target_id"],"version":item["version"],"status":item["status"],"content":database.decode(item["content_json"],None),"metadata":database.decode(item["metadata_json"],{}),"created_at":item["created_at"],"accepted_at":item["accepted_at"]} for item in candidates],
        "created_at":row["created_at"],"updated_at":row["updated_at"],
    }


def _agent_plan_event(database:Database,plan_id:str,event_type:str,detail:dict[str,Any]|None=None)->None:
    with database.connect() as c:c.execute("INSERT INTO agent_plan_events_v5(plan_id,event_type,detail_json,created_at) VALUES(?,?,?,?)",(plan_id,event_type,database.encode(redact(detail or {})),utcnow()))


def _agent_plan_row(database:Database,plan_id:str)->sqlite3.Row:
    with database.connect() as c:row=c.execute("SELECT * FROM agent_plans_v5 WHERE id=?",(plan_id,)).fetchone()
    if not row:raise HTTPException(404,"Agent 计划不存在。")
    return row


def _agent_skill(skill_id:str|None)->dict[str,Any]|None:
    if not skill_id:return None
    try:return workflow_manifest(skill_id)
    except KeyError as exc:raise HTTPException(422,"指定的 Agent Skill 不存在。") from exc


async def _submit_agent_provider(database:Database,body:AgentPlanCreateV3,snapshot:dict[str,Any],skill:dict[str,Any]|None)->tuple[dict[str,Any],dict[str,Any],str]:
    profile,bound_model=resolve_profile(database,"orchestrator",body.provider_profile_id)
    model=body.model or bound_model or profile["model_config"].get("orchestrator_model")
    if not model:raise HTTPException(409,"尚未配置编排模型。")
    validate_orchestrator_model(profile,model)
    adapter=adapter_for_profile(profile)
    if not adapter.supports("orchestrator"):
        raise HTTPException(409,{"message":"当前 Provider 未声明 orchestrator 能力。","provider_profile_id":profile["id"]})
    input_text=json.dumps(snapshot,ensure_ascii=False)
    issues=adapter.validate_request("orchestrator",{"prompt_chars":len(input_text)+len(body.message)})
    if issues:raise HTTPException(422,{"message":"Agent 输入超过 Provider 限制。","issues":issues})
    instructions=("你是 FRAMEFLOW V3 的监督式 Agent。只返回可审阅的结构化计划和补丁，不直接修改项目，不执行任何媒体调用。"
                  "只能新增或修改工作流节点/连接、创建脚本或 Prompt 候选、建议运行节点和建议审批门。"
                  "不得替换 active 资产，不得发布、同步或交付。所有付费媒体、批量生成、外部同步、发布和最终交付必须列入审批建议。回答使用中文。")
    if skill:instructions+=f" 当前 Skill：{skill['skill_id']} v{skill['skill_version']}；审批策略：{skill['approval_policy']}。"
    request_payload={"model":model,"instructions":instructions,"input_text":body.message+"\n\n完整输入快照："+input_text,"schema":AGENT_RESULT_SCHEMA,"schema_name":"frameflow_agent_plan"}
    provider_result=await adapter.submit("orchestrator",request_payload,get_profile_secret(profile))
    return provider_result,profile,model


def _store_agent_plan(database:Database,project_id:str,status:str,message:str,skill_id:str|None,provider_profile_id:str|None,provider_model:str|None,base_project_revision:int,base_graph_revision:int,input_snapshot:dict[str,Any],normalized:dict[str,Any],preview:dict[str,Any],decision:dict[str,Any]|None=None,plan_id:str|None=None)->str:
    plan_id=plan_id or f"AGENT_{secrets.token_hex(8)}"; now=utcnow(); decision_payload={"reply":normalized.get("reply",""),"next_skill":normalized.get("next_skill"),"provider_response_id":normalized.get("provider_response_id"),**(decision or {})}
    with database.connect() as c:
        c.execute("INSERT INTO agent_plans_v5(id,project_id,status,message,skill_id,provider_profile_id,provider_model,base_project_revision,base_graph_revision,input_snapshot_json,patch_json,preview_json,decision_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(plan_id,project_id,status,message,skill_id,provider_profile_id,provider_model,base_project_revision,base_graph_revision,database.encode(redact(input_snapshot)),database.encode(redact(normalized.get("patch",{}))),database.encode(redact(preview)),database.encode(redact(decision_payload)),now,now))
        c.execute("INSERT INTO agent_plan_events_v5(plan_id,event_type,detail_json,created_at) VALUES(?,?,?,?)",(plan_id,"created",database.encode({"status":status,"requires_confirmation":preview.get("requires_confirmation",False)}),now))
    return plan_id


async def _create_agent_plan(body:AgentPlanCreateV3,request:Request)->dict[str,Any]:
    database=db(request); pdata=await read_project(body.project_id,request); graph=ensure_graph(database,body.project_id)
    if body.project_revision is not None and body.project_revision!=pdata["revision"]:raise HTTPException(409,{"message":"项目版本已变化，请刷新后重新生成 Agent 计划。","current_revision":pdata["revision"]})
    if body.graph_revision is not None and body.graph_revision!=graph["revision"]:raise HTTPException(409,{"message":"工作流图版本已变化，请刷新后重新生成 Agent 计划。","current_revision":graph["revision"]})
    known={str(node.get("id")) for node in graph["graph"].get("nodes",[]) if node.get("id")}; missing=[node_id for node_id in body.selected_node_ids if node_id not in known]
    if missing:raise HTTPException(422,{"message":"Agent 选择包含不存在的画布节点。","missing":missing})
    skill=_agent_skill(body.skill_id)
    skill_catalog=[workflow_manifest(skill_id) for skill_id in WORKFLOWS]
    snapshot=build_input_snapshot(pdata["document"],graph["graph"],body.message,body.selected_node_ids,body.context,body.cost_boundary,pdata["revision"],graph["revision"],skill,skill_catalog)
    provider_result,profile,model=await _submit_agent_provider(database,body,snapshot,skill)
    try:
        normalized=normalize_agent_patch(provider_result,pdata["revision"],graph["revision"])
        patch=AgentPatchV3.model_validate(normalized["patch"])
        preview=patch_preview(graph["graph"],patch)
    except HTTPException:
        raise
    except Exception as exc:
        raise ProviderError(f"Agent 返回的结构化补丁无法通过校验：{exc}","validation",502) from exc
    plan_id=_store_agent_plan(database,body.project_id,"awaiting_review",body.message,body.skill_id,profile["id"],model,pdata["revision"],graph["revision"],snapshot,normalized,preview)
    payload=_agent_plan_payload(database,_agent_plan_row(database,plan_id)); return {"id":plan_id,"status":payload["status"],"plan":payload,"reply":payload["reply"],"patch":payload["patch"],"preview":payload["preview"]}


@app.post("/api/v2/agent/plans")
async def create_agent_plan(body:AgentPlanCreateV3,request:Request):return await _create_agent_plan(body,request)


@app.post("/api/v2/projects/{project_id}/agent/plans")
async def create_project_agent_plan(project_id:str,body:AgentPlanCreateV3,request:Request):
    if body.project_id!=project_id:raise HTTPException(409,"Agent 计划的项目 ID 与路径不一致。")
    return await _create_agent_plan(body,request)


async def _preview_agent_patch(body:AgentPatchPreviewV3,request:Request)->dict[str,Any]:
    database=db(request); pdata=await read_project(body.project_id,request); graph=ensure_graph(database,body.project_id)
    if body.project_revision is not None and body.project_revision!=pdata["revision"]:raise HTTPException(409,{"message":"项目版本已变化。","current_revision":pdata["revision"]})
    if body.graph_revision is not None and body.graph_revision!=graph["revision"]:raise HTTPException(409,{"message":"工作流图版本已变化。","current_revision":graph["revision"]})
    try:
        normalized=normalize_agent_patch({"patch":body.patch},pdata["revision"],graph["revision"]); patch=AgentPatchV3.model_validate(normalized["patch"]); preview=patch_preview(graph["graph"],patch)
    except HTTPException:
        raise
    except Exception as exc:raise HTTPException(422,{"message":"结构化 Agent 补丁无效。","details":str(exc)}) from exc
    return {"project_id":body.project_id,"project_revision":pdata["revision"],"graph_revision":graph["revision"],"patch":patch.model_dump(mode="json"),"preview":redact(preview)}


@app.post("/api/v2/agent/patches/preview")
async def preview_agent_patch(body:AgentPatchPreviewV3,request:Request):return await _preview_agent_patch(body,request)


@app.post("/api/v2/projects/{project_id}/agent/patches/preview")
async def preview_project_agent_patch(project_id:str,body:AgentPatchPreviewV3,request:Request):
    if body.project_id!=project_id:raise HTTPException(409,"Agent 补丁的项目 ID 与路径不一致。")
    return await _preview_agent_patch(body,request)


@app.get("/api/v2/projects/{project_id}/agent/plans")
async def list_agent_plans(project_id:str,request:Request):
    database=db(request)
    with database.connect() as c:rows=c.execute("SELECT * FROM agent_plans_v5 WHERE project_id=? ORDER BY created_at DESC LIMIT 100",(project_id,)).fetchall()
    return {"plans":[_agent_plan_payload(database,row) for row in rows]}


@app.get("/api/v2/agent/plans/{plan_id}")
async def read_agent_plan(plan_id:str,request:Request):return _agent_plan_payload(db(request),_agent_plan_row(db(request),plan_id))


@app.get("/api/v2/agent/plans/{plan_id}/events")
async def agent_plan_events(plan_id:str,request:Request):
    database=db(request); _agent_plan_row(database,plan_id)
    with database.connect() as c:rows=c.execute("SELECT id,event_type,detail_json,created_at FROM agent_plan_events_v5 WHERE plan_id=? ORDER BY id",(plan_id,)).fetchall()
    return {"events":[{"id":row["id"],"event":row["event_type"],"detail":database.decode(row["detail_json"],{}),"created_at":row["created_at"]} for row in rows]}


async def _apply_agent_plan(plan_id:str,body:AgentPlanDecisionV3,request:Request)->dict[str,Any]:
    database=db(request); row=_agent_plan_row(database,plan_id)
    if row["status"]!="awaiting_review":raise HTTPException(409,f"Agent 计划不能从 {row['status']} 应用。")
    pdata=await read_project(row["project_id"],request); graph=ensure_graph(database,row["project_id"])
    expected_project=body.expected_project_revision or row["base_project_revision"]; expected_graph=body.expected_graph_revision or row["base_graph_revision"]
    if pdata["revision"]!=expected_project:raise HTTPException(409,{"message":"项目版本已变化，Agent 补丁已失效。","current_revision":pdata["revision"]})
    if graph["revision"]!=expected_graph:raise HTTPException(409,{"message":"工作流图版本已变化，Agent 补丁已失效。","current_revision":graph["revision"]})
    try:
        patch=AgentPatchV3.model_validate(database.decode(row["patch_json"],{})); proposed=apply_patch_to_graph(graph["graph"],patch)
    except HTTPException:
        raise
    except Exception as exc:raise HTTPException(422,{"message":"Agent 补丁无法应用。","details":str(exc)}) from exc
    now=utcnow(); graph_changed=proposed!=graph["graph"]; next_graph_revision=graph["revision"]+1 if graph_changed else graph["revision"]
    candidate_ids=[]
    with database.connect() as c:
        current_graph=c.execute("SELECT revision FROM workflow_graphs WHERE project_id=?",(row["project_id"],)).fetchone()
        if not current_graph or current_graph["revision"]!=expected_graph:raise HTTPException(409,"工作流图在应用前发生变化，请重新审阅。")
        if graph_changed:
            c.execute("UPDATE workflow_graphs SET revision=?,graph_json=?,updated_at=? WHERE project_id=?",(next_graph_revision,database.encode(proposed),now,row["project_id"]))
            c.execute("INSERT INTO workflow_graph_events(project_id,revision,event_type,detail_json,created_at) VALUES(?,?,?,?,?)",(row["project_id"],next_graph_revision,"agent_patch_applied",database.encode({"plan_id":plan_id,"node_count":len(proposed.get("nodes",[])),"edge_count":len(proposed.get("edges",[]))}),now))
        for candidate in patch.candidates:
            version_row=c.execute("SELECT COALESCE(MAX(version),0) AS version FROM agent_candidate_versions_v5 WHERE project_id=? AND kind=? AND COALESCE(target_id,'')=COALESCE(?, '')",(row["project_id"],candidate.kind,candidate.target_id)).fetchone(); version=int(version_row["version"] or 0)+1
            candidate_id=f"AGC_{secrets.token_hex(8)}"; candidate_ids.append(candidate_id)
            status="awaiting_confirmation" if candidate.replace_active else "candidate"
            c.execute("INSERT INTO agent_candidate_versions_v5(id,plan_id,project_id,kind,target_id,version,status,content_json,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",(candidate_id,plan_id,row["project_id"],candidate.kind,candidate.target_id,version,status,database.encode(redact(candidate.content)),database.encode(redact(candidate.metadata)),now))
        previous_decision=database.decode(row["decision_json"],{})
        decision={**previous_decision,"detail":redact(body.detail),"applied_graph_revision":next_graph_revision,"candidate_ids":candidate_ids,"execution_requires_confirmation":bool(row["preview_json"] and database.decode(row["preview_json"],{}).get("requires_confirmation"))}
        c.execute("UPDATE agent_plans_v5 SET status='applied',decision_json=?,updated_at=? WHERE id=?",(database.encode(decision),now,plan_id))
        c.execute("INSERT INTO agent_plan_events_v5(plan_id,event_type,detail_json,created_at) VALUES(?,?,?,?)",(plan_id,"applied",database.encode(decision),now))
    payload=_agent_plan_payload(database,_agent_plan_row(database,plan_id)); return {"id":plan_id,"status":payload["status"],"plan":payload,"graph_revision":next_graph_revision,"candidate_ids":candidate_ids,"execution_requires_confirmation":payload["decision"].get("execution_requires_confirmation",False)}


@app.post("/api/v2/agent/plans/{plan_id}/apply")
async def apply_agent_plan(plan_id:str,body:AgentPlanDecisionV3,request:Request):return await _apply_agent_plan(plan_id,body,request)


@app.post("/api/v2/agent/plans/{plan_id}/approve")
async def approve_agent_plan(plan_id:str,body:AgentPlanDecisionV3,request:Request):return await _apply_agent_plan(plan_id,body,request)


@app.post("/api/v2/agent/plans/{plan_id}/reject")
async def reject_agent_plan(plan_id:str,body:AgentPlanDecisionV3,request:Request):
    database=db(request); row=_agent_plan_row(database,plan_id)
    if row["status"]!="awaiting_review":raise HTTPException(409,f"Agent 计划不能从 {row['status']} 拒绝。")
    now=utcnow(); decision={**database.decode(row["decision_json"],{}),"detail":redact(body.detail)}
    with database.connect() as c:
        c.execute("UPDATE agent_plans_v5 SET status='rejected',decision_json=?,updated_at=? WHERE id=?",(database.encode(decision),now,plan_id)); c.execute("INSERT INTO agent_plan_events_v5(plan_id,event_type,detail_json,created_at) VALUES(?,?,?,?)",(plan_id,"rejected",database.encode(decision),now))
    payload=_agent_plan_payload(database,_agent_plan_row(database,plan_id)); return {"id":plan_id,"status":payload["status"],"plan":payload}


@app.get("/api/v2/projects/{project_id}/agent/candidates")
async def list_agent_candidates(project_id:str,request:Request):
    database=db(request)
    with database.connect() as c:rows=c.execute("SELECT id,plan_id,kind,target_id,version,status,content_json,metadata_json,created_at,accepted_at FROM agent_candidate_versions_v5 WHERE project_id=? ORDER BY created_at DESC LIMIT 200",(project_id,)).fetchall()
    return {"candidates":[{"id":row["id"],"plan_id":row["plan_id"],"kind":row["kind"],"target_id":row["target_id"],"version":row["version"],"status":row["status"],"content":database.decode(row["content_json"],None),"metadata":database.decode(row["metadata_json"],{}),"created_at":row["created_at"],"accepted_at":row["accepted_at"]} for row in rows]}


@app.get("/api/v2/providers/catalog")
async def provider_catalog_v3(request:Request):
    database=db(request)
    with database.connect() as c:rows=c.execute("SELECT * FROM provider_profiles ORDER BY display_name").fetchall()
    providers=[]
    for row in rows:
        profile=public_profile(row_profile(database,row)); health=profile.get("last_health") or {}; contract=provider_contract(profile)
        providers.append({"id":profile["id"],"type":profile["provider_type"],"name":profile["display_name"],"enabled":profile["enabled"],"credential_configured":profile["credential_configured"],"credential":credential_state(profile),"adapter":contract["adapter"],"contract_version":contract["version"],"capabilities":contract["capabilities"],"models":health.get("models",[]),"healthy":health.get("ok"),"base_url":profile["base_url"],"capability_specs":contract["capability_specs"],"input_limits":contract["input_limits"],"output_types":contract["output_types"],"task_modes":contract["task_modes"],"retry_policy":contract["retry_policy"]})
    return {"providers":providers,"capability_contract":["orchestrator","vision","image","image_edit","video","tts","music","sfx","upscale","lip_sync","upload"]}


@app.get("/api/v2/providers/{provider_id}/contract")
async def provider_contract_v3(provider_id:str,request:Request):
    profile=get_profile(db(request),provider_id)
    contract=provider_contract(profile)
    return {"provider":public_profile(profile),"contract":contract}


@app.post("/api/v2/providers/{provider_id}/probe")
async def probe_provider_v3(provider_id:str,request:Request):
    database=db(request); profile=get_profile(database,provider_id)
    result=await probe_profile(profile,get_profile_secret(profile))
    contract=provider_contract(profile)
    result.update({"adapter":contract["adapter"],"contract_version":contract["version"],"credential":credential_state(profile),"capability_specs":contract["capability_specs"],"input_limits":contract["input_limits"],"output_types":contract["output_types"],"task_modes":contract["task_modes"],"retry_policy":contract["retry_policy"]})
    with database.connect() as c:
        c.execute("UPDATE provider_profiles SET last_health_json=?,capabilities_json=?,updated_at=? WHERE id=?",(database.encode(result),database.encode(result.get("capabilities",contract["capabilities"])),utcnow(),provider_id))
    return {"provider":public_profile(get_profile(database,provider_id)),"probe":result}


@app.post("/api/v2/providers/route-preview")
async def provider_route_preview_v3(body:ProviderRoutePreviewV3,request:Request):
    database=db(request)
    binding_capability={"vision":"orchestrator","image_edit":"image"}.get(body.capability,body.capability)
    profile,bound_model=resolve_profile(database,binding_capability,body.provider_profile_id)
    adapter=adapter_for_profile(profile); contract=adapter.contract()
    if not profile["enabled"]:
        return {"selected":False,"reason":"Provider 已停用。","provider":public_profile(profile),"contract":contract}
    if body.privacy=="local_first" and profile["provider_type"] not in {"comfyui","local"}:
        return {"selected":False,"reason":"当前没有满足 local_first 的本地 Provider。","provider":public_profile(profile),"model":body.model or bound_model,"contract":contract}
    model=body.model or bound_model or (profile["model_config"].get("orchestrator_model") if body.capability in {"orchestrator","vision"} else None)
    request_shape={key:value for key,value in {"width":body.width,"height":body.height,"duration":body.duration}.items() if value is not None}
    issues=adapter.validate_request(body.capability,request_shape)
    health=profile.get("last_health") or {}; detected=set(str(item) for item in health.get("models",[]) or [])
    if model and detected and model not in detected:
        issues.append("指定模型不在最近探测到的模型目录中")
    estimate=adapter.estimate(body.capability,{**request_shape,"quantity":1})
    if issues:
        return {"selected":False,"reason":"；".join(issues),"provider":public_profile(profile),"model":model,"capability":body.capability,"quality":body.quality,"privacy":body.privacy,"constraints":contract["input_limits"].get(body.capability,{}),"contract":contract,"estimate":estimate}
    return {"selected":True,"provider":public_profile(profile),"model":model,"capability":body.capability,"quality":body.quality,"privacy":body.privacy,"constraints":contract["input_limits"].get(body.capability,{}),"estimated_cost":estimate["estimated_cost"],"currency":estimate["currency"],"estimate":estimate,"task_mode":contract["task_modes"].get(body.capability),"output_types":contract["output_types"].get(body.capability,[]),"reasons":["显式 Provider 优先" if body.provider_profile_id else "使用当前能力绑定","已应用隐私、能力与输入限制"]}


def _settings_provider_payload(database: Database, row: sqlite3.Row) -> dict[str, Any]:
    profile = public_profile(row_profile(database, row))
    contract = provider_contract(profile)
    health = profile.get("last_health") or {}
    return {
        **profile,
        "type": profile["provider_type"],
        "name": profile["display_name"],
        "credential": credential_state(profile),
        "contract": contract,
        "models": health.get("models", []),
        "model_catalog": health.get("model_catalog", []),
        "model_readiness": health.get("model_readiness", {}),
        "healthy": health.get("ok"),
        "last_probe": health,
    }


def _settings_providers(database: Database) -> list[dict[str, Any]]:
    with database.connect() as connection:
        rows = connection.execute("SELECT * FROM provider_profiles ORDER BY display_name, id").fetchall()
    return [_settings_provider_payload(database, row) for row in rows]


def _settings_provider(database: Database, provider_id: str) -> dict[str, Any]:
    with database.connect() as connection:
        row = connection.execute("SELECT * FROM provider_profiles WHERE id=?", (provider_id,)).fetchone()
    if not row:
        raise HTTPException(404, "V3 Provider 配置不存在。")
    return _settings_provider_payload(database, row)


def _settings_system_status(database: Database) -> dict[str, Any]:
    try:
        import keyring
        backend = keyring.get_keyring()
        keyring_available = not backend.__class__.__module__.startswith("keyring.backends.fail")
        keyring_backend = f"{backend.__class__.__module__}.{backend.__class__.__name__}"
    except Exception:
        keyring_available = False
        keyring_backend = None
    providers = _settings_providers(database)
    openai = next((item for item in providers if item["provider_type"] == "openai"), None)
    return {
        "runtime": "v3-only",
        "version": app.version,
        "schema_version": SCHEMA_VERSION,
        "database": {"path": str(database.path), "status": "ready"},
        "keyring": {"available": keyring_available, "backend": keyring_backend},
        "media": {"ffmpeg": find_binary("ffmpeg"), "ffprobe": find_binary("ffprobe")},
        "openai": {"profile_id": openai["id"] if openai else None, "credential_configured": bool(openai and openai["credential_configured"])},
        "disk_free_bytes": shutil.disk_usage(ROOT).free,
        "provider_count": len(providers),
    }


def _routing_health_rank(profile: dict[str, Any]) -> int:
    health = profile.get("last_health") or {}
    if health.get("ok") is True:
        return 0
    if health.get("ok") is False:
        return 2
    return 1


def _routing_model(profile: dict[str, Any], capability: str) -> str | None:
    config = profile.get("model_config") if isinstance(profile.get("model_config"), dict) else {}
    health = profile.get("last_health") or {}
    detected = [str(item) for item in health.get("models", []) or [] if item]
    keys = {
        "orchestrator": ("orchestrator_model", "preferred_model"),
        "image": ("image_model", "default_model"),
        "image_edit": ("image_edit_model", "image_model", "default_model"),
        "tts": ("tts_model", "default_model"),
        "video": ("model_version", "default_model", "model"),
    }.get(capability, ("default_model",))
    preferred = next((str(config[key]) for key in keys if config.get(key)), None)
    if preferred:
        if not detected or preferred in detected:
            return preferred
        if profile.get("provider_type") == "opencode":
            suffix = preferred.lower().split("/")[-1].removesuffix("-free")
            for item in detected:
                if item.lower().split("/")[-1].removesuffix("-free") == suffix:
                    return item
    return detected[0] if detected else preferred


def _auto_match_capability_bindings(database: Database) -> list[dict[str, Any]]:
    """Fill missing/invalid routes without overwriting a valid manual route."""
    with database.connect() as connection:
        rows = connection.execute("SELECT * FROM provider_profiles ORDER BY display_name, id").fetchall()
        bindings = {row["capability"]: dict(row) for row in connection.execute("SELECT * FROM capability_bindings").fetchall()}
    profiles = [row_profile(database, row) for row in rows]
    profile_by_id = {profile["id"]: profile for profile in profiles}
    changes: list[dict[str, Any]] = []
    removals: list[str] = []
    updates: list[tuple[str, str, str | None, str]] = []

    for capability in CAPABILITIES:
        current = bindings.get(capability)
        current_profile = profile_by_id.get(current["provider_profile_id"]) if current else None
        if current_profile and current_profile["enabled"] and capability in provider_contract(current_profile)["capabilities"]:
            continue
        priority = AUTO_ROUTING_PROVIDER_PRIORITY.get(capability, [])
        candidates = [
            profile for profile in profiles
            if profile["enabled"] and capability in provider_contract(profile)["capabilities"]
        ]
        candidates.sort(key=lambda profile: (
            _routing_health_rank(profile),
            priority.index(profile["provider_type"]) if profile["provider_type"] in priority else len(priority),
            profile["display_name"].lower(),
        ))
        selected = candidates[0] if candidates else None
        if not selected:
            if current:
                removals.append(capability)
            continue
        model = _routing_model(selected, capability)
        updates.append((capability, selected["id"], model, utcnow()))
        changes.append({"capability": capability, "provider_profile_id": selected["id"], "model": model})

    with database.connect() as connection:
        for capability in removals:
            connection.execute("DELETE FROM capability_bindings WHERE capability=?", (capability,))
        for capability, provider_id, model, updated_at in updates:
            connection.execute(
                "INSERT INTO capability_bindings(capability,provider_profile_id,model,updated_at) VALUES(?,?,?,?) ON CONFLICT(capability) DO UPDATE SET provider_profile_id=excluded.provider_profile_id,model=excluded.model,updated_at=excluded.updated_at",
                (capability, provider_id, model, updated_at),
            )
    return changes


def _settings_binding_payload(database: Database) -> list[dict[str, Any]]:
    with database.connect() as connection:
        rows = connection.execute("SELECT * FROM capability_bindings ORDER BY capability").fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        try:
            profile = get_profile(database, row["provider_profile_id"])
            provider = {"id": profile["id"], "name": profile["display_name"], "type": profile["provider_type"], "enabled": profile["enabled"], "models": (profile.get("last_health") or {}).get("models", [])}
        except HTTPException:
            provider = None
        result.append({"capability": row["capability"], "provider_profile_id": row["provider_profile_id"], "model": row["model"], "updated_at": row["updated_at"], "provider": provider})
    return result


@app.get("/api/v2/settings")
async def settings_v3(request: Request):
    database = db(request)
    _auto_match_capability_bindings(database)
    contract = provider_contract({"provider_type": "openai", "model_config": {}, "capabilities": []})
    return {
        "settings_version": "3.0",
        "system": _settings_system_status(database),
        "providers": _settings_providers(database),
        "presets": [{"preset_id": key, **value} for key, value in PROVIDER_PRESETS.items()],
        "bindings": _settings_binding_payload(database),
        "capabilities": list(CAPABILITIES),
        "orchestrator_models": {"default": DEFAULT_ORCHESTRATOR_MODEL, "models": ORCHESTRATOR_MODEL_OPTIONS},
        "routing_policy": "先按 Provider 能力、启用状态和最近探测状态自动匹配；手动保存绑定后保留人工选择。",
    }


@app.get("/api/v2/settings/providers")
async def settings_provider_list_v3(request: Request):
    return {"providers": _settings_providers(db(request)), "presets": [{"preset_id": key, **value} for key, value in PROVIDER_PRESETS.items()]}


@app.post("/api/v2/settings/providers")
async def settings_provider_create_v3(body: ProviderProfileCreate, request: Request):
    profile = await add_profile(body, request)
    return {"provider": profile}


@app.post("/api/v2/settings/providers/from-preset/{preset_id}")
async def settings_provider_from_preset_v3(preset_id: str, request: Request):
    preset = PROVIDER_PRESETS.get(preset_id)
    if not preset:
        raise HTTPException(404, "V3 Provider 预设不存在。")
    body = ProviderProfileCreate(**{key: value for key, value in preset.items() if key != "model_options"})
    profile = await add_profile(body, request)
    return {"provider": profile, "preset_id": preset_id}


@app.patch("/api/v2/settings/providers/{provider_id}")
async def settings_provider_update_v3(provider_id: str, body: ProviderProfileUpdate, request: Request):
    profile = await update_profile(provider_id, body, request)
    return {"provider": profile}


@app.delete("/api/v2/settings/providers/{provider_id}")
async def settings_provider_delete_v3(provider_id: str, request: Request):
    result = await remove_profile(provider_id, request)
    return {**result, "providers": _settings_providers(db(request))}


@app.post("/api/v2/settings/providers/{provider_id}/credential")
async def settings_provider_credential_v3(provider_id: str, body: CredentialWrite, request: Request):
    database = db(request)
    profile = get_profile(database, provider_id)
    try:
        set_secret(profile["credential_ref"], body.api_key)
    except Exception as exc:
        raise HTTPException(503, f"无法写入系统凭据库：{exc}") from exc
    return {"ok": True, "provider_id": provider_id, "credential_configured": True, "credential_mask": mask_secret(body.api_key), "storage": "system_credential_store"}


@app.post("/api/v2/settings/providers/{provider_id}/credential/import")
async def settings_provider_credential_import_v3(provider_id: str, body: CredentialImport, request: Request):
    value = os.environ.get(body.environment_variable, "")
    if not value:
        raise HTTPException(404, f"环境变量 {body.environment_variable} 未设置。")
    return await settings_provider_credential_v3(provider_id, CredentialWrite(api_key=value), request)


@app.delete("/api/v2/settings/providers/{provider_id}/credential")
async def settings_provider_credential_clear_v3(provider_id: str, request: Request):
    database = db(request)
    profile = get_profile(database, provider_id)
    try:
        delete_secret(profile["credential_ref"])
        cleared = True
    except SecretStoreError:
        cleared = False
    current = get_profile(database, provider_id)
    return {"ok": True, "provider_id": provider_id, "cleared_system_store": cleared, "credential_configured": bool(current["credential_configured"]), "environment_variable": provider_environment(profile)}


@app.post("/api/v2/settings/providers/{provider_id}/probe")
async def settings_provider_probe_v3(provider_id: str, request: Request):
    database = db(request)
    profile = get_profile(database, provider_id)
    contract = provider_contract(profile)
    started = time.perf_counter()
    credential = ""
    try:
        credential = get_profile_secret(profile)
        # Keep the probe boundary injectable for local contract tests while
        # using the same provider contract as runtime adapters.
        result = await probe_profile(profile, credential)
    except ProviderError as exc:
        # A probe is a health measurement, so a failed upstream request is
        # still a valid probe result. Persist it instead of returning the old
        # successful result to the UI.
        result = {
            "ok": False,
            "latency_ms": round((time.perf_counter() - started) * 1000),
            "models": [],
            "model_catalog": [],
            "connected_providers": [],
            "capabilities": contract["capabilities"],
            "model_readiness": {},
            "server_version": None,
            "error": str(exc),
            "error_kind": exc.kind,
            "checked_at": time.time(),
        }
    result.update({"adapter": contract["adapter"], "contract_version": contract["version"], "credential": credential_state(profile, credential), "capability_specs": contract["capability_specs"], "input_limits": contract["input_limits"], "output_types": contract["output_types"], "task_modes": contract["task_modes"], "retry_policy": contract["retry_policy"]})
    with database.connect() as connection:
        connection.execute("UPDATE provider_profiles SET last_health_json=?,capabilities_json=?,updated_at=? WHERE id=?", (database.encode(result), database.encode(result.get("capabilities", contract["capabilities"])), utcnow(), provider_id))
    return {"provider": _settings_provider(database, provider_id), "probe": result}


@app.get("/api/v2/settings/providers/{provider_id}/models")
async def settings_provider_models_v3(provider_id: str, request: Request):
    profile = get_profile(db(request), provider_id)
    health = profile.get("last_health") or {}
    return {"provider_id": provider_id, "models": health.get("models", []), "model_catalog": health.get("model_catalog", []), "model_readiness": health.get("model_readiness", {}), "last_probe": health.get("checked_at")}


@app.get("/api/v2/settings/capability-bindings")
async def settings_binding_list_v3(request: Request):
    return {"bindings": _settings_binding_payload(db(request))}


@app.post("/api/v2/settings/capability-bindings/auto-match")
async def settings_binding_auto_match_v3(request: Request):
    database = db(request)
    changes = _auto_match_capability_bindings(database)
    return {"ok": True, "changes": changes, "bindings": _settings_binding_payload(database)}


@app.put("/api/v2/settings/capability-bindings")
async def settings_binding_put_v3(body: CapabilityBinding, request: Request):
    database = db(request)
    profile = get_profile(database, body.provider_profile_id)
    contract = provider_contract(profile)
    if not profile["enabled"]:
        raise HTTPException(409, "不能把能力绑定到已停用的 Provider。")
    if body.capability not in contract["capabilities"]:
        raise HTTPException(409, "该 Provider 当前不声明所选能力，请先检查 Provider 契约或重新探测。")
    if body.capability == "orchestrator":
        validate_orchestrator_model(profile, body.model)
    with database.connect() as connection:
        connection.execute("INSERT INTO capability_bindings(capability,provider_profile_id,model,updated_at) VALUES(?,?,?,?) ON CONFLICT(capability) DO UPDATE SET provider_profile_id=excluded.provider_profile_id,model=excluded.model,updated_at=excluded.updated_at", (body.capability, body.provider_profile_id, body.model, utcnow()))
    return {"ok": True, "binding": next(item for item in _settings_binding_payload(database) if item["capability"] == body.capability)}


@app.get("/api/v2/settings/orchestrator-model-options")
async def settings_orchestrator_models_v3():
    return {"default": DEFAULT_ORCHESTRATOR_MODEL, "models": ORCHESTRATOR_MODEL_OPTIONS}


@app.get("/api/v2/artifacts/{artifact_id}/lineage")
async def artifact_lineage_v3(artifact_id:str,request:Request):
    database=db(request)
    with database.connect() as c:
        artifact=c.execute("SELECT id,project_id,artifact_type,logical_asset_id,version,status,sha256,created_at FROM artifacts WHERE id=?",(artifact_id,)).fetchone()
        if not artifact:raise HTTPException(404,"资产不存在。")
        parents=c.execute("SELECT parent_artifact_id,relation,node_id,created_at FROM artifact_lineage_v3 WHERE child_artifact_id=? ORDER BY id",(artifact_id,)).fetchall()
        children=c.execute("SELECT child_artifact_id,relation,node_id,created_at FROM artifact_lineage_v3 WHERE parent_artifact_id=? ORDER BY id",(artifact_id,)).fetchall()
    return {"artifact":dict(artifact),"parents":[dict(r) for r in parents],"children":[dict(r) for r in children]}


@app.post("/api/v2/artifacts/{artifact_id}/lineage")
async def create_artifact_lineage_v3(artifact_id:str,body:ArtifactLineageCreateV3,request:Request):
    database=db(request)
    with database.connect() as c:
        child=c.execute("SELECT id,project_id FROM artifacts WHERE id=?",(artifact_id,)).fetchone()
        parent=c.execute("SELECT id,project_id FROM artifacts WHERE id=?",(body.parent_artifact_id,)).fetchone()
        if not child or not parent: raise HTTPException(404,"父资产或子资产不存在。")
        if child["id"]==parent["id"]: raise HTTPException(422,"资产不能建立自指血缘。")
        if child["project_id"]!=parent["project_id"]: raise HTTPException(409,"父子资产必须属于同一项目。")
        c.execute("INSERT OR IGNORE INTO artifact_lineage_v3(project_id,parent_artifact_id,child_artifact_id,relation,node_id,created_at) VALUES(?,?,?,?,?,?)",(child["project_id"],parent["id"],child["id"],body.relation,body.node_id,utcnow()))
        row=c.execute("SELECT project_id,parent_artifact_id,child_artifact_id,relation,node_id,created_at FROM artifact_lineage_v3 WHERE parent_artifact_id=? AND child_artifact_id=? AND relation=?",(parent["id"],child["id"],body.relation)).fetchone()
    return dict(row)


def _timeline_clip_shot_id(clip:dict[str,Any])->str|None:
    metadata=clip.get("metadata") if isinstance(clip.get("metadata"),dict) else {}
    value=metadata.get("shot_id") or metadata.get("shotId")
    if value:return str(value)
    clip_id=str(clip.get("id") or "")
    if clip_id.startswith("clip:") and clip_id.split(":",1)[1].startswith("SH"):
        return clip_id.split(":",1)[1]
    return None


def _timeline_artifact_shots(database:Database, row:Any)->set[str]:
    metadata=database.decode(row["metadata_json"],{}) if row["metadata_json"] else {}
    if not isinstance(metadata,dict):return set()
    values=[]
    for key in ("shot_id","shotId"):
        if metadata.get(key):values.append(metadata[key])
    for key in ("shot_ids","shotIds","relevant_shots"):
        value=metadata.get(key)
        if isinstance(value,list):values.extend(value)
        elif isinstance(value,str):values.extend(value.replace(","," ").split())
    return {str(value) for value in values if value}


def _production_artifact_authority(database:Database, project_id:str, artifact_id:str)->dict[str,Any]:
    return production_artifact_gate(database,project_id,artifact_id,DATA_DIR/"projects")


def _timeline_artifact_ready(database:Database, project_id:str, row:Any)->bool:
    try:
        _production_artifact_authority(database,project_id,str(row["id"]))
        return True
    except ProductionArtifactGateError:
        return False


def _timeline_preflight(database:Database, project_id:str, envelope:dict[str,Any])->dict[str,Any]:
    with database.connect() as connection:
        project_row=connection.execute("SELECT document_json FROM projects WHERE id=?",(project_id,)).fetchone()
        artifact_rows=connection.execute("SELECT id,artifact_type,local_path,mime_type,sha256,qa_decision,status,metadata_json,created_at FROM artifacts WHERE project_id=? ORDER BY created_at DESC",(project_id,)).fetchall()
    if not project_row:raise HTTPException(404,"项目不存在。")
    project=database.decode(project_row["document_json"],{})
    library=_library_payload(database,project_id,project)
    assets_by_id={str(item.get("id")):item for item in library.get("assets",[]) if item.get("id")}
    artifact_by_id={str(row["id"]):row for row in artifact_rows}
    video_rows=[row for row in artifact_rows if str(row["mime_type"] or "").lower().startswith("video/") or str(row["artifact_type"] or "").lower() in {"video","final_video","shot_video"}]
    video_by_shot:dict[str,Any]={}
    for row in video_rows:
        if not _timeline_artifact_ready(database,project_id,row):continue
        for shot_id in _timeline_artifact_shots(database,row):video_by_shot.setdefault(shot_id,row)

    timeline=envelope["document"]
    clips_by_shot:dict[str,list[dict[str,Any]]]={}
    for track in timeline.get("tracks",[]):
        for clip in track.get("clips",[]):
            shot_id=_timeline_clip_shot_id(clip)
            if shot_id:clips_by_shot.setdefault(shot_id,[]).append({"track_id":track.get("id"),"kind":track.get("kind"),"clip":clip})

    def blocker(code:str,message:str,source:str|None=None)->dict[str,Any]:
        return {"code":code,"message":message,"source":source}

    shots=[]; placed_shots=set(); ready_shots=set(); blocked_shots=0; error_count=0
    for index,shot in enumerate([item for item in project.get("shots",[]) if isinstance(item,dict) and item.get("id")]):
        shot_id=str(shot["id"]); requirements=shot.get("assetRequirements") or []; blockers=[]; linked=clips_by_shot.get(shot_id,[]); linked_video=[item for item in linked if item.get("kind") in {"video","overlay"}]
        clip_ids=[str(item["clip"].get("id")) for item in linked]
        artifact_ids=[str(item["clip"].get("artifact_id")) for item in linked_video if item["clip"].get("artifact_id")]
        if linked_video:placed_shots.add(shot_id)
        for requirement in requirements:
            if not isinstance(requirement,dict) or not requirement.get("required",True):continue
            asset_id=str(requirement.get("assetId") or requirement.get("asset_id") or "")
            asset=assets_by_id.get(asset_id)
            if not asset or not asset.get("production_ready"):
                blockers.append(blocker("asset_not_production_ready",f"缺少可入镜资产：{asset.get('name',asset_id) if asset else asset_id}",asset_id))
        for item in linked_video:
            aid=item["clip"].get("artifact_id")
            if not aid:
                blockers.append(blocker("missing_video_artifact","主视频片段没有关联已登记 artifact",shot_id))
            elif str(aid) not in artifact_by_id or not _timeline_artifact_ready(database,project_id,artifact_by_id[str(aid)]):
                blockers.append(blocker("artifact_not_ready","时间线片段的媒体 artifact 不可用",str(aid)))
        if not linked_video:
            candidate=video_by_shot.get(shot_id)
            if candidate:
                artifact_ids.append(str(candidate["id"]))
                if shot.get("required",True) is not False:
                    blockers.append(blocker("required_shot_not_placed","镜头已有候选 artifact，但尚未进入主视频轨",shot_id))
            else:blockers.append(blocker("missing_video_artifact","没有可用的批准视频 artifact",shot_id))
        status=str(shot.get("status") or "ready").lower()
        if status in {"blocked","missing"}:blockers.append(blocker("shot_blocked",f"镜头状态为 {status}",shot_id))
        if blockers:blocked_shots+=1; error_count+=len(blockers)
        else:ready_shots.add(shot_id)
        shots.append({"shot_id":shot_id,"scene_id":str(shot.get("scene") or ""),"order":index+1,"duration":float(shot.get("duration") or 0),"status":status,"clip_ids":clip_ids,"artifact_ids":sorted(set(artifact_ids)),"thumbnail_url":None,"purpose":shot.get("purpose") or "","camera":shot.get("camera") or "","action":shot.get("action") or "","blockers":blockers})

    linked_clip_ids={str(item["clip"].get("id")) for values in clips_by_shot.values() for item in values}; track_summaries=[]; audio_ready=0; caption_count=0; video_clip_count=0
    for track in timeline.get("tracks",[]):
        clips=track.get("clips",[]); kind=str(track.get("kind") or "")
        if kind in {"video","overlay"}:
            video_clip_count+=sum(1 for clip in clips if clip.get("artifact_id") and str(clip.get("artifact_id")) in artifact_by_id and _timeline_artifact_ready(database,project_id,artifact_by_id[str(clip.get("artifact_id"))]) and not track.get("muted"))
        if kind in {"dialogue","music","ambience","sfx"}:
            audio_ready+=sum(1 for clip in clips if clip.get("artifact_id") and str(clip.get("artifact_id")) in artifact_by_id and _timeline_artifact_ready(database,project_id,artifact_by_id[str(clip.get("artifact_id"))]))
        if kind=="captions":
            caption_count+=len(clips)
            for clip in clips:
                metadata=clip.get("metadata") if isinstance(clip.get("metadata"),dict) else {}
                text=str(metadata.get("text") or metadata.get("caption") or metadata.get("value") or "").strip()
                start=float(clip.get("start") or 0); duration=float(clip.get("duration") or 0)
                if not text:error_count+=1
                if duration<=0 or start<0 or start+duration>float(timeline.get("duration") or 0)+0.001:error_count+=1
        for clip in clips:
            start=float(clip.get("start") or 0); duration=float(clip.get("duration") or 0); clip_id=str(clip.get("id") or "")
            if start<0 or duration<=0 or start+duration>float(timeline.get("duration") or 0)+0.001:error_count+=1
            if clip_id not in linked_clip_ids and kind in {"video","overlay","dialogue","music","ambience","sfx"}:
                aid=clip.get("artifact_id")
                if not aid or str(aid) not in artifact_by_id or not _timeline_artifact_ready(database,project_id,artifact_by_id[str(aid)]):error_count+=1
        track_summaries.append({"id":track.get("id"),"kind":kind,"name":track.get("name") or track.get("id"),"muted":bool(track.get("muted")),"locked":bool(track.get("locked")),"clip_count":len(clips)})
    if video_clip_count==0:error_count+=1
    warnings=[]
    video_track=next((track for track in timeline.get("tracks",[]) if track.get("kind")=="video"),None)
    if video_track:
        ordered=sorted(video_track.get("clips",[]),key=lambda clip:float(clip.get("start") or 0))
        for previous,current in zip(ordered,ordered[1:]):
            previous_end=float(previous.get("start") or 0)+float(previous.get("duration") or 0); current_start=float(current.get("start") or 0)
            if current_start>previous_end+0.001:warnings.append({"code":"video_gap","message":f"主视频轨存在 {round(current_start-previous_end,2)} 秒间隙"})
            if current_start<previous_end-0.001:
                warnings.append({"code":"video_overlap","message":"主视频轨存在片段重叠"}); error_count+=1
    if not audio_ready:warnings.append({"code":"audio_missing","message":"当前没有已登记的可用音频片段"})
    delivery_ready=bool(video_clip_count and blocked_shots==0 and error_count==0)
    return {"project_id":project_id,"timeline_revision":envelope["revision"],"summary":{"shot_total":len(shots),"shot_placed":len(placed_shots),"shot_ready":len(ready_shots),"blocked_shots":blocked_shots,"audio_ready":audio_ready,"caption_count":caption_count,"delivery_ready":delivery_ready,"error_count":error_count,"warning_count":len(warnings)},"shots":shots,"tracks":track_summaries,"warnings":warnings,"deliverables":{"master_burn_in":"ready" if delivery_ready else "blocked","clean":"ready" if delivery_ready else "blocked","srt":"ready"},"asset_summary":library.get("summary",{})}


@app.get("/api/v2/projects/{project_id}/timeline")
async def read_timeline_v3(project_id:str,request:Request):return ensure_timeline(db(request),project_id)


@app.get("/api/v2/projects/{project_id}/timeline/preflight")
async def preflight_timeline_v3(project_id:str,request:Request):
    return _timeline_preflight(db(request),project_id,ensure_timeline(db(request),project_id))
@app.put("/api/v2/projects/{project_id}/timeline")
async def write_timeline_v3(project_id:str,body:TimelineUpdateV3,request:Request):
    ensure_timeline(db(request),project_id)
    return save_timeline(db(request),project_id,body.document,body.expected_revision)


@app.post("/api/v2/projects/{project_id}/timeline/assemble")
async def assemble_timeline_v3(project_id:str,body:TimelineAssemblyRequestV3,request:Request):
    return assemble_approved_timeline(db(request),project_id,body.expected_revision,body.include_audio,body.replace_existing,DATA_DIR/"projects")


@app.post("/api/v2/projects/{project_id}/timeline/preview")
async def preview_timeline_v3(project_id:str,body:TimelinePreviewRequestV3,request:Request):
    database=db(request)
    envelope=ensure_timeline(database,project_id)
    if envelope["revision"]!=body.expected_revision:
        raise HTTPException(409,{"message":"时间线版本已变化，请刷新后重试。","current_revision":envelope["revision"]})
    request_data={"project_id":project_id,"timeline_revision":envelope["revision"],"output_name":"preview.mp4","resolution":body.resolution,"fps":envelope["document"]["fps"],"delivery_set":"single","subtitle_mode":"external","use_proxies":body.use_proxies,"mode":"preview","confirmed":True,"timeline":envelope["document"]}
    manifest=_render_manifest(database,project_id,envelope["revision"],envelope["document"],request_data)
    render_id=f"PREVIEW_{secrets.token_hex(8)}"; now=utcnow()
    with database.connect() as connection:
        connection.execute("INSERT INTO render_jobs_v6(id,project_id,timeline_revision,status,request_json,manifest_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",(render_id,project_id,envelope["revision"],"queued",database.encode(request_data),database.encode(manifest),now,now))
    schedule_v3_render(request.app,render_id)
    return _render_job_payload(database,_render_job(database,render_id))


def _render_output_name(value: str) -> str:
    name = Path(value).name
    if name != value or name in {"", ".", ".."} or not name.lower().endswith(".mp4"):
        raise HTTPException(422, "输出文件名必须是当前任务目录中的 .mp4 文件名。")
    return name


def _render_resolution(timeline: dict[str, Any], requested: str | None) -> str:
    value = requested or f"{timeline['width']}x{timeline['height']}"
    if not re.fullmatch(r"[1-9]\d{1,4}x[1-9]\d{1,4}", value):
        raise HTTPException(422, "输出分辨率必须使用 WIDTHxHEIGHT 格式。")
    width, height = (int(part) for part in value.split("x", 1))
    if width > 8192 or height > 8192:
        raise HTTPException(422, "输出分辨率不能超过 8192。")
    return f"{width}x{height}"


def _timeline_artifact_rows(database: Database, project_id: str, timeline: dict[str, Any]) -> dict[str, sqlite3.Row]:
    source_only = [
        clip.get("id")
        for track in timeline.get("tracks", [])
        for clip in track.get("clips", [])
        if track.get("kind") in {"video", "overlay", "dialogue", "music", "ambience", "sfx"} and clip.get("source") and not clip.get("artifact_id")
    ]
    if source_only:
        raise HTTPException(422, {"message": "V3 渲染只允许使用当前项目 artifact，不能直接使用文件路径。", "clip_ids": source_only})
    artifact_ids = {
        str(clip.get("artifact_id"))
        for track in timeline.get("tracks", [])
        for clip in track.get("clips", [])
        if clip.get("artifact_id")
    }
    if not artifact_ids:
        return {}
    authority: dict[str, dict[str, Any]] = {}
    for artifact_id in sorted(artifact_ids):
        try:
            authority[artifact_id] = _production_artifact_authority(database, project_id, artifact_id)
        except ProductionArtifactGateError as exc:
            raise HTTPException(409, {"message": "时间线素材未通过生产门禁。", "production_gate": exc.payload()}) from exc
    marks = ",".join("?" for _ in artifact_ids)
    with database.connect() as connection:
        rows = connection.execute(
            f"SELECT id,project_id,artifact_type,local_path,mime_type,sha256,qa_decision,status FROM artifacts WHERE id IN ({marks})",
            tuple(sorted(artifact_ids)),
        ).fetchall()
    found = {row["id"]: row for row in rows}
    missing = sorted(artifact_ids - set(found))
    if missing:
        raise HTTPException(409, {"message": "时间线包含未登记的 artifact。", "missing_artifact_ids": missing})
    return found


def _render_manifest(database: Database, project_id: str, timeline_revision: int, timeline: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    video_clips = [
        clip
        for track in timeline.get("tracks", [])
        if track.get("kind") in {"video", "overlay"} and not track.get("muted")
        for clip in track.get("clips", [])
    ]
    if not video_clips:
        raise HTTPException(422, "时间线至少需要一个未静音的视频或叠加视频片段。")
    rows = _timeline_artifact_rows(database, project_id, timeline)
    project_root = (DATA_DIR / "projects" / project_id).resolve()
    assets = []
    for artifact_id, row in sorted(rows.items()):
        path = Path(row["local_path"]).resolve()
        try:
            authority = _production_artifact_authority(database, project_id, artifact_id)
        except ProductionArtifactGateError as exc:
            raise HTTPException(409,{"message":"渲染清单素材未通过生产门禁。","production_gate":exc.payload()}) from exc
        assets.append({
            "artifact_id": artifact_id,
            "artifact_type": row["artifact_type"],
            "mime_type": row["mime_type"],
            "sha256": authority["sha256"],
            "relative_path": path.relative_to(project_root).as_posix(),
            "logical_asset_id": authority["logical_asset_id"],
            "asset_version_id": authority["asset_version_id"],
            "asset_version": authority["asset_version"],
            "qa_run_id": authority["qa_run_id"],
        })
    return {
        "manifest_version": 1,
        "project_id": project_id,
        "timeline_revision": timeline_revision,
        "timeline": timeline,
        "inputs": assets,
        "tracks": timeline.get("tracks", []),
        "output": {
            "name": _render_output_name(str(request.get("output_name") or "final.mp4")),
            "resolution": _render_resolution(timeline, request.get("resolution")),
            "fps": int(request.get("fps") or timeline["fps"]),
            "duration": timeline["duration"],
            "delivery_set": str(request.get("delivery_set") or "master_clean_srt"),
            "subtitle_mode": str(request.get("subtitle_mode") or "burn_in"),
            "mode": str(request.get("mode") or "delivery"),
            "audio_mapping": [track["id"] for track in timeline.get("tracks", []) if track.get("kind") in {"dialogue", "music", "ambience", "sfx"}],
            "subtitle_tracks": [track["id"] for track in timeline.get("tracks", []) if track.get("kind") == "captions"],
        },
        "created_at": utcnow(),
    }


def _render_job_payload(database: Database, row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "timeline_revision": row["timeline_revision"],
        "status": row["status"],
        "request": database.decode(row["request_json"], {}),
        "manifest": database.decode(row["manifest_json"], {}),
        "result": database.decode(row["result_json"], None),
        "error": database.decode(row["error_json"], None),
        "idempotency_fingerprint": row["idempotency_fingerprint"],
        "approval_token": row["id"] if row["status"] == "awaiting_confirmation" and not row["approval_consumed_at"] else None,
        "approval_consumed_at": row["approval_consumed_at"],
        "confirmed_at": row["confirmed_at"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _render_job(database: Database, render_id: str) -> sqlite3.Row:
    with database.connect() as connection:
        row = connection.execute("SELECT * FROM render_jobs_v6 WHERE id=?", (render_id,)).fetchone()
    if not row:
        raise HTTPException(404, "渲染作业不存在。")
    return row


@app.post("/api/v2/renders/estimate")
async def estimate_render_v3(body:RenderEstimateV3,request:Request):
    database = db(request)
    envelope = ensure_timeline(database, body.project_id)
    if body.timeline_revision is not None and body.timeline_revision != envelope["revision"]:
        raise HTTPException(409, {"message": "时间线版本已变化，请刷新后重试。", "current_revision": envelope["revision"]})
    manifest = _render_manifest(database, body.project_id, envelope["revision"], envelope["document"], body.model_dump(mode="json"))
    preflight = _timeline_preflight(database, body.project_id, envelope)
    if not preflight["summary"]["delivery_ready"]:
        raise HTTPException(409, {"message": "时间线尚未通过交付预检。", "preflight": preflight})
    return {
        "project_id": body.project_id,
        "timeline_revision": envelope["revision"],
        "estimate": {
            "estimated_cost": 0,
            "currency": "USD",
            "estimated_seconds": max(1, round(float(envelope["document"]["duration"]) * 0.4)),
            "requires_confirmation": True,
            "input_count": len(manifest["inputs"]),
            "track_count": len(envelope["document"].get("tracks", [])),
        },
        "manifest": manifest,
    }


@app.post("/api/v2/renders")
async def create_render_v3(body:RenderCreateV3,request:Request):
    database = db(request)
    envelope = ensure_timeline(database, body.project_id)
    if body.timeline_revision is not None and body.timeline_revision != envelope["revision"]:
        raise HTTPException(409, {"message": "时间线版本已变化，请刷新后重试。", "current_revision": envelope["revision"]})
    request_data = body.model_dump(mode="json")
    manifest = _render_manifest(database, body.project_id, envelope["revision"], envelope["document"], request_data)
    preflight = _timeline_preflight(database, body.project_id, envelope)
    if not preflight["summary"]["delivery_ready"]:
        raise HTTPException(409, {"message": "时间线尚未通过交付预检。", "preflight": preflight})
    request_data.update({"timeline": envelope["document"], "timeline_revision": envelope["revision"], "confirmed": bool(body.confirmed)})
    fingerprint=render_fingerprint(body.project_id,envelope["revision"],envelope["document"],manifest["inputs"],request_data)
    render_id = f"RENDER_{secrets.token_hex(8)}"
    status = "queued" if body.confirmed else "awaiting_confirmation"
    now = utcnow();created=False
    with database.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing=connection.execute("SELECT id FROM render_jobs_v6 WHERE idempotency_fingerprint=? AND status IN ('awaiting_confirmation','queued','running') ORDER BY created_at LIMIT 1",(fingerprint,)).fetchone()
        if existing:
            render_id=str(existing["id"])
        else:
            created=True
            connection.execute(
                "INSERT INTO render_jobs_v6(id,project_id,timeline_revision,status,request_json,manifest_json,idempotency_fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (render_id, body.project_id, envelope["revision"], status, database.encode(request_data), database.encode(manifest), fingerprint, now, now),
            )
    if created and status == "queued":
        schedule_v3_render(request.app, render_id)
    payload=_render_job_payload(database, _render_job(database, render_id));payload["idempotent_replay"]=not created
    return payload


@app.get("/api/v2/renders/{render_id}")
async def read_render_v3(render_id:str,request:Request):
    return _render_job_payload(db(request), _render_job(db(request), render_id))


@app.post("/api/v2/renders/{render_id}/approve")
async def approve_render_v3(render_id:str,body:RenderDecisionV3,request:Request):
    database = db(request)
    row = _render_job(database, render_id)
    if row["status"] != "awaiting_confirmation":
        raise HTTPException(409, "当前渲染作业不在等待确认状态。")
    request_data = database.decode(row["request_json"], {})
    manifest = database.decode(row["manifest_json"], {})
    timeline = request_data.get("timeline") or manifest.get("timeline")
    if not isinstance(timeline,dict):
        raise HTTPException(409,"渲染快照缺少时间线文档。")
    _render_manifest(database,row["project_id"],int(row["timeline_revision"]),timeline,request_data)
    preflight = _timeline_preflight(database,row["project_id"],{"revision":int(row["timeline_revision"]),"document":timeline})
    if not preflight["summary"]["delivery_ready"]:
        raise HTTPException(409,{"message":"时间线尚未通过交付预检。","preflight":preflight})
    now = utcnow();approved=False
    with database.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        current=connection.execute("SELECT status,approval_consumed_at FROM render_jobs_v6 WHERE id=?",(render_id,)).fetchone()
        if not current or current["status"]!="awaiting_confirmation" or current["approval_consumed_at"]:
            raise HTTPException(409,"渲染审批令牌不存在或已被消费。")
        request_data["confirmed"] = True
        request_data["approval_detail"] = body.detail
        updated=connection.execute("UPDATE render_jobs_v6 SET status='queued',request_json=?,confirmed_at=?,approval_consumed_at=?,updated_at=? WHERE id=? AND status='awaiting_confirmation' AND approval_consumed_at IS NULL", (database.encode(request_data), now, now, now, render_id))
        approved=updated.rowcount==1
    if not approved:raise HTTPException(409,"渲染审批令牌不存在或已被消费。")
    schedule_v3_render(request.app, render_id)
    return _render_job_payload(database, _render_job(database, render_id))


@app.post("/api/v2/renders/{render_id}/cancel")
async def cancel_render_v3(render_id:str,request:Request):
    database = db(request)
    row = _render_job(database, render_id)
    if row["status"] not in {"awaiting_confirmation", "queued", "running"}:
        raise HTTPException(409, "当前渲染作业不能取消。")
    with database.connect() as connection:
        connection.execute("UPDATE render_jobs_v6 SET status='canceled',updated_at=? WHERE id=?", (utcnow(), render_id))
    return _render_job_payload(database, _render_job(database, render_id))


@app.post("/api/v2/projects/{project_id}/proxies")
async def create_proxy_v3(project_id:str,body:ProxyCreateV3,request:Request,background:BackgroundTasks):
    database = db(request)
    with database.connect() as connection:
        artifact = connection.execute("SELECT * FROM artifacts WHERE id=? AND project_id=?", (body.artifact_id, project_id)).fetchone()
    if not artifact:
        raise HTTPException(404, "代理源 artifact 不存在或不属于当前项目。")
    if not str(artifact["mime_type"] or "").startswith("video/"):
        raise HTTPException(422, "代理预览目前只支持视频 artifact。")
    source = Path(artifact["local_path"]).resolve()
    if not source.is_file():
        raise HTTPException(404, "代理源文件不存在。")
    source_hash = artifact["sha256"] or sha256_file(source)
    with database.connect() as connection:
        existing = connection.execute("SELECT * FROM media_proxies_v6 WHERE project_id=? AND artifact_id=? AND source_sha256=? AND preset=?", (project_id, body.artifact_id, source_hash, body.preset)).fetchone()
        if existing and existing["status"] == "ready" and existing["local_path"] and Path(existing["local_path"]).is_file():
            return {"id": existing["id"], "project_id": project_id, "artifact_id": body.artifact_id, "preset": body.preset, "status": "ready", "path": artifact_url(project_id, Path(existing["local_path"]))}
        proxy_id = existing["id"] if existing else f"PROXY_{secrets.token_hex(8)}"
        now = utcnow()
        if existing:
            connection.execute("UPDATE media_proxies_v6 SET status='queued',error_json=NULL,updated_at=? WHERE id=?", (now, proxy_id))
        else:
            connection.execute("INSERT INTO media_proxies_v6(id,project_id,artifact_id,source_sha256,preset,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", (proxy_id, project_id, body.artifact_id, source_hash, body.preset, "queued", now, now))
    background.add_task(run_proxy_task, request.app, proxy_id)
    return {"id": proxy_id, "project_id": project_id, "artifact_id": body.artifact_id, "preset": body.preset, "status": "queued"}


@app.get("/api/v2/proxies/{proxy_id}")
async def read_proxy_v3(proxy_id:str,request:Request):
    database = db(request)
    with database.connect() as connection:
        row = connection.execute("SELECT * FROM media_proxies_v6 WHERE id=?", (proxy_id,)).fetchone()
    if not row:
        raise HTTPException(404, "代理作业不存在。")
    metadata = database.decode(row["metadata_json"], {})
    payload = {"id": row["id"], "project_id": row["project_id"], "artifact_id": row["artifact_id"], "preset": row["preset"], "status": row["status"], "metadata": metadata, "error": database.decode(row["error_json"], None), "created_at": row["created_at"], "updated_at": row["updated_at"]}
    if row["local_path"] and Path(row["local_path"]).is_file():
        payload["path"] = artifact_url(row["project_id"], Path(row["local_path"]))
    for key in ("thumbnail", "waveform"):
        if metadata.get(key) and Path(str(metadata[key])).is_file():
            payload[f"{key}_url"] = artifact_url(row["project_id"], Path(str(metadata[key])))
    return payload


@app.get("/api/v2/projects/{project_id}/story")
async def read_story_v3(project_id:str,request:Request):
    doc,revision=await read_project_doc(request,project_id)
    return {"project_id":project_id,"revision":revision,"story":story_document(doc),"checks":story_checks(doc)}


@app.get("/api/v2/projects/{project_id}/story/checks")
async def check_story_v3(project_id:str,request:Request):
    doc,revision=await read_project_doc(request,project_id)
    return {"project_id":project_id,"revision":revision,"checks":story_checks(doc)}


@app.put("/api/v2/projects/{project_id}/story")
async def write_story_v3(project_id:str,body:StoryDocumentUpdateV3,request:Request):
    doc,revision=await read_project_doc(request,project_id)
    if revision!=body.expected_revision:
        raise HTTPException(409,{"message":"故事文档已有更新，请刷新后重试。","current_revision":revision})
    before_script=str(doc.get("script") or "")
    before_shots=[shot for shot in doc.get("shots",[]) if isinstance(shot,dict)]
    before_story={"spec":doc.get("storySpec") or {},"script":before_script,"scenes":doc.get("scenes") or [],"shots":before_shots}
    payload=body.model_dump(mode="json")
    doc["storySpec"]=payload["spec"]
    doc["brief"]=payload["spec"].get("creative_goal") or doc.get("brief","")
    doc["duration"]=payload["spec"]["duration"]
    doc["ratio"]=payload["spec"]["ratio"]
    doc["script"]=payload["script"]
    doc["scenes"]=payload["scenes"]
    doc["shots"]=payload["shots"]
    now=utcnow()
    if before_script!=payload["script"]:
        parent_script=next((version.get("id") for version in doc.setdefault("scriptVersions",[]) if version.get("status")=="active"),None)
        for version in doc.setdefault("scriptVersions",[]):
            if version.get("status")=="active":version["status"]="superseded"
        doc["scriptVersions"].append({"id":_story_version_id("script",project_id,len(doc["scriptVersions"])+1),"parentId":parent_script,"status":"active","text":payload["script"],"source":"user","skillId":None,"providerProfileId":None,"model":None,"createdAt":now,"acceptedAt":now})
    if before_shots!=payload["shots"]:
        parent_storyboard=next((version.get("id") for version in doc.setdefault("storyboardVersions",[]) if version.get("status")=="active"),None)
        for version in doc.setdefault("storyboardVersions",[]):
            if version.get("status")=="active":version["status"]="superseded"
        doc["storyboardVersions"].append({"id":_story_version_id("storyboard",project_id,len(doc["storyboardVersions"])+1),"parentId":parent_storyboard,"scriptVersionId":doc["scriptVersions"][-1]["id"] if doc.get("scriptVersions") else None,"status":"active","shotIds":[shot.get("id") for shot in payload["shots"]],"package":{"scenes":payload["scenes"],"shots":payload["shots"]},"createdAt":now,"acceptedAt":now})
    save_project_document(
        request,doc,body.expected_revision,
        audit_event={
            "action":"story_updated", "target_type":"story", "target_id":project_id,
            "reason":"story_document_updated", "before":before_story,
            "after":{"spec":doc.get("storySpec") or {},"script":doc.get("script") or "","scenes":doc.get("scenes") or [],"shots":doc.get("shots") or []},
        },
    )
    return {"project_id":project_id,"revision":body.expected_revision+1,"story":story_document(doc),"checks":story_checks(doc)}


def _find_story_version(document:dict[str,Any],version_id:str)->tuple[str,dict[str,Any]]|None:
    for kind,key in (("script","scriptVersions"),("storyboard","storyboardVersions")):
        for version in document.get(key,[]):
            if isinstance(version,dict) and version.get("id")==version_id:
                return kind,version
    return None


def _story_version_story(document:dict[str,Any],version_id:str)->tuple[str,dict[str,Any]]|None:
    found=_find_story_version(document,version_id)
    if not found:return None
    kind,version=found
    if kind=="script":
        return kind,{"script":str(version.get("text") or ""),"scenes":document.get("scenes",[]),"shots":document.get("shots",[])}
    package=version.get("package") if isinstance(version.get("package"),dict) else {}
    return kind,{"script":document.get("script",[]),"scenes":package.get("scenes",[]),"shots":package.get("shots",[])}


def _shot_diff(before:list[dict[str,Any]],after:list[dict[str,Any]])->dict[str,Any]:
    old={str(item.get("id")):item for item in before if isinstance(item,dict) and item.get("id")}
    new={str(item.get("id")):item for item in after if isinstance(item,dict) and item.get("id")}
    added=[new[key] for key in new.keys()-old.keys()]
    removed=[old[key] for key in old.keys()-new.keys()]
    changed=[]
    for key in old.keys() & new.keys():
        fields=sorted({field for field in set(old[key]) | set(new[key]) if old[key].get(field)!=new[key].get(field)})
        if fields:changed.append({"id":key,"fields":fields,"before":old[key],"after":new[key]})
    return {"added":added,"removed":removed,"changed":changed}


@app.get("/api/v2/projects/{project_id}/story/diff")
async def story_diff_v3(project_id:str,request:Request):
    from_id=request.query_params.get("from_version_id")
    to_id=request.query_params.get("to_version_id")
    if not from_id or not to_id:raise HTTPException(422,"差异审阅需要 from_version_id 和 to_version_id。")
    doc,_=await read_project_doc(request,project_id)
    before=_story_version_story(doc,from_id); after=_story_version_story(doc,to_id)
    if not before or not after:raise HTTPException(404,"故事版本不存在。")
    before_script=str(before[1].get("script") or "").splitlines()
    after_script=str(after[1].get("script") or "").splitlines()
    script_diff=[]
    for tag,old_start,old_end,new_start,new_end in difflib.SequenceMatcher(a=before_script,b=after_script).get_opcodes():
        if tag=="equal":script_diff.extend({"type":"same","text":line} for line in after_script[new_start:new_end])
        elif tag in {"delete","replace"}:script_diff.extend({"type":"del","text":line} for line in before_script[old_start:old_end])
        if tag in {"insert","replace"}:script_diff.extend({"type":"add","text":line} for line in after_script[new_start:new_end])
    return {"project_id":project_id,"from_version_id":from_id,"to_version_id":to_id,"script_diff":script_diff,"shot_diff":_shot_diff(before[1].get("shots",[]),after[1].get("shots",[]))}


@app.post("/api/v2/projects/{project_id}/story/rollback")
async def story_rollback_v3(project_id:str,body:StoryRollbackV3,request:Request):
    doc,revision=await read_project_doc(request,project_id)
    if revision!=body.expected_revision:raise HTTPException(409,{"message":"故事文档已有更新，请刷新后重试。","current_revision":revision})
    found=_find_story_version(doc,body.version_id)
    if not found:raise HTTPException(404,"故事版本不存在。")
    before_story={"spec":doc.get("storySpec") or {},"script":doc.get("script") or "","scenes":doc.get("scenes") or [],"shots":doc.get("shots") or []}
    kind,version=found
    now=utcnow(); changed=False
    apply_script=body.scope in {"all","script"} and kind=="script"
    apply_shots=body.scope in {"all","shots"} and kind=="storyboard"
    if body.scope=="all" and kind=="script":apply_script=True
    if body.scope=="all" and kind=="storyboard":apply_shots=True
    if not apply_script and not apply_shots:raise HTTPException(422,"回退范围与所选版本类型不匹配。")
    if apply_script:
        parent=next((item.get("id") for item in doc.setdefault("scriptVersions",[]) if item.get("status")=="active"),None)
        for item in doc["scriptVersions"]:
            if item.get("status")=="active":item["status"]="superseded"
        doc["script"]=str(version.get("text") or "")
        doc["scriptVersions"].append({"id":_story_version_id("script",project_id,len(doc["scriptVersions"])+1),"parentId":parent,"sourceVersionId":body.version_id,"status":"active","text":doc["script"],"source":"rollback","skillId":None,"providerProfileId":None,"model":None,"createdAt":now,"acceptedAt":now})
        changed=True
    if apply_shots:
        package=version.get("package") if isinstance(version.get("package"),dict) else {}
        parent=next((item.get("id") for item in doc.setdefault("storyboardVersions",[]) if item.get("status")=="active"),None)
        for item in doc["storyboardVersions"]:
            if item.get("status")=="active":item["status"]="superseded"
        doc["scenes"]=[item for item in package.get("scenes",[]) if isinstance(item,dict)]
        doc["shots"]=[item for item in package.get("shots",[]) if isinstance(item,dict)]
        doc["storyboardVersions"].append({"id":_story_version_id("storyboard",project_id,len(doc["storyboardVersions"])+1),"parentId":parent,"sourceVersionId":body.version_id,"scriptVersionId":next((item.get("id") for item in doc.get("scriptVersions",[]) if item.get("status")=="active"),None),"status":"active","shotIds":[item.get("id") for item in doc["shots"]],"package":{"scenes":doc["scenes"],"shots":doc["shots"]},"source":"rollback","createdAt":now,"acceptedAt":now})
        changed=True
    if not changed:raise HTTPException(422,"没有可回退的故事内容。")
    save_project_document(
        request,doc,body.expected_revision,
        audit_event={
            "action":"story_rolled_back", "target_type":"story", "target_id":project_id,
            "reason":"story_version_rollback", "before":before_story,
            "after":{"spec":doc.get("storySpec") or {},"script":doc.get("script") or "","scenes":doc.get("scenes") or [],"shots":doc.get("shots") or []},
            "metadata":{"version_id":body.version_id,"scope":body.scope},
        },
    )
    return {"project_id":project_id,"revision":body.expected_revision+1,"rolled_back_from":body.version_id,"story":story_document(doc),"checks":story_checks(doc)}


# ---------------------------------------------------------------------------
# Story optimization: two-stage script/storyboard -> asset regulator workflow.
# ---------------------------------------------------------------------------

def _storyboard_input_package(doc:dict[str,Any],body:StoryOptimizationCreate)->dict[str,Any]:
    assets=doc.get("assets",[])
    return {
        "project_id":doc.get("id"),
        "project_name":doc.get("name"),
        "source_script_version_id":body.source_script_version_id,
        "current_script":doc.get("script",""),
        "project_brief":doc.get("brief",""),
        "duration":body.duration or doc.get("duration",30),
        "aspect_ratio":body.ratio or doc.get("ratio","9:16"),
        "target_generator":body.generator or doc.get("generator","Seedance 2.5"),
        "existing_asset_ids":[a.get("id") for a in assets],
        "existing_shot_ids":[s.get("id") for s in doc.get("shots",[])],
        "optimization_goal":body.goal,
        "change_strength":body.strength,
        "must_preserve":body.must_preserve,
        "must_avoid":body.must_avoid + body.prohibited_content,
        "story_spec":{
            "creative_goal":doc.get("storySpec",{}).get("creative_goal") if isinstance(doc.get("storySpec"),dict) else doc.get("brief",""),
            "audience":body.audience or (doc.get("storySpec",{}).get("audience","") if isinstance(doc.get("storySpec"),dict) else ""),
            "platform":body.platform or (doc.get("storySpec",{}).get("platform","") if isinstance(doc.get("storySpec"),dict) else ""),
            "language":body.language,
            "brand_requirements":body.brand_requirements,
            "duration":body.duration or doc.get("duration",30),
            "ratio":body.ratio or doc.get("ratio","9:16"),
            "structure":(doc.get("storySpec",{}).get("structure",[]) if isinstance(doc.get("storySpec"),dict) else []),
            "beats":(doc.get("storySpec",{}).get("beats",[]) if isinstance(doc.get("storySpec"),dict) else []),
        },
    }

def _validate_storyboard_output(result:dict[str,Any])->list[str]:
    issues=[]
    if not isinstance(result.get("proposedScript"),str) or not result["proposedScript"].strip():issues.append("proposedScript 缺失或为空")
    if not isinstance(result.get("shots"),list):issues.append("shots 必须是数组")
    else:
        ids=[s.get("id") for s in result["shots"] if isinstance(s,dict)]
        if len(ids)!=len(set(ids)):issues.append("镜头 ID 重复")
        for s in result["shots"]:
            for f in ("id","scene","duration","purpose","size","camera","action"):
                if f not in s or s[f] in (None,""):issues.append(f"镜头缺少必填字段 {f}")
    handoff=result.get("assetHandoff") or {}
    for key in ("characters","scenes","props"):
        items=handoff.get(key) or []
        ids=[i.get("id") for i in items if isinstance(i,dict)]
        if len(ids)!=len(set(ids)):issues.append(f"Asset Handoff {key} ID 重复")
    return issues

def _validate_regulator_output(result:dict[str,Any])->list[str]:
    issues=[]
    reqs=result.get("assetRequirements")
    if not isinstance(reqs,list):issues.append("assetRequirements 必须是数组")
    else:
        seen=set()
        for r in reqs:
            if not isinstance(r,dict):issues.append("assetRequirements 元素必须是对象");continue
            if not r.get("shotId") or not r.get("assetId") or not r.get("assetClass"):issues.append("assetRequirements 缺少 shotId/assetId/assetClass")
            key=(r.get("shotId"),r.get("assetId"))
            if key in seen:issues.append(f"依赖重复 {key}")
            seen.add(key)
    return issues

async def _run_storyboard_agent(request:Request,project_id:str,input_package:dict[str,Any])->dict[str,Any]:
    database=db(request); profile,bound=resolve_profile(database,"orchestrator"); model=bound or profile["model_config"].get("orchestrator_model")
    if not model:raise HTTPException(409,"尚未配置编排模型，无法运行脚本优化。")
    validate_orchestrator_model(profile,model)
    instructions=("你是 FRAMEFLOW 的 video-script-storyboard Skill。把用户的故事/脚本转成可执行分镜，"
                  "保留核心意图，只输出结构化 JSON，稳定 ID（SH/C/S/P）尽量保留。不要生成图片或视频。")
    text=f"请按完整前期包处理以下项目。\n\n输入包：{json.dumps(input_package,ensure_ascii=False)}"
    if profile["provider_type"]=="opencode":
        return await opencode_structured(profile,get_profile_secret(profile),model,instructions,text,STORYBOARD_OUTPUT_SCHEMA,"FRAMEFLOW · Storyboard")
    return await openai_structured(profile,get_profile_secret(profile),model,instructions,text,STORYBOARD_OUTPUT_SCHEMA,"frameflow_storyboard")

async def _run_regulator_agent(request:Request,project_id:str,input_package:dict[str,Any])->dict[str,Any]:
    database=db(request); profile,bound=resolve_profile(database,"orchestrator"); model=bound or profile["model_config"].get("orchestrator_model")
    if not model:raise HTTPException(409,"尚未配置编排模型，无法运行资产总控。")
    validate_orchestrator_model(profile,model)
    instructions=("你是 FRAMEFLOW 的 video-asset-regulator Skill。审计分镜、提取并分级资产、建立逐镜头依赖和下游路由，"
                  "只输出结构化 JSON。你不生成最终 Prompt、图片或视频，也不伪造领域 QA 结果。")
    text=f"请审计以下分镜交接包。\n\n输入包：{json.dumps(input_package,ensure_ascii=False)}"
    if profile["provider_type"]=="opencode":
        return await opencode_structured(profile,get_profile_secret(profile),model,instructions,text,REGULATOR_OUTPUT_SCHEMA,"FRAMEFLOW · Asset Regulator")
    return await openai_structured(profile,get_profile_secret(profile),model,instructions,text,REGULATOR_OUTPUT_SCHEMA,"frameflow_regulator")

def _asset_prompt_skill(asset_class:str)->str:
    return {
        "character":"video-character-design-director",
        "scene":"video-scene-design-director",
        "prop":"video-prop-design-director",
        "product":"video-prop-design-director",
        "fusion":"video-fusion-production-director",
        "style":"video-asset-regulator",
        "audio":"voice-controller",
        "music":"voice-controller",
        "sfx":"voice-controller",
    }.get(asset_class,"video-asset-regulator")

async def _run_asset_prompt_agent(request:Request,project_id:str,input_package:dict[str,Any])->dict[str,Any]:
    database=db(request); profile,bound=resolve_profile(database,"orchestrator"); model=bound or profile["model_config"].get("orchestrator_model")
    if not model:raise HTTPException(409,"尚未配置编排模型，无法生成资产 Prompt。")
    validate_orchestrator_model(profile,model)
    instructions=("你是 FRAMEFLOW 的 video-asset-regulator 下游资产 Prompt 编排器。根据已经完成的资产总控审计，"
                  "为每个需要制作的角色、场景、道具、产品或风格资产生成完整、可执行的中文视觉资产 Prompt 卡。"
                  "角色必须覆盖身份锁定、脸部与表情、发型轮廓、服装材质、身体动作、构图镜头、光线渲染、背景、必须保留和必须避免；"
                  "场景必须覆盖空间布局、陈设、材质表面、光线气氛、动作空间、机位和连续性；道具必须覆盖结构、材质、尺度、使用状态、"
                  "参考图角色和负面约束。融合资产不得在本阶段生成最终可执行 Prompt，只能写入 fusionPlans，说明对应镜头、候选输入资产、"
                  "镜头目标、角色/环境角色和连续性约束；正式融合 Prompt 必须等待用户完成真实资产连线并确认。"
                  "每张非融合资产卡必须路由到对应 domain skill，并完整填写 promptPack 和自然语言 prompt。"
                  "你不生成图片、不调用图片服务、不宣称 Prompt QA 或图片 QA 已通过；所有卡片的 promptQaDecision 必须保持 Pending，"
                  "generationChoiceStatus 必须是 user-confirmation-required，等待用户确认后才允许图片生成。只输出结构化 JSON。")
    text=f"请根据以下故事分镜、资产总控审计和交接约束生成 Prompt 卡。\n\n输入包：{json.dumps(input_package,ensure_ascii=False)}"
    if profile["provider_type"]=="opencode":
        return await opencode_structured(profile,get_profile_secret(profile),model,instructions,text,ASSET_PROMPT_OUTPUT_SCHEMA,"FRAMEFLOW · Asset Prompts")
    return await openai_structured(profile,get_profile_secret(profile),model,instructions,text,ASSET_PROMPT_OUTPUT_SCHEMA,"frameflow_asset_prompts")

async def _run_fusion_prompt_agent(request:Request,project_id:str,input_package:dict[str,Any],provider_profile_id:str|None=None,requested_model:str|None=None)->dict[str,Any]:
    database=db(request); profile,bound=resolve_profile(database,"orchestrator",provider_profile_id); model=requested_model or bound or profile["model_config"].get("orchestrator_model")
    if not model:raise HTTPException(409,"尚未配置编排模型，无法生成融合 Prompt。")
    validate_orchestrator_model(profile,model)
    instructions=("你是 FRAMEFLOW 的 video-fusion-production-director。你只负责把已经确认连接的角色、场景、道具资产，"
                  "按指定剧本和分镜组织成一个可执行的中文融合场景 Prompt。必须严格保留输入资产身份、服装、材质、空间关系、"
                  "镜头方向、尺度、遮挡、地面接触、光线和连续性；不得凭空加入未连接资产或改变分镜动作。"
                  "输出只能是结构化 JSON。不要生成图片，不要调用图片服务，不要宣称 Prompt QA 或图片 QA 已通过。")
    text=f"请根据以下已确认连接交接包生成正式融合 Prompt。\n\n输入包：{json.dumps(input_package,ensure_ascii=False)}"
    if profile["provider_type"]=="opencode":
        return await opencode_structured(profile,get_profile_secret(profile),model,instructions,text,FUSION_PROMPT_OUTPUT_SCHEMA,"FRAMEFLOW · Fusion Prompt")
    return await openai_structured(profile,get_profile_secret(profile),model,instructions,text,FUSION_PROMPT_OUTPUT_SCHEMA,"frameflow_fusion_prompt")

def _normalise_id_list(values:Any)->list[str]:
    if not isinstance(values,list):return []
    return list(dict.fromkeys(str(value).strip() for value in values if str(value).strip()))

def _story_snapshot_hash(doc:dict[str,Any],shot_id:str)->str:
    shot=next((item for item in doc.get("shots",[]) if isinstance(item,dict) and str(item.get("id"))==shot_id),{})
    payload={"brief":doc.get("brief",""),"script":doc.get("script",""),"scenes":doc.get("scenes") or [],"shot":shot}
    return hashlib.sha256(json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode("utf-8")).hexdigest()

def _fusion_shot_candidates(asset:dict[str,Any],doc:dict[str,Any])->list[str]:
    values=[]
    values.extend(_normalise_id_list(asset.get("promptRelevantShots")))
    values.extend(str(item.get("shot_id") or item.get("shotId") or "") for item in (asset.get("shotDependencies") or []) if isinstance(item,dict))
    values.extend(str(item.get("shot_id") or item.get("shotId") or "") for item in (_asset_metadata(asset).get("shot_dependencies") or []) if isinstance(item,dict))
    values.extend(re.findall(r"SH\d{1,3}",str(asset.get("id") or ""),flags=re.IGNORECASE))
    values.extend(re.findall(r"SH\d{1,3}",str(asset.get("name") or ""),flags=re.IGNORECASE))
    values.extend(re.findall(r"SH\d{1,3}",str(asset.get("note") or ""),flags=re.IGNORECASE))
    known={str(item.get("id")) for item in doc.get("shots",[]) if isinstance(item,dict) and item.get("id")}
    result=[]
    for value in values:
        normalised=str(value).upper()
        if normalised in known and normalised not in result:result.append(normalised)
    return result

def _fusion_plan_for_asset(doc:dict[str,Any],asset:dict[str,Any],regulator_output:dict[str,Any]|None=None,plan_hint:dict[str,Any]|None=None)->dict[str,Any]:
    asset_id=str(asset.get("id") or "")
    shot_ids=_fusion_shot_candidates(asset,doc)
    requirements=[item for item in (regulator_output or {}).get("assetRequirements",[]) if isinstance(item,dict)]
    candidates=[]
    explicit=_asset_metadata(asset).get("fusion_source_asset_ids") or _asset_metadata(asset).get("fusionSourceAssetIds") or asset.get("fusionSourceAssetIds") or []
    candidates.extend(str(value) for value in explicit if str(value).strip())
    candidates.extend(re.findall(r"\b(?:C|S|P)\d{1,3}\b",str(asset.get("note") or ""),flags=re.IGNORECASE))
    for requirement in requirements:
        if str(requirement.get("shotId") or requirement.get("shot_id") or "").upper() in shot_ids:
            candidate_id=str(requirement.get("assetId") or requirement.get("asset_id") or "")
            if candidate_id and candidate_id!=asset_id:candidates.append(candidate_id)
    known_assets={str(item.get("id")):item for item in doc.get("assets",[]) if isinstance(item,dict) and item.get("id")}
    source_ids=[]
    for candidate in candidates:
        candidate=str(candidate).strip()
        if candidate in known_assets and candidate not in source_ids and _asset_class(known_assets[candidate])!="fusion":source_ids.append(candidate)
    shot_id=shot_ids[0] if shot_ids else ""
    shot=next((item for item in doc.get("shots",[]) if isinstance(item,dict) and str(item.get("id"))==shot_id),{})
    role_labels={"character":"角色","scene":"环境","prop":"道具","product":"道具","style":"风格"}
    roles=[]
    for source_id in source_ids:
        source=known_assets[source_id]; label=role_labels.get(_asset_class(source),_asset_class(source) or "资产")
        if label not in roles:roles.append(label)
    plan={
        "fusion_asset_id":asset_id,
        "shot_id":shot_id,
        "candidate_source_asset_ids":source_ids,
        "shot_intent":str(shot.get("purpose") or shot.get("action") or asset.get("note") or "等待指定镜头目标"),
        "required_roles":roles,
        "continuity_constraints":[value for value in [shot.get("camera"),shot.get("action"),shot.get("scene")] if value],
        "status":"awaiting_connection",
    }
    if isinstance(plan_hint,dict):
        aliases={
            "shot_id":("shot_id","shotId"),
            "candidate_source_asset_ids":("candidate_source_asset_ids","candidateSourceAssetIds"),
            "shot_intent":("shot_intent","shotIntent"),
            "required_roles":("required_roles","requiredRoles"),
            "continuity_constraints":("continuity_constraints","continuityConstraints"),
            "status":("status",),
        }
        for key,keys in aliases.items():
            value=next((plan_hint[candidate] for candidate in keys if plan_hint.get(candidate) is not None),None)
            if value is not None:plan[key]=value
    return plan

def _asset_board_connection_ids(database:Database,project_id:str,fusion_asset_id:str)->tuple[int,list[str]]:
    current=_ensure_asset_board(database,project_id)
    board=current.get("board") or {}; nodes={str(node.get("id")):node for node in board.get("nodes",[]) if isinstance(node,dict)}
    source_ids=[]
    for edge in board.get("edges",[]):
        if not isinstance(edge,dict) or edge.get("relation")!="fusion_input":continue
        source=nodes.get(str(edge.get("source"))); target=nodes.get(str(edge.get("target")))
        if target and str(target.get("asset_id") or "")==fusion_asset_id and source and source.get("asset_id"):source_ids.append(str(source["asset_id"]))
    return int(current["revision"]),list(dict.fromkeys(source_ids))

def _fusion_input_fingerprint(doc:dict[str,Any],fusion_asset_id:str,shot_id:str,source_ids:list[str],board_revision:int)->str:
    assets={str(item.get("id")):item for item in doc.get("assets",[]) if isinstance(item,dict) and item.get("id")}
    source_versions={source_id:str(assets.get(source_id,{}).get("promptVersion") or "") for source_id in sorted(source_ids)}
    payload={"fusion_asset_id":fusion_asset_id,"shot_id":shot_id,"source_asset_ids":sorted(source_ids),"source_prompt_versions":source_versions,"story_snapshot":_story_snapshot_hash(doc,shot_id),"board_revision":board_revision}
    return hashlib.sha256(json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode("utf-8")).hexdigest()

def _fusion_prompt_state(database:Database,project_id:str,doc:dict[str,Any],asset:dict[str,Any])->dict[str,Any]:
    if _asset_class(asset)!="fusion":return {}
    run=asset.get("fusionPromptRun") if isinstance(asset.get("fusionPromptRun"),dict) else {}
    if not run or str(asset.get("fusionPromptSource") or "")!="fusion-connection-agent":
        return {"fusionPromptState":"awaiting_connection","fusionPromptStale":False,"fusionPromptStaleReason":None}
    shot_id=str(run.get("shot_id") or "")
    board_revision,current_sources=_asset_board_connection_ids(database,project_id,str(asset.get("id")))
    source_ids=_normalise_id_list(asset.get("fusionSourceAssetIds") or run.get("source_asset_ids"))
    current_fingerprint=_fusion_input_fingerprint(doc,str(asset.get("id")),shot_id,current_sources,board_revision)
    stale=[]
    if sorted(source_ids)!=sorted(current_sources):stale.append("融合连线已变化")
    if str(run.get("input_fingerprint") or "")!=current_fingerprint:stale.append("输入资产、剧本/分镜或画布版本已变化")
    return {"fusionPromptState":"stale" if stale else str(asset.get("fusionPromptState") or "prompt_draft_ready"),"fusionPromptStale":bool(stale),"fusionPromptStaleReason":"；".join(stale) if stale else None}

def _validate_asset_prompt_output(result:dict[str,Any],allowed_ids:set[str],expected_ids:set[str]|None=None,shot_ids:set[str]|None=None)->list[str]:
    issues=[]; cards=result.get("assets")
    if not isinstance(cards,list):return ["assets 必须是数组"]
    expected_ids=expected_ids or set()
    shot_ids=shot_ids or set()
    seen:set[str]=set()
    for card in cards:
        if not isinstance(card,dict):issues.append("资产 Prompt 卡必须是对象"); continue
        asset_id=str(card.get("id") or "")
        if str(card.get("assetClass") or "").lower()=="fusion":
            # A fusion card in the provider response is tolerated for
            # backwards-compatible providers, but it is never promoted to a
            # production Prompt by the initial full-project run.
            continue
        if not asset_id or asset_id not in allowed_ids:issues.append(f"资产 Prompt 卡引用了未知资产 {asset_id or '<empty>'}")
        if asset_id in seen:issues.append(f"资产 Prompt 卡重复 {asset_id}")
        seen.add(asset_id)
        if not str(card.get("prompt") or "").strip():issues.append(f"资产 {asset_id} 的 Prompt 为空")
        if not isinstance(card.get("promptPack"),dict):issues.append(f"资产 {asset_id} 的 promptPack 必须是对象")
        if not isinstance(card.get("relevantShots"),list):issues.append(f"资产 {asset_id} 的 relevantShots 必须是数组")
        else:
            unknown_shots=[str(shot_id) for shot_id in card.get("relevantShots",[]) if str(shot_id) not in shot_ids]
            if unknown_shots:issues.append(f"资产 {asset_id} 的 relevantShots 引用了未知镜头：{'、'.join(unknown_shots)}")
    missing=sorted(expected_ids-seen)
    if missing:issues.append(f"资产 Prompt 卡不完整，缺少：{'、'.join(missing)}")
    return issues

def _sync_asset_board_after_document(database:Database,project_id:str,doc:dict[str,Any],project_revision:int)->dict[str,Any]:
    current=_ensure_asset_board(database,project_id)
    board=_validate_asset_board(_asset_board_from_document(database,project_id,doc,project_revision,current.get("board") or {}))
    revision=int(current["revision"])+1; now=utcnow()
    with database.connect() as connection:
        connection.execute("UPDATE asset_boards_v7 SET revision=?,board_json=?,updated_at=? WHERE project_id=?",(revision,database.encode(board),now,project_id))
        row=connection.execute("SELECT * FROM asset_boards_v7 WHERE project_id=?",(project_id,)).fetchone()
    return _asset_board_payload(database,project_id,row)

def _story_version_id(kind:str,project_id:str,n:int)->str:
    prefix={"script":"SCRIPT","storyboard":"STORYBOARD","regulator":"REGULATOR"}.get(kind,kind.upper())
    return f"{prefix}_{project_id[:6].upper()}_v{n:03d}"

@app.post("/api/v2/projects/{project_id}/asset-prompt-runs")
async def generate_asset_prompts(project_id:str,body:AssetPromptRunCreate,request:Request):
    database=db(request); doc,revision=await read_project_doc(request,project_id)
    if body.expected_revision is not None and revision!=body.expected_revision:
        raise HTTPException(409,{"message":"故事或资产已有更新，请刷新后重试。","current_revision":revision})
    shots=[item for item in doc.get("shots",[]) if isinstance(item,dict) and item.get("id")]
    if not shots:raise HTTPException(409,"故事分镜尚未准备就绪，至少需要一个镜头。")
    existing_assets=[item for item in doc.get("assets",[]) if isinstance(item,dict) and item.get("id")]
    target_asset_id=str(body.target_asset_id or "").strip()
    target_asset=next((item for item in existing_assets if str(item.get("id"))==target_asset_id),None) if target_asset_id else None
    if target_asset_id and target_asset is None:raise HTTPException(404,"目标资产不存在。")
    if target_asset is not None and _asset_class(target_asset)=="fusion":raise HTTPException(409,"融合资产必须通过实际连线后的融合 Prompt 流程生成。")
    input_package={
        "project_id":project_id,
        "project_name":doc.get("name"),
        "project_brief":doc.get("brief",""),
        "story_spec":doc.get("storySpec") or {},
        "script":doc.get("script",""),
        "scenes":doc.get("scenes") or [],
        "shots":shots,
        "existing_assets":existing_assets,
        "existing_asset_ids":[str(item["id"]) for item in existing_assets],
        "aspect_ratio":doc.get("ratio","9:16"),
        "duration":doc.get("duration",30),
        "target_generator":doc.get("generator","Seedance 2.5"),
        "workflow_constraint":"先完成 video-asset-regulator 审计，再按 domain skill 生成 Prompt 卡；Prompt QA 和图片生成都必须等待用户确认。",
    }
    if target_asset_id:
        input_package["target_asset_id"]=target_asset_id
        input_package["workflow_constraint"] += " 本次只为指定目标资产生成 Prompt 草稿，不修改其他资产的 Prompt。"
    regulator_output=await _run_regulator_agent(request,project_id,input_package)
    regulator_issues=_validate_regulator_output(regulator_output)
    if regulator_issues:raise HTTPException(502,{"message":"资产总控返回未通过结构校验。","issues":regulator_issues})
    raw_extraction=[item for item in regulator_output.get("assetExtraction",[]) if isinstance(item,dict) and item.get("id")]
    raw_requirements=[item for item in regulator_output.get("assetRequirements",[]) if isinstance(item,dict) and item.get("assetId")]
    extraction=[item for item in raw_extraction if not target_asset_id or str(item.get("id"))==target_asset_id]
    scoped_requirements=[item for item in raw_requirements if not target_asset_id or str(item.get("assetId"))==target_asset_id]
    requirement_ids=[str(item.get("assetId")) for item in scoped_requirements]
    allowed_ids={str(item["id"]) for item in existing_assets}|{str(item["id"]) for item in extraction}|set(requirement_ids)
    scoped_regulator_output={**regulator_output,"assetExtraction":extraction,"assetRequirements":scoped_requirements}
    prompt_input={**input_package,"regulator_output":scoped_regulator_output,"allowed_asset_ids":sorted(allowed_ids)}
    prompt_output=await _run_asset_prompt_agent(request,project_id,prompt_input)
    # Do not retain provider-generated fusion cards from the initial run,
    # even when an older provider ignores the two-stage instruction. The
    # initial run's persisted output is part of the audit trail as well.
    prompt_cards=[card for card in prompt_output.get("assets",[]) if isinstance(card,dict) and str(card.get("assetClass") or "").lower()!="fusion"]
    if target_asset_id:
        prompt_cards=[card for card in prompt_cards if str(card.get("id") or "")==target_asset_id]
        if not prompt_cards:raise HTTPException(502,"AI 未返回目标资产的 Prompt 草稿，请重试。")
    prompt_output={**prompt_output,"assets":prompt_cards}
    # Fusion assets are intentionally excluded from the initial production
    # Prompt set. They receive a planning card below and can only get a final
    # Prompt after the user confirms real asset-board connections.
    fusion_ids={str(item.get("id")) for item in existing_assets if _asset_class(item)=="fusion"}
    fusion_ids.update(str(item["id"]) for item in extraction if str(item.get("assetClass") or item.get("class") or "").lower()=="fusion")
    fusion_ids.update(str(item.get("assetId")) for item in scoped_requirements if str(item.get("assetClass") or "").lower()=="fusion" and item.get("assetId"))
    expected_prompt_ids={target_asset_id} if target_asset_id else {str(item["id"]) for item in extraction if str(item["id"]) not in fusion_ids}
    if not target_asset_id:
        expected_prompt_ids.update(str(value) for value in requirement_ids if str(value) not in fusion_ids)
    shot_ids={str(item["id"]) for item in shots}
    prompt_issues=_validate_asset_prompt_output(prompt_output,allowed_ids,expected_prompt_ids,shot_ids)
    if prompt_issues:raise HTTPException(502,{"message":"资产 Prompt 返回未通过结构校验。","issues":prompt_issues})
    assets_by_id={str(item["id"]):item for item in existing_assets}
    class_skill={"character":"character","scene":"scene","prop":"prop","fusion":"fusion","product":"product","style":"style","audio":"audio","music":"music","sfx":"sfx"}
    for item in extraction:
        asset_id=str(item["id"]); cls=str(item.get("assetClass") or item.get("class") or "unknown").lower()
        asset=assets_by_id.get(asset_id)
        if asset is None:
            asset={"id":asset_id,"name":item.get("name") or asset_id,"type":asset_audit.CLASS_TYPE_LABEL.get(cls,cls),"grade":item.get("grade") or item.get("priority") or "B","status":"missing","note":item.get("role") or "","skill":class_skill.get(cls,cls)}
            assets_by_id[asset_id]=asset
        else:
            asset.setdefault("name",item.get("name") or asset_id)
            if item.get("assetClass") or item.get("class"):asset["assetClass"]=cls
            if item.get("priority") and not asset.get("grade"):asset["grade"]=item["priority"]
            if item.get("role") and not asset.get("note"):asset["note"]=item["role"]
    for requirement in scoped_requirements:
        if not isinstance(requirement,dict) or not requirement.get("assetId"):continue
        asset_id=str(requirement["assetId"])
        if asset_id in assets_by_id:continue
        cls=str(requirement.get("assetClass") or "unknown").lower()
        assets_by_id[asset_id]={"id":asset_id,"name":asset_id,"type":asset_audit.CLASS_TYPE_LABEL.get(cls,cls),"assetClass":cls,"grade":requirement.get("priority") or "B","status":"missing","note":requirement.get("role") or "","skill":class_skill.get(cls,cls)}
    req_map:dict[str,list[dict[str,Any]]]={}
    for requirement in scoped_requirements:
        if not isinstance(requirement,dict):continue
        req_map.setdefault(str(requirement.get("shotId")),[]).append({"assetId":str(requirement.get("assetId")),"assetClass":requirement.get("assetClass"),"role":requirement.get("role",""),"priority":requirement.get("priority","B"),"required":requirement.get("required",True),"requiredReadiness":requirement.get("requiredReadiness","production"),"source":"video-asset-regulator"})
    if target_asset_id:
        for shot in shots:
            existing_requirements=[item for item in shot.get("assetRequirements",[]) if isinstance(item,dict) and str(item.get("assetId") or item.get("asset_id") or "")!=target_asset_id]
            shot["assetRequirements"]=existing_requirements+req_map.get(str(shot.get("id")),[])
    else:
        for shot in shots:shot["assetRequirements"]=req_map.get(str(shot.get("id")),[])
    enriched_cards=[]
    visual_classes={"character","scene","prop","fusion","product","style"}
    for card in prompt_output.get("assets",[]):
        asset_id=str(card["id"]); asset=assets_by_id.get(asset_id)
        if asset is None:continue
        cls=str(card.get("assetClass") or _asset_class(asset) or "unknown").lower(); prompt=str(card.get("prompt") or "").strip()
        if cls=="fusion":continue
        target_skill=str(card.get("targetSkill") or _asset_prompt_skill(cls))
        if target_asset_id:
            # A targeted AI request is an editor suggestion only. Keep the
            # generated text in the run payload so the client can place it in
            # the right-side editor; the user must explicitly save it before a
            # Prompt version or QA state is created.
            enriched_cards.append({**card,"assetClass":cls,"targetSkill":target_skill,"promptVersion":asset.get("promptVersion"),"promptQaDecision":asset.get("promptQaDecision") or "Pending","generationChoiceStatus":"user-confirmation-required","generationStatus":asset.get("generationStatus") or "planned","imageGenerationEligible":bool(card.get("imageGenerationEligible",cls in visual_classes))})
            continue
        prompt_version=asset_audit.create_prompt_version(database,project_id,asset_id,cls,prompt,"asset-prompt-generator",target_skill,parent_version=None,change_reason="故事分镜就绪后由资产总控生成 Prompt 卡")
        shots_for_card=[str(value) for value in card.get("relevantShots",[]) if value]
        asset.update({"assetClass":cls,"assetRole":asset.get("assetRole") or card.get("role") or cls,"prompt":prompt,"promptVersion":prompt_version["id"],"promptPack":card.get("promptPack") or {},"promptTargetSkill":target_skill,"promptQaDecision":"Pending","generationChoice":"user-confirmation-required","generationChoiceStatus":"user-confirmation-required","generationStatus":"planned","promptStatus":"prompt-draft","promptRelevantShots":shots_for_card,"mustPreserve":[str(value) for value in card.get("mustPreserve",[]) if value],"mustAvoid":[str(value) for value in card.get("mustAvoid",[]) if value],"imageGenerationEligible":bool(card.get("imageGenerationEligible",cls in visual_classes))})
        enriched_cards.append({**card,"assetClass":cls,"targetSkill":target_skill,"promptVersion":prompt_version["id"],"promptQaDecision":"Pending","generationChoiceStatus":"user-confirmation-required","generationStatus":"planned","imageGenerationEligible":asset["imageGenerationEligible"]})
    fusion_plans=[]
    prompt_plan_hints={str(item.get("fusionAssetId") or item.get("fusion_asset_id")):item for item in prompt_output.get("fusionPlans",[]) if isinstance(item,dict) and (item.get("fusionAssetId") or item.get("fusion_asset_id"))}
    for asset in ([] if target_asset_id else assets_by_id.values()):
        if _asset_class(asset)!="fusion":continue
        asset_id=str(asset.get("id")); existing_source=str(asset.get("fusionPromptSource") or "")
        plan=_fusion_plan_for_asset(doc,asset,regulator_output,prompt_plan_hints.get(asset_id))
        asset["fusionPlan"]=plan
        if existing_source!="fusion-connection-agent":
            if asset.get("prompt"):
                asset["fusionPromptAuthority"]="historical"
                asset["fusionPromptSource"]="legacy-initial"
            asset["fusionPromptState"]="awaiting_connection"
            asset["fusionPromptQaAllowed"]=False
            asset["fusionPromptGenerationAllowed"]=False
        fusion_plans.append(plan)
    doc["assets"]=list(assets_by_id.values())
    missing_a=[str(asset["id"]) for asset in doc["assets"] if str(asset.get("grade","")) in {"A","A+"} and not asset_audit.asset_readiness(asset).get("ready")]
    run_id=asset_audit.new_id("ASSETPROMPT")
    now=utcnow(); doc.setdefault("assetPromptRuns",[]).append({"id":run_id,"status":"prompt_drafts_ready","createdAt":now,"regulatorOutput":regulator_output,"promptOutput":prompt_output,"promptCards":enriched_cards,"fusionPlans":fusion_plans,"missingAssetRegister":prompt_output.get("missingAssetRegister",[]),"dependencyTable":prompt_output.get("dependencyTable",[]),"routingPlan":prompt_output.get("routingPlan",[]),"nextActions":prompt_output.get("nextActions",[])})
    doc["assetRegulator"]={**(doc.get("assetRegulator") if isinstance(doc.get("assetRegulator"),dict) else {}),"version":3,"status":"prompt_drafts_ready","promptRunId":run_id,"auditedAt":now,"missingA":missing_a,"promptQaRequired":True,"generationConfirmationRequired":True,"fusionPlans":fusion_plans,"missingAssetRegister":prompt_output.get("missingAssetRegister",[]),"dependencyTable":prompt_output.get("dependencyTable",[]),"routingPlan":prompt_output.get("routingPlan",[])}
    new_revision=save_project_document(request,doc,revision)
    board=_sync_asset_board_after_document(database,project_id,doc,new_revision)
    return {"project_id":project_id,"revision":new_revision,"run":{"id":run_id,"status":"prompt_drafts_ready","regulatorOutput":regulator_output,"promptOutput":prompt_output,"promptCards":enriched_cards,"fusionPlans":fusion_plans,"missingA":missing_a},"story": {"project_id":project_id,"revision":new_revision,"story":story_document(doc),"checks":story_checks(doc)},"library":_library_payload(database,project_id,doc),"asset_board":board}

@app.post("/api/v2/projects/{project_id}/fusion-prompt-runs")
async def generate_fusion_prompt(project_id:str,body:FusionPromptRunCreate,request:Request):
    database=db(request)
    if not body.confirmed:raise HTTPException(409,"融合 Prompt 生成必须先确认资产连线。")
    doc,project_revision=await read_project_doc(request,project_id)
    if project_revision!=body.expected_project_revision:
        raise HTTPException(409,{"message":"项目或故事已有更新，请刷新后重试。","current_revision":project_revision})
    fusion_asset=_project_asset(doc,body.fusion_asset_id)
    if _asset_class(fusion_asset)!="fusion":raise HTTPException(422,"目标资产必须是融合资产。")
    source_ids=[str(value).strip() for value in body.source_asset_ids]
    if len(source_ids)!=len(set(source_ids)):raise HTTPException(422,"融合输入资产不能重复。")
    if len(source_ids)<2:raise HTTPException(422,"至少需要连接两个基础资产。")
    shot_id=str(body.shot_id).upper()
    shot=next((item for item in doc.get("shots",[]) if isinstance(item,dict) and str(item.get("id") or "").upper()==shot_id),None)
    if shot is None:raise HTTPException(422,f"指定镜头 {shot_id} 不存在。")
    assets_by_id={str(item.get("id")):item for item in doc.get("assets",[]) if isinstance(item,dict) and item.get("id")}
    unknown=[asset_id for asset_id in source_ids if asset_id not in assets_by_id]
    if unknown:raise HTTPException(422,{"message":"存在未知的融合输入资产。","unknown_asset_ids":unknown})
    fusion_sources=[assets_by_id[asset_id] for asset_id in source_ids]
    fusion_sources_classes=[_asset_class(asset) for asset in fusion_sources]
    if any(asset_class=="fusion" for asset_class in fusion_sources_classes):raise HTTPException(422,"融合资产不能作为另一融合资产的直接输入。")
    readiness={asset_id:asset_audit.asset_readiness(assets_by_id[asset_id]) for asset_id in source_ids}
    blocked={asset_id:report for asset_id,report in readiness.items() if not report.get("production_ready")}
    if blocked:raise HTTPException(409,{"message":"所有连接资产必须达到 production_ready。","blocked_sources":blocked})
    board_revision,connected_ids=_asset_board_connection_ids(database,project_id,body.fusion_asset_id)
    if board_revision!=body.expected_board_revision:
        raise HTTPException(409,{"message":"资产画布已有更新，请刷新后重试。","current_revision":board_revision})
    if sorted(connected_ids)!=sorted(source_ids):
        raise HTTPException(409,{"message":"确认的输入资产与画布实际融合连线不一致，请先保存画布后重试。","connected_asset_ids":connected_ids,"requested_asset_ids":source_ids})
    plan=_fusion_plan_for_asset(doc,fusion_asset)
    plan["shot_id"]=shot_id; plan["candidate_source_asset_ids"]=source_ids; plan["status"]="confirmed"
    source_prompt_versions={asset_id:str(assets_by_id[asset_id].get("promptVersion") or "") for asset_id in source_ids}
    input_fingerprint=_fusion_input_fingerprint(doc,body.fusion_asset_id,shot_id,source_ids,board_revision)
    # Saving the updated project synchronises the asset board once. Persist
    # the lineage against that final revision so the freshly generated
    # version is not immediately considered stale, while later board edits
    # still invalidate it strictly by revision.
    persisted_board_revision=board_revision+1
    persisted_input_fingerprint=_fusion_input_fingerprint(doc,body.fusion_asset_id,shot_id,source_ids,persisted_board_revision)
    input_package={
        "project_id":project_id,
        "project_name":doc.get("name"),
        "project_brief":doc.get("brief",""),
        "story_spec":doc.get("storySpec") or {},
        "script":doc.get("script",""),
        "scenes":doc.get("scenes") or [],
        "shot":shot,
        "target_fusion_asset":{**fusion_asset,"fusion_plan":plan},
        "connected_assets":[{
            "id":asset_id,
            "name":assets_by_id[asset_id].get("name"),
            "asset_class":_asset_class(assets_by_id[asset_id]),
            "prompt":assets_by_id[asset_id].get("prompt") or "",
            "prompt_version":source_prompt_versions[asset_id],
            "prompt_pack":assets_by_id[asset_id].get("promptPack") or {},
            "asset_spec":assets_by_id[asset_id].get("assetSpec") or _asset_metadata(assets_by_id[asset_id]).get("asset_spec") or {},
            "identity_anchors":assets_by_id[asset_id].get("identityAnchors") or _asset_metadata(assets_by_id[asset_id]).get("identity_anchors") or {},
            "must_preserve":assets_by_id[asset_id].get("mustPreserve") or _asset_metadata(assets_by_id[asset_id]).get("must_preserve") or [],
            "must_avoid":assets_by_id[asset_id].get("mustAvoid") or _asset_metadata(assets_by_id[asset_id]).get("must_avoid") or [],
            "readiness":readiness[asset_id],
        } for asset_id in source_ids],
        "connection":{
            "fusion_asset_id":body.fusion_asset_id,
            "source_asset_ids":source_ids,
            "board_revision":board_revision,
            "input_fingerprint":input_fingerprint,
        },
        "aspect_ratio":doc.get("ratio","16:9"),
        "target_generator":doc.get("generator","Seedance 2.5"),
    }
    result=await _run_fusion_prompt_agent(request,project_id,input_package,body.provider_profile_id,body.model)
    result_asset_id=str(result.get("fusionAssetId") or result.get("fusion_asset_id") or "")
    result_shot_id=str(result.get("shotId") or result.get("shot_id") or "").upper()
    result_sources=_normalise_id_list(result.get("sourceAssetIds") or result.get("source_asset_ids"))
    issues=[]
    if result_asset_id!=body.fusion_asset_id:issues.append("AI 返回的融合资产 ID 与请求不一致")
    if result_shot_id!=shot_id:issues.append("AI 返回的镜头 ID 与请求不一致")
    if sorted(result_sources)!=sorted(source_ids):issues.append("AI 返回的输入资产与已确认连线不一致")
    if not str(result.get("prompt") or "").strip():issues.append("AI 返回的融合 Prompt 为空")
    if issues:raise HTTPException(502,{"message":"融合 Prompt 返回未通过结构校验。","issues":issues})
    prompt=str(result["prompt"]).strip(); now=utcnow(); run_id=asset_audit.new_id("FUSIONPROMPT")
    latest=asset_audit.get_prompt_version(database,None,project_id,body.fusion_asset_id)
    prompt_version=asset_audit.create_prompt_version(database,project_id,body.fusion_asset_id,"fusion",prompt,"fusion-connection-agent","video-fusion-production-director",parent_version=int(latest["version"]) if latest else None,change_reason="用户确认融合连线后按剧本与分镜生成正式融合 Prompt")
    metadata={**_asset_metadata(fusion_asset),"fusion_source_asset_ids":source_ids,"fusion_shot_id":shot_id,"fusion_input_fingerprint":persisted_input_fingerprint,"fusion_board_revision":persisted_board_revision}
    fusion_asset.update({
        "assetClass":"fusion","assetMetadata":metadata,"fusionSourceAssetIds":source_ids,"fusionPlan":plan,
        "fusionPromptSource":"fusion-connection-agent","fusionPromptAuthority":"production",
        "fusionPromptState":"prompt_draft_ready","fusionPromptQaAllowed":True,"fusionPromptGenerationAllowed":False,
        "fusionPromptRun":{"id":run_id,"status":"prompt_draft_ready","created_at":now,"shot_id":shot_id,"source_asset_ids":source_ids,"source_prompt_versions":source_prompt_versions,"story_snapshot_hash":_story_snapshot_hash(doc,shot_id),"project_revision":project_revision,"story_revision":project_revision,"board_revision":persisted_board_revision,"input_fingerprint":persisted_input_fingerprint},
        "prompt":prompt,"promptVersion":prompt_version["id"],"promptPack":result.get("promptPack") or {},"promptTargetSkill":"video-fusion-production-director","promptRelevantShots":[shot_id],
        "promptQaDecision":"Pending","generationChoice":"user-confirmation-required","generationChoiceStatus":"user-confirmation-required","generationStatus":"planned","promptStatus":"prompt-draft","mustPreserve":[str(value) for value in result.get("mustPreserve",[]) if value],"mustAvoid":[str(value) for value in result.get("mustAvoid",[]) if value],"imageGenerationEligible":True,
    })
    doc.setdefault("fusionPromptRuns",[]).append({"id":run_id,"status":"prompt_draft_ready","createdAt":now,"fusionAssetId":body.fusion_asset_id,"shotId":shot_id,"sourceAssetIds":source_ids,"sourcePromptVersions":source_prompt_versions,"projectRevision":project_revision,"storyRevision":project_revision,"boardRevision":persisted_board_revision,"inputFingerprint":persisted_input_fingerprint,"promptVersion":prompt_version["id"],"warnings":[str(value) for value in result.get("warnings",[]) if value]})
    new_revision=save_project_document(request,doc,project_revision)
    asset_audit.record_event(database,project_id,None,body.fusion_asset_id,"awaiting_connection","prompt_draft_ready",{"run_id":run_id,"prompt_version":prompt_version["id"],"source_asset_ids":source_ids,"shot_id":shot_id,"board_revision":persisted_board_revision,"input_fingerprint":persisted_input_fingerprint})
    board=_sync_asset_board_after_document(database,project_id,doc,new_revision)
    return {"project_id":project_id,"revision":new_revision,"board_revision":board["revision"],"run":{"id":run_id,"status":"prompt_draft_ready","fusion_asset_id":body.fusion_asset_id,"shot_id":shot_id,"source_asset_ids":source_ids,"source_prompt_versions":source_prompt_versions,"project_revision":project_revision,"story_revision":project_revision,"board_revision":persisted_board_revision,"input_fingerprint":persisted_input_fingerprint,"warnings":result.get("warnings",[])},"prompt_version":prompt_version,"fusion_asset":next((item for item in _library_payload(database,project_id,doc)["assets"] if item["id"]==body.fusion_asset_id),None),"library":_library_payload(database,project_id,doc),"asset_board":board}

@app.post("/api/v2/projects/{project_id}/story/runs")
@app.post("/api/projects/{project_id}/story-optimization-runs")
async def create_story_run(project_id:str,body:StoryOptimizationCreate,request:Request):
    database=db(request); doc,rev=await read_project_doc(request,project_id)
    # Immutable source snapshot of the current script.
    n=len(doc.get("scriptVersions",[]))+1; sid=_story_version_id("script",project_id,n); now=utcnow()
    doc.setdefault("scriptVersions",[]).append({"id":sid,"parentId":doc["scriptVersions"][-1]["id"] if doc["scriptVersions"] else None,"status":"active" if n==1 else "candidate","text":doc.get("script",""),"source":"user","skillId":None,"providerProfileId":None,"model":None,"createdAt":now,"acceptedAt":None})
    save_project_document(request,doc,rev)
    rid=asset_audit.new_id("STORYRUN")
    with database.connect() as c:
        c.execute("INSERT INTO story_workflow_chains(id,project_id,source_script_version_id,active_step,status,input_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",(rid,project_id,sid,"draft","draft",database.encode(_storyboard_input_package(doc,body)),now,now))
    return {"id":rid,"project_id":project_id,"status":"draft","active_step":"draft"}

@app.get("/api/v2/projects/{project_id}/story/runs")
@app.get("/api/projects/{project_id}/story-optimization-runs")
async def list_story_runs(project_id:str,request:Request):
    with db(request).connect() as c:rows=c.execute("SELECT * FROM story_workflow_chains WHERE project_id=? ORDER BY created_at DESC",(project_id,)).fetchall()
    return {"runs":[story_chain_payload(db(request),r) for r in rows]}

def story_chain_payload(database:Database,row:Any)->dict[str,Any]:
    return {"id":row["id"],"project_id":row["project_id"],"source_script_version_id":row["source_script_version_id"],"storyboard_run_id":row["storyboard_run_id"],"regulator_run_id":row["regulator_run_id"],"active_step":row["active_step"],"status":row["status"],"provider_profile_id":row["provider_profile_id"],"provider_model":row["provider_model"],"input":database.decode(row["input_json"],{}),"storyboard_output":database.decode(row["storyboard_output_json"]),"regulator_output":database.decode(row["regulator_output_json"]),"error":database.decode(row["error_json"]),"created_at":row["created_at"],"updated_at":row["updated_at"]}

@app.get("/api/v2/story-runs/{run_id}")
@app.get("/api/story-optimization-runs/{run_id}")
async def get_story_run(run_id:str,request:Request):
    with db(request).connect() as c:row=c.execute("SELECT * FROM story_workflow_chains WHERE id=?",(run_id,)).fetchone()
    if not row:raise HTTPException(404,"脚本优化运行不存在。")
    return {"run":story_chain_payload(db(request),row)}

def _set_chain(database:Database,run_id:str,**fields)->None:
    sets=",".join(f"{k}=?" for k in fields); params=list(fields.values()); params.append(utcnow())
    with database.connect() as c:c.execute(f"UPDATE story_workflow_chains SET {sets},updated_at=? WHERE id=?",(*params,run_id))

@app.post("/api/v2/story-runs/{run_id}/start")
@app.post("/api/story-optimization-runs/{run_id}/start")
async def start_story_run(run_id:str,request:Request):
    database=db(request)
    with database.connect() as c:row=c.execute("SELECT * FROM story_workflow_chains WHERE id=?",(run_id,)).fetchone()
    if not row:raise HTTPException(404,"脚本优化运行不存在。")
    if row["status"]!="draft":raise HTTPException(409,"运行不处于 draft 状态。")
    project_id=row["project_id"]; _set_chain(database,run_id,active_step="running_storyboard",status="running_storyboard")
    try:
        result=await _run_storyboard_agent(request,project_id,database.decode(row["input_json"],{}))
        issues=_validate_storyboard_output(result)
        if issues:
            raise ProviderError("结构化输出不合法："+"; ".join(issues),"validation",422)
        _set_chain(database,run_id,active_step="storyboard_review_required",status="storyboard_review_required",storyboard_output_json=database.encode(result),storyboard_run_id=asset_audit.new_id("RUN"),provider_profile_id=result.get("model"))
    except Exception as exc:
        client_status,kind,retryable,error_json=classify_failure(exc)
        _set_chain(database,run_id,active_step="failed",status="failed",error_json=database.encode(error_json))
        return structured_error(client_status,"storyboard_failed",kind,f"脚本优化失败：{exc}",{"stage":"storyboard"},retryable=retryable)
    return {"run":story_chain_payload(database,_chain_row(database,run_id))}

def _chain_row(database:Database,run_id:str):
    with database.connect() as c:row=c.execute("SELECT * FROM story_workflow_chains WHERE id=?",(run_id,)).fetchone()
    return row

@app.post("/api/v2/story-runs/{run_id}/accept-storyboard")
@app.post("/api/story-optimization-runs/{run_id}/accept-storyboard")
async def accept_storyboard(run_id:str,body:StoryboardAcceptRequest,request:Request):
    database=db(request); row=_chain_row(database,run_id)
    if not row:raise HTTPException(404,"脚本优化运行不存在。")
    if row["status"]!="storyboard_review_required":raise HTTPException(409,"运行不处于待审阅状态。")
    output=database.decode(row["storyboard_output_json"]); project_id=row["project_id"]; doc,rev=await read_project_doc(request,project_id)
    proposed=output.get("proposedScript","")
    proposed_shots=output.get("shots",[])
    if isinstance(output.get("structure"),list) or isinstance(output.get("beats"),list):
        spec=doc.setdefault("storySpec",{})
        if isinstance(output.get("structure"),list):spec["structure"]=[item for item in output["structure"] if isinstance(item,dict)]
        if isinstance(output.get("beats"),list):spec["beats"]=[item for item in output["beats"] if isinstance(item,dict)]
    if body.scope in {"all","script_only"} and proposed:
        doc["script"]=proposed
        sv={"id":_story_version_id("script",project_id,len(doc.get("scriptVersions",[]))+1),"parentId":row["source_script_version_id"],"status":"active","text":proposed,"source":"agent","skillId":"video-script-storyboard","providerProfileId":None,"model":output.get("model"),"createdAt":utcnow(),"acceptedAt":utcnow()}
        for v in doc.get("scriptVersions",[]):v["status"]="superseded" if v.get("status")=="active" else v.get("status")
        doc.setdefault("scriptVersions",[]).append(sv)
    if body.scope in {"all","shots_only"} and proposed_shots:
        existing={s.get("id"):s for s in doc.get("shots",[])}
        chosen=body.shot_ids or [s.get("id") for s in proposed_shots]
        merged=[]
        for s in proposed_shots:
            if s.get("id") not in chosen:continue
            base=existing.get(s.get("id"),{"id":s.get("id")})
            merged.append({**base,**{k:v for k,v in s.items() if k not in ("assetRequirements",)},**{"status":base.get("status") or "ready"}})
        if body.shot_ids:
            selected_ids={s.get("id") for s in proposed_shots if s.get("id") in chosen}
            merged.extend(old for old in doc.get("shots",[]) if old.get("id") not in selected_ids)
        # Deprecate shots that disappeared instead of deleting them.
        proposed_ids={s.get("id") for s in proposed_shots if s.get("id") in chosen}
        if body.shot_ids:
            proposed_ids.update(old.get("id") for old in doc.get("shots",[]) if old.get("id") not in proposed_ids)
        for old in doc.get("shots",[]):
            if old.get("id") not in proposed_ids and old.get("id") not in [m.get("id") for m in merged]:
                merged.append({**old,"status":"deprecated"})
        doc["shots"]=merged
        if isinstance(output.get("scenes"),list) and not body.shot_ids:
            doc["scenes"]=[scene for scene in output["scenes"] if isinstance(scene,dict)]
        sbv={"id":_story_version_id("storyboard",project_id,len(doc.get("storyboardVersions",[]))+1),"parentId":row["source_script_version_id"],"scriptVersionId":doc["scriptVersions"][-1]["id"] if doc.get("scriptVersions") else None,"status":"active","shotIds":[s.get("id") for s in merged],"package":output,"createdAt":utcnow(),"acceptedAt":utcnow()}
        for v in doc.get("storyboardVersions",[]):v["status"]="superseded" if v.get("status")=="active" else v.get("status")
        doc.setdefault("storyboardVersions",[]).append(sbv)
    save_project_document(request,doc,rev)
    # Now run regulator stage.
    _set_chain(database,run_id,active_step="running_regulator",status="running_regulator")
    try:
        reg_input={"project_id":project_id,"visualized_script":doc.get("script",""),"shots":doc.get("shots",[]),"asset_handoff":output.get("assetHandoff",{}),"existing_assets":doc.get("assets",[]),"stable_shot_ids":[s.get("id") for s in doc.get("shots",[])],"existing_qa_evidence":[]}
        result=await _run_regulator_agent(request,project_id,reg_input)
        issues=_validate_regulator_output(result)
        if issues:raise ProviderError("结构化输出不合法："+"; ".join(issues),"validation",422)
        _set_chain(database,run_id,active_step="regulator_review_required",status="regulator_review_required",regulator_output_json=database.encode(result),regulator_run_id=asset_audit.new_id("RUN"))
    except Exception as exc:
        client_status,kind,retryable,error_json=classify_failure(exc)
        _set_chain(database,run_id,active_step="failed",status="failed",error_json=database.encode({**error_json,"stage":"regulator"}))
        return structured_error(client_status,"regulator_failed",kind,f"分镜已接受，但资产总控运行失败：{exc}",{"stage":"regulator"},retryable=retryable)
    return {"run":story_chain_payload(database,_chain_row(database,run_id))}

@app.post("/api/v2/story-runs/{run_id}/accept-regulator")
@app.post("/api/story-optimization-runs/{run_id}/accept-regulator")
async def accept_regulator(run_id:str,request:Request):
    database=db(request); row=_chain_row(database,run_id)
    if not row:raise HTTPException(404,"脚本优化运行不存在。")
    if row["status"]!="regulator_review_required":raise HTTPException(409,"运行不处于资产总控待审阅状态。")
    output=database.decode(row["regulator_output_json"]); project_id=row["project_id"]; doc,rev=await read_project_doc(request,project_id)
    # Apply extracted assets (create missing logical assets, keep stable IDs).
    existing={a.get("id"):a for a in doc.get("assets",[])}
    for item in output.get("assetExtraction",[]):
        if not isinstance(item,dict) or not item.get("id"):continue
        if item["id"] in existing:continue
        cls=item.get("assetClass") or item.get("class") or "unknown"
        skill={cls:"character","scene":"scene","prop":"prop","fusion":"fusion","audio":"audio"}.get(cls,"regulator")
        existing[item["id"]]={"id":item["id"],"name":item.get("name") or item["id"],"type":asset_audit.CLASS_TYPE_LABEL.get(cls,cls),"grade":item.get("priority") or item.get("grade") or "B","status":"missing","note":item.get("role") or "","skill":skill}
    doc["assets"]=list(existing.values())
    # Apply per-shot asset requirements.
    req_map={}
    for r in output.get("assetRequirements",[]):
        if not isinstance(r,dict):continue
        req_map.setdefault(r.get("shotId"),[]).append({"assetId":r.get("assetId"),"assetClass":r.get("assetClass"),"role":r.get("role",""),"priority":r.get("priority","B"),"required":r.get("required",True),"requiredReadiness":r.get("requiredReadiness","production"),"source":"video-asset-regulator"})
    for s in doc.get("shots",[]):s["assetRequirements"]=req_map.get(s.get("id"),[])
    missingA=[a["id"] for a in doc.get("assets",[]) if str(a.get("grade","")).startswith("A") and not (a.get("status") in {"ready","approved"} and (a.get("artifactId") or a.get("filePath")) and a.get("qaDecision")=="Approved" and a.get("regulatorRegistered") is True)]
    doc["assetRegulator"]={"version":2,"status":"approved" if not missingA else "draft","auditedAt":utcnow(),"missingA":missingA,"dependencyVersion":"v02"}
    doc.setdefault("storyWorkflowRuns",[]).append({"runId":run_id,"acceptedAt":utcnow(),"step":"regulator"})
    save_project_document(request,doc,rev)
    _set_chain(database,run_id,active_step="succeeded",status="succeeded")
    return {"run":story_chain_payload(database,_chain_row(database,run_id)),"missingA":missingA}

@app.post("/api/v2/story-runs/{run_id}/reject-storyboard")
@app.post("/api/story-optimization-runs/{run_id}/reject-storyboard")
async def reject_storyboard(run_id:str,request:Request):
    database=db(request); row=_chain_row(database,run_id)
    if not row:raise HTTPException(404,"脚本优化运行不存在。")
    _set_chain(database,run_id,active_step="storyboard_rejected",status="storyboard_rejected")
    return {"ok":True,"status":"storyboard_rejected"}

@app.post("/api/v2/story-runs/{run_id}/reject-regulator")
@app.post("/api/story-optimization-runs/{run_id}/reject-regulator")
async def reject_regulator(run_id:str,request:Request):
    database=db(request); row=_chain_row(database,run_id)
    if not row:raise HTTPException(404,"脚本优化运行不存在。")
    _set_chain(database,run_id,active_step="regulator_rejected",status="regulator_rejected")
    return {"ok":True,"status":"regulator_rejected"}

@app.post("/api/v2/story-runs/{run_id}/cancel")
@app.post("/api/story-optimization-runs/{run_id}/cancel")
async def cancel_story_run(run_id:str,request:Request):
    database=db(request); row=_chain_row(database,run_id)
    if not row:raise HTTPException(404,"脚本优化运行不存在。")
    _set_chain(database,run_id,active_step="canceled",status="canceled")
    return {"ok":True,"status":"canceled"}

@app.get("/api/v2/projects/{project_id}/story/versions")
@app.get("/api/projects/{project_id}/story-versions")
async def story_versions(project_id:str,request:Request):
    doc,_=await read_project_doc(request,project_id)
    return {"scriptVersions":doc.get("scriptVersions",[]),"storyboardVersions":doc.get("storyboardVersions",[])}


@app.post("/api/assistant/stream")
async def assistant(body:AssistantRequest,request:Request):
    database=db(request); pdata=await read_project(body.project_id,request); graph=ensure_graph(database,body.project_id); profile,bound=resolve_profile(database,"orchestrator"); model=bound or profile["model_config"].get("orchestrator_model")
    if not model:raise HTTPException(409,"尚未配置编排模型。")
    validate_orchestrator_model(profile,model)
    cid=body.conversation_id or f"CONV_{secrets.token_hex(8)}"; now=utcnow()
    with database.connect() as c:c.execute("INSERT OR IGNORE INTO conversations(id,project_id,created_at,updated_at) VALUES(?,?,?,?)",(cid,body.project_id,now,now)); c.execute("INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,\'user\',?,?)",(f"MSG_{secrets.token_hex(8)}",cid,body.message,now))
    skill=workflow_manifest(body.skill_id) if body.skill_id in WORKFLOWS else None
    async def events():
        yield f"event: meta\ndata: {json.dumps({'conversation_id':cid,'model':model,'provider_profile_id':profile['id']},ensure_ascii=False)}\n\n"
        try:
            if profile["provider_type"]=="opencode":
                instructions=("你是 FRAMEFLOW 视频工作台内的创作助手。只输出对项目的结构化建议，不执行付费媒体调用，"
                              "不批准媒体 QA，不更改稳定 ID。所有新增或修改内容必须放入 patch，用户确认后才会应用。"
                              "Prompt QA 不代表执行授权。回答使用中文。")
                if skill:instructions+=f" 当前工作流：{skill['skill_id']} v{skill['skill_version']}；审批策略：{skill['approval_policy']}。"
                prompt=body.message+"\n\n项目上下文："+json.dumps({"project":pdata["document"],"selection":body.context},ensure_ascii=False)
                result=await opencode_structured(profile,get_profile_secret(profile),model,instructions,prompt,PROJECT_PATCH_SCHEMA,"FRAMEFLOW · Assistant")
            else:
                result=await openai_assistant(profile,get_profile_secret(profile),model,body.message,{"project":pdata["document"],"selection":body.context},skill)
            selected_node_ids=body.context.get("selected_node_ids",[]) if isinstance(body.context,dict) else []
            if not isinstance(selected_node_ids,list):selected_node_ids=[]
            snapshot=build_input_snapshot(pdata["document"],graph["graph"],body.message,[str(item) for item in selected_node_ids],body.context,{},pdata["revision"],graph["revision"])
            normalized=normalize_agent_patch(result,pdata["revision"],graph["revision"]); patch=AgentPatchV3.model_validate(normalized["patch"]); preview=patch_preview(graph["graph"],patch)
            plan_id=_store_agent_plan(database,body.project_id,"awaiting_review",body.message,body.skill_id,profile["id"],model,pdata["revision"],graph["revision"],snapshot,normalized,preview)
            result={**result,"reply":normalized["reply"],"patch":normalized["patch"],"plan_id":plan_id,"plan_status":"awaiting_review","preview":redact(preview),"requires_confirmation":preview.get("requires_confirmation",False)}
            with database.connect() as c:c.execute("INSERT INTO messages(id,conversation_id,role,content,metadata_json,created_at) VALUES(?,?,\'assistant\',?,?,?)",(f"MSG_{secrets.token_hex(8)}",cid,result.get("reply",""),database.encode({"patch":result.get("patch"),"plan_id":plan_id,"response_id":result.get("response_id")}),utcnow())); c.execute("UPDATE conversations SET updated_at=? WHERE id=?",(utcnow(),cid))
            yield f"event: result\ndata: {json.dumps(result,ensure_ascii=False)}\n\n"
        except Exception as exc:yield f"event: error\ndata: {json.dumps({'error':str(exc)},ensure_ascii=False)}\n\n"
    return StreamingResponse(events(),media_type="text/event-stream",headers={"Cache-Control":"no-store","X-Accel-Buffering":"no"})
@app.get("/api/conversations/{cid}/messages")
async def messages(cid:str,request:Request):
    database=db(request)
    with database.connect() as c:rows=c.execute("SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at",(cid,)).fetchall()
    return {"messages":[{"id":r["id"],"role":r["role"],"content":r["content"],"metadata":database.decode(r["metadata_json"],{}),"created_at":r["created_at"]} for r in rows]}

@app.post("/api/tasks")
async def create_task(body:TaskCreate,request:Request):return create_task_record(db(request),body)
@app.get("/api/tasks")
async def list_tasks(request:Request,project_id:str|None=None):
    database=db(request)
    with database.connect() as c:rows=c.execute("SELECT * FROM tasks WHERE project_id=? ORDER BY created_at DESC",(project_id,)).fetchall() if project_id else c.execute("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200").fetchall()
    return {"tasks":[task_payload(database,r) for r in rows]}
@app.post("/api/tasks/{tid}/confirm")
async def confirm_task(tid:str,request:Request,background:BackgroundTasks):
    database=db(request)
    with database.connect() as c:r=c.execute("SELECT * FROM tasks WHERE id=?",(tid,)).fetchone()
    if not r:raise HTTPException(404,"任务不存在。")
    if r["status"]!="awaiting_confirmation":raise HTTPException(409,"任务当前不等待确认。")
    with database.connect() as c:c.execute("UPDATE tasks SET confirmed_at=? WHERE id=?",(utcnow(),tid))
    transition(database,tid,"queued",{"confirmed":True})
    if r["task_type"]=="seedance_video":background.add_task(run_seedance_task,app,tid)
    elif r["task_type"]=="final_render":background.add_task(run_render_task,app,tid)
    return {"ok":True,"task_id":tid,"status":"queued"}
@app.post("/api/tasks/{tid}/retry")
async def retry_task(tid:str,request:Request,background:BackgroundTasks):
    database=db(request)
    with database.connect() as c:r=c.execute("SELECT * FROM tasks WHERE id=?",(tid,)).fetchone()
    if not r:raise HTTPException(404,"任务不存在。")
    if r["attempts"]>=2:raise HTTPException(409,"任务已失败两次，需要重建 Prompt 或人工处理。")
    transition(database,tid,"queued",{"retry":True})
    if r["task_type"]=="seedance_video":background.add_task(run_seedance_task,app,tid)
    elif r["task_type"]=="final_render":background.add_task(run_render_task,app,tid)
    return {"ok":True,"status":"queued"}
@app.post("/api/tasks/{tid}/cancel")
async def cancel_task(tid:str,request:Request):
    database=db(request)
    with database.connect() as c:r=c.execute("SELECT * FROM tasks WHERE id=?",(tid,)).fetchone()
    if not r:raise HTTPException(404,"任务不存在。")
    # The official CLI has no documented remote-cancel command.  Stop local
    # polling and keep the task's provider submit_id for auditability.
    transition(database,tid,"canceled",{"user_requested":True}); return {"ok":True,"status":"canceled"}

@app.post("/api/seedance/packages")
async def create_seedance_package(body:SeedancePackageCreate,request:Request):
    database=db(request); profile=get_profile(database,body.provider_profile_id)
    if profile["provider_type"]!="jimeng_cli":raise HTTPException(409,"视频生成必须使用即梦 CLI 配置。")
    config=profile["model_config"]; expected=str(config.get("model_version") or "seedance2.0")
    if body.provider_model_or_endpoint!=expected:raise HTTPException(409,"模型版本与即梦 CLI 配置不一致，请先在设置中选择已探测模型。")
    package=body.model_dump(); package.update({"schema_version":"1.0","adapter_version":"jimeng-cli-1.0","provider_task_id":None,"generation_manifest":None,"created_at":utcnow()})
    issues=validate_video_package(package,profile)
    if issues:raise HTTPException(422,"；".join(issues))
    pdata=await read_project(body.project_id,request); gates=evaluate_project_gates(pdata["document"],"seedance-shot-packager")
    if not gates["allowed"]:raise HTTPException(409,{"message":"项目尚未通过 Seedance 确定性门禁。","missing":gates["missing"]})
    doc=pdata["document"]; packages=doc.setdefault("seedancePackages",[]); package["id"]=f"SDPKG_{body.shot_id}_{len(packages)+1:02d}"; package["version"]=1+max([int(x.get("version",0)) for x in packages if x.get("shot_id")==body.shot_id and x.get("model_generation")==body.model_generation] or [0]); packages.append(package)
    await save_project(body.project_id,ProjectImport(document=doc,expected_revision=pdata["revision"]),request)
    task=create_task_record(database,TaskCreate(project_id=body.project_id,task_type="seedance_video",provider_profile_id=body.provider_profile_id,provider_model=body.provider_model_or_endpoint,request=package,paid=True)); return {"package":package,"task":task}
@app.post("/api/seedance/packages/{package_id}/clone-to-25")
async def clone_to_25(package_id:str,project_id:str,request:Request):
    raise HTTPException(410,"即梦 CLI 不支持 Seedance 2.5 接入点克隆；请在执行包中直接选择目标模型版本。")

def register_artifact(database:Database,project_id:str|None,kind:str,path:Path,profile:dict|None,model:str|None,task_id:str|None,metadata:dict)->dict:
    aid=f"ART_{secrets.token_hex(8)}"; record={"id":aid,"project_id":project_id,"artifact_type":kind,"role":metadata.get("role"),"version":1,"local_path":str(path.resolve()),"sha256":sha256_file(path),"mime_type":mimetypes.guess_type(path.name)[0],"metadata":metadata,"provider_profile_id":profile["id"] if profile else None,"provider_model":model,"task_id":task_id,"qa_owner":metadata.get("qa_owner"),"qa_decision":"Pending","status":"generated_pending_qa","created_at":utcnow()}
    with database.connect() as c:c.execute("INSERT INTO artifacts(id,project_id,artifact_type,role,version,local_path,sha256,mime_type,metadata_json,provider_profile_id,provider_model,task_id,qa_owner,qa_decision,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(aid,project_id,kind,record["role"],1,record["local_path"],record["sha256"],record["mime_type"],database.encode(metadata),record["provider_profile_id"],model,task_id,record["qa_owner"],"Pending","generated_pending_qa",record["created_at"]))
    return record
def artifact_url(project_id:str|None,path:Path)->str:
    if project_id:return f"/api/project-files/{project_id}/{path.resolve().relative_to((DATA_DIR/'projects'/project_id).resolve()).as_posix()}"
    return f"/generated/{path.resolve().relative_to(GENERATED_DIR.resolve()).as_posix()}"
def audio_duration(path:Path)->float|None:
    if path.suffix.lower()!=".wav":return None
    try:
        with wave.open(str(path),"rb") as a:return round(a.getnframes()/a.getframerate(),3)
    except Exception:return None

@app.post("/api/images/generate")
async def generate_image(body:ImageGenerate,request:Request):
    if not body.confirmed:raise HTTPException(409,"图片生成会产生费用，请先确认。")
    database=db(request); profile,_=resolve_profile(database,"image",body.provider_profile_id); payload=await openai_image(profile,get_profile_secret(profile),body.prompt,body.size,body.quality); item=(payload.get("data") or [{}])[0]; raw=item.get("b64_json")
    if not raw:raise HTTPException(502,"图片服务未返回图像数据。")
    target=safe_project_path(DATA_DIR,body.project_id,"artifacts/images") if body.project_id else GENERATED_DIR; target.mkdir(parents=True,exist_ok=True); dest=target/f"frameflow-{secrets.token_hex(8)}.png"
    try:dest.write_bytes(base64.b64decode(raw,validate=True))
    except Exception as exc:raise HTTPException(502,"图片数据无效。") from exc
    artifact=register_artifact(database,body.project_id,"image",dest,profile,payload.get("model") or profile["model_config"].get("image_model"),None,{"size":body.size,"quality":body.quality,"revised_prompt":item.get("revised_prompt")}); return {"url":artifact_url(body.project_id,dest),"filename":dest.name,"model":artifact["provider_model"],"size":body.size,"quality":body.quality,"revised_prompt":item.get("revised_prompt"),"artifact_id":artifact["id"]}
@app.post("/api/v2/projects/{project_id}/prompt-versions/{prompt_version_id}/qa")
async def prompt_qa_decision_v3(project_id:str,prompt_version_id:str,body:PromptQADecision,request:Request):
    database=db(request)
    with database.connect() as connection:row=connection.execute("SELECT project_id FROM prompt_versions WHERE id=?",(prompt_version_id,)).fetchone()
    if not row or row["project_id"]!=project_id:raise HTTPException(404,"Prompt 版本不存在于当前项目。")
    return await prompt_qa_decision(prompt_version_id,body,request)


def _generation_reference_snapshot(database:Database,project_id:str,logical_asset_id:str)->list[dict[str,Any]]:
    with database.connect() as connection:
        references=connection.execute(
            "SELECT * FROM asset_reference_roles_v4 WHERE project_id=? AND logical_asset_id=?",
            (project_id,logical_asset_id),
        ).fetchall()
    return ordered_reference_snapshot(database,project_id,references)


def _set_generation_snapshot(database:Database,snapshot_id:str,status:str,artifact_id:str|None=None,provider_model:str|None=None,error:dict[str,Any]|None=None)->None:
    with database.connect() as connection:
        connection.execute(
            "UPDATE generation_snapshots_v9 SET status=?,artifact_id=COALESCE(?,artifact_id),provider_model=COALESCE(?,provider_model),error_json=?,updated_at=? WHERE id=?",
            (status,artifact_id,provider_model,database.encode(error) if error is not None else None,utcnow(),snapshot_id),
        )


@app.post("/api/v2/projects/{project_id}/assets/{logical_asset_id}/generate-image")
async def generate_asset_image_v3(project_id:str,logical_asset_id:str,body:AssetImageGenerate,request:Request):
    if not body.confirmed:raise HTTPException(409,"图片生成会产生费用，请先确认。")
    database=db(request); doc,revision=await read_project_doc(request,project_id); asset=_project_asset(doc,logical_asset_id)
    if _asset_class(asset) not in ASSET_BOARD_VISUAL_CLASSES:raise HTTPException(409,"当前资产不是视觉图像资产，不能走图片生成流程。")
    if _asset_class(asset)=="fusion" and asset.get("fusionPromptSource")!="fusion-connection-agent":raise HTTPException(409,"融合资产必须先完成实际连线并生成正式融合 Prompt。")
    if asset.get("promptQaDecision")!="Approved":raise HTTPException(409,"请先完成 Prompt QA，Prompt 通过后才能进入图片生成。")
    current_prompt_version=str(asset.get("promptVersion") or "")
    requested_prompt_version=str(body.prompt_version or current_prompt_version or "")
    if not requested_prompt_version:raise HTTPException(409,"必须指定当前 Approved Prompt 版本。")
    if current_prompt_version and requested_prompt_version!=current_prompt_version:raise HTTPException(409,"Prompt 版本已变化，请刷新资产卡后重试。")
    try:
        canonical=canonical_approved_prompt(database,project_id,logical_asset_id,requested_prompt_version)
    except PromptAuthorityError as exc:
        raise HTTPException(409,{"message":exc.message,"prompt_authority":exc.payload()}) from exc
    if body.prompt is not None and prompt_sha256(body.prompt)!=canonical["prompt_sha256"]:
        raise HTTPException(409,{"message":"客户端 Prompt 正文与 Approved canonical Prompt 不一致。","prompt_authority":{"code":"prompt_body_tampered","prompt_version_id":canonical["id"],"expected_sha256":canonical["prompt_sha256"],"received_sha256":prompt_sha256(body.prompt)}})
    prompt=canonical["prompt"]
    cls=_asset_class(asset); profile,_=resolve_profile(database,"image",body.provider_profile_id)
    reference_snapshot=_generation_reference_snapshot(database,project_id,logical_asset_id)
    snapshot_id=f"GEN_{secrets.token_hex(8)}"; now=utcnow(); requested_model=str(profile["model_config"].get("image_model") or "")
    with database.connect() as connection:
        connection.execute(
            "INSERT INTO generation_snapshots_v9(id,project_id,logical_asset_id,operation_type,status,prompt_version_id,prompt_sha256,prompt_body,reference_snapshot_json,provider_profile_id,provider_model,parameters_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (snapshot_id,project_id,logical_asset_id,"asset_image_generation","submitted",canonical["id"],canonical["prompt_sha256"],prompt,database.encode(reference_snapshot),profile["id"],requested_model,database.encode({"size":body.size,"quality":body.quality}),now,now),
        )
    try:
        payload=await openai_image(profile,get_profile_secret(profile),prompt,body.size,body.quality); item=(payload.get("data") or [{}])[0]; raw=item.get("b64_json")
        if not raw:raise HTTPException(502,"图片服务未返回图像数据。")
        target=safe_project_path(DATA_DIR,project_id,"artifacts/images"); target.mkdir(parents=True,exist_ok=True); dest=target/f"asset-{logical_asset_id}-{secrets.token_hex(8)}.png"
        try:dest.write_bytes(base64.b64decode(raw,validate=True))
        except Exception as exc:raise HTTPException(502,"图片数据无效。") from exc
        generation_id=snapshot_id; qa_owner=asset_audit.QA_OWNER_BY_CLASS.get(cls) or "video-asset-regulator"; actual_model=payload.get("model") or requested_model
        artifact=register_artifact(database,project_id,"image",dest,profile,actual_model,None,{"role":"asset-candidate","qa_owner":qa_owner,"logical_asset_id":logical_asset_id,"asset_class":cls,"asset_role":asset.get("assetRole") or cls,"source_type":"codex-imagegen","generation_id":generation_id,"generation_snapshot_id":snapshot_id,"prompt_version":canonical["id"],"prompt_sha256":canonical["prompt_sha256"],"size":body.size,"quality":body.quality,"revised_prompt":item.get("revised_prompt")})
        now=utcnow()
        with database.connect() as connection:
            connection.execute("UPDATE artifacts SET logical_asset_id=?,asset_class=?,asset_role=?,collection='intake',intake_status='generated_pending_qa',source_type='codex-imagegen',generation_id=?,attempt_number=1,prompt_version=?,updated_at=? WHERE id=?",(logical_asset_id,cls,asset.get("assetRole") or cls,generation_id,canonical["id"],now,artifact["id"]))
        _set_generation_snapshot(database,snapshot_id,"succeeded",artifact["id"],actual_model)
    except Exception as exc:
        _set_generation_snapshot(database,snapshot_id,"failed",error={"type":type(exc).__name__,"message":str(exc)[:2000]})
        raise
    asset.update({"generationChoice":"codex-imagegen-approved","generationStatus":"generated-pending-qa","lastGenerationId":generation_id,"lastGeneratedArtifactId":artifact["id"],"status":"generated-pending-qa"})
    new_revision=save_project_document(request,doc,revision); asset_audit.record_event(database,project_id,artifact["id"],logical_asset_id,"generated_pending_qa","codex_image_generation",{"generation_id":generation_id,"generation_snapshot_id":snapshot_id,"prompt_version":canonical["id"],"prompt_sha256":canonical["prompt_sha256"],"confirmed":True})
    return {"project_id":project_id,"revision":new_revision,"execution_status":"generated-pending-qa","generation_id":generation_id,"generation_snapshot_id":snapshot_id,"prompt_version_id":canonical["id"],"prompt_sha256":canonical["prompt_sha256"],"artifact":{**artifact,"url":artifact_url(project_id,dest),"logical_asset_id":logical_asset_id,"asset_class":cls,"source_type":"codex-imagegen","prompt_version":canonical["id"],"status":"generated_pending_qa"},"qa_required":True,"next":"image_qa_then_registration"}

@app.post("/api/audio/speech")
async def generate_speech(body:SpeechGenerate,request:Request):
    if not body.confirmed:raise HTTPException(409,"语音生成会产生费用，请先确认。")
    if body.model not in ALLOWED_TTS_MODELS or body.voice not in ALLOWED_TTS_VOICES:raise HTTPException(422,"TTS 模型或声音无效。")
    database=db(request); profile,_=resolve_profile(database,"tts",body.provider_profile_id); upstream={"model":body.model,"input":body.text,"voice":body.voice,"response_format":body.format,"speed":body.speed}
    if body.instructions:upstream["instructions"]=body.instructions
    audio=await openai_speech(profile,get_profile_secret(profile),upstream); safe_id=re.sub(r"[^A-Za-z0-9_-]","",body.dialogue_id)[:40] or "DLG"; target=safe_project_path(DATA_DIR,body.project_id,"artifacts/audio") if body.project_id else GENERATED_AUDIO_DIR; target.mkdir(parents=True,exist_ok=True); dest=target/f"{safe_id}-{secrets.token_hex(8)}.{body.format}"; dest.write_bytes(audio); artifact=register_artifact(database,body.project_id,"audio",dest,profile,body.model,None,{"voice":body.voice,"format":body.format,"ai_generated_disclosure":True}); return {"url":artifact_url(body.project_id,dest),"filename":dest.name,"model":body.model,"voice":body.voice,"format":body.format,"duration":audio_duration(dest),"artifact_id":artifact["id"],"disclosure":"此声音由 AI 合成。"}


def _default_audio_studio() -> dict[str, Any]:
    return {
        "version": 1,
        "selected_mode": "overview",
        "voices": [],
        "voice_references": [],
        "auditions": [],
        "dialogues": [],
        "takes": [],
        "music_cues": [],
        "sound_design": [],
        "handoff": {"status": "provisional", "approved_asset_ids": [], "notes": ""},
        "updated_at": utcnow(),
    }


def _audio_value(record: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in record and record.get(key) is not None:
            return record.get(key)
    return default


def _audio_ids(value: Any) -> list[str]:
    if isinstance(value, str):
        return [item.strip().upper() for item in re.split(r"[,，\s]+", value) if item.strip()]
    if isinstance(value, list):
        return [str(item).strip().upper() for item in value if str(item).strip()]
    return []


def _audio_status(record: dict[str, Any], default: str = "planned") -> str:
    return str(_audio_value(record, "status", "execution_status", "executionStatus", default=default))


def _audio_reference_record(record: dict[str, Any], index: int) -> dict[str, Any]:
    return {
        **record,
        "id": str(_audio_value(record, "id", default=f"VREF{index:03d}")),
        "voice_id": _audio_value(record, "voice_id", "voiceId"),
        "artifact_id": _audio_value(record, "artifact_id", "artifactId"),
        "source_type": str(_audio_value(record, "source_type", "sourceType", default="reference-recording")),
        "consent_status": str(_audio_value(record, "consent_status", "consentStatus", default="pending-consent")),
        "evidence_ref": str(_audio_value(record, "evidence_ref", "evidenceRef", default="")),
        "allowed_use": str(_audio_value(record, "allowed_use", "allowedUse", default="")),
        "geography": str(_audio_value(record, "geography", default="")),
        "term": str(_audio_value(record, "term", default="")),
        "notes": str(_audio_value(record, "notes", default="")),
    }


def _audio_voice_record(record: dict[str, Any], index: int) -> dict[str, Any]:
    traits = _audio_value(record, "traits", default=[])
    if isinstance(traits, str):
        traits = [item.strip() for item in re.split(r"[,，]", traits) if item.strip()]
    return {
        **record,
        "id": str(_audio_value(record, "id", default=f"V{index:03d}")),
        "name": str(_audio_value(record, "name", default="未命名声音")),
        "character_id": _audio_value(record, "character_id", "characterId"),
        "role": str(_audio_value(record, "role", default="character")),
        "source_type": str(_audio_value(record, "source_type", "sourceType", default="design")),
        "provider": _audio_value(record, "provider"),
        "model": _audio_value(record, "model"),
        "provider_profile_id": _audio_value(record, "provider_profile_id", "providerProfileId"),
        "provider_voice_id": _audio_value(record, "provider_voice_id", "providerVoiceId"),
        "language": _audio_value(record, "language", default=""),
        "dialect": _audio_value(record, "dialect", default=""),
        "traits": traits if isinstance(traits, list) else [],
        "pronunciation_risks": _audio_value(record, "pronunciation_risks", "pronunciationRisks", default=[]),
        "register": str(_audio_value(record, "register", default="")),
        "age_range": str(_audio_value(record, "age_range", "ageRange", default="")),
        "pitch_energy": str(_audio_value(record, "pitch_energy", "pitchEnergy", default="")),
        "breath_noise_profile": str(_audio_value(record, "breath_noise_profile", "breathNoiseProfile", default="")),
        "consent_status": str(_audio_value(record, "consent_status", "consentStatus", default="not-required")),
        "consent_evidence_ref": str(_audio_value(record, "consent_evidence_ref", "consentEvidenceRef", default="")),
        "allowed_use": str(_audio_value(record, "allowed_use", "allowedUse", default="")),
        "geography": str(_audio_value(record, "geography", default="")),
        "term": str(_audio_value(record, "term", default="")),
        "provider_eligibility": str(_audio_value(record, "provider_eligibility", "providerEligibility", default="")),
        "logical_asset_id": _audio_value(record, "logical_asset_id", "logicalAssetId"),
        "selected_audition_id": _audio_value(record, "selected_audition_id", "selectedAuditionId"),
        "continuity_anchor": _audio_value(record, "continuity_anchor", "continuityAnchor", default={}),
        "status": str(_audio_value(record, "status", default="draft")),
        "notes": str(_audio_value(record, "notes", default="")),
    }


def _audio_audition_record(record: dict[str, Any], index: int) -> dict[str, Any]:
    conditions = {"neutral", "emotional", "pronunciation-stress"}
    condition = str(_audio_value(record, "condition", default="neutral"))
    if condition not in conditions:
        condition = "neutral"
    return {
        **record,
        "id": str(_audio_value(record, "id", default=f"AUD{index:03d}")),
        "voice_id": _audio_value(record, "voice_id", "voiceId"),
        "character_id": _audio_value(record, "character_id", "characterId"),
        "condition": condition,
        "text": str(_audio_value(record, "text", default="")),
        "emotion": str(_audio_value(record, "emotion", default="")),
        "instructions": str(_audio_value(record, "instructions", default="")),
        "target_duration": _audio_value(record, "target_duration", "targetDuration"),
        "artifact_id": _audio_value(record, "artifact_id", "artifactId"),
        "qa_run_id": _audio_value(record, "qa_run_id", "qaRunId"),
        "provider_profile_id": _audio_value(record, "provider_profile_id", "providerProfileId"),
        "provider": _audio_value(record, "provider"),
        "model": _audio_value(record, "model"),
        "status": _audio_status(record),
        "notes": str(_audio_value(record, "notes", default="")),
    }


def _audio_dialogue_record(record: dict[str, Any], index: int) -> dict[str, Any]:
    return {
        **record,
        "id": str(_audio_value(record, "id", default=f"DLG{index:03d}")),
        "asset_id": _audio_value(record, "asset_id", "assetId"),
        "character_id": _audio_value(record, "character_id", "characterId"),
        "voice_id": _audio_value(record, "voice_id", "voiceId"),
        "shot_ids": _audio_ids(_audio_value(record, "shot_ids", "shotIds", default=[])),
        "text": str(_audio_value(record, "text", default="")),
        "emotion": str(_audio_value(record, "emotion", default="")),
        "target_duration": _audio_value(record, "target_duration", "targetDuration"),
        "artifact_id": _audio_value(record, "artifact_id", "artifactId"),
        "qa_run_id": _audio_value(record, "qa_run_id", "qaRunId"),
        "operation": str(_audio_value(record, "operation", default="tts")),
        "execution_status": str(_audio_value(record, "execution_status", "executionStatus", default=_audio_value(record, "status", default="planned"))),
        "selected_take_id": _audio_value(record, "selected_take_id", "selectedTakeId"),
        "provider_profile_id": _audio_value(record, "provider_profile_id", "providerProfileId"),
        "provider": _audio_value(record, "provider"),
        "model": _audio_value(record, "model"),
        "logical_asset_id": _audio_value(record, "logical_asset_id", "logicalAssetId"),
        "notes": str(_audio_value(record, "notes", default="")),
    }


def _audio_take_record(record: dict[str, Any], index: int) -> dict[str, Any]:
    return {
        **record,
        "id": str(_audio_value(record, "id", default=f"TAKE{index:03d}")),
        "dialogue_id": _audio_value(record, "dialogue_id", "dialogueId"),
        "voice_id": _audio_value(record, "voice_id", "voiceId"),
        "version": int(_audio_value(record, "version", default=1) or 1),
        "artifact_id": _audio_value(record, "artifact_id", "artifactId"),
        "logical_asset_id": _audio_value(record, "logical_asset_id", "logicalAssetId"),
        "qa_run_id": _audio_value(record, "qa_run_id", "qaRunId"),
        "provider_profile_id": _audio_value(record, "provider_profile_id", "providerProfileId"),
        "provider": _audio_value(record, "provider"),
        "model": _audio_value(record, "model"),
        "operation": str(_audio_value(record, "operation", default="tts")),
        "status": _audio_status(record),
        "notes": str(_audio_value(record, "notes", default="")),
    }


def _audio_music_record(record: dict[str, Any], index: int) -> dict[str, Any]:
    start = _audio_value(record, "start", default=0)
    end = _audio_value(record, "end")
    duration = _audio_value(record, "duration")
    if duration is None and isinstance(start, (int, float)) and isinstance(end, (int, float)):
        duration = max(0, end - start)
    return {
        **record,
        "id": str(_audio_value(record, "id", default=f"CUE{index:03d}")),
        "asset_id": _audio_value(record, "asset_id", "assetId", "music_id", "musicId"),
        "shot_ids": _audio_ids(_audio_value(record, "shot_ids", "shotIds", default=[])),
        "purpose": str(_audio_value(record, "purpose", default="")),
        "entry": str(_audio_value(record, "entry", default="")),
        "development": str(_audio_value(record, "development", default="")),
        "exit": str(_audio_value(record, "exit", default="")),
        "duration": duration,
        "bpm": _audio_value(record, "bpm"),
        "instrumentation": str(_audio_value(record, "instrumentation", default="")),
        "texture": str(_audio_value(record, "texture", default="")),
        "dialogue_avoidance": _audio_ids(_audio_value(record, "dialogue_avoidance", "dialogueAvoidance", default=[])),
        "rights_status": str(_audio_value(record, "rights_status", "licenseStatus", default="unknown")),
        "execution_status": str(_audio_value(record, "execution_status", "executionStatus", default=_audio_value(record, "status", default="planned"))),
        "provider_hint": str(_audio_value(record, "provider_hint", "providerHint", default="")),
        "notes": str(_audio_value(record, "notes", default="")),
    }


def _audio_sound_record(record: dict[str, Any], index: int, kind: str) -> dict[str, Any]:
    return {
        **record,
        "id": str(_audio_value(record, "id", default=f"SND{index:03d}")),
        "asset_id": _audio_value(record, "asset_id", "assetId"),
        "shot_ids": _audio_ids(_audio_value(record, "shot_ids", "shotIds", default=[])),
        "kind": str(_audio_value(record, "kind", default=kind)),
        "description": str(_audio_value(record, "description", "name", default="")),
        "entry": str(_audio_value(record, "entry", default="")),
        "exit": str(_audio_value(record, "exit", default="")),
        "rights_status": str(_audio_value(record, "rights_status", "licenseStatus", default="unknown")),
        "execution_status": str(_audio_value(record, "execution_status", "executionStatus", default=_audio_value(record, "status", default="planned"))),
        "notes": str(_audio_value(record, "notes", default="")),
    }


def _audio_studio_document(doc: dict[str, Any]) -> dict[str, Any]:
    stored = doc.get("audio")
    if not isinstance(stored, dict):
        stored = doc if any(key in doc for key in ("voices", "dialogues", "music_cues", "musicCues", "sound_design", "soundEffects", "ambience", "handoff")) else _default_audio_studio()
    result = {**_default_audio_studio(), **stored}
    voices = result.get("voices") if isinstance(result.get("voices"), list) else []
    references = result.get("voice_references") if isinstance(result.get("voice_references"), list) else []
    auditions = result.get("auditions") if isinstance(result.get("auditions"), list) else []
    dialogues = result.get("dialogues") if isinstance(result.get("dialogues"), list) else []
    takes = result.get("takes") if isinstance(result.get("takes"), list) else []
    music = result.get("music_cues") if isinstance(result.get("music_cues"), list) else []
    if not music and isinstance(result.get("musicCues"), list):
        music = result.get("musicCues")
    sound = result.get("sound_design") if isinstance(result.get("sound_design"), list) else []
    if not sound:
        for legacy_key, kind in (("soundEffects", "sfx"), ("ambience", "ambience")):
            for record in result.get(legacy_key) if isinstance(result.get(legacy_key), list) else []:
                if isinstance(record, dict):
                    sound.append({**record, "kind": kind})
    result["voices"] = [_audio_voice_record(item, index) for index, item in enumerate(voices, 1) if isinstance(item, dict)]
    result["voice_references"] = [_audio_reference_record(item, index) for index, item in enumerate(references, 1) if isinstance(item, dict)]
    result["auditions"] = [_audio_audition_record(item, index) for index, item in enumerate(auditions, 1) if isinstance(item, dict)]
    result["dialogues"] = [_audio_dialogue_record(item, index) for index, item in enumerate(dialogues, 1) if isinstance(item, dict)]
    result["takes"] = [_audio_take_record(item, index) for index, item in enumerate(takes, 1) if isinstance(item, dict)]
    result["music_cues"] = [_audio_music_record(item, index) for index, item in enumerate(music, 1) if isinstance(item, dict)]
    result["sound_design"] = [_audio_sound_record(item, index, str(item.get("kind") or "sfx")) for index, item in enumerate(sound, 1) if isinstance(item, dict)]
    handoff = result.get("handoff") if isinstance(result.get("handoff"), dict) else {}
    result["handoff"] = {
        **handoff,
        "status": str(_audio_value(handoff, "status", default="provisional")),
        "approved_asset_ids": _audio_ids(_audio_value(handoff, "approved_asset_ids", "approvedAssetIds", default=[])),
        "notes": str(_audio_value(handoff, "notes", default="")),
    }
    return result


def _audio_gate_item(status: str, missing: list[str], next_action: str, **extra: Any) -> dict[str, Any]:
    return {"status": status, "allowed": status == "ready", "missing": list(dict.fromkeys(missing)), "next_action": next_action, **extra}


def _audio_studio_gates(document: dict[str, Any], capabilities: dict[str, dict[str, Any]], assets: list[dict[str, Any]]) -> dict[str, Any]:
    voices = [item for item in document.get("voices", []) if isinstance(item, dict)]
    auditions = [item for item in document.get("auditions", []) if isinstance(item, dict)]
    dialogues = [item for item in document.get("dialogues", []) if isinstance(item, dict)]
    takes = [item for item in document.get("takes", []) if isinstance(item, dict)]
    voice_missing: list[str] = []
    audition_missing: list[str] = []
    for voice in voices:
        voice_id = str(voice.get("id") or "voice")
        for field in ("name", "language", "dialect"):
            if not str(voice.get(field) or "").strip():
                voice_missing.append(f"{voice_id}:{field}")
        if str(voice.get("source_type") or "design") in {"clone", "speech-to-speech"}:
            if voice.get("consent_status") != "consent-verified":
                voice_missing.append(f"{voice_id}:consent-verified")
            if not str(voice.get("consent_evidence_ref") or "").strip():
                voice_missing.append(f"{voice_id}:consent_evidence_ref")
        if voice.get("status") != "approved":
            voice_missing.append(f"{voice_id}:voice_approval")
        voice_auditions = [item for item in auditions if str(item.get("voice_id") or "") == voice_id]
        for condition in ("neutral", "emotional", "pronunciation-stress"):
            match = next((item for item in voice_auditions if item.get("condition") == condition), None)
            if not match or match.get("status") != "approved" or not match.get("artifact_id"):
                audition_missing.append(f"{voice_id}:{condition}")
    if not voices:
        voice_missing.append("至少建立一个人物声音简报")
    voice_gate = _audio_gate_item("ready" if not voice_missing else "pending", voice_missing, "锁定声音身份" if voice_missing else "声音身份已锁定", count=len(voices))
    audition_gate = _audio_gate_item("ready" if not audition_missing and bool(voices) else "pending", audition_missing or (["先建立人物声音"] if not voices else []), "完成 neutral / emotional / pronunciation-stress 三组 audition" if audition_missing or not voices else "audition 已完成", count=len(auditions))

    tts = capabilities.get("tts") or {}
    tts_gate = _audio_gate_item("ready" if tts.get("ready") else "external-execution-pending", [] if tts.get("ready") else ["TTS Provider 未绑定或未探测"], "可生成试听" if tts.get("ready") else "导出 provider-neutral audition 包", provider=tts.get("provider"), model=tts.get("model"))

    asset_by_id = {str(item.get("id")): item for item in assets if isinstance(item, dict)}
    selected_asset_ids = [str(item) for item in (document.get("handoff") or {}).get("approved_asset_ids", [])]
    asset_missing: list[str] = []
    for asset_id in selected_asset_ids:
        asset = asset_by_id.get(asset_id)
        if not asset:
            asset_missing.append(f"{asset_id}:asset_missing")
        elif not asset.get("production_ready"):
            asset_missing.append(f"{asset_id}:{asset.get('next_action') or 'not_production_ready'}")
    if not selected_asset_ids:
        asset_missing.append("显式选择至少一个已 QA、已登记的音频资产")
    asset_gate = _audio_gate_item("ready" if not asset_missing else "pending", asset_missing, "选择并完成音频资产 QA/登记" if asset_missing else "选定资产已就绪", count=len(selected_asset_ids))

    dialogue_missing: list[str] = []
    for dialogue in dialogues:
        dialogue_id = str(dialogue.get("id") or "dialogue")
        if not dialogue.get("voice_id"):
            dialogue_missing.append(f"{dialogue_id}:voice_id")
        if not dialogue.get("shot_ids"):
            dialogue_missing.append(f"{dialogue_id}:shot_ids")
        selected_take_id = dialogue.get("selected_take_id")
        selected_take = next((item for item in takes if str(item.get("id")) == str(selected_take_id)), None) if selected_take_id else None
        if not selected_take or selected_take.get("status") != "approved" or not selected_take.get("artifact_id"):
            dialogue_missing.append(f"{dialogue_id}:selected_approved_take")
    dialogue_gate = _audio_gate_item("ready" if not dialogue_missing else "pending", dialogue_missing, "为每条对白选择 QA Approved Take" if dialogue_missing else "对白 Take 已就绪", count=len(dialogues))
    handoff_missing = voice_missing + audition_missing + asset_missing + dialogue_missing
    handoff_gate = _audio_gate_item("ready" if not handoff_missing else "blocked", handoff_missing, "完成声音身份、Take、资产 QA 和显式交接" if handoff_missing else "可交给时间线与镜头导演")
    return {"voice_identity": voice_gate, "auditions": audition_gate, "tts_execution": tts_gate, "dialogues": dialogue_gate, "assets": asset_gate, "handoff": handoff_gate}


def _audio_studio_envelope(database: Database, project_id: str, doc: dict[str, Any], revision: int) -> dict[str, Any]:
    library = _library_payload(database, project_id, doc)
    audio_assets = [asset for asset in library["assets"] if asset.get("assetClass") in {"audio", "music", "sfx"}]
    capabilities = _effective_capabilities(database)
    return {
        "project_id": project_id,
        "revision": revision,
        "document": _audio_studio_document(doc),
        "assets": audio_assets,
        "capabilities": capabilities,
        "audio_gates": _audio_studio_gates(_audio_studio_document(doc), capabilities, audio_assets),
        "workflow": {"router": "voice-controller", "voice": "voice-performance-director", "music": "music-sound-designer", "qa_owner": "voice-controller"},
    }


@app.get("/api/v2/projects/{project_id}/audio-studio")
async def read_audio_studio_v3(project_id: str, request: Request):
    database = db(request)
    doc, revision = await read_project_doc(request, project_id)
    return _audio_studio_envelope(database, project_id, doc, revision)


@app.put("/api/v2/projects/{project_id}/audio-studio")
async def write_audio_studio_v3(project_id: str, body: dict[str, Any], request: Request):
    doc, revision = await read_project_doc(request, project_id)
    expected_revision = body.get("expected_revision")
    if expected_revision is not None and int(expected_revision) != revision:
        raise HTTPException(409, {"message": "声音工作区版本已变化，请刷新后重试。", "current_revision": revision})
    document = body.get("document") if isinstance(body.get("document"), dict) else body
    if not isinstance(document, dict):
        raise HTTPException(422, "声音工作区文档必须是 JSON 对象。")
    audio = _audio_studio_document(document)
    audio["version"] = max(1, int(audio.get("version") or 1))
    audio["updated_at"] = utcnow()
    database = db(request)
    library = _library_payload(database, project_id, {**doc, "audio": audio})
    capabilities = _effective_capabilities(database)
    audio_assets = [asset for asset in library["assets"] if asset.get("assetClass") in {"audio", "music", "sfx"}]
    gates = _audio_studio_gates(audio, capabilities, audio_assets)
    if str((audio.get("handoff") or {}).get("status")) == "ready" and not gates["handoff"].get("allowed"):
        raise HTTPException(409, {"message": "声音交接仍有未完成门禁。", "audio_gates": gates})
    doc["audio"] = audio
    next_revision = save_project_document(request, doc, revision)
    return _audio_studio_envelope(database, project_id, doc, next_revision)


@app.post("/api/v2/projects/{project_id}/audio/tts")
async def generate_project_speech_v3(project_id: str, body: SpeechGenerate, request: Request):
    database = db(request)
    doc, revision = await read_project_doc(request, project_id)
    if not body.logical_asset_id:
        raise HTTPException(409, "声音生成必须绑定到 audio 逻辑资产，不能只生成未登记文件。")
    asset = _project_asset(doc, body.logical_asset_id)
    if _asset_class(asset) not in {"audio", "music"}:
        raise HTTPException(409, "人物声音结果必须绑定到 audio 或 music 逻辑资产。")
    audio = _audio_studio_document(doc)
    voice = next((item for item in audio.get("voices", []) if str(item.get("id")) == str(body.voice_id)), None) if body.voice_id else None
    if not voice:
        raise HTTPException(422, "声音生成必须绑定已保存的人物声音 profile。")
    if voice.get("source_type") in {"preset", "clone", "design", "speech-to-speech"} and not voice.get("provider_voice_id"):
        raise HTTPException(409, "当前声音路径尚无可执行 Provider voice ID，请先导出 provider-neutral 包或绑定支持该路径的 Provider。")
    if voice.get("source_type") == "clone" and voice.get("consent_status") != "consent-verified":
        raise HTTPException(409, "Clone 声音在 consent-verified 前不能执行。")
    payload = body.model_copy(update={"project_id": project_id})
    result = await generate_speech(payload, request)
    artifact_id = str(result.get("artifact_id") or "")
    if not artifact_id:
        raise HTTPException(502, "Provider 没有返回可登记的 audio artifact。")
    metadata = _asset_metadata(asset)
    metadata.update({
        "audio_operation": body.operation or "tts",
        "voice": body.voice,
        "voice_id": body.voice_id,
        "audition_id": body.audition_id,
        "emotion": body.emotion,
        "target_duration": body.target_duration,
        "shot_ids": list(body.shot_ids),
        "consent_status": voice.get("consent_status") or "not-required",
        "ai_generated_disclosure": True,
    })
    asset["assetMetadata"] = metadata
    asset["lastGeneratedArtifactId"] = artifact_id
    asset["generationStatus"] = "generated-pending-qa"
    asset["status"] = "generated-pending-qa"
    with database.connect() as connection:
        connection.execute(
            "UPDATE artifacts SET logical_asset_id=?,asset_class='audio',asset_role=?,source_type='openai-tts',collection='intake',intake_status='generated_pending_qa',qa_owner='voice-controller',metadata_json=?,updated_at=? WHERE id=? AND project_id=?",
            (body.logical_asset_id, asset.get("assetRole") or "dialogue", database.encode(metadata), utcnow(), artifact_id, project_id),
        )
    existing_takes = [item for item in audio.get("takes", []) if isinstance(item, dict) and str(item.get("dialogue_id")) == str(body.dialogue_id) and str(item.get("voice_id")) == str(body.voice_id)]
    version = max([int(item.get("version") or 0) for item in existing_takes] or [0]) + 1
    take_id = body.take_id or f"TAKE{len(audio.get('takes', [])) + 1:03d}"
    take = {
        "id": take_id, "dialogue_id": body.dialogue_id, "voice_id": body.voice_id, "version": version,
        "artifact_id": artifact_id, "logical_asset_id": body.logical_asset_id, "qa_run_id": None,
        "provider_profile_id": body.provider_profile_id, "provider": result.get("provider"), "model": body.model,
        "operation": body.operation or "tts", "status": "generated-pending-qa", "notes": body.instructions,
    }
    audio["takes"] = [item for item in audio.get("takes", []) if not (isinstance(item, dict) and str(item.get("id")) == str(take_id))] + [take]
    for audition in audio.get("auditions", []):
        if body.audition_id and str(audition.get("id")) == str(body.audition_id):
            audition.update({"artifact_id": artifact_id, "status": "generated-pending-qa"})
    for dialogue in audio.get("dialogues", []):
        if str(dialogue.get("id")) == str(body.dialogue_id):
            dialogue.update({"voice_id": body.voice_id, "execution_status": "generated-pending-qa", "artifact_id": artifact_id, "qa_run_id": None, "provider_profile_id": body.provider_profile_id, "provider": result.get("provider"), "model": body.model})
    doc["audio"] = audio
    next_revision = save_project_document(request, doc, revision)
    result.update({"project_id": project_id, "revision": next_revision, "logical_asset_id": body.logical_asset_id, "take_id": take_id, "execution_status": "generated-pending-qa", "qa_required": True})
    return result

@app.post("/api/images/edit")
async def edit_image(body:ImageEdit,request:Request):
    if not body.confirmed:raise HTTPException(409,"图片编辑会产生费用，请先确认。")
    database=db(request)
    with database.connect() as c:row=c.execute("SELECT * FROM artifacts WHERE id=? AND project_id=? AND artifact_type='image'",(body.artifact_id,body.project_id)).fetchone()
    if not row:raise HTTPException(404,"源图片资产不存在。")
    source=Path(row["local_path"]).resolve()
    if not source.is_file():raise HTTPException(404,"源图片文件不存在。")
    profile,bound=resolve_profile(database,"orchestrator",body.provider_profile_id); model=bound or profile["model_config"].get("orchestrator_model")
    mime=mimetypes.guess_type(source.name)[0] or "image/png"; data_url=f"data:{mime};base64,{base64.b64encode(source.read_bytes()).decode('ascii')}"; result=await openai_image_edit(profile,get_profile_secret(profile),model,body.prompt,data_url); target=safe_project_path(DATA_DIR,body.project_id,"artifacts/images"); target.mkdir(parents=True,exist_ok=True); dest=target/f"edit-{secrets.token_hex(8)}.png"; dest.write_bytes(base64.b64decode(result["b64_json"],validate=True)); artifact=register_artifact(database,body.project_id,"image",dest,profile,result["model"],None,{"source_artifact_id":body.artifact_id,"edit_prompt":body.prompt,"response_id":result["response_id"]}); return {"url":artifact_url(body.project_id,dest),"filename":dest.name,"model":result["model"],"artifact_id":artifact["id"],"source_artifact_id":body.artifact_id}

@app.post("/api/assets/upload")
async def upload_asset(request:Request,project_id:str,file:UploadFile=File(...)):
    if not file.filename:raise HTTPException(422,"缺少文件名。")
    ext=Path(file.filename).suffix.lower(); allowed={".png",".jpg",".jpeg",".webp",".wav",".mp3",".m4a",".aac",".flac",".ogg",".mp4",".webm",".mov",".srt",".vtt"}
    if ext not in allowed:raise HTTPException(415,"文件格式不受支持。")
    folder=safe_project_path(DATA_DIR,project_id,"uploads"); name=re.sub(r"[^A-Za-z0-9._-]","_",Path(file.filename).name); dest=folder/f"{secrets.token_hex(6)}-{name}"
    staged=None; finalized=False
    try:
        staged=await stage_upload(file,dest,MAX_UPLOAD)
        if staged.size==0:raise HTTPException(413,"文件为空或超过 1GB。")
        if ext==".png" and not staged.inspection.startswith(b"\x89PNG\r\n\x1a\n"):raise HTTPException(415,"PNG 签名无效。")
        if ext in {".jpg",".jpeg"} and not staged.inspection.startswith(b"\xff\xd8\xff"):raise HTTPException(415,"JPEG 签名无效。")
        finalize_staged_upload(staged,dest); finalized=True
        artifact=register_artifact(db(request),project_id,"upload",dest,None,None,None,{"original_name":file.filename,"media_info":media_info(dest) if ext in {".mp4",".webm",".mov"} else {}})
        return {"artifact":artifact,"url":artifact_url(project_id,dest)}
    except UploadTooLarge as exc:
        raise HTTPException(413,"文件为空或超过 1GB。") from exc
    except Exception:
        if finalized:cleanup_file(dest)
        raise
    finally:
        if staged:cleanup_staged_upload(staged)


def save_project_document(request:Request,doc:dict[str,Any],expected_revision:int|None,*,connection:sqlite3.Connection|None=None,audit_event:dict[str,Any]|None=None)->int:
    database=db(request); now=utcnow()
    def _save(c:sqlite3.Connection)->int:
        current=c.execute("SELECT revision,document_json FROM projects WHERE id=?",(doc["id"],)).fetchone()
        if not current:raise HTTPException(404,"项目不存在。")
        if expected_revision is not None and current["revision"]!=expected_revision:
            raise HTTPException(409,{"message":"项目已有更新。","current_revision":current["revision"]})
        rev=current["revision"]+1
        c.execute("UPDATE projects SET name=?,document_json=?,revision=?,updated_at=? WHERE id=?",(doc.get("name",""),database.encode(doc),rev,now,doc["id"]))
        if audit_event:
            event=dict(audit_event)
            event.setdefault("project_id",doc["id"])
            event.setdefault("created_at",now)
            audit_trail.write_event_connection(c,database,**event)
        return rev
    if connection is not None:
        return _save(connection)
    with database.connect() as c:
        return _save(c)

async def read_project_doc(request:Request,project_id:str)->tuple[dict[str,Any],int]:
    pdata=await read_project(project_id,request)
    return pdata["document"],pdata["revision"]

def _project_asset(doc:dict[str,Any],asset_id:str)->dict[str,Any]:
    asset=next((a for a in doc.get("assets",[]) if a.get("id")==asset_id),None)
    if asset is None:raise HTTPException(404,f"逻辑资产 {asset_id} 不存在于当前项目。")
    return asset


def _asset_metadata(asset:dict[str,Any])->dict[str,Any]:
    """Read the stage-D metadata block while tolerating v1/v2 asset shapes."""
    metadata=asset.get("assetMetadata")
    if not isinstance(metadata,dict):
        metadata=asset.get("metadata") if isinstance(asset.get("metadata"),dict) else {}
    return metadata


def _asset_class(asset:dict[str,Any])->str:
    metadata=_asset_metadata(asset)
    value=metadata.get("asset_class") or metadata.get("assetClass") or asset.get("assetClass")
    if value:
        return str(value)
    return asset_audit.asset_class_for_skill(asset.get("skill")) or asset_audit.classify_by_role(asset.get("assetRole") or asset.get("type"))


def _dependency_payload(database:Database,row:Any)->dict[str,Any]:
    return {
        "id":row["id"], "project_id":row["project_id"], "logical_asset_id":row["logical_asset_id"],
        "dependency_asset_id":row["dependency_asset_id"], "shot_id":row["shot_id"],
        "relation":row["relation"], "role":row["role"], "required":bool(row["required"]),
        "created_at":row["created_at"],
    }


def _reference_payload(database:Database,row:Any)->dict[str,Any]:
    return {
        "id":row["id"], "project_id":row["project_id"], "logical_asset_id":row["logical_asset_id"],
        "reference_id":row["reference_id"], "reference_kind":row["reference_kind"],
        "artifact_id":row["artifact_id"], "role":row["role"], "source":row["source"],
        "notes":row["notes"], "priority":int(row["priority"] or 100), "scope":row["scope"],
        "authority":row["authority"], "conflict_group":row["conflict_group"], "effective_version":row["effective_version"],
        "created_at":row["created_at"], "updated_at":row["updated_at"],
    }


def _comparison_payload(database:Database,row:Any)->dict[str,Any]:
    return {
        "id":row["id"], "project_id":row["project_id"], "logical_asset_id":row["logical_asset_id"],
        "comparison_group":row["comparison_group"], "strategy":row["strategy"],
        "prompt_version":row["prompt_version"], "candidates":database.decode(row["candidates_json"],[]),
        "notes":row["notes"], "created_at":row["created_at"], "updated_at":row["updated_at"],
    }


def _asset_relations(database:Database,project_id:str,logical_asset_id:str)->tuple[list[dict[str,Any]],list[dict[str,Any]],list[dict[str,Any]]]:
    with database.connect() as c:
        dependencies=c.execute("SELECT * FROM asset_dependencies_v4 WHERE project_id=? AND logical_asset_id=? ORDER BY created_at",(project_id,logical_asset_id)).fetchall()
        references=c.execute("SELECT * FROM asset_reference_roles_v4 WHERE project_id=? AND logical_asset_id=? ORDER BY priority,created_at,id",(project_id,logical_asset_id)).fetchall()
        comparisons=c.execute("SELECT * FROM asset_comparisons_v4 WHERE project_id=? AND logical_asset_id=? ORDER BY created_at DESC",(project_id,logical_asset_id)).fetchall()
    return ([ _dependency_payload(database,row) for row in dependencies ], [ _reference_payload(database,row) for row in references ], [ _comparison_payload(database,row) for row in comparisons ])


def _fusion_gate(doc:dict[str,Any],asset:dict[str,Any],database:Database,project_id:str,references:list[dict[str,Any]]|None=None)->dict[str,Any]:
    metadata=_asset_metadata(asset)
    source_ids=list(metadata.get("fusion_source_asset_ids") or metadata.get("fusionSourceAssetIds") or asset.get("fusionSourceAssetIds") or [])
    if not source_ids:
        source_ids=[str(item.get("dependency_asset_id")) for item in metadata.get("shot_dependencies",[]) if isinstance(item,dict) and item.get("dependency_asset_id")]
    assets={str(item.get("id")):item for item in doc.get("assets",[]) if isinstance(item,dict) and item.get("id")}
    missing_sources=[]
    for source_id in source_ids:
        source=assets.get(str(source_id))
        readiness=asset_audit.asset_readiness(source)
        if not source or not readiness["ready"]:
            missing_sources.append({"asset_id":source_id,"readiness":readiness})
    if references is None:
        _,references,_=_asset_relations(database,project_id,str(asset.get("id")))
    role_issues=[]
    for reference in references:
        if reference["role"] not in asset_audit.REFERENCE_ROLES:
            role_issues.append({"reference_id":reference["reference_id"],"reason":"invalid_role"})
    if not references:
        role_issues.append({"reason":"reference_roles_missing"})
    allowed=bool(source_ids) and not missing_sources and not role_issues
    return {
        "logical_asset_id":asset.get("id"), "asset_class":_asset_class(asset), "allowed":allowed,
        "source_asset_ids":source_ids, "missing_sources":missing_sources,
        "reference_role_issues":role_issues,
        "message":"融合基础资产和引用角色均已就绪" if allowed else "融合必须在角色/场景/道具基础资产完成登记后进行",
    }


def _library_payload(database:Database,project_id:str,doc:dict[str,Any])->dict[str,Any]:
    """Build one detailed library projection without per-asset database queries.

    The original audit's 1000-asset failure was amplified by four read queries
    for every logical asset plus a full media integrity scan on every library
    refresh.  All relational children are now loaded in bounded batches; full
    hash integrity remains available through its explicit audit endpoint.
    """
    with database.connect() as c:
        artifact_rows=c.execute("SELECT * FROM artifacts WHERE project_id=? ORDER BY created_at DESC",(project_id,)).fetchall()
        version_rows=c.execute("SELECT * FROM asset_versions WHERE project_id=? ORDER BY version DESC",(project_id,)).fetchall()
        prompt_rows=c.execute("SELECT * FROM prompt_versions WHERE project_id=? ORDER BY logical_asset_id,version DESC,id DESC",(project_id,)).fetchall()
        dependency_rows=c.execute("SELECT * FROM asset_dependencies_v4 WHERE project_id=? ORDER BY logical_asset_id,created_at,id",(project_id,)).fetchall()
        reference_rows=c.execute("SELECT * FROM asset_reference_roles_v4 WHERE project_id=? ORDER BY logical_asset_id,priority,created_at,id",(project_id,)).fetchall()
        comparison_rows=c.execute("SELECT * FROM asset_comparisons_v4 WHERE project_id=? ORDER BY logical_asset_id,created_at DESC,id DESC",(project_id,)).fetchall()
    artifacts_by_logical:dict[str,list[dict[str,Any]]]={}
    for row in artifact_rows:
        if row["logical_asset_id"]:
            artifacts_by_logical.setdefault(row["logical_asset_id"],[]).append(asset_audit.artifact_payload(database,row))
    versions_by_logical:dict[str,list[dict[str,Any]]]={}
    for row in version_rows:
        versions_by_logical.setdefault(row["logical_asset_id"],[]).append(asset_audit.asset_version_payload(database,row))
    prompts_by_logical:dict[str,list[dict[str,Any]]]={}
    for row in prompt_rows:
        prompts_by_logical.setdefault(row["logical_asset_id"],[]).append(asset_audit.prompt_version_payload(database,row))
    dependencies_by_logical:dict[str,list[dict[str,Any]]]={}
    for row in dependency_rows:
        dependencies_by_logical.setdefault(row["logical_asset_id"],[]).append(_dependency_payload(database,row))
    references_by_logical:dict[str,list[dict[str,Any]]]={}
    for row in reference_rows:
        references_by_logical.setdefault(row["logical_asset_id"],[]).append(_reference_payload(database,row))
    comparisons_by_logical:dict[str,list[dict[str,Any]]]={}
    for row in comparison_rows:
        comparisons_by_logical.setdefault(row["logical_asset_id"],[]).append(_comparison_payload(database,row))
    result=[]; ready_count=0; production_ready_count=0; blocked_count=0
    by_class:dict[str,int]={}; by_status:dict[str,int]={}
    for asset in doc.get("assets",[]):
        if not isinstance(asset,dict) or not asset.get("id"):continue
        logical_id=str(asset["id"])
        dependencies=dependencies_by_logical.get(logical_id,[])
        references=references_by_logical.get(logical_id,[])
        comparisons=comparisons_by_logical.get(logical_id,[])
        asset_class=_asset_class(asset)
        linked_artifacts=artifacts_by_logical.get(logical_id,[])
        # The logical asset is intentionally not marked ready by a browser
        # upload.  For audio, however, the latest mapped artifact is still
        # useful evidence that a file exists and which audio QA/authorization
        # metadata is currently pending.  Feed that evidence into the
        # readiness calculator without changing the authoritative asset state.
        readiness_asset=dict(asset)
        readiness_asset.setdefault("assetClass", asset_class)
        if linked_artifacts:
            latest_artifact=linked_artifacts[0]
            readiness_asset.setdefault("artifactId", latest_artifact.get("id"))
            readiness_asset.setdefault("filePath", latest_artifact.get("local_path"))
            if not readiness_asset.get("qaDecision") and latest_artifact.get("qa_decision"):
                readiness_asset["qaDecision"]=latest_artifact.get("qa_decision")
            metadata=latest_artifact.get("metadata") if isinstance(latest_artifact.get("metadata"),dict) else {}
            if metadata.get("usage_scope"):
                readiness_asset["usage_scope"]=metadata.get("usage_scope")
            if asset_class in {"audio","music","sfx"} and not (readiness_asset.get("authorizationStatus") or readiness_asset.get("authorization_status")):
                if metadata.get("authorization_status") is not None:
                    readiness_asset["authorizationStatus"]=metadata.get("authorization_status")
        readiness=asset_audit.asset_readiness(readiness_asset)
        item={**asset,"assetClass":asset_class,"assetMetadata":_asset_metadata(asset),"readiness":readiness,"registered_ready":readiness.get("registered_ready",False),"production_ready":readiness.get("production_ready",False),"next_action":readiness.get("next_action"),"artifacts":linked_artifacts,"artifact_count":len(linked_artifacts),"versions":versions_by_logical.get(logical_id,[]),"promptVersions":prompts_by_logical.get(logical_id,[]),"references":references,"dependencies":dependencies,"comparisons":comparisons}
        item["workflow"]=_asset_workflow(item,linked_artifacts,versions_by_logical.get(logical_id,[]),readiness)
        if asset_class=="fusion":
            item.update(_fusion_prompt_state(database,project_id,doc,asset))
            item["fusionPlan"]=asset.get("fusionPlan") or _fusion_plan_for_asset(doc,asset)
            item["fusionGate"]=_fusion_gate(doc,asset,database,project_id,references)
            if readiness.get("production_ready") and not item["fusionGate"].get("allowed"):
                readiness["production_ready"]=False
                readiness.setdefault("production_missing",[]).append("fusion_gate")
                readiness["next_action"]="检查融合门"
        item["registered_ready"]=readiness.get("registered_ready",False)
        item["production_ready"]=readiness.get("production_ready",False)
        item["next_action"]=readiness.get("next_action")
        if readiness["ready"]:ready_count+=1
        if readiness.get("production_ready"):production_ready_count+=1
        if readiness["status"]=="blocked":blocked_count+=1
        by_class[asset_class]=by_class.get(asset_class,0)+1
        by_status[str(readiness["status"])]=by_status.get(str(readiness["status"]),0)+1
        result.append(item)
    return {"project_id":project_id,"assets":result,"summary":{"total":len(result),"ready":ready_count,"blocked":blocked_count,"missing_required_a":sum(1 for item in result if item["readiness"]["required"] and not item["readiness"]["ready"]),"by_class":by_class,"by_status":by_status,"registered_ready":ready_count,"production_ready":production_ready_count,"artifact_count":sum(int(item.get("artifact_count") or 0) for item in result)},"storage_integrity":{"ok":None,"status":"not_checked","message":"完整文件哈希审计仅由 /integrity 显式执行，资产库刷新不会隐式扫描媒体。"}}


def _asset_audit_payload(database:Database,project_id:str,doc:dict[str,Any],queue:str|None=None)->dict[str,Any]:
    """Build the shared audit queue without changing logical asset state."""
    library=_library_payload(database,project_id,doc)
    assets_by_id={str(item["id"]):item for item in library["assets"]}
    normalized={"mapping":"待映射","image_qa":"待图片 QA","video_qa":"待视频 QA","audio_qa":"待声音 QA","reference_qa":"待参考审核","qa_in_progress":"QA 进行中","registration":"待登记","revision":"需要修订","rejected":"拒绝/重建 Prompt","archived":"已归档"}
    items=[]; counts={label:0 for label in normalized.values()}
    with database.connect() as connection:
        qa_rows=connection.execute("SELECT * FROM asset_qa_runs WHERE project_id=? ORDER BY created_at DESC",(project_id,)).fetchall()
    latest_qa={str(row["artifact_id"]):asset_audit.qa_run_payload(database,row) for row in qa_rows}
    for artifact in [artifact for asset in library["assets"] for artifact in asset.get("artifacts",[])]:
        aid=str(artifact.get("id") or artifact.get("artifact_id") or "")
        logical_id=str(artifact.get("logical_asset_id") or "")
        asset=assets_by_id.get(logical_id)
        qa_decision=str(artifact.get("qa_decision") or "Pending")
        status=str(artifact.get("status") or artifact.get("intake_status") or "")
        collection=str(artifact.get("collection") or "")
        if not logical_id or not asset or not artifact.get("asset_class") or artifact.get("asset_class")=="unknown":
            bucket="mapping"
        elif collection=="archived" or status=="archived":
            bucket="archived"
        elif qa_decision in {"Reject and rebuild prompt","Rejected","Blocked"} or status in {"rejected","blocked"}:
            bucket="rejected"
        elif qa_decision in {"Needs revision","Revision required"} or status in {"revision_required","revision-required"}:
            bucket="revision"
        elif aid in latest_qa and str(latest_qa[aid].get("status")) in {"running","in_progress"}:
            bucket="qa_in_progress"
        elif status=="reference_pending_review" or (artifact.get("metadata") or {}).get("qa_type")=="reference":
            bucket="reference_qa"
        elif status in {"generated_pending_qa","pending_qa","mapping_required"} and ((artifact.get("metadata") or {}).get("qa_type")=="video" or artifact.get("asset_class")=="video"):
            bucket="video_qa"
        elif qa_decision != "Approved" or status in {"generated_pending_qa","pending_qa","mapping_required"}:
            bucket="audio_qa" if artifact.get("asset_class") in {"audio","music","sfx"} else "image_qa"
        elif logical_id and not any(bool(version.get("is_active")) and version.get("artifact_id")==aid for version in asset.get("versions",[])):
            bucket="registration"
        else:
            continue
        label=normalized[bucket]; counts[label]+=1
        items.append({"queue":bucket,"queue_label":label,"asset":asset,"artifact":artifact,"qa":latest_qa.get(aid),"next_action":asset.get("readiness",{}).get("next_action") or label})
    # Logical assets with no candidate still belong to a useful audit queue.
    if queue in {None,"all","registration","revision"}:
        for asset in library["assets"]:
            readiness=asset.get("readiness",{})
            if readiness.get("status")=="blocked" or readiness.get("production_missing"):
                if not asset.get("artifacts") and readiness.get("status")!="blocked":
                    continue
                bucket="revision" if readiness.get("status")=="blocked" else "registration"
                label=normalized[bucket]
                if not any(item.get("asset",{}).get("id")==asset.get("id") and item["queue"]==bucket for item in items):
                    counts[label]+=1
                    items.append({"queue":bucket,"queue_label":label,"asset":asset,"artifact":None,"qa":None,"next_action":readiness.get("next_action")})
    if queue and queue not in {"all", "*"}:
        items=[item for item in items if item["queue"]==queue]
    return {"project_id":project_id,"queue":queue or "all","items":items,"counts":counts,"total":len(items),"summary":library["summary"]}


def _asset_workflow(asset:dict[str,Any],artifacts:list[dict[str,Any]],versions:list[dict[str,Any]],readiness:dict[str,Any])->dict[str,Any]:
    """Return one authoritative, actionable workflow state for the UI."""
    candidate=next((item for item in artifacts if item.get("status") not in {"ready","reference","archived"}),None)
    candidate=candidate or (artifacts[0] if artifacts else None)
    metadata=candidate.get("metadata") if isinstance(candidate and candidate.get("metadata"),dict) else {}
    qa_type=str(metadata.get("qa_type") or readiness.get("qa_kind") or asset_audit.qa_type_for_artifact(asset.get("assetClass"),candidate.get("mime_type") if candidate else None,metadata))
    state=str(candidate.get("status") if candidate else readiness.get("status") or "missing")
    is_reference=metadata.get("usage_scope")=="reference" or readiness.get("kind")=="reference"
    if is_reference:
        kind="reference"
        if state not in {"reference","blocked","rejected"}:
            state="reference_pending_review"
        if state=="reference":
            next_code,next_label="reference_only","仅供参考，不可入镜"; enabled=False; actions=["view_artifact","view_qa"]
        elif state=="reference_pending_review":
            next_code,next_label="start_reference_review","开始参考审核"; enabled=bool(candidate); actions=["view_artifact","start_qa"]
        else:
            next_code,next_label="resolve_blocker","查看阻塞原因"; enabled=True; actions=["view_artifact","view_qa","resolve"]
    elif state=="approved_pending_registration":
        kind="production"; next_code,next_label="register_artifact","登记为资产版本"; enabled=True; actions=["view_artifact","view_qa","register_artifact"]
    elif state in {"generated_pending_qa","audit_blocked"}:
        kind="production"; next_code,next_label=f"start_{qa_type}_qa",f"开始{'视频' if qa_type=='video' else '声音' if qa_type=='audio' else '图片'} QA"; enabled=True; actions=["view_artifact","start_qa"]
    elif state=="qa_in_progress":
        kind="production"; next_code,next_label="open_qa","打开 QA 审核"; enabled=True; actions=["view_artifact","view_qa","submit_qa"]
    elif state in {"revision_required","rejected"}:
        kind="production"; next_code,next_label="resolve_revision","查看问题并重新上传"; enabled=True; actions=["view_artifact","view_qa","resolve"]
    elif readiness.get("production_ready"):
        kind="production"; next_code,next_label="production_ready","可入镜"; enabled=False; actions=["view_artifact","view_qa"]
    elif readiness.get("registered_ready") or readiness.get("ready"):
        kind="production"; next_code,next_label="resolve_gate","处理入镜门禁"; enabled=True; actions=["view_artifact","view_qa","resolve"]
    else:
        kind="production"; next_code,next_label="upload_candidate","上传候选文件"; enabled=True; actions=["upload_candidate"]
    blockers=list(readiness.get("production_missing") or [])
    return {
        "state":state,
        "kind":kind,
        "qa_type":qa_type,
        "qa_owner":(candidate or {}).get("qa_owner") or asset.get("qaOwner") or asset_audit.QA_OWNER_BY_CLASS.get(asset.get("assetClass")),
        "artifact_id":(candidate or {}).get("id"),
        "next_action":{"code":next_code,"label":next_label,"enabled":enabled},
        "allowed_actions":actions,
        "blockers":blockers,
    }


ASSET_BOARD_CLASS_LABELS={"character":"角色","scene":"场景","prop":"道具","fusion":"融合","audio":"声音","music":"音乐","sfx":"音效","product":"产品","style":"风格","unknown":"待分类"}
ASSET_BOARD_VISUAL_CLASSES={"character","scene","prop","fusion","product","style"}


def _asset_board_node_position(previous:dict[str,Any],node_id:str,default:dict[str,float])->dict[str,float]:
    node=previous.get(node_id) or {}
    position=node.get("position") if isinstance(node,dict) else None
    if isinstance(position,dict) and isinstance(position.get("x"),(int,float)) and isinstance(position.get("y"),(int,float)):
        return {"x":float(position["x"]),"y":float(position["y"])}
    return default


def _asset_board_from_document(database:Database,project_id:str,doc:dict[str,Any],project_revision:int,previous:dict[str,Any]|None=None,artifact_rows:list[Any]|None=None)->dict[str,Any]:
    previous=previous or {}
    previous_nodes={str(node.get("id")):node for node in previous.get("nodes",[]) if isinstance(node,dict) and node.get("id")}
    nodes:list[dict[str,Any]]=[]; edges:list[dict[str,Any]]=[]; known_nodes:set[str]=set()
    assets=[item for item in doc.get("assets",[]) if isinstance(item,dict) and item.get("id")]
    shots=[item for item in doc.get("shots",[]) if isinstance(item,dict) and item.get("id")]
    assets_by_id={str(item["id"]):item for item in assets}
    shot_by_id={str(item["id"]):item for item in shots}
    class_items:dict[str,list[dict[str,Any]]]={}
    for asset in assets:
        asset_id=str(asset["id"]); class_name=_asset_class(asset) or "unknown"; class_items.setdefault(class_name,[]).append(asset)

    group_order=[("shots","镜头依赖"),("character","角色资产"),("scene","场景资产"),("prop","道具资产"),("fusion","融合资产"),("other","其他资产")]
    group_positions={"shots":{"x":40.0,"y":20.0},"character":{"x":420.0,"y":20.0},"scene":{"x":800.0,"y":20.0},"prop":{"x":1180.0,"y":20.0},"fusion":{"x":1560.0,"y":20.0},"other":{"x":1940.0,"y":20.0}}
    group_ids=set()
    for group_key,label in group_order:
        group_id=f"group:{group_key}"; group_ids.add(group_id)
        old=previous_nodes.get(group_id) or {}
        config={"category":group_key,"width":320,"height":760,"collapsed":False}
        if isinstance(old.get("config"),dict): config={**config,**old["config"]}
        nodes.append({"id":group_id,"node_type":"group","label":label,"position":_asset_board_node_position(previous_nodes,group_id,group_positions[group_key]),"config":config,"status":"idle"}); known_nodes.add(group_id)

    for index,shot in enumerate(shots):
        shot_id=str(shot["id"]); node_id=f"shot:{shot_id}"; old=previous_nodes.get(node_id) or {}
        scene=str(shot.get("scene") or "未命名场景"); label=f"{shot_id} · {scene}"
        config={"scene":scene,"duration":shot.get("duration"),"purpose":shot.get("purpose"),"camera":shot.get("camera"),"action":shot.get("action"),"group_id":"group:shots"}
        if isinstance(old.get("config"),dict): config={**config,**old["config"]}
        nodes.append({"id":node_id,"node_type":"shot","label":label,"position":_asset_board_node_position(previous_nodes,node_id,{"x":70.0,"y":100.0+index*116}),"shot_id":shot_id,"config":config,"status":str(shot.get("status") or "ready")}); known_nodes.add(node_id)

    group_for_class={"character":"character","scene":"scene","prop":"prop","fusion":"fusion"}
    visual_assets=[]
    for class_name,_label in group_order[1:]:
        visual_assets.extend(class_items.get(class_name,[]))
    visual_assets.extend(item for key,item_list in class_items.items() if key not in group_for_class for item in item_list)
    row_by_group={key:0 for key,_ in group_order}
    if artifact_rows is None:
        with database.connect() as connection:
            artifact_rows=connection.execute("SELECT * FROM artifacts WHERE project_id=? ORDER BY created_at DESC",(project_id,)).fetchall()
    artifacts_by_asset:dict[str,list[Any]]={}
    for row in artifact_rows:
        if row["logical_asset_id"]:artifacts_by_asset.setdefault(str(row["logical_asset_id"]),[]).append(row)

    def preview_artifact(asset_id:str):
        for row in artifacts_by_asset.get(asset_id,[]):
            mime=str(row["mime_type"] or "").lower()
            status=str(row["status"] or "")
            if mime.startswith("image/") and status not in {"archived","rejected","revision_required","superseded"}:
                return row
        return None

    for asset in visual_assets:
        asset_id=str(asset["id"]); class_name=_asset_class(asset) or "unknown"; group_key=group_for_class.get(class_name,"other"); row=row_by_group[group_key]; row_by_group[group_key]+=1
        node_id=f"asset:{asset_id}"; old=previous_nodes.get(node_id) or {}
        readiness=asset_audit.asset_readiness(asset); label=str(asset.get("name") or asset_id)
        config={"asset_class":class_name,"grade":asset.get("grade") or readiness.get("grade") or "B","readiness_status":readiness.get("status"),"required":bool(readiness.get("required")),"group_id":f"group:{group_key}","archived":False}
        if isinstance(old.get("config"),dict): config={**config,**old["config"]}
        base_x=group_positions.get(group_key,group_positions["other"])["x"]+30
        nodes.append({"id":node_id,"node_type":"asset","label":label,"position":_asset_board_node_position(previous_nodes,node_id,{"x":base_x,"y":100.0+row*150}),"asset_id":asset_id,"config":config,"status":str(readiness.get("status") or "missing")}); known_nodes.add(node_id)
        prompt=str(asset.get("prompt") or "").strip(); metadata=_asset_metadata(asset)
        draft_metadata=metadata.get("production_draft") if isinstance(metadata.get("production_draft"),dict) else {}
        nested_metadata=metadata.get("metadata") if isinstance(metadata.get("metadata"),dict) else {}
        production_draft=draft_metadata if draft_metadata.get("active") else nested_metadata.get("production_draft") if isinstance(nested_metadata.get("production_draft"),dict) else {}
        production_draft_active=bool(production_draft.get("active"))
        # A prompt card is the single human handoff surface for an asset.
        # Older versions also created a generic "ChatGPT · asset" bridge for
        # every unfinished visual asset. That card had no additional payload
        # and duplicated the prompt card once Prompt generation was run.
        if prompt or production_draft_active:
            handoff_id=f"handoff:{asset_id}"; old_handoff=previous_nodes.get(handoff_id) or {}
            preview=preview_artifact(asset_id); preview_id=str(preview["id"]) if preview else ""; preview_url=artifact_url(project_id,Path(preview["local_path"])) if preview else ""
            handoff_config={"asset_id":asset_id,"source_type":"chatgpt-web","group_id":f"group:{group_key}","archived":False,"artifact_id":preview_id or None,"artifact_url":preview_url or None,"artifact_status":str(preview["status"]) if preview else None,"artifact_qa_decision":str(preview["qa_decision"]) if preview else None,"artifact_source_type":str(preview["source_type"] or "upload") if preview else None}
            if isinstance(old_handoff.get("config"),dict): handoff_config={**handoff_config,**old_handoff["config"]}
            handoff_config.update({"prompt_card":True,"production_draft":production_draft_active,"asset_class":class_name,"prompt":prompt,"prompt_pack":asset.get("promptPack") or metadata.get("prompt_pack") or {},"prompt_version":asset.get("promptVersion") or metadata.get("prompt_version"),"prompt_qa_decision":asset.get("promptQaDecision") or "Pending","generation_choice":asset.get("generationChoice") or "user-confirmation-required","generation_status":asset.get("generationStatus") or "planned","target_skill":asset.get("promptTargetSkill") or asset.get("skill") or _asset_prompt_skill(class_name),"relevant_shots":asset.get("promptRelevantShots") or [],"must_preserve":asset.get("mustPreserve") or metadata.get("must_preserve") or [],"must_avoid":asset.get("mustAvoid") or metadata.get("must_avoid") or [],"image_generation_eligible":asset.get("imageGenerationEligible",class_name in ASSET_BOARD_VISUAL_CLASSES),"fusion_prompt_source":asset.get("fusionPromptSource"),"fusion_prompt_state":asset.get("fusionPromptState"),"fusion_prompt_stale":bool(asset.get("fusionPromptStale")),"fusion_prompt_stale_reason":asset.get("fusionPromptStaleReason"),"fusion_plan":asset.get("fusionPlan") or {}})
            nodes.append({"id":handoff_id,"node_type":"handoff","label":f"资产 Prompt · {label}","position":_asset_board_node_position(previous_nodes,handoff_id,{"x":base_x+225,"y":100.0+row*150}),"asset_id":asset_id,"config":handoff_config,"status":"prompt_draft_ready" if prompt else "production_draft"}); known_nodes.add(handoff_id)

    def add_edge(source:str,target:str,relation:str)->None:
        if source not in known_nodes or target not in known_nodes or source==target:return
        edge_id=f"edge:{source}:{target}:{relation}"
        if any(edge["id"]==edge_id for edge in edges):return
        edges.append({"id":edge_id,"source":source,"target":target,"relation":relation})

    for shot in shots:
        shot_id=str(shot["id"]); shot_node=f"shot:{shot_id}"; requirements=shot.get("assetRequirements") or []
        if not requirements:
            for asset in assets:
                for dependency in asset.get("shotDependencies") or []:
                    if isinstance(dependency,dict) and str(dependency.get("shot_id") or dependency.get("shotId") or "") == shot_id:
                        requirements.append({"assetId":asset.get("id")})
        for requirement in requirements:
            if isinstance(requirement,dict) and requirement.get("assetId") in assets_by_id:add_edge(shot_node,f"asset:{requirement['assetId']}","shot_dependency")

    for asset in assets:
        asset_id=str(asset["id"]); asset_node=f"asset:{asset_id}"; metadata=_asset_metadata(asset)
        source_ids=asset.get("fusionSourceAssetIds") or metadata.get("fusion_source_asset_ids") or metadata.get("fusionSourceAssetIds") or []
        for source_id in source_ids or []:add_edge(f"asset:{source_id}",asset_node,"fusion_input")
        if f"handoff:{asset_id}" in known_nodes:add_edge(asset_node,f"handoff:{asset_id}","candidate")

    for asset_id,rows in artifacts_by_asset.items():
        asset_node=f"asset:{asset_id}"
        for index,row in enumerate(rows):
            artifact_id=str(row["id"]); node_id=f"artifact:{artifact_id}"; old=previous_nodes.get(node_id) or {}; url=artifact_url(project_id,Path(row["local_path"]))
            nodes.append({"id":node_id,"node_type":"artifact","label":f"候选 · {artifact_id[-8:]}","position":_asset_board_node_position(previous_nodes,node_id,{"x":(previous_nodes.get(asset_node,{}).get("position") or {}).get("x",0)+225,"y":(previous_nodes.get(asset_node,{}).get("position") or {}).get("y",100)+90+index*92}),"asset_id":asset_id,"config":{"artifact_id":artifact_id,"url":url,"source_type":row["source_type"] or "upload","qa_decision":row["qa_decision"],"artifact_status":row["status"]},"status":str(row["status"])}); known_nodes.add(node_id); add_edge(asset_node,node_id,"candidate")

    current_ids={str(node["id"]) for node in nodes}
    for old_id,old in previous_nodes.items():
        if old_id in current_ids or old_id in group_ids or not isinstance(old,dict):continue
        if old.get("node_type") not in {"asset","shot","handoff","artifact"}:continue
        old_asset_id=str(old.get("asset_id") or "")
        old_shot_id=str(old.get("shot_id") or "")
        if old_asset_id and old_asset_id not in assets_by_id:continue
        if old_shot_id and old_shot_id not in shot_by_id:continue
        archived={**old,"status":"archived","config":{**(old.get("config") or {}),"archived":True}}
        nodes.append(archived); known_nodes.add(old_id)
    edges=[edge for edge in edges if edge["source"] in known_nodes and edge["target"] in known_nodes]
    viewport=previous.get("viewport") if isinstance(previous.get("viewport"),dict) else {"x":0.0,"y":0.0,"zoom":0.75}
    previous_metadata=previous.get("metadata") if isinstance(previous.get("metadata"),dict) else {}
    return {"version":1,"viewport":viewport,"nodes":nodes,"edges":edges,"metadata":{**previous_metadata,"story_revision":project_revision,"asset_source_revision":project_revision}}


def _validate_asset_board(board:dict[str,Any])->dict[str,Any]:
    node_ids=[str(node.get("id")) for node in board.get("nodes",[]) if isinstance(node,dict)]
    if len(node_ids)!=len(set(node_ids)):raise HTTPException(422,"资产画布节点 ID 不能重复。")
    known=set(node_ids)
    for node in board.get("nodes",[]):
        if not isinstance(node,dict):raise HTTPException(422,"资产画布节点格式无效。")
        node_type=node.get("node_type")
        if node_type in {"asset","handoff","artifact"} and not node.get("asset_id"):raise HTTPException(422,"资产节点缺少 asset_id。")
        if node_type=="shot" and not node.get("shot_id"):raise HTTPException(422,"镜头节点缺少 shot_id。")
    edge_ids=[str(edge.get("id")) for edge in board.get("edges",[]) if isinstance(edge,dict)]
    if len(edge_ids)!=len(set(edge_ids)):raise HTTPException(422,"资产画布连接 ID 不能重复。")
    for edge in board.get("edges",[]):
        if edge.get("source") not in known or edge.get("target") not in known:raise HTTPException(422,"资产画布连接指向不存在的节点。")
        if edge.get("source")==edge.get("target"):raise HTTPException(422,"资产画布不能连接节点自身。")
    return board


def _strip_legacy_asset_handoffs(board:dict[str,Any])->dict[str,Any]:
    """Remove the pre-Prompt generic ChatGPT bridge from persisted boards."""
    nodes=[node for node in board.get("nodes",[]) if not (isinstance(node,dict) and node.get("node_type")=="handoff" and not (node.get("config") or {}).get("prompt_card"))]
    known={str(node.get("id")) for node in nodes if isinstance(node,dict) and node.get("id")}
    edges=[edge for edge in board.get("edges",[]) if isinstance(edge,dict) and edge.get("source") in known and edge.get("target") in known]
    return {**board,"nodes":nodes,"edges":edges}


def _asset_board_payload(database:Database,project_id:str,row:Any)->dict[str,Any]:
    return {"project_id":project_id,"revision":int(row["revision"]),"board":database.decode(row["board_json"],{}),"updated_at":row["updated_at"]}


def _ensure_asset_board(database:Database,project_id:str)->dict[str,Any]:
    with database.connect() as connection:
        project=connection.execute("SELECT document_json,revision FROM projects WHERE id=?",(project_id,)).fetchone()
        if not project:raise HTTPException(404,"项目不存在。")
        row=connection.execute("SELECT * FROM asset_boards_v7 WHERE project_id=?",(project_id,)).fetchone()
        if row:return _asset_board_payload(database,project_id,row)
        doc=database.decode(project["document_json"],{}); board=_asset_board_from_document(database,project_id,doc,int(project["revision"])) ; now=utcnow()
        connection.execute("INSERT INTO asset_boards_v7(project_id,revision,board_json,created_at,updated_at) VALUES(?,?,?,?,?)",(project_id,1,database.encode(board),now,now))
        row=connection.execute("SELECT * FROM asset_boards_v7 WHERE project_id=?",(project_id,)).fetchone()
    return _asset_board_payload(database,project_id,row)


@app.get("/api/v2/projects/{project_id}/asset-board")
async def asset_board(project_id:str,request:Request):
    database=db(request); current=_ensure_asset_board(database,project_id)
    legacy_handoffs=[node for node in (current.get("board") or {}).get("nodes",[]) if isinstance(node,dict) and node.get("node_type")=="handoff" and not (node.get("config") or {}).get("prompt_card")]
    if not legacy_handoffs:return current
    # Upgrade boards created before Prompt cards existed. Rebuild from the
    # current story/document while preserving the user's saved positions and
    # viewport; the generic ChatGPT bridge is intentionally not carried over.
    doc,project_revision=await read_project_doc(request,project_id)
    board=_strip_legacy_asset_handoffs(_validate_asset_board(_asset_board_from_document(database,project_id,doc,project_revision,current.get("board") or {}))); now=utcnow(); revision=int(current["revision"])+1
    with database.connect() as connection:
        connection.execute("UPDATE asset_boards_v7 SET revision=?,board_json=?,updated_at=? WHERE project_id=?",(revision,database.encode(board),now,project_id))
        row=connection.execute("SELECT * FROM asset_boards_v7 WHERE project_id=?",(project_id,)).fetchone()
    return _asset_board_payload(database,project_id,row)


@app.put("/api/v2/projects/{project_id}/asset-board")
async def update_asset_board(project_id:str,body:AssetBoardUpdateV3,request:Request):
    database=db(request); current=_ensure_asset_board(database,project_id)
    if current["revision"]!=body.expected_revision:raise HTTPException(409,{"message":"资产画布已在其他位置更新，请刷新后重试。","current_revision":current["revision"]})
    board=_strip_legacy_asset_handoffs(_validate_asset_board(body.board.model_dump(mode="json"))); now=utcnow(); revision=current["revision"]+1
    with database.connect() as connection:
        connection.execute("UPDATE asset_boards_v7 SET revision=?,board_json=?,updated_at=? WHERE project_id=?",(revision,database.encode(board),now,project_id))
        row=connection.execute("SELECT * FROM asset_boards_v7 WHERE project_id=?",(project_id,)).fetchone()
    return _asset_board_payload(database,project_id,row)


@app.post("/api/v2/projects/{project_id}/asset-board/sync")
async def sync_asset_board(project_id:str,body:AssetBoardSyncV3,request:Request):
    database=db(request); current=_ensure_asset_board(database,project_id)
    if current["revision"]!=body.expected_revision:raise HTTPException(409,{"message":"资产画布已在其他位置更新，请刷新后重试。","current_revision":current["revision"]})
    doc,project_revision=await read_project_doc(request,project_id); board=_asset_board_from_document(database,project_id,doc,project_revision,current["board"] if body.preserve_layout else None); board=_validate_asset_board(board); now=utcnow(); revision=current["revision"]+1
    with database.connect() as connection:
        connection.execute("UPDATE asset_boards_v7 SET revision=?,board_json=?,updated_at=? WHERE project_id=?",(revision,database.encode(board),now,project_id))
        row=connection.execute("SELECT * FROM asset_boards_v7 WHERE project_id=?",(project_id,)).fetchone()
    return _asset_board_payload(database,project_id,row)


@app.post("/api/v2/projects/{project_id}/asset-assignments")
async def assign_asset_v3(project_id:str,body:AssetAssignmentV3,request:Request):
    """Atomically keep story requirements, dependency rows and board edges aligned."""
    database=db(request); now=utcnow()
    with database.connect() as connection:
        project_row=connection.execute("SELECT document_json,revision FROM projects WHERE id=?",(project_id,)).fetchone()
        board_row=connection.execute("SELECT * FROM asset_boards_v7 WHERE project_id=?",(project_id,)).fetchone()
        if not project_row:raise HTTPException(404,"项目不存在。")
        if not board_row:
            initial_doc=database.decode(project_row["document_json"],{})
            initial_board=_asset_board_from_document(database,project_id,initial_doc,int(project_row["revision"]))
            connection.execute("INSERT INTO asset_boards_v7(project_id,revision,board_json,created_at,updated_at) VALUES(?,?,?,?,?)",(project_id,1,database.encode(initial_board),now,now))
            board_row=connection.execute("SELECT * FROM asset_boards_v7 WHERE project_id=?",(project_id,)).fetchone()
        if int(project_row["revision"])!=body.expected_project_revision:
            raise HTTPException(409,{"message":"项目故事已更新，请刷新后重试。","current_revision":int(project_row["revision"])})
        if int(board_row["revision"])!=body.expected_board_revision:
            raise HTTPException(409,{"message":"资产画布已更新，请刷新后重试。","current_revision":int(board_row["revision"])})
        doc=database.decode(project_row["document_json"],{})
        asset=_project_asset(doc,body.asset_id)
        shot=next((item for item in doc.get("shots",[]) if str(item.get("id")).upper()==body.shot_id.upper()),None)
        if not shot:raise HTTPException(404,f"镜头 {body.shot_id} 不存在。")
        if body.mode in {"move","remove"}:
            for item in doc.get("shots",[]):
                item["assetRequirements"]=[req for req in item.get("assetRequirements",[]) if str(req.get("assetId") or "")!=body.asset_id]
        if body.mode != "remove":
            requirements=list(shot.get("assetRequirements") or [])
            if not any(str(req.get("assetId") or "") == body.asset_id for req in requirements):
                requirements.append({"assetId":body.asset_id,"assetClass":_asset_class(asset),"role":body.role or asset.get("assetRole") or f"{_asset_class(asset)}镜头依赖","priority":asset.get("grade") or "B","required":body.required,"requiredReadiness":body.required_readiness,"source":"asset-assignment"})
            shot["assetRequirements"]=requirements
        next_project_revision=int(project_row["revision"])+1
        previous_board=database.decode(board_row["board_json"],{})
        next_board=_validate_asset_board(_asset_board_from_document(database,project_id,doc,next_project_revision,previous_board))
        next_board_revision=int(board_row["revision"])+1
        connection.execute("UPDATE projects SET document_json=?,revision=?,updated_at=? WHERE id=?",(database.encode(doc),next_project_revision,now,project_id))
        connection.execute("UPDATE asset_boards_v7 SET revision=?,board_json=?,updated_at=? WHERE project_id=?",(next_board_revision,database.encode(next_board),now,project_id))
        connection.execute("DELETE FROM asset_dependencies_v4 WHERE project_id=? AND logical_asset_id=? AND shot_id IS NOT NULL",(project_id,body.asset_id))
        for item in doc.get("shots",[]):
            for requirement in item.get("assetRequirements") or []:
                if str(requirement.get("assetId") or "") != body.asset_id:continue
                connection.execute("INSERT INTO asset_dependencies_v4(id,project_id,logical_asset_id,dependency_asset_id,shot_id,relation,role,required,created_at) VALUES(?,?,?,?,?,?,?,?,?)",(asset_audit.new_id("DEP"),project_id,body.asset_id,body.asset_id,str(item.get("id")),"shot_dependency",requirement.get("role") or "",int(bool(requirement.get("required",True))),now))
    asset_audit.record_event(database,project_id,None,body.asset_id,None,"shot_assignment_updated",{"shot_id":body.shot_id,"mode":body.mode})
    return {"project_id":project_id,"project_revision":next_project_revision,"board_revision":next_board_revision,"story":story_document(doc),"asset_board":{"project_id":project_id,"revision":next_board_revision,"board":next_board,"updated_at":now},"library":_library_payload(database,project_id,doc)}


async def _update_project_asset(request:Request,project_id:str,asset_id:str,updater)->dict[str,Any]:
    doc,rev=await read_project_doc(request,project_id); asset=_project_asset(doc,asset_id); updater(asset); save_project_document(request,doc,rev); return asset

def _artifact_row(database:Database,artifact_id:str,project_id:str|None=None):
    with database.connect() as c:
        if project_id:row=c.execute("SELECT * FROM artifacts WHERE id=? AND project_id=?",(artifact_id,project_id)).fetchone()
        else:row=c.execute("SELECT * FROM artifacts WHERE id=?",(artifact_id,)).fetchone()
    if not row:raise HTTPException(404,"artifact 不存在。")
    return row

def _vision_profile(database:Database):
    try:
        profile,_=resolve_profile(database,"orchestrator"); return profile
    except HTTPException:return None

@app.post("/api/assets/intake")
async def asset_intake(
    request:Request,
    project_id:str=Form(...),
    file:UploadFile=File(...),
    logical_asset_id:str|None=Form(None),
    asset_class:str|None=Form(None),
    asset_role:str|None=Form(None),
    source_type:str=Form("external-upload"),
    generation_id:str|None=Form(None),
    prompt_version:str|None=Form(None),
    relevant_shots_json:str=Form("[]"),
    run_audit:bool=Form(True),
    is_sensitive:bool=Form(False),
    authorization_status:str|None=Form(None),
):
    database=db(request)
    await read_project_doc(request,project_id)
    if not file.filename:raise HTTPException(422,"缺少文件名。")
    folder=safe_project_path(DATA_DIR,project_id,"artifacts/intake")
    name=asset_audit.safe_filename(file.filename); dest=folder/f"{secrets.token_hex(6)}-{name}"
    staged=None; finalized=False; inserted=False; aid=None
    try:
        staged=await stage_upload(file,dest,MAX_UPLOAD)
        validation=asset_audit.technical_validation(staged.inspection,file.filename,project_id,MAX_UPLOAD,total_size=staged.size,sha256=staged.sha256)
        if not validation["ok"]:
            return structured_error(422,"technical_validation_failed","technical",f"文件技术校验失败：{'；'.join(validation['failures'])}",{"technical_validation":validation,"retry_allowed":True},retryable=False)
        try:shots=json.loads(relevant_shots_json or "[]")
        except json.JSONDecodeError:shots=[]
        if not isinstance(shots,list):shots=[]
        # Resolve asset class / logical asset mapping.
        cls=(asset_class or "").strip().lower() or asset_audit.classify_by_role(asset_role)
        if cls not in asset_audit.ASSET_CLASSES:
            cls="unknown" if not asset_class else cls
        mapped=bool(logical_asset_id and logical_asset_id.strip())
        if mapped:
            doc,_=await read_project_doc(request,project_id); _project_asset(doc,logical_asset_id)
            if cls=="unknown":
                for a in doc.get("assets",[]):
                    if a.get("id")==logical_asset_id and a.get("skill"):
                        cls={"character":"character","scene":"scene","prop":"prop","fusion":"fusion","audio":"audio","music":"music","sfx":"sfx"}.get(a["skill"],"unknown"); break
            if cls=="unknown":
                return structured_error(422,"mapping_incomplete","mapping","无法确定资产类型，请先完成资产映射。",{},retryable=False)
        mime_type=validation["checks"].get("mime_type")
        usage=asset_audit.infer_artifact_usage(file.filename,mime_type,cls,asset_role)
        status=("reference_pending_review" if usage["usage_scope"]=="reference" else "generated_pending_qa") if (mapped and cls!="unknown") else "mapping_required"
        collection=asset_audit.collection_for_status(status)
        sha=staged.sha256
        duplicate=None
        with database.connect() as c:
            dup=c.execute("SELECT id FROM artifacts WHERE project_id=? AND sha256=?",(project_id,sha)).fetchone()
            if dup:duplicate=dup["id"]
        aid=asset_audit.new_id("ART"); now=utcnow()
        qa_owner=asset_audit.QA_OWNER_BY_CLASS.get(cls) if cls!="unknown" else None
        metadata={"original_name":file.filename,"is_sensitive":bool(is_sensitive),"authorization_status":authorization_status,"relevant_shots":shots,"source_type":source_type,"mime_signature_consistent":validation["checks"].get("mime_signature_consistent",True),**usage}
        finalize_staged_upload(staged,dest); finalized=True
        with database.connect() as c:
            c.execute("INSERT INTO artifacts(id,project_id,artifact_type,role,version,local_path,sha256,mime_type,metadata_json,provider_profile_id,provider_model,prompt_version,task_id,qa_owner,qa_decision,status,logical_asset_id,asset_class,asset_role,collection,intake_status,source_type,generation_id,attempt_number,qa_report_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (aid,project_id,"upload",asset_role,1,str(dest.resolve()),sha,mime_type,database.encode(metadata),None,None,prompt_version,None,qa_owner,"Pending",status,logical_asset_id or None,cls if cls!="unknown" else None,asset_role,collection,status,source_type,generation_id,1,"{}",now,now))
        inserted=True
        asset_audit.record_event(database,project_id,aid,logical_asset_id or None,None,status,{"source_type":source_type})
        audit_trail.record_event(
            database, project_id=project_id, action="artifact_intake", target_type="artifact", target_id=aid,
            reason="artifact_intake_submitted", before={},
            after={"artifact_id":aid,"logical_asset_id":logical_asset_id,"asset_class":cls,"status":status,"sha256":sha,"size":staged.size},
            metadata={"source_type":source_type,"original_name":file.filename},
        )
        artifact=asset_audit.artifact_payload(database,_artifact_row(database,aid,project_id))
        return {"artifact":artifact,"technical_validation":validation,"mapping":{"logical_asset_id":logical_asset_id,"asset_class":cls,"asset_role":asset_role,"prompt_version":prompt_version,"relevant_shots":shots,"usage":usage},"next_status":status,"audit_allowed":status in {"generated_pending_qa","reference_pending_review"},"url":artifact_url(project_id,dest),"warnings":[f"检测到与 {duplicate} 相同的文件哈希" if duplicate else None,None if run_audit else "未开启自动审计"],"duplicate_hash":bool(duplicate)}
    except UploadTooLarge as exc:
        raise HTTPException(413,f"文件超过大小限制（{MAX_UPLOAD} 字节）。") from exc
    except Exception:
        try:
            if inserted and aid:
                with database.connect() as c:
                    c.execute("DELETE FROM asset_events WHERE artifact_id=?",(aid,))
                    c.execute("DELETE FROM artifacts WHERE id=? AND project_id=?",(aid,project_id))
        finally:
            if finalized:cleanup_file(dest)
        raise
    finally:
        if staged:cleanup_staged_upload(staged)


@app.post("/api/v2/projects/{project_id}/asset-intake")
async def asset_intake_v3(
    project_id:str,
    request:Request,
    file:UploadFile=File(...),
    logical_asset_id:str|None=Form(None),
    asset_class:str|None=Form(None),
    asset_role:str|None=Form(None),
    source_type:str=Form("chatgpt-web"),
    generation_id:str|None=Form(None),
    prompt_version:str|None=Form(None),
    relevant_shots_json:str=Form("[]"),
    run_audit:bool=Form(True),
    is_sensitive:bool=Form(False),
    authorization_status:str|None=Form(None),
):
    return await asset_intake(
        request=request,
        project_id=project_id,
        file=file,
        logical_asset_id=logical_asset_id,
        asset_class=asset_class,
        asset_role=asset_role,
        source_type=source_type,
        generation_id=generation_id,
        prompt_version=prompt_version,
        relevant_shots_json=relevant_shots_json,
        run_audit=run_audit,
        is_sensitive=is_sensitive,
        authorization_status=authorization_status,
    )


@app.post("/api/v2/projects/{project_id}/artifacts/{artifact_id}/map")
async def map_artifact_v3(project_id:str,artifact_id:str,body:ArtifactMapRequest,request:Request):
    database=db(request); row=_ensure_artifact_project(database,project_id,artifact_id)
    if row["status"] not in {"mapping_required", "technical_validation", "unqualified"}:
        raise HTTPException(409,f"当前状态 {row['status']} 不能重新映射。")
    return await map_artifact(artifact_id,body,request)


@app.post("/api/v2/projects/{project_id}/artifacts/{artifact_id}/resolution")
async def resolve_artifact_v3(project_id:str,artifact_id:str,body:ResolutionRequest,request:Request):
    _ensure_artifact_project(db(request),project_id,artifact_id)
    return await resolve_artifact(artifact_id,body,request)


def _ensure_artifact_project(database:Database,project_id:str,artifact_id:str):
    row=_artifact_row(database,artifact_id)
    if row["project_id"]!=project_id:raise HTTPException(404,"候选素材不属于当前项目。")
    return row


@app.post("/api/v2/projects/{project_id}/artifacts/{artifact_id}/qa-runs")
async def create_qa_run_v3(project_id:str,artifact_id:str,body:QARunCreate,request:Request):
    _ensure_artifact_project(db(request),project_id,artifact_id)
    return await create_qa_run(artifact_id,body,request)


@app.get("/api/v2/projects/{project_id}/artifacts/{artifact_id}/qa-runs")
async def list_qa_runs_v3(project_id:str,artifact_id:str,request:Request):
    database=db(request); _ensure_artifact_project(database,project_id,artifact_id)
    with database.connect() as connection:
        rows=connection.execute("SELECT * FROM asset_qa_runs WHERE project_id=? AND artifact_id=? ORDER BY created_at DESC",(project_id,artifact_id)).fetchall()
    return {"project_id":project_id,"artifact_id":artifact_id,"qa_runs":[asset_audit.qa_run_payload(database,row) for row in rows]}


@app.post("/api/v2/projects/{project_id}/qa-runs/{qa_run_id}/submit")
async def submit_qa_decision_v3(project_id:str,qa_run_id:str,body:QADecisionSubmit,request:Request):
    database=db(request); run=_qa_row(database,qa_run_id)
    if run["project_id"]!=project_id:raise HTTPException(404,"QA 记录不属于当前项目。")
    return await submit_qa_decision(qa_run_id,body,request)


@app.post("/api/v2/projects/{project_id}/artifacts/{artifact_id}/register")
async def register_asset_v3(project_id:str,artifact_id:str,body:ArtifactRegisterRequest,request:Request):
    _ensure_artifact_project(db(request),project_id,artifact_id)
    return await register_asset(artifact_id,body,request)

@app.get("/api/assets/intake")
async def list_intake(request:Request,project_id:str,collection:str|None=None,status:str|None=None,logical_asset_id:str|None=None,asset_class:str|None=None):
    database=db(request)
    clauses=["project_id=?"]; params:list[Any]=[project_id]
    if collection:clauses.append("collection=?"); params.append(collection)
    if status:clauses.append("status=?"); params.append(status)
    if logical_asset_id:clauses.append("logical_asset_id=?"); params.append(logical_asset_id)
    if asset_class:clauses.append("asset_class=?"); params.append(asset_class)
    where=" AND ".join(clauses)
    with database.connect() as c:
        rows=c.execute(f"SELECT * FROM artifacts WHERE {where} ORDER BY created_at DESC",params).fetchall()
    artifacts=[asset_audit.artifact_payload(database,r) for r in rows]
    for a in artifacts:
        a["failure_count"]=asset_audit.count_qa_failures(database,project_id,a["logical_asset_id"])
        a["force_rebuild"]=asset_audit.should_force_rebuild(database,project_id,a["logical_asset_id"],a["asset_class"] or "unknown")
    return {"artifacts":artifacts,"counts":{"total":len(artifacts),"unqualified":sum(1 for a in artifacts if a["collection"]=="unqualified"),"qualified":sum(1 for a in artifacts if a["collection"]=="qualified"),"intake":sum(1 for a in artifacts if a["collection"]=="intake")}}

@app.get("/api/assets/artifacts/{artifact_id}")
async def get_artifact(artifact_id:str,request:Request):
    database=db(request); row=_artifact_row(database,artifact_id); a=asset_audit.artifact_payload(database,row); a["failure_count"]=asset_audit.count_qa_failures(database,row["project_id"],row["logical_asset_id"]); a["force_rebuild"]=asset_audit.should_force_rebuild(database,row["project_id"],row["logical_asset_id"],row["asset_class"] or "unknown"); a["url"]=artifact_url(row["project_id"],Path(row["local_path"])); return {"artifact":a}

@app.post("/api/assets/artifacts/{artifact_id}/map")
async def map_artifact(artifact_id:str,body:ArtifactMapRequest,request:Request):
    database=db(request); row=_artifact_row(database,artifact_id); doc,_=await read_project_doc(request,row["project_id"]); _project_asset(doc,body.logical_asset_id)
    cls=body.asset_class.strip().lower()
    if cls not in asset_audit.ASSET_CLASSES:raise HTTPException(422,"资产类型无效。")
    old_metadata=database.decode(row["metadata_json"],{})
    usage=asset_audit.infer_artifact_usage(old_metadata.get("original_name"),row["mime_type"],cls,body.asset_role,old_metadata)
    metadata={**old_metadata,"relevant_shots":body.relevant_shots,**usage}
    next_status="reference_pending_review" if usage["usage_scope"]=="reference" else "generated_pending_qa"
    with database.connect() as c:
        c.execute("UPDATE artifacts SET logical_asset_id=?,asset_class=?,asset_role=?,prompt_version=?,qa_owner=?,metadata_json=?,updated_at=? WHERE id=?",(body.logical_asset_id,cls,body.asset_role,body.prompt_version,asset_audit.QA_OWNER_BY_CLASS.get(cls),database.encode(metadata),utcnow(),artifact_id))
    asset_audit.transition_artifact(database,artifact_id,next_status,{"mapped":True,"usage":usage})
    return {"ok":True,"artifact":asset_audit.artifact_payload(database,_artifact_row(database,artifact_id))}

@app.post("/api/assets/artifacts/{artifact_id}/qa-runs")
async def create_qa_run(artifact_id:str,body:QARunCreate,request:Request):
    database=db(request); row=_artifact_row(database,artifact_id); project_id=row["project_id"]
    if row["status"] not in {"generated_pending_qa","reference_pending_review","audit_blocked","qa_in_progress"}:raise HTTPException(409,f"当前状态 {row['status']} 不能发起 QA。")
    meta=database.decode(row["metadata_json"],{})
    expected_qa=asset_audit.qa_type_for_artifact(row["asset_class"],row["mime_type"],meta)
    if body.qa_type == "prompt" and expected_qa in {"video", "audio", "reference"}:
        return structured_error(422, "media_qa_required", "qa", f"该候选必须先完成 {expected_qa} 媒体 QA；Prompt QA 不能替代媒体审核。", {"expected": expected_qa, "actual": body.qa_type}, retryable=False)
    if body.qa_type != expected_qa and body.qa_type != "prompt":
        return structured_error(422,"media_qa_type_mismatch","qa",f"该候选必须使用 {expected_qa} QA。",{"expected":expected_qa,"actual":body.qa_type},retryable=False)
    if body.qa_type == "audio" and row["asset_class"] not in {"audio", "music", "sfx"}:
        raise HTTPException(409, "只有 audio / music / sfx artifact 可以发起声音 QA。")
    if body.qa_type == "video" and not str(row["mime_type"] or "").startswith("video/"):
        return structured_error(422,"media_type_mismatch","qa","正式视频 QA 只能用于视频文件，当前候选不是视频。",{},retryable=False)
    if body.qa_type == "reference" and not str(row["mime_type"] or "").startswith("image/"):
        return structured_error(422,"media_type_mismatch","qa","参考审核只能用于图片关键帧或构图板。",{},retryable=False)
    # Idempotent: reuse the latest pending/blocked run for this artifact instead of duplicating.
    with database.connect() as c:
        existing=c.execute("SELECT * FROM asset_qa_runs WHERE artifact_id=? AND qa_type=? AND status IN ('pending','running','blocked') ORDER BY created_at DESC LIMIT 1",(artifact_id,body.qa_type)).fetchone()
    if existing and row["status"] in {"qa_in_progress","audit_blocked"}:
        return {"qa_run":asset_audit.qa_run_payload(database,existing),"blocked":existing["status"]=="blocked","artifact":asset_audit.artifact_payload(database,row)}
    cls=row["asset_class"]; qa_owner=asset_audit.QA_OWNER_BY_CLASS.get(cls)
    if not qa_owner or cls in {"unknown",None}:
        asset_audit.transition_artifact(database,artifact_id,"audit_blocked",{"reason":"unmapped"})
        return structured_error(409,"qa_unmapped","mapping","无法确定 QA Owner，请先完成资产映射。",{"asset_class":cls},retryable=False)
    now=utcnow(); rid=asset_audit.new_id("QARUN"); capability="none"; blocked_reason=None; run_status="pending"; profile=None
    if body.qa_type in {"image", "video", "reference"}:
        if body.manual_review or body.qa_type in {"video", "reference"}:
            capability="manual"
        else:
            profile=_vision_profile(database)
            capability="vision" if profile and asset_audit.supports_vision(profile) else "none"
        if capability=="none":
            run_status="blocked"; blocked_reason="no_vision_capability"
        else:
            if meta.get("is_sensitive") and meta.get("authorization_status") not in {"cleared","not-required","consent-verified"}:
                run_status="blocked"; blocked_reason="sensitive_material_unauthorized"
    provider_profile_id=profile["id"] if (body.qa_type=="image" and profile and asset_audit.supports_vision(profile)) else None
    with database.connect() as c:
        c.execute("INSERT INTO asset_qa_runs(id,project_id,artifact_id,logical_asset_id,qa_owner,qa_type,status,decision,report_json,provider_profile_id,provider_model,capability,blocked_reason,started_at,finished_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (rid,project_id,artifact_id,row["logical_asset_id"],qa_owner,body.qa_type,run_status,None,"{}",provider_profile_id,None,capability,blocked_reason,None,None,now))
    if run_status=="blocked":
        asset_audit.transition_artifact(database,artifact_id,"audit_blocked",{"reason":blocked_reason})
    else:
        asset_audit.transition_artifact(database,artifact_id,"qa_in_progress",{"qa_run_id":rid})
    run=asset_audit.qa_run_payload(database,_qa_row(database,rid))
    return {"qa_run":run,"blocked":run_status=="blocked","artifact":asset_audit.artifact_payload(database,_artifact_row(database,artifact_id))}

def _qa_row(database:Database,rid:str):
    with database.connect() as c:row=c.execute("SELECT * FROM asset_qa_runs WHERE id=?",(rid,)).fetchone()
    if not row:raise HTTPException(404,"QA Run 不存在。")
    return row


def _audio_qa_missing(report: dict[str, Any]) -> list[str]:
    """Return missing human-listening checks for an Approved audio artifact."""
    required = {
        "technical": ("format", "sample_rate", "channels", "duration", "no_clipping", "noise_ok"),
        "performance": ("text_accuracy", "pronunciation", "language_dialect", "emotion", "rhythm", "continuity", "handles"),
        "rights": ("authorization",),
    }
    missing: list[str] = []
    for section, keys in required.items():
        values = report.get(section)
        if not isinstance(values, dict):
            missing.append(section)
            continue
        for key in keys:
            value = values.get(key)
            if value is None or value is False or (isinstance(value, str) and not value.strip()):
                missing.append(f"{section}.{key}")
    return missing


async def _mark_audio_record_qa(request: Request, project_id: str, artifact_id: str, qa_run_id: str, decision: str) -> None:
    doc, revision = await read_project_doc(request, project_id)
    audio = _audio_studio_document(doc)
    status = {"Approved": "approved", "Needs revision": "needs-revision", "Rejected": "rejected", "Blocked": "blocked"}.get(decision, decision)
    for collection in ("voice_references", "auditions", "takes"):
        for item in audio.get(collection, []):
            if isinstance(item, dict) and str(item.get("artifact_id") or "") == artifact_id:
                item["qa_run_id"] = qa_run_id
                item["status"] = status
    doc["audio"] = audio
    save_project_document(request, doc, revision)

@app.get("/api/assets/qa-runs/{qa_run_id}")
async def get_qa_run(qa_run_id:str,request:Request):return {"qa_run":asset_audit.qa_run_payload(db(request),_qa_row(db(request),qa_run_id))}

@app.post("/api/assets/qa-runs/{qa_run_id}/submit")
async def submit_qa_decision(qa_run_id:str,body:QADecisionSubmit,request:Request):
    database=db(request); run=_qa_row(database,qa_run_id); artifact=_artifact_row(database,run["artifact_id"]); project_id=run["project_id"]
    expected_owner=asset_audit.QA_OWNER_BY_CLASS.get(artifact["asset_class"])
    if expected_owner and run["qa_owner"]!=expected_owner:
        return structured_error(409,"qa_owner_mismatch","qa",f"QA Owner 必须是 {expected_owner}，不能由其他 Skill 代替。",{"expected":expected_owner,"actual":run["qa_owner"]},retryable=False)
    if body.decision not in asset_audit.QA_DECISIONS:
        return structured_error(422,"invalid_decision","qa","QA 决策无效。",{"allowed":sorted(asset_audit.QA_DECISIONS)},retryable=False)
    report=body.report or {}
    if body.decision!="Blocked" and not report:
        return structured_error(422,"empty_report","qa","QA 报告不能为空。",{},retryable=False)
    if run["qa_type"] == "audio" and body.decision == "Approved":
        missing = _audio_qa_missing(report)
        if missing:
            return structured_error(422,"audio_qa_incomplete","qa","声音 QA 尚未完成全部技术、表演和授权检查。",{"missing":missing},retryable=False)
    if run["qa_type"] == "video" and body.decision == "Approved":
        required_video_checks = {"file_playable", "duration_target", "technical_format", "first_last_frame", "content_match", "continuity", "visual_artifacts", "av_sync", "lineage_complete"}
        video_checks = report.get("video_checks") if isinstance(report.get("video_checks"), dict) else {}
        missing_video_checks = sorted(key for key in required_video_checks if video_checks.get(key) is not True)
        if missing_video_checks:
            return structured_error(422,"video_qa_incomplete","qa","视频 QA 尚未完成全部检查项。",{"missing":missing_video_checks},retryable=False)
    now=utcnow()
    with database.connect() as c:
        c.execute("UPDATE asset_qa_runs SET status='completed',decision=?,report_json=?,finished_at=? WHERE id=?",(body.decision,database.encode({"decision":body.decision,"observed_issues":body.observed_issues,"affected_shots":body.affected_shots,"approved_roles":body.approved_roles,"forbidden_roles":body.forbidden_roles,"image_editable":body.image_editable,"rebuild_required":body.rebuild_required,**report}),now,qa_run_id))
        c.execute("UPDATE artifacts SET qa_decision=?,qa_report_json=?,updated_at=? WHERE id=?",(body.decision,database.encode(report),now,run["artifact_id"]))
    if body.decision=="Approved" and run["qa_type"]=="reference":
        asset_audit.transition_artifact(database,run["artifact_id"],"reference",{"qa_run_id":qa_run_id,"reference_review":True})
        if artifact["logical_asset_id"]:
            def _up_reference(a):a["qaDecision"]="Approved";a["status"]="reference";a["referenceReady"]=True
            await _update_project_asset(request,project_id,artifact["logical_asset_id"],_up_reference)
    elif body.decision=="Approved":
        asset_audit.transition_artifact(database,run["artifact_id"],"approved_pending_registration",{"qa_run_id":qa_run_id})
        if artifact["logical_asset_id"]:
            def _up(a):a["qaDecision"]="Approved";a["status"]="generated-pending-qa"
            await _update_project_asset(request,project_id,artifact["logical_asset_id"],_up)
    elif body.decision=="Needs revision":
        asset_audit.transition_artifact(database,run["artifact_id"],"revision_required",{"qa_run_id":qa_run_id})
        with database.connect() as c:c.execute("UPDATE artifacts SET rejection_reason=? WHERE id=?",("Needs revision: "+"; ".join(body.observed_issues[:3] or ["未说明"]),run["artifact_id"]))
        if artifact["logical_asset_id"]:
            def _up(a):a["qaDecision"]="Needs revision";a["status"]="revision-required"
            await _update_project_asset(request,project_id,artifact["logical_asset_id"],_up)
    elif body.decision in {"Reject and rebuild prompt", "Rejected"}:
        asset_audit.transition_artifact(database,run["artifact_id"],"rejected",{"qa_run_id":qa_run_id})
        with database.connect() as c:c.execute("UPDATE artifacts SET rejection_reason=? WHERE id=?",(body.decision,run["artifact_id"]))
        if artifact["logical_asset_id"]:
            def _up(a):a["qaDecision"]="Rejected";a["status"]="revision-required"
            await _update_project_asset(request,project_id,artifact["logical_asset_id"],_up)
    elif body.decision=="Blocked":
        asset_audit.transition_artifact(database,run["artifact_id"],"audit_blocked",{"qa_run_id":qa_run_id})
    if run["qa_type"] == "audio":
        await _mark_audio_record_qa(request, project_id, run["artifact_id"], qa_run_id, body.decision)
    updated_artifact=_artifact_row(database,run["artifact_id"])
    audit_trail.record_event(
        database, project_id=project_id, action="qa_decision_submitted", target_type="artifact",
        target_id=str(run["artifact_id"]), reason="qa_decision_submitted",
        before={"status":artifact["status"],"qa_decision":artifact["qa_decision"]},
        after={"status":updated_artifact["status"],"qa_decision":updated_artifact["qa_decision"]},
        metadata={"qa_run_id":qa_run_id,"qa_type":run["qa_type"],"decision":body.decision},
    )
    return {"qa_run":asset_audit.qa_run_payload(database,_qa_row(database,qa_run_id)),"artifact":asset_audit.artifact_payload(database,_artifact_row(database,run["artifact_id"]))}

@app.post("/api/assets/artifacts/{artifact_id}/register")
async def register_asset(artifact_id:str,body:ArtifactRegisterRequest,request:Request):
    database=db(request); row=_artifact_row(database,artifact_id); project_id=row["project_id"]
    metadata=database.decode(row["metadata_json"],{})
    usage=asset_audit.infer_artifact_usage(metadata.get("original_name"),row["mime_type"],row["asset_class"],row["asset_role"],metadata)
    if usage["usage_scope"]=="reference":
        return structured_error(409,"reference_only","registration","该文件是分镜/构图参考素材，不能登记为可入镜生产资产。",{"usage":usage,"next_action":"完成参考审核或上传正式视频"},retryable=False)
    # Idempotent: if this artifact is already registered, return the existing version.
    if row["status"]=="ready":
        with database.connect() as c:
            existing=c.execute("SELECT * FROM asset_versions WHERE project_id=? AND artifact_id=? ORDER BY version DESC LIMIT 1",(project_id,artifact_id)).fetchone()
        if existing:return {"ok":True,"asset_version":asset_audit.asset_version_payload(database,existing),"artifact":asset_audit.artifact_payload(database,row),"is_active":bool(existing["is_active"]),"already_registered":True}
        raise HTTPException(409,"该 artifact 已登记但未找到版本记录。")
    if row["status"]!="approved_pending_registration":raise HTTPException(409,f"QA 尚未通过，当前状态 {row['status']}，不能登记。")
    path=Path(row["local_path"]).resolve()
    if not path.is_file():return structured_error(409,"file_missing","registration","文件不存在，不能登记为生产就绪。",{},retryable=False)
    if not row["sha256"]:return structured_error(409,"hash_missing","registration","文件哈希未登记。",{},retryable=False)
    project_root=(DATA_DIR/"projects"/project_id).resolve()
    try:
        path.relative_to(project_root)
    except ValueError:
        return structured_error(409,"file_outside_project","registration","正式登记文件必须位于当前项目目录。",{},retryable=False)
    actual_sha=sha256_file(path)
    if actual_sha and actual_sha.lower()!=str(row["sha256"]).lower():
        return structured_error(409,"hash_mismatch","registration","文件内容已变化，SHA-256 与入库记录不一致。",{"expected":row["sha256"],"actual":actual_sha},retryable=False)
    expected_owner=asset_audit.QA_OWNER_BY_CLASS.get(row["asset_class"])
    if expected_owner and row["qa_owner"]!=expected_owner:return structured_error(409,"qa_owner_mismatch","registration","QA Owner 与资产类型不符。",{},retryable=False)
    if not row["logical_asset_id"]:return structured_error(409,"unmapped","registration","尚未映射到逻辑资产。",{},retryable=False)
    if row["asset_class"]=="fusion":
        doc,_=await read_project_doc(request,project_id); fusion_asset=_project_asset(doc,row["logical_asset_id"]); gate=_fusion_gate(doc,fusion_asset,database,project_id)
        if not gate["allowed"]:
            return structured_error(409,"fusion_gate_blocked","registration","融合资产尚未通过基础资产门禁。",gate,retryable=False)
    existing_active=None
    with database.connect() as c:existing_active=c.execute("SELECT * FROM asset_versions WHERE project_id=? AND logical_asset_id=? AND is_active=1",(project_id,row["logical_asset_id"])).fetchone()
    is_active=(existing_active is None) or body.replace_active
    status="active" if is_active else "candidate"
    registration={"asset_id":row["logical_asset_id"],"asset_class":row["asset_class"],"version":row["version"],"project_path":row["local_path"],"source_generation_id":row["generation_id"],"source_prompt_version":row["prompt_version"],"generation_source":row["source_type"],"qa_owner":row["qa_owner"],"qa_decision":row["qa_decision"],"registered_by":"video-asset-regulator","registered_at":utcnow()}
    av=asset_audit.create_asset_version(database,project_id,row["logical_asset_id"],row["asset_class"] or "unknown",artifact_id,row["prompt_version"],status,is_active,registration)
    asset_audit.transition_artifact(database,artifact_id,"ready",{"asset_version_id":av["id"]})
    if is_active:
        def _up(a):
            a["artifactId"]=artifact_id;a["filePath"]=artifact_url(project_id,path);a["sha256"]=row["sha256"];a["version"]=av["version"];a["activeVersionId"]=av["id"];a["approvedVersion"]=av["version"];a["qaDecision"]="Approved";a["regulatorRegistered"]=True;a["status"]="ready";a["readiness"]="ready"
        await _update_project_asset(request,project_id,row["logical_asset_id"],_up)
    with database.connect() as c:
        c.execute("INSERT INTO approvals(id,project_id,subject_type,subject_id,decision,detail_json,created_at) VALUES(?,?,?,?,?,?,?)",(asset_audit.new_id("APR"),project_id,"asset_registration",artifact_id,"registered",database.encode(registration),utcnow()))
    return {"ok":True,"asset_version":av,"artifact":asset_audit.artifact_payload(database,_artifact_row(database,artifact_id)),"is_active":is_active}

@app.post("/api/assets/artifacts/{artifact_id}/resolution")
async def resolve_artifact(artifact_id:str,body:ResolutionRequest,request:Request):
    database=db(request); row=_artifact_row(database,artifact_id); project_id=row["project_id"]; logical=row["logical_asset_id"]; cls=row["asset_class"] or "unknown"
    if body.action in {"revise_prompt","rebuild_prompt"}:
        if not logical:return structured_error(409,"unmapped","resolution","尚未映射到逻辑资产，无法修订或重建 Prompt。",{},retryable=False)
        if body.action=="revise_prompt" and asset_audit.should_force_rebuild(database,project_id,logical,cls):
            return structured_error(409,"rebuild_threshold","resolution","同一融合目标已连续失败两次，禁止继续用旧 Prompt 重试，必须完全重建或人工处理。",{"force_rebuild":True},retryable=False)
        doc,rev=await read_project_doc(request,project_id); asset=_project_asset(doc,logical)
        base_prompt=asset.get("prompt") or ""
        source="revision" if body.action=="revise_prompt" else "rebuild"
        prompt=base_prompt
        if body.reason:prompt=f"{base_prompt}".strip()
        pv=asset_audit.create_prompt_version(database,project_id,logical,cls,prompt,source,asset_audit.QA_OWNER_BY_CLASS.get(cls),parent_version=None,change_reason=body.reason or ("修订 Prompt" if source=="revision" else "完全重建 Prompt"),source_qa_run_id=getattr(body,"source_qa_run_id",None),rebuilt_from_failure_ids=[])
        # Record a domain-skill workflow run for the prompt work.
        skill=asset_audit.QA_OWNER_BY_CLASS.get(cls) or "video-asset-regulator"
        manifest=workflow_manifest(skill); wrid=asset_audit.new_id("RUN")
        with database.connect() as c:
            c.execute("INSERT INTO workflow_runs(id,project_id,skill_id,skill_version,status,input_json,gate_result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",(wrid,project_id,skill,manifest["skill_version"],"validated",database.encode({"purpose":source,"logical_asset_id":logical,"prompt_version":pv["id"],"source_qa_run_id":row["qa_run"] if False else None}),"{}",utcnow(),utcnow()))
        def _up(a):a["prompt"]=prompt;a["promptVersion"]=pv["id"];a["promptQaDecision"]="Pending";a["generationChoice"]="user-confirmation-required"
        await _update_project_asset(request,project_id,logical,_up)
        asset_audit.record_event(database,project_id,artifact_id,logical,row["status"],"prompt_revision" if source=="revision" else "prompt_rebuild",{"prompt_version":pv["id"],"workflow_run_id":wrid})
        return {"ok":True,"action":body.action,"prompt_version":pv,"workflow_run_id":wrid,"next":"prompt_qa_required"}
    if body.action=="manual_review":
        asset_audit.transition_artifact(database,artifact_id,"awaiting_human_review",{"resolution":body.action,"reason":body.reason})
    elif body.action=="keep_unqualified":
        asset_audit.set_artifact_collection(database,artifact_id,"unqualified"); asset_audit.record_event(database,project_id,artifact_id,logical,row["status"],"keep_unqualified",{"reason":body.reason})
    elif body.action=="defer":
        asset_audit.record_event(database,project_id,artifact_id,logical,row["status"],"deferred",{"reason":body.reason})
    return {"ok":True,"action":body.action,"artifact":asset_audit.artifact_payload(database,_artifact_row(database,artifact_id))}

@app.get("/api/assets/{logical_asset_id}/versions")
async def asset_versions(project_id:str,logical_asset_id:str,request:Request):
    return {"versions":asset_audit.list_asset_versions(db(request),project_id,logical_asset_id)}

@app.get("/api/assets/{logical_asset_id}/prompt-versions")
async def prompt_versions(project_id:str,logical_asset_id:str,request:Request):
    return {"prompt_versions":asset_audit.list_prompt_versions(db(request),project_id,logical_asset_id)}

@app.post("/api/assets/{logical_asset_id}/prompt-versions")
async def create_prompt_version(project_id:str,logical_asset_id:str,body:PromptCreateRequest,request:Request):
    database=db(request); doc,_=await read_project_doc(request,project_id); asset=_project_asset(doc,logical_asset_id)
    cls=asset_audit.asset_class_for_skill(asset.get("skill")) or asset_audit.classify_by_role(asset.get("type"))
    if cls=="fusion" and body.source!="fusion-connection-agent":raise HTTPException(409,"融合资产的正式 Prompt 只能由确认连线后的定向融合流程生成。")
    pv=asset_audit.create_prompt_version(database,project_id,logical_asset_id,cls,body.prompt,body.source,body.skill_id or asset_audit.QA_OWNER_BY_CLASS.get(cls),parent_version=None,change_reason=body.change_reason,source_qa_run_id=body.source_qa_run_id,rebuilt_from_failure_ids=body.rebuilt_from_failure_ids)
    asset["prompt"]=body.prompt; asset["promptVersion"]=pv["id"]; asset["promptQaDecision"]="Pending"; asset["generationChoice"]="user-confirmation-required"
    save_project_document(request,doc,_get_rev(db(request),project_id))
    return {"prompt_version":pv}

def _get_rev(database:Database,project_id:str)->int:
    with database.connect() as c:r=c.execute("SELECT revision FROM projects WHERE id=?",(project_id,)).fetchone()
    return r["revision"] if r else 1

@app.post("/api/assets/prompt-versions/{prompt_version_id}/qa")
async def prompt_qa_decision(prompt_version_id:str,body:PromptQADecision,request:Request):
    database=db(request)
    with database.connect() as c:row=c.execute("SELECT * FROM prompt_versions WHERE id=?",(prompt_version_id,)).fetchone()
    if not row:raise HTTPException(404,"Prompt 版本不存在。")
    doc,rev=await read_project_doc(request,row["project_id"]); asset=_project_asset(doc,row["logical_asset_id"])
    before_asset=json.loads(json.dumps(asset,ensure_ascii=False))
    if _asset_class(asset)=="fusion" and asset.get("fusionPromptSource")!="fusion-connection-agent":raise HTTPException(409,"融合资产必须先完成实际连线并生成正式融合 Prompt。")
    status={"Approved":"prompt_qa_approved","Needs revision":"prompt_qa_needs_revision","Blocked":"prompt_qa_blocked"}[body.decision]
    if body.decision=="Approved":
        try:row=approve_prompt_version(database,prompt_version_id)
        except PromptAuthorityError as exc:raise HTTPException(409,{"message":exc.message,"prompt_authority":exc.payload()}) from exc
    else:
        with database.connect() as c:
            c.execute("UPDATE prompt_versions SET status=? WHERE id=?",(status,prompt_version_id))
            row=c.execute("SELECT * FROM prompt_versions WHERE id=?",(prompt_version_id,)).fetchone()
    if body.decision=="Approved":
        asset["promptQaDecision"]="Approved"; asset["prompt"]=row["prompt"]; asset["promptVersion"]=prompt_version_id; asset["generationChoice"]="user-confirmation-required"
    else:
        asset["promptQaDecision"]="Needs revision" if body.decision=="Needs revision" else "Blocked"
    save_project_document(
        request,doc,rev,
        audit_event={
            "action":"prompt_qa_decision", "target_type":"prompt", "target_id":prompt_version_id,
            "reason":"prompt_qa_decision", "before":{"asset_id":row["logical_asset_id"],"prompt_qa_decision":before_asset.get("promptQaDecision")},
            "after":{"asset_id":row["logical_asset_id"],"prompt_qa_decision":asset.get("promptQaDecision"),"prompt_version":prompt_version_id},
            "metadata":{"decision":body.decision},
        },
    )
    return {"ok":True,"prompt_version":asset_audit.prompt_version_payload(database,row),"decision":body.decision}

@app.get("/api/projects/{project_id}/shot-assets")
async def shot_assets(project_id:str,request:Request):
    doc,rev=await read_project_doc(request,project_id)
    assets={a.get("id"):a for a in doc.get("assets",[])}
    shots=[]
    for s in doc.get("shots",[]):
        reqs=s.get("assetRequirements",[])
        resolved=[]
        for r in reqs:
            a=assets.get(r.get("assetId"))
            resolved.append({"assetId":r.get("assetId"),"assetClass":r.get("assetClass"),"role":r.get("role"),"priority":r.get("priority"),"required":r.get("required",True),"requiredReadiness":r.get("requiredReadiness","production"),"asset":a if a else None})
        shots.append({"shot_id":s.get("id"),"requirements":resolved})
    return {"project_id":project_id,"shots":shots,"assets":assets}


def _library_page(library:dict[str,Any],page:int|None,page_size:int,q:str|None,asset_type:str|None,status:str|None,sort:str)->dict[str,Any]:
    """Apply server-side library query semantics after the authoritative projection."""
    assets=list(library.get("assets") or [])
    needle=str(q or "").strip().lower(); selected_type=str(asset_type or "").strip().lower(); selected_status=str(status or "all").strip().lower()
    if selected_type and selected_type!="all":
        allowed={"scene","prop"} if selected_type=="scene-prop" else {selected_type}
        assets=[item for item in assets if str(item.get("assetClass") or "").lower() in allowed]
    if needle:
        assets=[item for item in assets if needle in " ".join(str(item.get(key) or "") for key in ("id","name","assetClass","assetRole","prompt")).lower()]
    if selected_status!="all":
        def matches(item:dict[str,Any])->bool:
            readiness=item.get("readiness") or {}
            if selected_status=="production":return bool(readiness.get("production_ready"))
            if selected_status=="registered":return bool(readiness.get("registered_ready"))
            if selected_status=="blocked":return str(readiness.get("status") or "")=="blocked"
            if selected_status=="candidate":return int(item.get("artifact_count") or 0)>0 and not bool(readiness.get("registered_ready"))
            if selected_status=="audit":return str(readiness.get("status") or "") in {"partial","provisional"}
            if selected_status=="missing":return int(item.get("artifact_count") or 0)==0
            return True
        assets=[item for item in assets if matches(item)]
    if sort=="id":assets.sort(key=lambda item:str(item.get("id") or ""))
    elif sort=="grade":
        rank={"A+":0,"A":1,"B":2,"C":3,"optional":4,"Reject":5}; assets.sort(key=lambda item:(rank.get(str(item.get("grade") or "B"),9),str(item.get("id") or "")))
    elif sort=="updated":assets.sort(key=lambda item:str(item.get("updatedAt") or item.get("updated_at") or ""),reverse=True)
    else:assets.sort(key=lambda item:(not bool((item.get("readiness") or {}).get("required")),bool((item.get("readiness") or {}).get("production_ready")),str(item.get("id") or "")))
    total=len(assets)
    if page is None:return {**library,"assets":assets,"pagination":{"page":1,"page_size":total,"total":total,"page_count":1,"paginated":False}}
    size=max(1,min(int(page_size),200)); page_count=max(1,(total+size-1)//size); current=max(1,min(int(page),page_count)); start=(current-1)*size
    return {**library,"assets":assets[start:start+size],"pagination":{"page":current,"page_size":size,"total":total,"page_count":page_count,"paginated":True}}


@app.get("/api/v2/projects/{project_id}/assets")
async def asset_library(project_id:str,request:Request,page:int|None=None,page_size:int=100,q:str|None=None,asset_type:str|None=None,status:str|None=None,sort:str="priority"):
    if page is not None and page<1:raise HTTPException(422,"page 必须大于等于 1。")
    if page_size<1 or page_size>200:raise HTTPException(422,"page_size 必须在 1 到 200 之间。")
    if sort not in {"priority","grade","updated","id"}:raise HTTPException(422,"sort 参数无效。")
    doc,_=await read_project_doc(request,project_id)
    return _library_page(_library_payload(db(request),project_id,doc),page,page_size,q,asset_type,status,sort)


@app.get("/api/v2/projects/{project_id}/assets/{logical_asset_id}/workflow")
async def asset_workflow_v3(project_id:str,logical_asset_id:str,request:Request):
    library=await asset_library(project_id,request)
    asset=next((item for item in library["assets"] if item["id"]==logical_asset_id),None)
    if asset is None:raise HTTPException(404,f"逻辑资产 {logical_asset_id} 不存在于当前项目。")
    return {"project_id":project_id,"logical_asset_id":logical_asset_id,"workflow":asset["workflow"],"readiness":asset["readiness"]}


@app.get("/api/v2/projects/{project_id}/asset-audit")
async def asset_audit_queue(project_id:str,request:Request,queue:str|None=None):
    doc,_=await read_project_doc(request,project_id)
    allowed={"all","mapping","image_qa","video_qa","audio_qa","reference_qa","qa_in_progress","registration","revision","rejected","archived"}
    if queue and queue not in allowed:raise HTTPException(422,{"message":"审计队列无效。","allowed":sorted(allowed)})
    return _asset_audit_payload(db(request),project_id,doc,queue)


@app.get("/api/v2/projects/{project_id}/artifacts/{artifact_id}")
async def artifact_detail_v3(project_id:str,artifact_id:str,request:Request):
    database=db(request); row=_ensure_artifact_project(database,project_id,artifact_id)
    artifact=asset_audit.artifact_payload(database,row)
    artifact["failure_count"]=asset_audit.count_qa_failures(database,project_id,artifact.get("logical_asset_id"))
    artifact["force_rebuild"]=asset_audit.should_force_rebuild(database,project_id,artifact.get("logical_asset_id"),artifact.get("asset_class") or "unknown")
    with database.connect() as connection:
        qa_rows=connection.execute("SELECT * FROM asset_qa_runs WHERE project_id=? AND artifact_id=? ORDER BY created_at DESC",(project_id,artifact_id)).fetchall()
    artifact["qa_runs"]=[asset_audit.qa_run_payload(database,row) for row in qa_rows]
    return {"project_id":project_id,"artifact":artifact,"url":artifact.get("url")}


@app.get("/api/v2/projects/{project_id}/assets/{logical_asset_id}/prompt-versions")
async def prompt_versions_v3(project_id:str,logical_asset_id:str,request:Request):
    doc,_=await read_project_doc(request,project_id); _project_asset(doc,logical_asset_id)
    return {"project_id":project_id,"logical_asset_id":logical_asset_id,"prompt_versions":asset_audit.list_prompt_versions(db(request),project_id,logical_asset_id)}


@app.post("/api/v2/projects/{project_id}/assets/{logical_asset_id}/prompt-versions")
async def create_prompt_version_v3(project_id:str,logical_asset_id:str,body:PromptCreateRequest,request:Request):
    database=db(request); doc,revision=await read_project_doc(request,project_id); asset=_project_asset(doc,logical_asset_id)
    before_asset=json.loads(json.dumps(asset,ensure_ascii=False))
    cls=_asset_class(asset)
    if cls=="fusion" and body.source!="fusion-connection-agent":raise HTTPException(409,"融合资产的正式 Prompt 只能由确认连线后的定向融合流程生成。")
    latest=asset_audit.get_prompt_version(database,None,project_id,logical_asset_id)
    with database.connect() as connection:
        pv=asset_audit.create_prompt_version(database,project_id,logical_asset_id,cls,body.prompt,body.source,body.skill_id or asset_audit.QA_OWNER_BY_CLASS.get(cls),parent_version=int(latest["version"]) if latest else None,change_reason=body.change_reason,source_qa_run_id=body.source_qa_run_id,rebuilt_from_failure_ids=body.rebuilt_from_failure_ids,connection=connection)
        asset["prompt"]=body.prompt; asset["promptVersion"]=pv["id"]; asset["promptQaDecision"]="Pending"; asset["generationChoice"]="user-confirmation-required"
        next_revision=save_project_document(
            request,doc,revision,connection=connection,
            audit_event={
                "action":"prompt_version_created", "target_type":"prompt", "target_id":pv["id"],
                "reason":"prompt_version_created", "before":{"asset_id":logical_asset_id,"prompt":before_asset.get("prompt"),"prompt_version":before_asset.get("promptVersion")},
                "after":{"asset_id":logical_asset_id,"prompt":body.prompt,"prompt_version":pv["id"],"version":pv["version"]},
                "metadata":{"logical_asset_id":logical_asset_id,"change_reason":body.change_reason},
            },
        )
    asset_audit.record_event(database,project_id,None,logical_asset_id,"prompt_version_created","prompt_version_created",{"prompt_version":pv["id"],"version":pv["version"]})
    return {"project_id":project_id,"revision":next_revision,"prompt_version":pv}


@app.post("/api/v2/projects/{project_id}/assets")
async def create_asset_v3(project_id:str,body:AssetCreateV3,request:Request):
    database=db(request); doc,revision=await read_project_doc(request,project_id)
    if revision!=body.expected_revision:raise HTTPException(409,{"message":"项目已有更新，请刷新后重试。","current_revision":revision})
    if any(str(item.get("name") or "").strip()==body.name.strip() for item in doc.get("assets",[]) if isinstance(item,dict)):
        raise HTTPException(409,"当前项目已经存在同名逻辑资产。")
    asset_id=f"asset-{secrets.token_hex(6)}"; now=utcnow(); skill=body.asset_class
    asset={"id":asset_id,"name":body.name.strip(),"skill":skill,"assetClass":body.asset_class,"assetRole":body.asset_role.strip(),"grade":body.grade,"required":body.required,"status":"missing","prompt":"","assetMetadata":{"asset_class":body.asset_class,"asset_role":body.asset_role.strip(),"created_source":"asset-board"},"createdAt":now,"updatedAt":now}
    doc.setdefault("assets",[]).append(asset)
    next_revision=save_project_document(
        request,doc,revision,
        audit_event={
            "action":"asset_created", "target_type":"logical_asset", "target_id":asset_id,
            "reason":"logical_asset_created", "before":{}, "after":asset,
            "metadata":{"asset_class":body.asset_class,"asset_role":body.asset_role.strip()},
        },
    )
    return {"project_id":project_id,"revision":next_revision,"asset":asset,"library":_library_payload(database,project_id,doc)}


def _replace_artifact_pointers(value:Any,artifact_ids:dict[str,str])->None:
    if isinstance(value,dict):
        for key,item in list(value.items()):
            if key in {"artifactId","artifact_id","activeArtifactId","active_artifact_id","supersedes_artifact_id"} and item is not None:
                value[key]=artifact_ids.get(str(item),item)
            else:
                _replace_artifact_pointers(item,artifact_ids)
    elif isinstance(value,list):
        for item in value:_replace_artifact_pointers(item,artifact_ids)


def _copy_asset_database_rows(database:Database,project_id:str,source_asset_id:str,target_asset_id:str)->dict[str,str]:
    """Copy the visible asset lineage without duplicating physical media files."""
    artifact_ids:dict[str,str]={}
    artifact_columns=("project_id","artifact_type","role","version","local_path","sha256","mime_type","metadata_json","provider_profile_id","provider_model","prompt_version","task_id","qa_owner","qa_decision","status","created_at","logical_asset_id","asset_class","asset_role","collection","intake_status","source_type","generation_id","attempt_number","qa_report_json","rejection_reason","supersedes_artifact_id","updated_at")
    with database.connect() as c:
        artifacts=c.execute("SELECT * FROM artifacts WHERE project_id=? AND logical_asset_id=? ORDER BY created_at",(project_id,source_asset_id)).fetchall()
        for row in artifacts:
            new_id=asset_audit.new_id("ART"); artifact_ids[str(row["id"])]=new_id
            values=[project_id]+[row[column] for column in artifact_columns[1:]]
            values[16]=target_asset_id
            values[26]=artifact_ids.get(str(row["supersedes_artifact_id"] or ""),row["supersedes_artifact_id"])
            columns=", ".join(("id",)+artifact_columns)
            placeholders=", ".join("?" for _ in range(len(values)+1))
            c.execute(f"INSERT INTO artifacts({columns}) VALUES({placeholders})",[new_id,*values])

        versions=c.execute("SELECT * FROM asset_versions WHERE project_id=? AND logical_asset_id=?",(project_id,source_asset_id)).fetchall()
        for row in versions:
            c.execute("INSERT INTO asset_versions(id,project_id,logical_asset_id,asset_class,version,artifact_id,prompt_version,prompt_version_id,status,is_active,registration_json,created_at,approved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",(
                asset_audit.new_id("AV"),project_id,target_asset_id,row["asset_class"],row["version"],artifact_ids.get(str(row["artifact_id"]),row["artifact_id"]),row["prompt_version"],None,row["status"],row["is_active"],row["registration_json"],row["created_at"],row["approved_at"]))

        prompts=c.execute("SELECT * FROM prompt_versions WHERE project_id=? AND logical_asset_id=?",(project_id,source_asset_id)).fetchall()
        for row in prompts:
            c.execute("INSERT INTO prompt_versions(id,project_id,logical_asset_id,asset_class,version,parent_version,prompt,source,skill_id,status,change_reason,source_qa_run_id,rebuilt_from_failure_ids,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(
                asset_audit.new_id("PROMPT"),project_id,target_asset_id,row["asset_class"],row["version"],row["parent_version"],row["prompt"],row["source"],row["skill_id"],row["status"],row["change_reason"],row["source_qa_run_id"],row["rebuilt_from_failure_ids"],row["created_at"]))

        qa_runs=c.execute("SELECT * FROM asset_qa_runs WHERE project_id=? AND logical_asset_id=?",(project_id,source_asset_id)).fetchall()
        for row in qa_runs:
            c.execute("INSERT INTO asset_qa_runs(id,project_id,artifact_id,logical_asset_id,qa_owner,qa_type,status,decision,report_json,provider_profile_id,provider_model,capability,blocked_reason,started_at,finished_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(
                asset_audit.new_id("QA"),project_id,artifact_ids.get(str(row["artifact_id"]),row["artifact_id"]),target_asset_id,row["qa_owner"],row["qa_type"],row["status"],row["decision"],row["report_json"],row["provider_profile_id"],row["provider_model"],row["capability"],row["blocked_reason"],row["started_at"],row["finished_at"],row["created_at"]))

        references=c.execute("SELECT * FROM asset_reference_roles_v4 WHERE project_id=? AND logical_asset_id=?",(project_id,source_asset_id)).fetchall()
        for row in references:
            reference_id=artifact_ids.get(str(row["reference_id"]),row["reference_id"])
            c.execute("INSERT INTO asset_reference_roles_v4(id,project_id,logical_asset_id,reference_id,reference_kind,artifact_id,role,source,notes,priority,scope,authority,conflict_group,effective_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(
                asset_audit.new_id("REF"),project_id,target_asset_id,reference_id,row["reference_kind"],artifact_ids.get(str(row["artifact_id"]),row["artifact_id"]),row["role"],row["source"],row["notes"],row["priority"],row["scope"],row["authority"],row["conflict_group"],row["effective_version"],row["created_at"],row["updated_at"]))

        comparisons=c.execute("SELECT * FROM asset_comparisons_v4 WHERE project_id=? AND logical_asset_id=?",(project_id,source_asset_id)).fetchall()
        for row in comparisons:
            candidates=database.decode(row["candidates_json"],[])
            _replace_artifact_pointers(candidates,artifact_ids)
            c.execute("INSERT INTO asset_comparisons_v4(id,project_id,logical_asset_id,comparison_group,strategy,prompt_version,candidates_json,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",(
                asset_audit.new_id("CMP"),project_id,target_asset_id,row["comparison_group"],row["strategy"],row["prompt_version"],database.encode(candidates),row["notes"],row["created_at"],row["updated_at"]))

        dependencies=c.execute("SELECT * FROM asset_dependencies_v4 WHERE project_id=? AND logical_asset_id=?",(project_id,source_asset_id)).fetchall()
        for row in dependencies:
            c.execute("INSERT INTO asset_dependencies_v4(id,project_id,logical_asset_id,dependency_asset_id,shot_id,relation,role,required,created_at) VALUES(?,?,?,?,?,?,?,?,?)",(
                asset_audit.new_id("DEP"),project_id,target_asset_id,row["dependency_asset_id"],row["shot_id"],row["relation"],row["role"],row["required"],row["created_at"]))
    return artifact_ids


@app.post("/api/v2/projects/{project_id}/assets/{logical_asset_id}/duplicate")
async def duplicate_asset_v3(project_id:str,logical_asset_id:str,body:AssetDuplicateV3,request:Request):
    database=db(request); doc,revision=await read_project_doc(request,project_id)
    if revision!=body.expected_revision:raise HTTPException(409,{"message":"项目已有更新，请刷新后重试。","current_revision":revision})
    source=_project_asset(doc,logical_asset_id)
    source_name=str(source.get("name") or logical_asset_id).strip()
    requested_name=str(body.name or f"{source_name} · 副本").strip()
    existing={str(item.get("name") or "").strip() for item in doc.get("assets",[]) if isinstance(item,dict)}
    name=requested_name or f"{source_name} · 副本"
    suffix=2
    while name in existing:
        name=f"{requested_name} {suffix}"; suffix+=1
    target_id=f"asset-{secrets.token_hex(6)}"; now=utcnow()
    asset=json.loads(json.dumps(source,ensure_ascii=False)); asset["id"]=target_id; asset["name"]=name; asset["createdAt"]=now; asset["updatedAt"]=now; asset["copiedFrom"]=logical_asset_id
    asset_metadata=asset.get("assetMetadata") if isinstance(asset.get("assetMetadata"),dict) else {}
    asset["assetMetadata"]={**asset_metadata,"copied_from":logical_asset_id}
    artifact_ids=_copy_asset_database_rows(database,project_id,logical_asset_id,target_id)
    _replace_artifact_pointers(asset,artifact_ids)
    doc.setdefault("assets",[]).append(asset)
    next_revision=save_project_document(
        request,doc,revision,
        audit_event={
            "action":"asset_duplicated", "target_type":"logical_asset", "target_id":target_id,
            "reason":"logical_asset_duplicated", "before":{"source_asset_id":logical_asset_id}, "after":asset,
            "metadata":{"source_asset_id":logical_asset_id,"copied_artifact_count":len(artifact_ids)},
        },
    )
    library=_library_payload(database,project_id,doc)
    copied=next((item for item in library["assets"] if item["id"]==target_id),asset)
    return {"project_id":project_id,"revision":next_revision,"asset":copied,"source_asset_id":logical_asset_id,"library":library}


@app.delete("/api/v2/projects/{project_id}/assets/{logical_asset_id}")
async def delete_asset_v3(project_id:str,logical_asset_id:str,request:Request,expected_revision:int|None=None):
    database=db(request); doc,revision=await read_project_doc(request,project_id)
    if expected_revision is not None and revision!=expected_revision:raise HTTPException(409,{"message":"项目已有更新，请刷新后重试。","current_revision":revision})
    removed_asset=json.loads(json.dumps(_project_asset(doc,logical_asset_id),ensure_ascii=False))
    for shot in doc.get("shots",[]):
        requirements=shot.get("assetRequirements") if isinstance(shot,dict) else None
        if isinstance(requirements,list):shot["assetRequirements"]=[item for item in requirements if not (isinstance(item,dict) and str(item.get("assetId") or item.get("asset_id") or "")==logical_asset_id)]
    for asset in doc.get("assets",[]):
        if not isinstance(asset,dict) or str(asset.get("id"))==logical_asset_id:continue
        for key in ("fusionSourceAssetIds","fusion_source_asset_ids"):
            if isinstance(asset.get(key),list):asset[key]=[value for value in asset[key] if str(value)!=logical_asset_id]
        for key in ("shotDependencies","shot_dependencies"):
            if isinstance(asset.get(key),list):asset[key]=[item for item in asset[key] if not (isinstance(item,dict) and str(item.get("dependency_asset_id") or item.get("dependencyAssetId") or "")==logical_asset_id)]
        metadata=asset.get("assetMetadata")
        if isinstance(metadata,dict):
            for key in ("fusion_source_asset_ids","fusionSourceAssetIds"):
                if isinstance(metadata.get(key),list):metadata[key]=[value for value in metadata[key] if str(value)!=logical_asset_id]
            for key in ("shot_dependencies","shotDependencies"):
                if isinstance(metadata.get(key),list):metadata[key]=[item for item in metadata[key] if not (isinstance(item,dict) and str(item.get("dependency_asset_id") or item.get("dependencyAssetId") or "")==logical_asset_id)]
    doc["assets"]=[asset for asset in doc.get("assets",[]) if not (isinstance(asset,dict) and str(asset.get("id"))==logical_asset_id)]
    next_revision=save_project_document(
        request,doc,revision,
        audit_event={
            "action":"asset_deleted", "target_type":"logical_asset", "target_id":logical_asset_id,
            "reason":"logical_asset_deleted", "before":removed_asset, "after":{},
        },
    )
    with database.connect() as c:
        c.execute("DELETE FROM asset_dependencies_v4 WHERE project_id=? AND (logical_asset_id=? OR dependency_asset_id=?)",(project_id,logical_asset_id,logical_asset_id))
        c.execute("DELETE FROM asset_reference_roles_v4 WHERE project_id=? AND logical_asset_id=?",(project_id,logical_asset_id))
        c.execute("DELETE FROM asset_comparisons_v4 WHERE project_id=? AND logical_asset_id=?",(project_id,logical_asset_id))
        c.execute("DELETE FROM asset_qa_runs WHERE project_id=? AND logical_asset_id=?",(project_id,logical_asset_id))
        c.execute("DELETE FROM asset_versions WHERE project_id=? AND logical_asset_id=?",(project_id,logical_asset_id))
        c.execute("DELETE FROM prompt_versions WHERE project_id=? AND logical_asset_id=?",(project_id,logical_asset_id))
        c.execute("UPDATE artifacts SET logical_asset_id=NULL,asset_class=NULL,asset_role=NULL WHERE project_id=? AND logical_asset_id=?",(project_id,logical_asset_id))
        board_envelope=None
        row=c.execute("SELECT * FROM asset_boards_v7 WHERE project_id=?",(project_id,)).fetchone()
        if row:
            board=database.decode(row["board_json"],{})
            nodes=[node for node in board.get("nodes",[]) if not (isinstance(node,dict) and str(node.get("asset_id") or "")==logical_asset_id)]
            node_ids={str(node.get("id")) for node in nodes if isinstance(node,dict)}
            board["nodes"]=nodes; board["edges"]=[edge for edge in board.get("edges",[]) if isinstance(edge,dict) and edge.get("source") in node_ids and edge.get("target") in node_ids]
            board_revision=int(row["revision"])+1; now=utcnow()
            c.execute("UPDATE asset_boards_v7 SET revision=?,board_json=?,updated_at=? WHERE project_id=?",(board_revision,database.encode(board),now,project_id))
            board_row=c.execute("SELECT * FROM asset_boards_v7 WHERE project_id=?",(project_id,)).fetchone()
            board_envelope=_asset_board_payload(database,project_id,board_row)
    library=_library_payload(database,project_id,doc)
    return {"ok":True,"project_id":project_id,"asset_id":logical_asset_id,"revision":next_revision,"library":library,"asset_board":board_envelope,"story":doc}


def _replace_asset_relations(database:Database,project_id:str,logical_asset_id:str,dependencies:list[dict[str,Any]],references:list[dict[str,Any]],*,connection:sqlite3.Connection|None=None)->None:
    now=utcnow()
    def _replace(c:sqlite3.Connection)->None:
        c.execute("DELETE FROM asset_dependencies_v4 WHERE project_id=? AND logical_asset_id=?",(project_id,logical_asset_id))
        c.execute("DELETE FROM asset_reference_roles_v4 WHERE project_id=? AND logical_asset_id=?",(project_id,logical_asset_id))
        for dependency in dependencies:
            c.execute("INSERT INTO asset_dependencies_v4(id,project_id,logical_asset_id,dependency_asset_id,shot_id,relation,role,required,created_at) VALUES(?,?,?,?,?,?,?,?,?)",(
                asset_audit.new_id("DEP"),project_id,logical_asset_id,dependency["dependency_asset_id"],dependency.get("shot_id"),dependency.get("relation") or "requires",dependency.get("role") or "",int(bool(dependency.get("required",True))),now))
        for reference in references:
            c.execute("INSERT INTO asset_reference_roles_v4(id,project_id,logical_asset_id,reference_id,reference_kind,artifact_id,role,source,notes,priority,scope,authority,conflict_group,effective_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(
                asset_audit.new_id("REF"),project_id,logical_asset_id,reference["reference_id"],reference.get("reference_kind") or "artifact",reference.get("artifact_id"),reference["role"],reference.get("source") or "project",reference.get("notes") or "",int(reference.get("priority") or 100),reference.get("scope") or "general",reference.get("authority") or "supporting",reference.get("conflict_group"),reference.get("effective_version"),now,now))
    if connection is not None:
        _replace(connection)
    else:
        with database.connect() as c:
            _replace(c)


@app.patch("/api/v2/projects/{project_id}/assets/{logical_asset_id}")
async def update_asset_metadata(project_id:str,logical_asset_id:str,body:AssetMetadataUpdate,request:Request):
    database=db(request); doc,revision=await read_project_doc(request,project_id); asset=_project_asset(doc,logical_asset_id)
    before_asset=json.loads(json.dumps(asset,ensure_ascii=False))
    if body.expected_revision is not None and body.expected_revision!=revision:
        raise HTTPException(409,{"message":"项目已有更新。","current_revision":revision})
    asset_class=body.asset_class or _asset_class(asset)
    if asset_class not in asset_audit.ASSET_CLASSES:
        raise HTTPException(422,"资产类型无效。")
    existing_dependencies,existing_references,_=_asset_relations(database,project_id,logical_asset_id)
    references=[item.model_dump() for item in body.references] if body.references is not None else existing_references
    references,reference_errors=normalize_reference_authority(database,project_id,references)
    if reference_errors:
        raise HTTPException(422,{"message":"引用角色不完整。","errors":reference_errors})
    known={str(item.get("id")) for item in doc.get("assets",[]) if isinstance(item,dict)}
    dependencies=[item.model_dump() for item in body.shot_dependencies] if body.shot_dependencies is not None else existing_dependencies
    unknown=[item["dependency_asset_id"] for item in dependencies if item["dependency_asset_id"] not in known]
    if unknown:
        raise HTTPException(422,{"message":"资产依赖不存在。","unknown_dependencies":unknown})
    metadata=_asset_metadata(asset)
    incoming=body.model_dump(exclude_none=True)
    incoming.pop("expected_revision",None)
    incoming["asset_class"]=asset_class
    metadata.update(incoming)
    asset["assetMetadata"]=metadata
    asset["assetClass"]=asset_class
    asset["grade"]=body.grade or asset.get("grade") or "B"
    asset["usageRoles"]=list(body.usage_roles) if body.usage_roles is not None else list(asset.get("usageRoles") or metadata.get("usage_roles") or [])
    asset["identityAnchors"]=dict(body.identity_anchors) if body.identity_anchors is not None else dict(asset.get("identityAnchors") or metadata.get("identity_anchors") or {})
    asset["assetSpec"]=dict(body.asset_spec) if body.asset_spec is not None else dict(asset.get("assetSpec") or metadata.get("asset_spec") or {})
    asset["references"]=[dict(item) for item in references]
    asset["shotDependencies"]=[dict(item) for item in dependencies]
    prompt_changed=body.prompt is not None and body.prompt.strip()!=str(asset.get("prompt") or "").strip()
    latest_prompt=None
    if prompt_changed:
        if asset_class=="fusion" and body.source!="fusion-connection-agent":raise HTTPException(409,"融合资产的正式 Prompt 只能由确认连线后的定向融合流程生成。")
        latest_prompt=asset_audit.get_prompt_version(database,None,project_id,logical_asset_id)
    with database.connect() as mutation_connection:
        if prompt_changed:
            prompt_version=asset_audit.create_prompt_version(database,project_id,logical_asset_id,asset_class,body.prompt or "",body.source or "asset-library",asset_audit.QA_OWNER_BY_CLASS.get(asset_class),parent_version=int(latest_prompt["version"]) if latest_prompt else None,change_reason="资产库编辑 Prompt",connection=mutation_connection)
            asset["prompt"]=body.prompt
            asset["promptVersion"]=prompt_version["id"]
            asset["promptQaDecision"]="Pending"
            asset["generationChoice"]="user-confirmation-required"
        elif body.prompt_version is not None and body.prompt_version==asset.get("promptVersion"):
            asset["promptVersion"]=body.prompt_version
        asset["source"]=body.source if body.source is not None else asset.get("source")
        asset["license"]=body.license if body.license is not None else asset.get("license")
        asset["authorizationStatus"]=body.authorization_status if body.authorization_status is not None else asset.get("authorizationStatus")
        asset["protectedRegions"]=list(body.protected_regions) if body.protected_regions is not None else list(asset.get("protectedRegions") or metadata.get("protected_regions") or [])
        asset["fusionSourceAssetIds"]=list(body.fusion_source_asset_ids) if body.fusion_source_asset_ids is not None else list(asset.get("fusionSourceAssetIds") or metadata.get("fusion_source_asset_ids") or [])
        if asset_class in {"character","scene","prop","product","style","fusion","audio","music","sfx"}:
            asset["skill"]={"character":"character","scene":"scene","prop":"prop","product":"product","style":"style","fusion":"fusion","audio":"audio","music":"music","sfx":"sfx"}[asset_class]
        next_revision=save_project_document(
            request,doc,revision,connection=mutation_connection,
            audit_event={
                "action":"asset_updated", "target_type":"logical_asset", "target_id":logical_asset_id,
                "reason":"asset_metadata_updated", "before":before_asset, "after":asset,
                "metadata":{"asset_class":asset_class,"reference_count":len(references),"dependency_count":len(dependencies)},
            },
        )
        _replace_asset_relations(database,project_id,logical_asset_id,dependencies,references,connection=mutation_connection)
    asset_audit.record_event(database,project_id,None,logical_asset_id,"metadata_updated","metadata_updated",{"asset_class":asset_class,"reference_count":len(references),"dependency_count":len(dependencies)})
    library=_library_payload(database,project_id,doc)
    return {"project_id":project_id,"revision":next_revision,"asset":next((item for item in library["assets"] if item["id"]==logical_asset_id),None),"summary":library["summary"]}


@app.post("/api/v2/projects/{project_id}/assets/{logical_asset_id}/manual-production-approval")
async def manual_production_approval(project_id:str,logical_asset_id:str,body:AssetManualProductionApproval,request:Request):
    """Apply or revoke the narrow human waiver for the Prompt gate."""
    database=db(request)
    doc,revision=await read_project_doc(request,project_id)
    asset=_project_asset(doc,logical_asset_id)
    before_asset=json.loads(json.dumps(asset,ensure_ascii=False))
    if revision!=body.expected_revision:
        raise HTTPException(409,{"message":"项目已有更新，请刷新后重试。","current_revision":revision})
    if body.approved and not body.reason.strip():
        raise HTTPException(422,"人工通过必须填写审核原因。")

    # The waiver may only be attached to the exact currently registered
    # artifact. Never allow it to manufacture a file, QA result, or register
    # an asset that has not passed the base gates.
    base_asset=json.loads(json.dumps(asset,ensure_ascii=False))
    base_asset.pop("manualProductionApproval",None)
    base_asset.pop("manual_production_approval",None)
    base_readiness=asset_audit.asset_readiness(base_asset)
    with database.connect() as connection:
        active_version=connection.execute(
            "SELECT artifact_id FROM asset_versions WHERE project_id=? AND logical_asset_id=? AND is_active=1 ORDER BY version DESC LIMIT 1",
            (project_id,logical_asset_id),
        ).fetchone()
    current_artifact_id=str(asset.get("artifactId") or asset.get("artifact_id") or (active_version["artifact_id"] if active_version else "") or "")
    if body.approved:
        if not base_readiness.get("registered_ready"):
            raise HTTPException(409,{"message":"当前资产尚未完成文件、图片 QA 和资产登记，不能人工通过。","missing":base_readiness.get("missing",[])})
        if not current_artifact_id or body.artifact_id!=current_artifact_id:
            raise HTTPException(409,{"message":"人工通过必须绑定当前登记文件版本。","current_artifact_id":current_artifact_id})
        asset["manualProductionApproval"]={
            "approved":True,
            "artifactId":current_artifact_id,
            "reason":body.reason.strip(),
            "approvedAt":utcnow(),
            "approvedBy":"local-operator",
        }
        event_status="manual_production_approved"
    else:
        asset.pop("manualProductionApproval",None)
        asset.pop("manual_production_approval",None)
        event_status="manual_production_approval_revoked"
    next_revision=save_project_document(
        request,doc,revision,
        audit_event={
            "action":event_status, "target_type":"logical_asset", "target_id":logical_asset_id,
            "reason":"manual_production_approval" if body.approved else "manual_production_approval_revoked",
            "before":before_asset, "after":asset,
            "metadata":{"artifact_id":body.artifact_id,"approval_reason":body.reason.strip(),"approved":body.approved},
        },
    )
    asset_audit.record_event(database,project_id,current_artifact_id or None,logical_asset_id,base_readiness.get("status"),event_status,{"artifact_id":body.artifact_id,"reason":body.reason.strip(),"approved":body.approved})
    library=_library_payload(database,project_id,doc)
    return {"project_id":project_id,"revision":next_revision,"asset":next((item for item in library["assets"] if item["id"]==logical_asset_id),None),"summary":library["summary"]}


@app.get("/api/v2/projects/{project_id}/assets/{logical_asset_id}/comparisons")
async def asset_comparisons(project_id:str,logical_asset_id:str,request:Request):
    doc,_=await read_project_doc(request,project_id); _project_asset(doc,logical_asset_id)
    _,_,comparisons=_asset_relations(db(request),project_id,logical_asset_id)
    return {"project_id":project_id,"logical_asset_id":logical_asset_id,"comparisons":comparisons}


@app.post("/api/v2/projects/{project_id}/assets/{logical_asset_id}/comparisons")
async def create_asset_comparison(project_id:str,logical_asset_id:str,body:AssetComparisonCreate,request:Request):
    database=db(request); doc,_=await read_project_doc(request,project_id); _project_asset(doc,logical_asset_id)
    with database.connect() as c:
        rows=c.execute("SELECT id FROM artifacts WHERE project_id=? AND logical_asset_id=?",(project_id,logical_asset_id)).fetchall()
    known={row["id"] for row in rows}; unknown=[item for item in body.candidate_artifact_ids if item not in known]
    if unknown:raise HTTPException(422,{"message":"候选 artifact 不属于该逻辑资产。","unknown_artifacts":unknown})
    candidates=[{"artifact_id":item,"score":None,"decision":"unreviewed","comment":"","annotations":[]} for item in body.candidate_artifact_ids]
    now=utcnow(); comparison_id=asset_audit.new_id("CMP")
    with database.connect() as c:
        c.execute("INSERT INTO asset_comparisons_v4(id,project_id,logical_asset_id,comparison_group,strategy,prompt_version,candidates_json,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",(
            comparison_id,project_id,logical_asset_id,body.comparison_group,body.strategy,body.prompt_version,database.encode(candidates),body.notes,now,now))
        row=c.execute("SELECT * FROM asset_comparisons_v4 WHERE id=?",(comparison_id,)).fetchone()
    asset_audit.record_event(database,project_id,None,logical_asset_id,None,"comparison_created",{"comparison_id":comparison_id,"strategy":body.strategy})
    return {"comparison":_comparison_payload(database,row)}


@app.post("/api/v2/projects/{project_id}/assets/{logical_asset_id}/comparisons/{comparison_id}/review")
async def review_asset_comparison(project_id:str,logical_asset_id:str,comparison_id:str,body:AssetComparisonReview,request:Request):
    database=db(request); doc,_=await read_project_doc(request,project_id); _project_asset(doc,logical_asset_id)
    with database.connect() as c:row=c.execute("SELECT * FROM asset_comparisons_v4 WHERE id=? AND project_id=? AND logical_asset_id=?",(comparison_id,project_id,logical_asset_id)).fetchone()
    if not row:raise HTTPException(404,"候选对比组不存在。")
    candidates=database.decode(row["candidates_json"],[]); target=next((item for item in candidates if item.get("artifact_id")==body.candidate_artifact_id),None)
    if target is None:raise HTTPException(404,"候选 artifact 不在该对比组中。")
    target.update({"score":body.score,"decision":body.decision,"comment":body.comment,"annotations":list(body.annotations)})
    now=utcnow()
    with database.connect() as c:
        c.execute("UPDATE asset_comparisons_v4 SET candidates_json=?,updated_at=? WHERE id=?",(database.encode(candidates),now,comparison_id))
        updated=c.execute("SELECT * FROM asset_comparisons_v4 WHERE id=?",(comparison_id,)).fetchone()
    asset_audit.record_event(database,project_id,body.candidate_artifact_id,logical_asset_id,None,"comparison_reviewed",{"comparison_id":comparison_id,"decision":body.decision,"score":body.score})
    return {"comparison":_comparison_payload(database,updated)}


@app.post("/api/v2/projects/{project_id}/assets/{logical_asset_id}/fusion-gate")
async def fusion_gate(project_id:str,logical_asset_id:str,request:Request):
    database=db(request); doc,_=await read_project_doc(request,project_id); asset=_project_asset(doc,logical_asset_id)
    if _asset_class(asset)!="fusion":raise HTTPException(422,"只有 fusion 资产可以执行融合门检查。")
    gate=_fusion_gate(doc,asset,database,project_id)
    return {"project_id":project_id,"gate":gate,"status":"allowed" if gate["allowed"] else "blocked"}


@app.get("/api/v2/projects/{project_id}/asset-gates")
async def asset_gates(project_id:str,request:Request):
    doc,_=await read_project_doc(request,project_id); library=_library_payload(db(request),project_id,doc)
    fusion_gates=[item["fusionGate"] for item in library["assets"] if item.get("assetClass")=="fusion" and item.get("fusionGate")]
    return {"project_id":project_id,"summary":library["summary"],"missing_required_a":[item["id"] for item in library["assets"] if item["readiness"]["required"] and not item["readiness"]["ready"]],"fusion_gates":fusion_gates}

@app.post("/api/audio/import")
async def import_audio(request:Request,file:UploadFile=File(...),project_id:str|None=None):
    ext=Path(file.filename or "reference.wav").suffix.lower()
    if ext not in {".mp3",".m4a",".wav",".ogg",".aac",".flac",".webm",".mp4"}:raise HTTPException(422,"音频格式不支持、为空或超过 25MB。")
    folder=safe_project_path(DATA_DIR,project_id,"uploads/audio") if project_id else REFERENCE_AUDIO_DIR; dest=folder/f"voice-ref-{secrets.token_hex(8)}{ext}"
    staged=None; finalized=False
    try:
        staged=await stage_upload(file,dest,MAX_AUDIO_UPLOAD)
        if staged.size==0:raise HTTPException(422,"音频格式不支持、为空或超过 25MB。")
        finalize_staged_upload(staged,dest); finalized=True
        artifact=register_artifact(db(request),project_id,"audio_upload",dest,None,None,None,{"original_name":file.filename}) if project_id else None
        return {"url":artifact_url(project_id,dest),"filename":dest.name,"original_name":Path(file.filename or "reference.wav").name,"sha256":staged.sha256,"bytes":staged.size,"format":ext.lstrip("."),"duration":audio_duration(dest),"artifact_id":artifact["id"] if artifact else None}
    except UploadTooLarge as exc:
        raise HTTPException(422,"音频格式不支持、为空或超过 25MB。") from exc
    except Exception:
        if finalized:cleanup_file(dest)
        raise
    finally:
        if staged:cleanup_staged_upload(staged)

@app.post("/api/projects/{project_id}/render")
async def create_render(project_id:str,body:RenderRequest,request:Request):
    if project_id!=body.project_id:raise HTTPException(409,"项目 ID 不一致。")
    if not body.confirmed:raise HTTPException(409,"最终合成必须确认。")
    return create_task_record(db(request),TaskCreate(project_id=project_id,task_type="final_render",request=body.model_dump(),paid=True))

async def run_seedance_task(application:FastAPI,tid:str)->None:
    database:Database=application.state.db
    try:
        with database.connect() as c:r=c.execute("SELECT * FROM tasks WHERE id=?",(tid,)).fetchone()
        if not r or r["status"] not in {"queued","running"}:return
        if r["status"]=="queued":transition(database,tid,"running")
        with database.connect() as c:c.execute("UPDATE tasks SET attempts=attempts+1,updated_at=? WHERE id=?",(utcnow(),tid))
        profile=get_profile(database,r["provider_profile_id"]); package=database.decode(r["request_json"],{}); provider_tid=r["provider_task_id"]
        if profile["provider_type"]!="jimeng_cli":raise ProviderError("任务绑定的 Provider 不是即梦 CLI。","configuration",409)
        if not provider_tid:
            await jimeng_user_credit(profile)
            created=await jimeng_create_task(profile,package); provider_tid=created.get("submit_id")
            if not provider_tid:raise ProviderError("即梦 CLI 未返回 submit_id。")
            with database.connect() as c:c.execute("UPDATE tasks SET provider_task_id=?,updated_at=? WHERE id=?",(provider_tid,utcnow(),tid))
        download_dir=safe_project_path(DATA_DIR,r["project_id"],f"artifacts/video/{tid}-jimeng")
        for _ in range(720):
            await asyncio.sleep(10)
            with database.connect() as c:current=c.execute("SELECT status FROM tasks WHERE id=?",(tid,)).fetchone()
            if not current or current["status"]=="canceled":return
            result=await jimeng_get_task(profile,provider_tid,download_dir); status=str(result.get("status","running")).lower()
            if status in {"failed","error"}:raise ProviderError("即梦 CLI 视频生成失败。")
            if status=="succeeded":
                source=Path(str(result.get("output_path") or ""))
                if not source.is_file():raise ProviderError("即梦 CLI 已报告成功，但下载目录中没有视频文件。")
                dest=safe_project_path(DATA_DIR,r["project_id"],f"artifacts/video/{tid}.mp4"); dest.parent.mkdir(parents=True,exist_ok=True)
                if source.resolve()!=dest.resolve():shutil.copy2(source,dest)
                artifact=register_artifact(database,r["project_id"],"video",dest,profile,r["provider_model"],tid,{"provider_task_id":provider_tid,"model_version":package.get("model_generation"),"source":"jimeng-cli","qa_owner":"video-shot-director"}); manifest={"provider_task_id":provider_tid,"artifact_id":artifact["id"],"sha256":artifact["sha256"]}
                with database.connect() as c:c.execute("UPDATE tasks SET result_json=?,updated_at=? WHERE id=?",(database.encode(manifest),utcnow(),tid))
                transition(database,tid,"generated_pending_qa",{"artifact_id":artifact["id"]});return
        raise ProviderError("Seedance 任务轮询超时。")
    except Exception as exc:
        kind=exc.kind if isinstance(exc,ProviderError) else "retryable"
        with database.connect() as c:c.execute("UPDATE tasks SET status='failed',error_kind=?,error_message=?,updated_at=? WHERE id=?",(kind,str(exc)[:2000],utcnow(),tid))

async def run_render_task(application:FastAPI,tid:str)->None:
    database:Database=application.state.db
    try:
        with database.connect() as c:r=c.execute("SELECT * FROM tasks WHERE id=?",(tid,)).fetchone()
        if not r or r["status"] not in {"queued","running"}:return
        if r["status"]=="queued":transition(database,tid,"running")
        body=database.decode(r["request_json"],{}); pid=r["project_id"]; clips=[safe_project_path(DATA_DIR,pid,x) for x in body.get("clips",[])]
        if body.get("artifact_ids"):
            marks=','.join('?' for _ in body["artifact_ids"])
            with database.connect() as c:artifact_rows=c.execute(f"SELECT id,local_path FROM artifacts WHERE project_id=? AND id IN ({marks})",(pid,*body["artifact_ids"])).fetchall()
            if len(artifact_rows)!=len(body["artifact_ids"]):raise ValueError("至少一个视频资产不存在或不属于当前项目。")
            artifact_map={x["id"]:Path(x["local_path"]).resolve() for x in artifact_rows}; clips.extend(artifact_map[x] for x in body["artifact_ids"])
        audio_tracks=[]
        if body.get("audio_tracks"):
            audio_ids=[x["artifact_id"] for x in body["audio_tracks"]]; marks=','.join('?' for _ in audio_ids)
            with database.connect() as c:audio_rows=c.execute(f"SELECT id,local_path FROM artifacts WHERE project_id=? AND id IN ({marks})",(pid,*audio_ids)).fetchall()
            audio_map={x["id"]:Path(x["local_path"]).resolve() for x in audio_rows}
            if len(audio_map)!=len(audio_ids):raise ValueError("至少一个音频资产不存在或不属于当前项目。")
            audio_tracks=[(audio_map[x["artifact_id"]],x) for x in body["audio_tracks"]]
        if not all(x.is_file() for x in clips):raise ValueError("至少一个合成片段不存在。")
        output=safe_project_path(DATA_DIR,pid,f"deliveries/{Path(body['output_name']).name}"); output.parent.mkdir(parents=True,exist_ok=True); ffmpeg=find_binary("ffmpeg")
        if not ffmpeg:raise RuntimeError("未找到 FFmpeg。")
        await asyncio.to_thread(render_video,ffmpeg,clips,output,body["resolution"],body["fps"],audio_tracks); artifact=register_artifact(database,pid,"final_video",output,None,"ffmpeg",tid,{"source_artifact_ids":body.get("artifact_ids",[]),"audio_tracks":body.get("audio_tracks",[]),"resolution":body["resolution"],"fps":body["fps"],"qa_owner":"final-render"}); report=output.with_suffix(".manifest.json"); report.write_text(json.dumps({"project_id":pid,"task_id":tid,"artifact":artifact,"rendered_at":utcnow()},ensure_ascii=False,indent=2),encoding="utf-8")
        with database.connect() as c:c.execute("UPDATE tasks SET result_json=?,updated_at=? WHERE id=?",(database.encode({"artifact":artifact,"manifest":str(report)}),utcnow(),tid))
        transition(database,tid,"succeeded",{"artifact_id":artifact["id"]})
    except Exception as exc:
        with database.connect() as c:c.execute("UPDATE tasks SET status='failed',error_kind='retryable',error_message=?,updated_at=? WHERE id=?",(str(exc)[:2000],utcnow(),tid))


def _srt_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds_part, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds_part:02d},{millis:03d}"


def _write_timeline_subtitles(timeline: dict[str, Any], destination: Path) -> int:
    entries: list[tuple[float, float, str]] = []
    for track in timeline.get("tracks", []):
        if track.get("kind") != "captions" or track.get("muted"):
            continue
        for clip in track.get("clips", []):
            metadata = clip.get("metadata") or {}
            text = metadata.get("text") or metadata.get("caption") or metadata.get("value")
            if isinstance(text, str) and text.strip():
                entries.append((float(clip.get("start") or 0), float(clip.get("duration") or 0), text.strip()))
    entries.sort(key=lambda item: (item[0], item[2]))
    lines: list[str] = []
    for index, (start, duration, text) in enumerate(entries, start=1):
        lines.extend([str(index), f"{_srt_timestamp(start)} --> {_srt_timestamp(start + duration)}", text, ""])
    destination.write_text("\n".join(lines), encoding="utf-8")
    return len(entries)


def _timeline_without_captions(timeline:dict[str,Any])->dict[str,Any]:
    clean=json.loads(json.dumps(timeline))
    for track in clean.get("tracks",[]):
        if track.get("kind")=="captions":track["muted"]=True
    return clean


async def _resolve_preview_paths(database:Database,project_id:str,timeline:dict[str,Any],rows:dict[str,sqlite3.Row],use_proxies:bool)->dict[str,Path]:
    paths={artifact_id:Path(row["local_path"]).resolve() for artifact_id,row in rows.items()}
    if not use_proxies:return paths
    ffmpeg=find_binary("ffmpeg") or "ffmpeg"
    video_ids={str(clip.get("artifact_id")) for track in timeline.get("tracks",[]) if track.get("kind") in {"video","overlay"} for clip in track.get("clips",[]) if clip.get("artifact_id")}
    for artifact_id in sorted(video_ids):
        row=rows.get(artifact_id)
        if not row or not (str(row["mime_type"] or "").lower().startswith("video/") or str(row["artifact_type"] or "").lower() in {"video","shot_video","final_video"}):continue
        source_sha=str(row["sha256"] or sha256_file(paths[artifact_id]))
        with database.connect() as connection:
            proxy=connection.execute("SELECT * FROM media_proxies_v6 WHERE project_id=? AND artifact_id=? AND source_sha256=? AND preset=?",(project_id,artifact_id,source_sha,"preview_540p")).fetchone()
        if proxy and proxy["status"]=="ready" and proxy["local_path"] and Path(proxy["local_path"]).is_file():
            paths[artifact_id]=Path(proxy["local_path"]).resolve();continue
        proxy_id=str(proxy["id"]) if proxy else f"PROXY_{secrets.token_hex(8)}"; now=utcnow(); target=safe_project_path(DATA_DIR,project_id,f"proxies/{proxy_id}-preview_540p.mp4")
        with database.connect() as connection:
            if proxy:
                connection.execute("UPDATE media_proxies_v6 SET status='running',error_json=NULL,updated_at=? WHERE id=?",(now,proxy_id))
            else:
                connection.execute("INSERT INTO media_proxies_v6(id,project_id,artifact_id,source_sha256,preset,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",(proxy_id,project_id,artifact_id,source_sha,"preview_540p","running",now,now))
        result=await asyncio.to_thread(create_proxy,ffmpeg,paths[artifact_id],target,"preview_540p")
        with database.connect() as connection:
            connection.execute("UPDATE media_proxies_v6 SET status='ready',local_path=?,metadata_json=?,updated_at=? WHERE id=?",(str(target),database.encode(result),utcnow(),proxy_id))
        paths[artifact_id]=target.resolve()
    return paths


async def run_v3_render_task(application:FastAPI,render_id:str)->None:
    database: Database = application.state.db
    try:
        row = _render_job(database, render_id)
        if row["status"] not in {"queued", "running"}:
            return
        request_data = database.decode(row["request_json"], {})
        manifest = database.decode(row["manifest_json"], {})
        project_id = row["project_id"]
        timeline = request_data.get("timeline") or manifest.get("timeline")
        if not isinstance(timeline, dict):
            raise ValueError("渲染快照缺少时间线文档。")
        # Worker start is a fresh authority boundary. A queued job must not
        # inherit approval if its artifact, file, QA or active version changed.
        _timeline_artifact_rows(database,project_id,timeline)
        mode=str(request_data.get("mode") or (manifest.get("output") or {}).get("mode") or "delivery")
        if mode != "preview":
            preflight=_timeline_preflight(database,project_id,{"revision":int(row["timeline_revision"]),"document":timeline})
            if not preflight["summary"]["delivery_ready"]:
                raise ValueError("Worker 启动时生产预检已失效。")
        now = utcnow()
        with database.connect() as connection:
            connection.execute("UPDATE render_jobs_v6 SET status='running',started_at=COALESCE(started_at,?),updated_at=? WHERE id=?", (now, now, render_id))
        row = _render_job(database, render_id)
        output = manifest.get("output") or {}
        rows = _timeline_artifact_rows(database, project_id, timeline)
        paths = await _resolve_preview_paths(database,project_id,timeline,rows,bool(request_data.get("use_proxies")) if mode=="preview" else False)
        resolution = str(output.get("resolution") or f"{timeline['width']}x{timeline['height']}")
        width, height = (int(value) for value in resolution.split("x", 1))
        render_timeline_doc = dict(timeline)
        render_timeline_doc["width"] = width
        render_timeline_doc["height"] = height
        render_timeline_doc["fps"] = int(output.get("fps") or timeline["fps"])
        delivery_root = safe_project_path(DATA_DIR, project_id, f"previews/{render_id}" if mode=="preview" else f"deliveries/{render_id}")
        delivery_root.mkdir(parents=True, exist_ok=True)
        output_name = _render_output_name(str(output.get("name") or "final.mp4"))
        ffmpeg=find_binary("ffmpeg") or "ffmpeg"
        if mode=="preview":
            video_output=delivery_root/output_name
            await asyncio.to_thread(render_timeline,ffmpeg,render_timeline_doc,paths,video_output)
            result={"preview_url":artifact_url(project_id,video_output),"preview_path":str(video_output),"used_proxies":bool(request_data.get("use_proxies")),"input_count":len(paths)}
            finished=utcnow()
            with database.connect() as connection:
                connection.execute("UPDATE render_jobs_v6 SET status='succeeded',result_json=?,finished_at=?,updated_at=? WHERE id=?",(database.encode(result),finished,finished,render_id))
            return
        delivery_set=str(output.get("delivery_set") or request_data.get("delivery_set") or "master_clean_srt")
        subtitle_mode=str(output.get("subtitle_mode") or request_data.get("subtitle_mode") or "burn_in")
        subtitle_output=delivery_root/"captions.srt"
        subtitle_count=_write_timeline_subtitles(timeline,subtitle_output)
        master_output=delivery_root/("master_burn_in.mp4" if delivery_set!="single" else output_name)
        if subtitle_mode=="burn_in" and subtitle_count:
            await asyncio.to_thread(render_timeline,ffmpeg,render_timeline_doc,paths,master_output,subtitle_output)
        else:
            await asyncio.to_thread(render_timeline,ffmpeg,render_timeline_doc,paths,master_output)
        clean_output=None
        if delivery_set=="master_clean_srt":
            clean_output=delivery_root/"clean.mp4"
            await asyncio.to_thread(render_timeline,ffmpeg,_timeline_without_captions(render_timeline_doc),paths,clean_output)
        # Revalidate immediately before registering final artifacts and writing
        # the delivery manifest/package. This prevents a mid-render authority
        # change from becoming an official delivery.
        _timeline_artifact_rows(database,project_id,timeline)
        project_json = delivery_root / "project.json"
        assets_json = delivery_root / "assets.json"
        manifest_path = delivery_root / "manifest.json"
        report_path = delivery_root / "production-report.json"
        project_json.write_text(json.dumps({"project_id": project_id, "timeline_revision": row["timeline_revision"], "timeline": timeline}, ensure_ascii=False, indent=2), encoding="utf-8")
        assets_json.write_text(json.dumps({"project_id": project_id, "inputs": manifest.get("inputs", [])}, ensure_ascii=False, indent=2), encoding="utf-8")
        artifact = register_artifact(database, project_id, "final_video", master_output, None, "ffmpeg", render_id, {"source_artifact_ids": sorted(paths), "timeline_revision": row["timeline_revision"], "subtitle_count": subtitle_count, "resolution": resolution, "fps": render_timeline_doc["fps"], "variant": "master_burn_in", "qa_owner": "final-render-v3"})
        clean_artifact = register_artifact(database, project_id, "final_video_clean", clean_output, None, "ffmpeg", render_id, {"source_artifact_ids": sorted(paths), "timeline_revision": row["timeline_revision"], "resolution": resolution, "fps": render_timeline_doc["fps"], "variant": "clean", "qa_owner": "final-render-v3"}) if clean_output else None
        outputs=[{"kind":"master_burn_in","label":"主片（烧录字幕）","path":str(master_output),"url":artifact_url(project_id,master_output),"artifact_id":artifact["id"],"sha256":sha256_file(master_output)}]
        if clean_output:
            outputs.append({"kind":"clean","label":"Clean 无字幕版","path":str(clean_output),"url":artifact_url(project_id,clean_output),"artifact_id":clean_artifact["id"] if clean_artifact else None,"sha256":sha256_file(clean_output)})
        outputs.append({"kind":"srt","label":"字幕文件","path":str(subtitle_output),"url":artifact_url(project_id,subtitle_output),"sha256":sha256_file(subtitle_output)})
        package_path=delivery_root/"delivery.zip"
        delivery = {
            "video": str(master_output),
            "video_url": artifact_url(project_id, master_output),
            "master_burn_in": str(master_output),
            "master_burn_in_url": artifact_url(project_id, master_output),
            "clean": str(clean_output) if clean_output else None,
            "clean_url": artifact_url(project_id, clean_output) if clean_output else None,
            "subtitles": str(subtitle_output),
            "subtitles_url": artifact_url(project_id, subtitle_output),
            "project_json": str(project_json),
            "project_json_url": artifact_url(project_id, project_json),
            "assets_json": str(assets_json),
            "assets_json_url": artifact_url(project_id, assets_json),
            "manifest": str(manifest_path),
            "manifest_url": artifact_url(project_id, manifest_path),
            "report": str(report_path),
            "report_url": artifact_url(project_id, report_path),
            "artifact_id": artifact["id"],
            "outputs": outputs,
            "package": str(package_path),
            "package_url": artifact_url(project_id,package_path),
        }
        final_manifest = dict(manifest)
        final_manifest["delivery"] = delivery
        final_manifest["outputs"] = [{"path": name, "sha256": sha256_file(path)} for name, path in ((item["kind"],Path(item["path"])) for item in outputs)]+[{"path":"project_json","sha256":sha256_file(project_json)},{"path":"assets_json","sha256":sha256_file(assets_json)}]
        manifest_path.write_text(json.dumps(final_manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        report = {"report_version": 1, "project_id": project_id, "render_id": render_id, "timeline_revision": row["timeline_revision"], "artifact_id": artifact["id"], "subtitle_count": subtitle_count, "input_count": len(paths), "rendered_at": utcnow(), "manifest_sha256": sha256_file(manifest_path)}
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        package_path=delivery_root/"delivery.zip"
        _timeline_artifact_rows(database,project_id,timeline)
        with ZipFile(package_path,"w") as package:
            for path in [Path(item["path"]) for item in outputs]+[project_json,assets_json,manifest_path,report_path]:
                package.write(path,path.name)
        result = {"artifact": artifact, "delivery": delivery, "manifest": str(manifest_path), "report": str(report_path)}
        finished = utcnow()
        with database.connect() as connection:
            connection.execute("UPDATE render_jobs_v6 SET status='succeeded',manifest_json=?,result_json=?,finished_at=?,updated_at=? WHERE id=?", (database.encode(final_manifest), database.encode(result), finished, finished, render_id))
    except Exception as exc:
        finished = utcnow()
        with database.connect() as connection:
            connection.execute("UPDATE render_jobs_v6 SET status='failed',error_json=?,finished_at=?,updated_at=? WHERE id=?", (database.encode({"message": str(exc)[:3000], "kind": "render"}), finished, finished, render_id))


async def run_proxy_task(application:FastAPI,proxy_id:str)->None:
    database: Database = application.state.db
    try:
        with database.connect() as connection:
            row = connection.execute("SELECT * FROM media_proxies_v6 WHERE id=?", (proxy_id,)).fetchone()
        if not row or row["status"] not in {"queued", "running"}:
            return
        now = utcnow()
        with database.connect() as connection:
            connection.execute("UPDATE media_proxies_v6 SET status='running',updated_at=? WHERE id=?", (now, proxy_id))
        with database.connect() as connection:
            artifact = connection.execute("SELECT local_path FROM artifacts WHERE id=? AND project_id=?", (row["artifact_id"], row["project_id"])).fetchone()
        if not artifact:
            raise ValueError("代理源 artifact 不存在。")
        source = Path(artifact["local_path"]).resolve()
        project_root = (DATA_DIR / "projects" / row["project_id"]).resolve()
        if project_root not in source.parents or not source.is_file():
            raise ValueError("代理源文件不在当前项目目录内。")
        target = safe_project_path(DATA_DIR, row["project_id"], f"proxies/{proxy_id}-{row['preset']}.mp4")
        result = await asyncio.to_thread(create_proxy, find_binary("ffmpeg") or "ffmpeg", source, target, row["preset"])
        with database.connect() as connection:
            connection.execute("UPDATE media_proxies_v6 SET status='ready',local_path=?,metadata_json=?,updated_at=? WHERE id=?", (str(target), database.encode(result), utcnow(), proxy_id))
    except Exception as exc:
        with database.connect() as connection:
            connection.execute("UPDATE media_proxies_v6 SET status='failed',error_json=?,updated_at=? WHERE id=?", (database.encode({"message": str(exc)[:2000], "kind": "proxy"}), utcnow(), proxy_id))

async def resume_tasks(application:FastAPI)->None:
    database:Database=application.state.db
    with database.connect() as c:rows=c.execute("SELECT id,task_type FROM tasks WHERE status IN ('queued','running')").fetchall()
    for r in rows:
        runner=run_seedance_task if r["task_type"]=="seedance_video" else run_render_task if r["task_type"]=="final_render" else None
        if runner:asyncio.create_task(runner(application,r["id"]))

@app.get("/api/project-files/{project_id}/{relative_path:path}")
async def project_file(project_id:str,relative_path:str):
    path=safe_project_path(DATA_DIR,project_id,unquote(relative_path))
    if not path.is_file():raise HTTPException(404,"文件不存在。")
    return FileResponse(path)
@app.get("/generated/{relative_path:path}")
async def generated_file(relative_path:str):
    root=GENERATED_DIR.resolve(); path=(root/unquote(relative_path)).resolve()
    if root not in path.parents or not path.is_file():raise HTTPException(404,"文件不存在。")
    return FileResponse(path)
@app.get("/{path:path}")
async def static(path:str):
    decoded=unquote("/"+path)
    if decoded in {"/", "/index.html"}:
        entry=STUDIO_DIST/"index.html"
        if not entry.is_file():raise HTTPException(503,"FrameFlow V3 尚未构建，请先在 web 目录执行 npm run build。")
        return FileResponse(entry,headers={"Cache-Control":"no-store, max-age=0","Pragma":"no-cache"})
    if decoded.startswith("/assets/"):
        relative=decoded.removeprefix("/")
        candidate=(STUDIO_DIST/relative).resolve(); root=STUDIO_DIST.resolve()
        if root not in candidate.parents or not candidate.is_file():raise HTTPException(404,"资源不存在。")
        return FileResponse(candidate,headers={"Cache-Control":"public, max-age=31536000, immutable"})
    if decoded not in STATIC_FILES:raise HTTPException(404,"资源不存在。")
    return FileResponse(ROOT/STATIC_FILES[decoded],headers={"Cache-Control":"no-store, max-age=0","Pragma":"no-cache"})


def _remove_retired_api_routes() -> None:
    """Keep the V3 surface small while preserving project media delivery."""
    allowed = ("/api/v2/", "/api/health", "/api/system/doctor", "/api/project-files/")
    app.router.routes = [
        route for route in app.router.routes
        if not (getattr(route, "path", "").startswith("/api/") and not getattr(route, "path", "").startswith(allowed))
    ]


_remove_retired_api_routes()

def open_browser_when_ready(url:str)->None:
    health=f"{url}/api/health"
    for _ in range(50):
        try:
            with urllib.request.urlopen(health,timeout=1) as response:
                if response.status==200:
                    webbrowser.open(url,new=2); return
        except Exception:time.sleep(.2)

def main()->None:
    bind_host=ensure_loopback_bind(requested_bind_host())
    url=f"http://{'['+bind_host+']' if ':' in bind_host else bind_host}:{DEFAULT_BIND_PORT}"
    print(f"FRAMEFLOW V3 工作台：{url}")
    threading.Thread(target=open_browser_when_ready,args=(url,),daemon=True).start()
    uvicorn.run("server:app",host=bind_host,port=DEFAULT_BIND_PORT,reload=False)
if __name__=="__main__":main()
