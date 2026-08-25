from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


ProviderType = Literal["openai", "openai_compatible", "jimeng_cli", "opencode", "comfyui"]
TaskStatus = Literal[
    "draft", "validated", "awaiting_confirmation", "queued", "running",
    "succeeded", "generated_pending_qa", "approved", "revision_required",
    "blocked", "failed", "canceled",
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ProjectDocument(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=100)
    ratio: str = "9:16"
    duration: int = Field(default=30, ge=1, le=3600)
    generator: str = "Seedance 2.5"
    brief: str = ""
    stage: int = 0
    sortOrder: int = Field(default=0)
    productionStatus: Literal["in_progress", "completed"] = "in_progress"
    lifecycleStatus: Literal["active", "archived"] = "active"
    createdAt: str | None = None
    script: str = ""
    assets: list[dict[str, Any]] = Field(default_factory=list)
    shots: list[dict[str, Any]] = Field(default_factory=list)
    audio: dict[str, Any] = Field(default_factory=dict)
    assetRegulator: dict[str, Any] = Field(default_factory=dict)
    generations: list[dict[str, Any]] = Field(default_factory=list)
    imagePrompt: str | None = None
    seedancePackages: list[dict[str, Any]] = Field(default_factory=list)
    providerOverrides: dict[str, Any] = Field(default_factory=dict)
    undoStack: list[dict[str, Any]] = Field(default_factory=list)
    scriptVersions: list[dict[str, Any]] = Field(default_factory=list)
    storyboardVersions: list[dict[str, Any]] = Field(default_factory=list)
    storyWorkflowRuns: list[dict[str, Any]] = Field(default_factory=list)


class ProjectImport(StrictModel):
    document: ProjectDocument
    expected_revision: int | None = Field(default=None, ge=1)


class ProjectCreateV3(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    ratio: str = "9:16"
    duration: int = Field(default=30, ge=1, le=3600)
    generator: str = "Seedance 2.5"
    brief: str = ""


class ProjectMetadataUpdate(StrictModel):
    expected_revision: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=100)
    productionStatus: Literal["in_progress", "completed"] | None = None
    lifecycleStatus: Literal["active", "archived"] | None = None
    sortOrder: int | None = None


class ProviderProfileCreate(StrictModel):
    id: str | None = None
    provider_type: ProviderType
    display_name: str = Field(min_length=1, max_length=80)
    base_url: str = Field(min_length=8, max_length=500)
    model_settings: dict[str, Any] = Field(default_factory=dict, alias="model_config", serialization_alias="model_config")
    capabilities: list[str] = Field(default_factory=list)
    enabled: bool = True

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        if not value.startswith(("https://", "http://127.0.0.1", "http://localhost", "cli://")):
            raise ValueError("base_url 必须使用 HTTPS；本机 Provider 可使用 HTTP，即梦 CLI 使用 cli://")
        return value.rstrip("/")


class ProviderProfileUpdate(StrictModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    base_url: str | None = None
    model_settings: dict[str, Any] | None = Field(default=None, alias="model_config", serialization_alias="model_config")
    capabilities: list[str] | None = None
    enabled: bool | None = None


class CredentialWrite(StrictModel):
    api_key: str = Field(min_length=1, max_length=10000)


class CredentialImport(StrictModel):
    environment_variable: Literal[
        "OPENAI_API_KEY", "DEEPSEEK_API_KEY",
        "OPENCODE_SERVER_PASSWORD", "COMFYUI_API_KEY",
    ]


class CapabilityBinding(StrictModel):
    capability: Literal[
        "orchestrator", "vision", "image", "image_edit", "video", "tts", "music", "sfx",
        "lip_sync", "upscale", "upload",
    ]
    provider_profile_id: str
    model: str | None = None


class AssistantRequest(StrictModel):
    project_id: str
    conversation_id: str | None = None
    message: str = Field(min_length=1, max_length=30000)
    context: dict[str, Any] = Field(default_factory=dict)
    skill_id: str | None = None


class WorkflowRunCreate(StrictModel):
    project_id: str
    skill_id: str
    input: dict[str, Any] = Field(default_factory=dict)


class TaskCreate(StrictModel):
    project_id: str | None = None
    task_type: str
    provider_profile_id: str | None = None
    provider_model: str | None = None
    request: dict[str, Any] = Field(default_factory=dict)
    paid: bool = False


class ImageGenerate(StrictModel):
    prompt: str = Field(min_length=1, max_length=32000)
    size: Literal["1024x1024", "1024x1536", "1536x1024"] = "1024x1024"
    quality: Literal["low", "medium", "high"] = "medium"
    project_id: str | None = None
    confirmed: bool = False
    provider_profile_id: str | None = None


class AssetPromptRunCreate(StrictModel):
    expected_revision: int | None = Field(default=None, ge=1)
    provider_profile_id: str | None = None
    model: str | None = Field(default=None, max_length=120)
    target_asset_id: str | None = Field(default=None, max_length=120)


class FusionPromptRunCreate(StrictModel):
    expected_project_revision: int = Field(ge=1)
    expected_board_revision: int = Field(ge=1)
    fusion_asset_id: str = Field(min_length=1, max_length=120)
    shot_id: str = Field(min_length=1, max_length=120)
    source_asset_ids: list[str] = Field(min_length=2, max_length=32)
    confirmed: bool = False
    provider_profile_id: str | None = None
    model: str | None = Field(default=None, max_length=120)


class AssetImageGenerate(StrictModel):
    prompt: str | None = Field(default=None, min_length=1, max_length=32000)
    prompt_version: str | None = Field(default=None, max_length=120)
    size: Literal["1024x1024", "1024x1536", "1536x1024"] = "1024x1024"
    quality: Literal["low", "medium", "high"] = "medium"
    confirmed: bool = False
    provider_profile_id: str | None = None


class ImageEdit(StrictModel):
    project_id: str
    artifact_id: str
    prompt: str = Field(min_length=1, max_length=32000)
    confirmed: bool = False
    provider_profile_id: str | None = None


class SpeechGenerate(StrictModel):
    text: str = Field(min_length=1, max_length=4096)
    model: str = "gpt-4o-mini-tts"
    voice: str = "coral"
    format: Literal["mp3", "opus", "aac", "flac", "wav", "pcm"] = "wav"
    instructions: str = ""
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    dialogue_id: str = "DLG"
    project_id: str | None = None
    logical_asset_id: str | None = Field(default=None, max_length=120)
    shot_ids: list[str] = Field(default_factory=list, max_length=64)
    emotion: str = Field(default="", max_length=240)
    target_duration: float | None = Field(default=None, gt=0, le=3600)
    confirmed: bool = False
    provider_profile_id: str | None = None
    voice_id: str | None = Field(default=None, max_length=120)
    audition_id: str | None = Field(default=None, max_length=120)
    take_id: str | None = Field(default=None, max_length=120)
    character_id: str | None = Field(default=None, max_length=120)
    operation: str = Field(default="tts", max_length=80)


class SeedancePackageCreate(StrictModel):
    project_id: str
    shot_id: str
    model_generation: str = Field(default="seedance2.0", min_length=1, max_length=80)
    provider_profile_id: str
    provider_model_or_endpoint: str = Field(min_length=1)
    prompt: str = Field(min_length=1)
    prompt_version: str = "v01"
    reference_assets: list[str] = Field(default_factory=list)
    reference_roles: dict[str, str] = Field(default_factory=dict)
    duration: int = Field(default=5, ge=1, le=180)
    resolution: str = "720p"
    aspect_ratio: str = "9:16"
    capability_snapshot: dict[str, Any] = Field(default_factory=dict)


class RenderAudioTrack(StrictModel):
    artifact_id: str
    role: Literal["dialogue", "music", "ambience", "sfx"]
    volume: float = Field(default=1.0, ge=0, le=4)
    start: float = Field(default=0, ge=0)
    fade_in: float = Field(default=0, ge=0, le=30)
    fade_out: float = Field(default=0, ge=0, le=30)


class RenderRequest(StrictModel):
    project_id: str
    clips: list[str] = Field(default_factory=list)
    artifact_ids: list[str] = Field(default_factory=list)
    audio_tracks: list[RenderAudioTrack] = Field(default_factory=list)
    output_name: str = "final.mp4"
    resolution: str = "1080x1920"
    fps: int = Field(default=30, ge=1, le=120)
    confirmed: bool = False

    @model_validator(mode="after")
    def require_sources(self):
        if not self.clips and not self.artifact_ids:
            raise ValueError("至少需要一个视频片段或资产 ID")
        return self


# ---------------------------------------------------------------------------
# Asset intake, QA, registration, resolution, prompt and story models.
# ---------------------------------------------------------------------------

class ArtifactMapRequest(StrictModel):
    logical_asset_id: str = Field(min_length=1, max_length=100)
    asset_class: str = Field(min_length=1, max_length=40)
    asset_role: str | None = None
    prompt_version: str | None = None
    relevant_shots: list[str] = Field(default_factory=list)


class QARunCreate(StrictModel):
    qa_type: Literal["prompt", "image", "video", "audio", "reference"] = "image"
    provider_profile_id: str | None = None
    manual_review: bool = False


class QADecisionSubmit(StrictModel):
    decision: str = Field(min_length=1, max_length=80)
    report: dict[str, Any] = Field(default_factory=dict)
    observed_issues: list[str] = Field(default_factory=list)
    affected_shots: list[str] = Field(default_factory=list)
    approved_roles: list[str] = Field(default_factory=list)
    forbidden_roles: list[str] = Field(default_factory=list)
    image_editable: bool = False
    rebuild_required: bool = False

    @field_validator("decision")
    @classmethod
    def validate_decision(cls, value: str) -> str:
        if value not in {"Approved", "Needs revision", "Reject and rebuild prompt", "Rejected", "Blocked"}:
            raise ValueError("QA 决策必须是 Approved / Needs revision / Reject and rebuild prompt / Rejected / Blocked")
        return value


class ArtifactRegisterRequest(StrictModel):
    replace_active: bool = False


class ResolutionRequest(StrictModel):
    action: Literal[
        "revise_prompt", "rebuild_prompt", "image_edit", "upload_replacement",
        "keep_unqualified", "defer", "manual_review",
    ]
    reason: str = ""


class PromptReviseRequest(StrictModel):
    prompt: str = Field(min_length=1, max_length=32000)
    change_reason: str = ""
    source_qa_run_id: str | None = None


class PromptRebuildRequest(StrictModel):
    prompt: str = Field(min_length=1, max_length=32000)
    change_reason: str = ""
    source_qa_run_id: str | None = None
    rebuilt_from_failure_ids: list[str] = Field(default_factory=list)


class PromptCreateRequest(StrictModel):
    prompt: str = Field(min_length=1, max_length=32000)
    source: str = Field(default="domain-skill", max_length=40)
    skill_id: str | None = None
    change_reason: str = ""
    source_qa_run_id: str | None = None
    rebuilt_from_failure_ids: list[str] = Field(default_factory=list)


class PromptQADecision(StrictModel):
    decision: Literal["Approved", "Needs revision", "Blocked"]
    report: dict[str, Any] = Field(default_factory=dict)


class AssetReferenceRole(StrictModel):
    reference_id: str = Field(min_length=1, max_length=500)
    reference_kind: Literal["artifact", "url", "path", "generated"] = "artifact"
    artifact_id: str | None = Field(default=None, max_length=120)
    role: Literal[
        "identity", "outfit", "action", "composition", "scene_structure",
        "style", "lighting", "product_structure",
    ]
    source: str = Field(default="project", max_length=120)
    notes: str = Field(default="", max_length=2000)
    priority: int = Field(default=100, ge=1, le=10000)
    scope: Literal[
        "general", "identity", "face", "costume", "pose", "camera", "lighting",
        "environment", "geometry", "material", "composition", "action", "style",
        "product_structure", "scene_structure",
    ] = "general"
    authority: Literal["absolute", "primary", "secondary", "supporting", "negative"] = "supporting"
    conflict_group: str | None = Field(default=None, max_length=120)
    effective_version: str | None = Field(default=None, max_length=160)


class AssetDependencySpec(StrictModel):
    dependency_asset_id: str = Field(min_length=1, max_length=100)
    shot_id: str | None = Field(default=None, max_length=100)
    relation: str = Field(default="requires", min_length=1, max_length=80)
    role: str = Field(default="", max_length=120)
    required: bool = True


class AssetMetadataUpdate(StrictModel):
    expected_revision: int | None = Field(default=None, ge=1)
    asset_class: str | None = Field(default=None, max_length=40)
    grade: Literal["A+", "A", "B", "C", "optional", "Reject"] | None = None
    usage_roles: list[str] | None = None
    identity_anchors: dict[str, Any] | None = None
    asset_spec: dict[str, Any] | None = None
    references: list[AssetReferenceRole] | None = None
    prompt: str | None = Field(default=None, max_length=32000)
    prompt_version: str | None = Field(default=None, max_length=120)
    source: str | None = Field(default=None, max_length=200)
    license: str | None = Field(default=None, max_length=500)
    authorization_status: str | None = Field(default=None, max_length=120)
    restrictions: list[str] | None = None
    must_preserve: list[str] | None = None
    must_avoid: list[str] | None = None
    protected_regions: list[str] | None = None
    fusion_source_asset_ids: list[str] | None = None
    shot_dependencies: list[AssetDependencySpec] | None = None
    metadata: dict[str, Any] | None = None


class AssetManualProductionApproval(StrictModel):
    """Human decision that may waive only the Prompt production gate."""

    expected_revision: int = Field(ge=1)
    approved: bool = True
    reason: str = Field(default="", max_length=2000)
    artifact_id: str = Field(min_length=1, max_length=160)


class AssetComparisonCreate(StrictModel):
    comparison_group: str = Field(min_length=1, max_length=120)
    strategy: Literal["multi_model", "multi_seed", "ab", "grid"]
    prompt_version: str | None = Field(default=None, max_length=120)
    candidate_artifact_ids: list[str] = Field(default_factory=list)
    notes: str = Field(default="", max_length=2000)


class AssetComparisonReview(StrictModel):
    candidate_artifact_id: str = Field(min_length=1, max_length=120)
    score: float | None = Field(default=None, ge=0, le=100)
    decision: Literal["unreviewed", "Approved", "Needs revision", "Reject and rebuild prompt"] = "unreviewed"
    comment: str = Field(default="", max_length=2000)
    annotations: list[str] = Field(default_factory=list)


class AssetBoardPosition(StrictModel):
    x: float = 0
    y: float = 0


class AssetBoardNodeV3(StrictModel):
    id: str = Field(min_length=1, max_length=160)
    node_type: Literal["asset", "shot", "group", "handoff", "artifact"]
    label: str = Field(min_length=1, max_length=500)
    position: AssetBoardPosition = Field(default_factory=AssetBoardPosition)
    asset_id: str | None = Field(default=None, max_length=120)
    shot_id: str | None = Field(default=None, max_length=120)
    config: dict[str, Any] = Field(default_factory=dict)
    status: str = Field(default="idle", max_length=80)


class AssetBoardEdgeV3(StrictModel):
    id: str = Field(min_length=1, max_length=200)
    source: str = Field(min_length=1, max_length=160)
    target: str = Field(min_length=1, max_length=160)
    relation: Literal["shot_dependency", "reference", "fusion_input", "candidate"]


class AssetBoardV3(StrictModel):
    version: int = Field(default=1, ge=1)
    viewport: dict[str, float] = Field(default_factory=lambda: {"x": 0.0, "y": 0.0, "zoom": 0.75})
    nodes: list[AssetBoardNodeV3] = Field(default_factory=list)
    edges: list[AssetBoardEdgeV3] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class AssetBoardUpdateV3(StrictModel):
    board: AssetBoardV3
    expected_revision: int = Field(ge=1)


class AssetBoardSyncV3(StrictModel):
    expected_revision: int = Field(ge=1)
    preserve_layout: bool = True


class AssetAssignmentV3(StrictModel):
    """Atomically update a shot requirement and its asset-board dependency."""

    expected_project_revision: int = Field(ge=1)
    expected_board_revision: int = Field(ge=1)
    asset_id: str = Field(min_length=1, max_length=120)
    shot_id: str = Field(min_length=1, max_length=120)
    mode: Literal["assign", "move", "remove"] = "assign"
    role: str = Field(default="", max_length=160)
    required: bool = True
    required_readiness: Literal["registered", "production"] = "production"


class AssetCreateV3(StrictModel):
    expected_revision: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=240)
    asset_class: Literal["character", "scene", "prop", "fusion", "product", "style", "video", "audio", "music", "sfx"]
    asset_role: str = Field(default="", max_length=160)
    grade: Literal["A+", "A", "B", "C", "optional", "Reject"] = "B"
    required: bool = False


class AssetDuplicateV3(StrictModel):
    expected_revision: int = Field(ge=1)
    name: str | None = Field(default=None, max_length=240)


class StoryOptimizationCreate(StrictModel):
    goal: Literal["full", "script", "script_storyboard", "reaudit"] = "full"
    strength: Literal["conservative", "balanced", "restructure"] = "conservative"
    duration: int | None = Field(default=None, ge=1, le=3600)
    ratio: str | None = None
    generator: str | None = None
    must_preserve: list[str] = Field(default_factory=list)
    must_avoid: list[str] = Field(default_factory=list)
    audience: str = Field(default="", max_length=500)
    platform: str = Field(default="", max_length=120)
    language: str = Field(default="中文", max_length=80)
    brand_requirements: list[str] = Field(default_factory=list)
    prohibited_content: list[str] = Field(default_factory=list)
    source_script_version_id: str | None = None


class StoryboardAcceptRequest(StrictModel):
    scope: Literal["all", "script_only", "shots_only"] = "all"
    shot_ids: list[str] = Field(default_factory=list)


class StorySpecV3(StrictModel):
    creative_goal: str = Field(default="", max_length=10000)
    audience: str = Field(default="", max_length=500)
    platform: str = Field(default="", max_length=120)
    duration: int = Field(default=30, ge=1, le=3600)
    ratio: str = Field(default="9:16", max_length=20)
    language: str = Field(default="中文", max_length=80)
    brand_requirements: list[str] = Field(default_factory=list)
    must_preserve: list[str] = Field(default_factory=list)
    must_avoid: list[str] = Field(default_factory=list)
    structure: list[dict[str, Any]] = Field(default_factory=list)
    beats: list[dict[str, Any]] = Field(default_factory=list)


class StoryDocumentUpdateV3(StrictModel):
    expected_revision: int = Field(ge=1)
    spec: StorySpecV3
    script: str = Field(default="", max_length=200000)
    scenes: list[dict[str, Any]] = Field(default_factory=list)
    shots: list[dict[str, Any]] = Field(default_factory=list)


class StoryRollbackV3(StrictModel):
    expected_revision: int = Field(ge=1)
    version_id: str = Field(min_length=1, max_length=160)
    scope: Literal["script", "shots", "all"] = "all"


# ---------------------------------------------------------------------------
# V3 graph runtime and delivery timeline.
# ---------------------------------------------------------------------------

class GraphPosition(StrictModel):
    x: float = 0
    y: float = 0


class WorkflowNodeV3(StrictModel):
    id: str = Field(min_length=1, max_length=120)
    kind: str = Field(min_length=1, max_length=80)
    label: str = Field(default="", max_length=200)
    position: GraphPosition = Field(default_factory=GraphPosition)
    config: dict[str, Any] = Field(default_factory=dict)
    inputs: list[str] = Field(default_factory=list)
    outputs: list[str] = Field(default_factory=list)
    status: str = Field(default="idle", max_length=40)
    version: int = Field(default=1, ge=1)
    locked: bool = False


class WorkflowEdgeV3(StrictModel):
    id: str = Field(min_length=1, max_length=160)
    source: str = Field(min_length=1, max_length=120)
    target: str = Field(min_length=1, max_length=120)
    source_port: str | None = Field(default=None, max_length=80)
    target_port: str | None = Field(default=None, max_length=80)
    relation: Literal["execution", "reference", "lineage", "annotation"] = "execution"


class WorkflowGraphV3(StrictModel):
    version: int = Field(default=1, ge=1)
    template_id: str | None = Field(default=None, max_length=120)
    nodes: list[WorkflowNodeV3] = Field(default_factory=list)
    edges: list[WorkflowEdgeV3] = Field(default_factory=list)
    viewport: dict[str, float] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class WorkflowGraphUpdateV3(StrictModel):
    graph: WorkflowGraphV3
    expected_revision: int = Field(ge=1)


class WorkflowTemplateCreateV3(StrictModel):
    id: str | None = Field(default=None, min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)
    category: str = Field(default="custom", min_length=1, max_length=40)
    graph: WorkflowGraphV3


class WorkflowTemplateApplyV3(StrictModel):
    template_id: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=1)


class ProviderRoutePreviewV3(StrictModel):
    capability: str = Field(min_length=1, max_length=80)
    provider_profile_id: str | None = None
    model: str | None = None
    quality: str = Field(default="balanced", max_length=40)
    privacy: Literal["local_first", "cloud_allowed"] = "cloud_allowed"
    width: int | None = Field(default=None, ge=1, le=8192)
    height: int | None = Field(default=None, ge=1, le=8192)
    duration: float | None = Field(default=None, gt=0, le=36000)


class ArtifactLineageCreateV3(StrictModel):
    parent_artifact_id: str = Field(min_length=1, max_length=120)
    relation: str = Field(default="derived_from", min_length=1, max_length=80)
    node_id: str | None = Field(default=None, max_length=120)


class WorkflowRunCreateV3(StrictModel):
    project_id: str = Field(min_length=1, max_length=100)
    graph_revision: int | None = Field(default=None, ge=1)
    node_ids: list[str] = Field(default_factory=list)
    max_parallel: int = Field(default=3, ge=1, le=12)
    confirmed: bool = False


class WorkflowRunEstimateV3(StrictModel):
    project_id: str = Field(min_length=1, max_length=100)
    node_ids: list[str] = Field(default_factory=list)


class RunDecisionV3(StrictModel):
    detail: dict[str, Any] = Field(default_factory=dict)


class AgentNodeChangeV3(StrictModel):
    node_id: str = Field(min_length=1, max_length=120)
    label: str | None = Field(default=None, max_length=200)
    position: GraphPosition | None = None
    config: dict[str, Any] | None = None
    inputs: list[str] | None = None
    outputs: list[str] | None = None
    status: str | None = Field(default=None, max_length=40)
    version: int | None = Field(default=None, ge=1)
    locked: bool | None = None


class AgentEdgeChangeV3(StrictModel):
    edge_id: str = Field(min_length=1, max_length=160)
    source: str | None = Field(default=None, min_length=1, max_length=120)
    target: str | None = Field(default=None, min_length=1, max_length=120)
    source_port: str | None = Field(default=None, max_length=80)
    target_port: str | None = Field(default=None, max_length=80)
    relation: Literal["execution", "reference", "lineage", "annotation"] | None = None


class AgentCandidateV3(StrictModel):
    kind: Literal["script", "prompt", "storyboard", "brief"]
    title: str = Field(default="Agent 候选", max_length=200)
    target_id: str | None = Field(default=None, max_length=160)
    content: str | dict[str, Any] = ""
    replace_active: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


class AgentApprovalGateV3(StrictModel):
    reason: str = Field(min_length=1, max_length=120)
    node_ids: list[str] = Field(default_factory=list)
    detail: dict[str, Any] = Field(default_factory=dict)


class AgentPatchV3(StrictModel):
    version: int = Field(default=1, ge=1)
    base_project_revision: int = Field(default=1, ge=1)
    base_graph_revision: int = Field(default=1, ge=1)
    add_nodes: list[WorkflowNodeV3] = Field(default_factory=list)
    modify_nodes: list[AgentNodeChangeV3] = Field(default_factory=list)
    remove_node_ids: list[str] = Field(default_factory=list)
    add_edges: list[WorkflowEdgeV3] = Field(default_factory=list)
    modify_edges: list[AgentEdgeChangeV3] = Field(default_factory=list)
    remove_edge_ids: list[str] = Field(default_factory=list)
    candidates: list[AgentCandidateV3] = Field(default_factory=list)
    suggested_run_node_ids: list[str] = Field(default_factory=list)
    suggested_approval_gates: list[AgentApprovalGateV3] = Field(default_factory=list)
    actions: list[str] = Field(default_factory=list)
    requires_confirmation: bool = False
    unsupported_operations: list[str] = Field(default_factory=list)
    notes: str = Field(default="", max_length=4000)


class AgentPlanCreateV3(StrictModel):
    project_id: str = Field(min_length=1, max_length=100)
    message: str = Field(min_length=1, max_length=30000)
    selected_node_ids: list[str] = Field(default_factory=list)
    graph_revision: int | None = Field(default=None, ge=1)
    project_revision: int | None = Field(default=None, ge=1)
    skill_id: str | None = Field(default=None, max_length=120)
    provider_profile_id: str | None = Field(default=None, max_length=120)
    model: str | None = Field(default=None, max_length=200)
    context: dict[str, Any] = Field(default_factory=dict)
    cost_boundary: dict[str, Any] = Field(default_factory=dict)


class AgentPatchPreviewV3(StrictModel):
    project_id: str = Field(min_length=1, max_length=100)
    patch: dict[str, Any] = Field(default_factory=dict)
    graph_revision: int | None = Field(default=None, ge=1)
    project_revision: int | None = Field(default=None, ge=1)


class AgentPlanDecisionV3(StrictModel):
    expected_project_revision: int | None = Field(default=None, ge=1)
    expected_graph_revision: int | None = Field(default=None, ge=1)
    detail: dict[str, Any] = Field(default_factory=dict)


class TimelineClipV3(StrictModel):
    id: str = Field(min_length=1, max_length=120)
    artifact_id: str | None = Field(default=None, max_length=120)
    source: str | None = Field(default=None, max_length=1000)
    start: float = Field(default=0, ge=0)
    duration: float = Field(gt=0, le=36000)
    source_in: float = Field(default=0, ge=0)
    speed: float = Field(default=1, gt=0, le=16)
    volume: float = Field(default=1, ge=0, le=4)
    fade_in: float = Field(default=0, ge=0, le=30)
    fade_out: float = Field(default=0, ge=0, le=30)
    transition: str | None = Field(default=None, max_length=80)
    metadata: dict[str, Any] = Field(default_factory=dict)


class TimelineTrackV3(StrictModel):
    id: str = Field(min_length=1, max_length=120)
    kind: Literal["video", "overlay", "dialogue", "music", "ambience", "sfx", "captions"]
    name: str = Field(default="", max_length=120)
    muted: bool = False
    locked: bool = False
    clips: list[TimelineClipV3] = Field(default_factory=list)


class TimelineDocumentV3(StrictModel):
    version: int = Field(default=1, ge=1)
    fps: int = Field(default=30, ge=1, le=120)
    width: int = Field(default=1080, ge=64, le=8192)
    height: int = Field(default=1920, ge=64, le=8192)
    duration: float = Field(default=30, gt=0, le=36000)
    tracks: list[TimelineTrackV3] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_structure(self):
        track_ids = [track.id for track in self.tracks]
        if len(track_ids) != len(set(track_ids)):
            raise ValueError("时间线轨道 ID 不能重复。")
        clip_ids: list[str] = []
        for track in self.tracks:
            for clip in track.clips:
                clip_ids.append(clip.id)
                if clip.start + clip.duration > self.duration + 0.001:
                    raise ValueError(f"片段 {clip.id} 超出时间线总时长。")
                if track.kind in {"video", "overlay", "dialogue", "music", "ambience", "sfx"} and not clip.artifact_id and not clip.source:
                    raise ValueError(f"媒体片段 {clip.id} 必须指定 artifact_id 或 source。")
        if len(clip_ids) != len(set(clip_ids)):
            raise ValueError("时间线片段 ID 不能重复。")
        return self


class TimelineUpdateV3(StrictModel):
    document: TimelineDocumentV3
    expected_revision: int = Field(ge=1)


class TimelineAssemblyRequestV3(StrictModel):
    expected_revision: int = Field(ge=1)
    include_audio: bool = True
    replace_existing: bool = False


class RenderEstimateV3(StrictModel):
    project_id: str = Field(min_length=1, max_length=100)
    timeline_revision: int | None = Field(default=None, ge=1)
    output_name: str = Field(default="final.mp4", min_length=1, max_length=120)
    fps: int | None = Field(default=None, ge=1, le=120)
    resolution: str | None = Field(default=None, max_length=20)
    delivery_set: Literal["master_clean_srt", "master_srt", "single"] = "master_clean_srt"
    subtitle_mode: Literal["burn_in", "external"] = "burn_in"


class RenderCreateV3(RenderEstimateV3):
    confirmed: bool = False
    use_proxies: bool = False


class TimelinePreviewRequestV3(StrictModel):
    expected_revision: int = Field(ge=1)
    resolution: str = Field(default="960x540", min_length=7, max_length=20)
    use_proxies: bool = True


class RenderDecisionV3(StrictModel):
    detail: dict[str, Any] = Field(default_factory=dict)


class BackupCreateV3(StrictModel):
    project_id: str | None = Field(default=None,max_length=100)


class RecoveryPreviewV3(StrictModel):
    source_project_id: str = Field(min_length=1,max_length=100)
    proposed_name: str | None = Field(default=None,max_length=240)


class RecoveryApplyV3(StrictModel):
    preview_id: str = Field(min_length=1,max_length=120)
    manifest_sha256: str = Field(min_length=64,max_length=64)
    confirmed: bool = False


class ProxyCreateV3(StrictModel):
    artifact_id: str = Field(min_length=1, max_length=120)
    preset: Literal["preview_360p", "preview_540p", "preview_720p"] = "preview_540p"
