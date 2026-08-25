export type ProjectRecord = {
  document: {
    id: string;
    name: string;
    brief?: string;
    ratio?: string;
    duration?: number;
    generator?: string;
    sortOrder?: number;
    createdAt?: string | null;
    productionStatus?: 'in_progress' | 'completed';
    lifecycleStatus?: 'active' | 'archived';
    assets?: Array<Record<string, unknown>>;
    shots?: Array<Record<string, unknown>>;
    audio?: AudioStudioDocument;
  };
  revision: number;
  updated_at: string;
  lifecycle_status?: 'active' | 'archived';
};

export type AudioVoiceProfile = {
  id: string;
  name: string;
  character_id?: string | null;
  role?: 'character' | 'narrator' | string;
  source_type: 'preset' | 'clone' | 'design' | string;
  provider?: string;
  model?: string;
  provider_profile_id?: string | null;
  provider_voice_id?: string;
  language?: string;
  dialect?: string;
  traits?: string[];
  pronunciation_risks?: string[] | string;
  register?: string;
  age_range?: string;
  pitch_energy?: string;
  breath_noise_profile?: string;
  consent_status: 'not-required' | 'pending-consent' | 'consent-supplied' | 'consent-verified' | 'restricted' | string;
  consent_evidence_ref?: string;
  allowed_use?: string;
  geography?: string;
  term?: string;
  provider_eligibility?: string;
  logical_asset_id?: string | null;
  selected_audition_id?: string | null;
  continuity_anchor?: Record<string, string>;
  status: 'draft' | 'audition' | 'approved' | 'blocked' | string;
  notes?: string;
};

export type AudioVoiceReference = {
  id: string;
  voice_id?: string | null;
  artifact_id?: string | null;
  source_type?: string;
  consent_status?: string;
  evidence_ref?: string;
  allowed_use?: string;
  geography?: string;
  term?: string;
  notes?: string;
};

export type AudioAudition = {
  id: string;
  voice_id?: string | null;
  character_id?: string | null;
  condition: 'neutral' | 'emotional' | 'pronunciation-stress' | string;
  text: string;
  emotion?: string;
  instructions?: string;
  target_duration?: number | null;
  artifact_id?: string | null;
  qa_run_id?: string | null;
  provider_profile_id?: string | null;
  provider?: string | null;
  model?: string | null;
  status: string;
  notes?: string;
};

export type AudioDialogueTask = {
  id: string;
  asset_id?: string | null;
  character_id?: string | null;
  voice_id?: string | null;
  logical_asset_id?: string | null;
  shot_ids: string[];
  text: string;
  emotion?: string;
  target_duration?: number | null;
  artifact_id?: string | null;
  qa_run_id?: string | null;
  operation: 'tts' | 'voice-clone' | 'voice-design' | 'speech-to-speech' | 'take-regeneration' | string;
  execution_status: string;
  selected_take_id?: string | null;
  provider_profile_id?: string | null;
  provider?: string | null;
  model?: string | null;
  notes?: string;
};

export type AudioTake = {
  id: string;
  dialogue_id?: string | null;
  voice_id?: string | null;
  version: number;
  artifact_id?: string | null;
  logical_asset_id?: string | null;
  qa_run_id?: string | null;
  provider_profile_id?: string | null;
  provider?: string | null;
  model?: string | null;
  operation?: string;
  status: string;
  notes?: string;
};

export type AudioMusicCue = {
  id: string;
  asset_id?: string | null;
  shot_ids: string[];
  purpose: string;
  entry?: string;
  development?: string;
  exit?: string;
  duration?: number | null;
  bpm?: number | null;
  instrumentation?: string;
  texture?: string;
  dialogue_avoidance?: string[];
  rights_status: string;
  execution_status: string;
  provider_hint?: string;
  notes?: string;
};

export type AudioSoundDesignItem = {
  id: string;
  asset_id?: string | null;
  shot_ids: string[];
  kind: 'ambience' | 'sfx' | 'foley' | 'transition' | string;
  description: string;
  entry?: string;
  exit?: string;
  rights_status: string;
  execution_status: string;
  notes?: string;
};

export type AudioStudioDocument = {
  version: number;
  selected_mode?: 'overview' | 'voices' | 'music' | 'sound' | 'handoff' | string;
  voices: AudioVoiceProfile[];
  voice_references?: AudioVoiceReference[];
  auditions?: AudioAudition[];
  dialogues: AudioDialogueTask[];
  takes?: AudioTake[];
  music_cues: AudioMusicCue[];
  sound_design: AudioSoundDesignItem[];
  handoff: { status: string; approved_asset_ids: string[]; notes?: string };
  updated_at?: string;
};

export type AudioStudioEnvelope = {
  project_id: string;
  revision: number;
  document: AudioStudioDocument;
  assets: LibraryAsset[];
  capabilities?: Record<string, { ready: boolean; status?: string; provider_profile_id?: string | null; provider?: string | null; model?: string | null; reason?: string | null }>;
  audio_gates?: Record<string, { status: string; allowed: boolean; missing: string[]; next_action: string; [key: string]: unknown }>;
  workflow?: { router?: string; voice?: string; music?: string; qa_owner?: string };
};

export type SpeechGenerateInput = {
  text: string;
  model?: string;
  voice?: string;
  format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  instructions?: string;
  speed?: number;
  dialogue_id?: string;
  logical_asset_id?: string | null;
  shot_ids?: string[];
  emotion?: string;
  target_duration?: number | null;
  confirmed: boolean;
  provider_profile_id?: string;
  voice_id?: string;
  audition_id?: string;
  take_id?: string;
  character_id?: string;
  operation?: string;
};

export type ProjectCreateInput = {
  name: string;
  brief: string;
  ratio: string;
  duration: number;
  generator: string;
};

export type HomeStatus =
  | 'not_started'
  | 'in_progress'
  | 'awaiting_confirmation'
  | 'awaiting_review'
  | 'ready'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'skipped';

export type DashboardTask = {
  id: string;
  category: 'content' | 'process' | 'asset' | 'execution' | 'delivery';
  title: string;
  reason: string;
  priority: 'critical' | 'high' | 'normal';
  status: HomeStatus;
  route: 'story' | 'assets' | 'canvas' | 'timeline' | 'audio' | 'settings' | 'home';
  targetId?: string;
  action: string;
  blockedBy?: string[];
};

export type ProjectProgress = {
  completed: number;
  total: number;
  percent: number;
};

export type ProjectHomeSummary = {
  project_id: string;
  name: string;
  ratio?: string;
  duration?: number;
  generator?: string;
  status: HomeStatus;
  progress: ProjectProgress;
  current_stage_id: string | null;
  current_stage_label: string | null;
  blocker_count: number;
  review_count: number;
  next_task: DashboardTask | null;
  updated_at?: string;
};

export type DashboardStage = {
  id: string;
  label: string;
  order: number;
  status: HomeStatus;
  completed: number;
  total: number;
  reason: string;
  route: string;
  next_task_id?: string;
};

export type ProjectDashboard = {
  project: ProjectHomeSummary;
  stages: DashboardStage[];
  primary_next_task: DashboardTask | null;
  task_queue: DashboardTask[];
  metrics: {
    content: Record<string, number | string>;
    assets: Record<string, number | string>;
    execution: Record<string, number | string>;
    delivery: Record<string, number | string>;
  };
  recent_activity: Array<{
    id: string;
    type: string;
    label: string;
    status: HomeStatus;
    created_at: string;
  }>;
  source_revisions: {
    project: number;
    graph: number;
    timeline: number;
  };
};

export type DashboardEnvelope = {
  generated_at: string;
  projects: ProjectHomeSummary[];
  selected_project: ProjectDashboard | null;
};

export type SettingsProvider = {
  id: string;
  provider_type: string;
  providerType?: string;
  display_name: string;
  base_url: string;
  model_config: Record<string, unknown>;
  capabilities: string[];
  enabled: boolean;
  credential_configured: boolean;
  credential?: { required: boolean; configured: boolean; source?: string | null; optional?: boolean };
  credential_mask?: string | null;
  models: string[];
  model_catalog?: Array<Record<string, unknown>>;
  model_readiness?: Record<string, boolean>;
  healthy?: boolean | null;
  last_probe?: Record<string, unknown> | null;
  contract?: {
    adapter: string;
    version: string;
    capabilities: string[];
    capability_specs: Record<string, Record<string, unknown>>;
    input_limits: Record<string, Record<string, unknown>>;
    output_types: Record<string, string[]>;
    task_modes: Record<string, string>;
  };
};

export type SettingsPreset = {
  preset_id: string;
  id: string;
  provider_type: string;
  display_name: string;
  base_url: string;
  model_config: Record<string, unknown>;
  capabilities: string[];
  enabled: boolean;
  model_options?: Array<{ id: string; label: string; description?: string }>;
};

export type SettingsBinding = {
  capability: string;
  provider_profile_id: string;
  model: string | null;
  updated_at: string;
  provider?: { id: string; name: string; type: string; enabled: boolean; models: string[] } | null;
};

export type SettingsEnvelope = {
  settings_version: string;
  system: {
    runtime: string;
    version: string;
    schema_version: number;
    database: { path: string; status: string };
    keyring: { available: boolean; backend?: string | null };
    media: { ffmpeg?: string | null; ffprobe?: string | null };
    openai: { profile_id?: string | null; credential_configured: boolean };
    disk_free_bytes: number;
    provider_count: number;
  };
  providers: SettingsProvider[];
  presets: SettingsPreset[];
  bindings: SettingsBinding[];
  capabilities: string[];
  orchestrator_models: { default: string; models: Array<{ id: string; label: string; description: string }> };
  routing_policy?: string;
};

export type GraphNodeData = {
  label: string;
  kind: string;
  config: Record<string, unknown>;
  status: string;
  inputs: string[];
  outputs: string[];
  version: number;
  locked: boolean;
};

export type GraphNode = {
  id: string;
  kind: string;
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  inputs: string[];
  outputs: string[];
  status: string;
  version: number;
  locked: boolean;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  source_port?: string | null;
  target_port?: string | null;
  relation: 'execution' | 'reference' | 'lineage' | 'annotation';
};

export type WorkflowGraph = {
  version: number;
  template_id?: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewport: Record<string, number>;
  metadata: Record<string, unknown>;
};

export type GraphEnvelope = {
  project_id: string;
  revision: number;
  graph: WorkflowGraph;
  updated_at: string;
};

export type AssetBoardNodeType = 'asset' | 'shot' | 'group' | 'handoff' | 'artifact';
export type AssetBoardEdgeRelation = 'shot_dependency' | 'reference' | 'fusion_input' | 'candidate';

export type AssetBoardNode = {
  id: string;
  node_type: AssetBoardNodeType;
  label: string;
  position: { x: number; y: number };
  asset_id?: string;
  shot_id?: string;
  config: Record<string, unknown>;
  status: string;
};

export type AssetBoardEdge = {
  id: string;
  source: string;
  target: string;
  relation: AssetBoardEdgeRelation;
};

export type AssetBoard = {
  version: number;
  viewport: { x: number; y: number; zoom: number };
  nodes: AssetBoardNode[];
  edges: AssetBoardEdge[];
  metadata: { story_revision?: number; asset_source_revision?: number; [key: string]: unknown };
};

export type AssetBoardEnvelope = {
  project_id: string;
  revision: number;
  board: AssetBoard;
  updated_at: string;
};

export type RunEstimate = {
  node_count: number;
  paid_node_count: number;
  paid_nodes: Array<{
    node_id: string;
    kind: string;
    estimated_cost: number;
    currency?: string;
    provider_profile_id?: string | null;
    model?: string | null;
    quantity?: number;
    resolution?: string | { width?: number; height?: number } | null;
    duration?: number | null;
    seed?: number | string | null;
    prompt_version?: string | null;
    privacy?: string;
  }>;
  selected_node_ids?: string[];
  impact_node_ids?: string[];
  estimated_cost: number;
  currency: string;
  requires_confirmation: boolean;
};

export type WorkflowRun = {
  id: string;
  project_id: string;
  graph_revision: number;
  status: string;
  estimate: RunEstimate;
  created_at: string;
  updated_at: string;
};

export type WorkflowRunDetail = WorkflowRun & {
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  nodes: Array<{
    node_id: string;
    status: string;
    attempt: number;
    output: Record<string, unknown> | null;
    error: Record<string, unknown> | null;
  }>;
  approval_gates: Array<{
    id: string;
    node_id: string | null;
    reason: string;
    status: string;
    estimate: Record<string, unknown>;
  }>;
};

export type AgentPlan = {
  id: string;
  project_id: string;
  status: string;
  message: string;
  base_project_revision: number;
  base_graph_revision: number;
  input_snapshot: Record<string, any>;
  patch: Record<string, any>;
  preview: Record<string, any>;
  reply?: string;
  candidates?: Array<Record<string, any>>;
  decision?: Record<string, any>;
};

export type WorkflowManifest = {
  skill_id: string;
  skill_version: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  instructions?: string;
  deterministic_gates?: string[];
  next_routes?: string[];
  approval_policy?: string;
};

export type TimelineClip = {
  id: string;
  artifact_id?: string | null;
  source?: string | null;
  start: number;
  duration: number;
  source_in: number;
  speed: number;
  volume: number;
  fade_in: number;
  fade_out: number;
  transition?: string | null;
  metadata: Record<string, unknown>;
};

export type TimelineTrack = {
  id: string;
  kind: 'video' | 'overlay' | 'dialogue' | 'music' | 'ambience' | 'sfx' | 'captions' | string;
  name: string;
  muted: boolean;
  locked: boolean;
  clips: TimelineClip[];
};

export type TimelineDocument = {
  version: number;
  fps: number;
  width: number;
  height: number;
  duration: number;
  tracks: TimelineTrack[];
  metadata: Record<string, unknown>;
};

export type TimelineEnvelope = {
  project_id: string;
  revision: number;
  document: TimelineDocument;
  updated_at: string;
};

export type TimelinePreflightBlocker = {
  code: string;
  message: string;
  source?: string | null;
};

export type TimelinePreflightShot = {
  shot_id: string;
  scene_id: string;
  order: number;
  duration: number;
  status: string;
  clip_ids: string[];
  artifact_ids: string[];
  thumbnail_url?: string | null;
  purpose?: string;
  camera?: string;
  action?: string;
  blockers: TimelinePreflightBlocker[];
};

export type TimelinePreflight = {
  project_id: string;
  timeline_revision: number;
  summary: {
    shot_total: number;
    shot_placed: number;
    shot_ready: number;
    blocked_shots: number;
    audio_ready: number;
    caption_count: number;
    delivery_ready: boolean;
    error_count: number;
    warning_count: number;
  };
  shots: TimelinePreflightShot[];
  tracks: Array<{ id: string; kind: string; name: string; muted: boolean; locked: boolean; clip_count: number }>;
  warnings: TimelinePreflightBlocker[];
  deliverables: { master_burn_in: string; clean: string; srt: string };
  asset_summary?: Record<string, any>;
};

export type RenderEstimate = {
  estimated_cost: number;
  currency: string;
  estimated_seconds: number;
  requires_confirmation: boolean;
  input_count: number;
  track_count: number;
};

export type RenderJob = {
  id: string;
  project_id: string;
  timeline_revision: number;
  status: string;
  request: Record<string, unknown>;
  manifest: Record<string, any>;
  result: Record<string, any> | null;
  error: Record<string, any> | null;
  confirmed_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type StorySpec = {
  creative_goal: string;
  audience: string;
  platform: string;
  duration: number;
  ratio: string;
  language: string;
  brand_requirements: string[];
  must_preserve: string[];
  must_avoid: string[];
  structure: Array<Record<string, unknown>>;
  beats: Array<Record<string, unknown>>;
};

export type StoryShot = {
  id: string;
  scene: string;
  duration: number;
  purpose: string;
  size: string;
  camera: string;
  action: string;
  [key: string]: unknown;
};

export type StoryDocument = {
  spec: StorySpec;
  script: string;
  scenes: Array<Record<string, unknown>>;
  shots: StoryShot[];
  script_versions: Array<Record<string, unknown>>;
  storyboard_versions: Array<Record<string, unknown>>;
};

export type StoryChecks = {
  ok: boolean;
  errors: number;
  warnings: number;
  issues: Array<{ code: string; severity: string; message: string; shot_id?: string }>;
  metrics: { scene_count: number; shot_count: number; total_duration: number; target_duration: number; estimated_dialogue_duration?: number };
};

export type StoryEnvelope = {
  project_id: string;
  revision: number;
  story: StoryDocument;
  checks: StoryChecks;
};

export type AssetPromptCard = {
  id: string;
  assetClass: string;
  name: string;
  priority?: string;
  required?: boolean;
  targetSkill?: string;
  relevantShots?: string[];
  prompt: string;
  promptPack?: Record<string, unknown>;
  mustPreserve?: string[];
  mustAvoid?: string[];
  promptVersion?: string;
  promptQaDecision?: string;
  generationChoiceStatus?: string;
  generationStatus?: string;
  imageGenerationEligible?: boolean;
};

export type AssetPromptRun = {
  id: string;
  status: string;
  promptCards: AssetPromptCard[];
  missingA?: string[];
  regulatorOutput?: Record<string, unknown>;
  promptOutput?: Record<string, unknown>;
};

export type AssetPromptRunEnvelope = {
  project_id: string;
  revision: number;
  run: AssetPromptRun;
  story: StoryEnvelope;
  library: AssetLibraryEnvelope;
  asset_board: AssetBoardEnvelope;
};

export type FusionPromptRunEnvelope = {
  project_id: string;
  revision: number;
  board_revision: number;
  run: {
    id: string;
    status: string;
    fusion_asset_id: string;
    shot_id: string;
    source_asset_ids: string[];
    source_prompt_versions?: Record<string, string>;
    input_fingerprint?: string;
    warnings?: string[];
  };
  prompt_version: Record<string, any>;
  fusion_asset: LibraryAsset | null;
  library: AssetLibraryEnvelope;
  asset_board: AssetBoardEnvelope;
};

export type AssetImageGenerate = {
  prompt: string;
  prompt_version?: string;
  size?: '1024x1024' | '1024x1536' | '1536x1024';
  quality?: 'low' | 'medium' | 'high';
  confirmed: boolean;
  provider_profile_id?: string;
};

export type StoryRun = {
  id: string;
  project_id: string;
  status: string;
  active_step: string;
  storyboard_output?: Record<string, unknown> | null;
  regulator_output?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
};

export type StoryDiff = {
  project_id: string;
  from_version_id: string;
  to_version_id: string;
  script_diff: Array<{ type: 'same' | 'add' | 'del'; text: string }>;
  shot_diff: { added: Array<Record<string, unknown>>; removed: Array<Record<string, unknown>>; changed: Array<{ id: string; fields: string[]; before: Record<string, unknown>; after: Record<string, unknown> }> };
};

export type AssetReference = {
  id?: string;
  reference_id: string;
  reference_kind?: string;
  artifact_id?: string | null;
  role: string;
  source?: string;
  notes?: string;
};

export type AssetReadiness = {
  status: string;
  kind?: 'production' | 'reference' | string;
  required: boolean;
  grade?: string;
  ready: boolean;
  registered_ready?: boolean;
  production_ready?: boolean;
  missing: string[];
  production_missing?: string[];
  next_action?: string;
  qa_kind?: 'prompt' | 'image' | 'video' | 'audio' | 'reference' | string;
  reference_ready?: boolean;
  qa_decision?: string | null;
  registered: boolean;
  has_file: boolean;
  manual_production_approval?: Record<string, any> | null;
  manual_approval_active?: boolean;
};

export type AssetWorkflow = {
  state: string;
  kind: 'production' | 'reference' | string;
  qa_type: 'prompt' | 'image' | 'video' | 'audio' | 'reference' | string;
  qa_owner?: string | null;
  artifact_id?: string | null;
  next_action: { code: string; label: string; enabled: boolean };
  allowed_actions: string[];
  blockers: string[];
};

export type AssetComparison = {
  id: string;
  comparison_group: string;
  strategy: string;
  prompt_version?: string | null;
  candidates: Array<{ artifact_id: string; score?: number | null; decision: string; comment?: string; annotations?: string[] }>;
  notes: string;
  created_at: string;
  updated_at: string;
};

export type LibraryAsset = Record<string, any> & {
  id: string;
  name?: string;
  assetClass: string;
  grade?: string;
  assetMetadata?: Record<string, any>;
  readiness: AssetReadiness;
  workflow: AssetWorkflow;
  registered_ready?: boolean;
  production_ready?: boolean;
  next_action?: string;
  artifact_count?: number;
  references: AssetReference[];
  dependencies: Array<{ dependency_asset_id: string; shot_id?: string | null; relation: string; role?: string; required: boolean }>;
  comparisons: AssetComparison[];
  fusionGate?: { allowed: boolean; source_asset_ids: string[]; missing_sources: Array<Record<string, any>>; reference_role_issues: Array<Record<string, any>>; message: string };
  fusionPromptState?: 'awaiting_connection' | 'prompt_draft_ready' | 'stale' | string;
  fusionPromptStale?: boolean;
  fusionPromptStaleReason?: string | null;
  fusionPlan?: Record<string, any>;
};

export type AssetLibraryEnvelope = {
  project_id: string;
  assets: LibraryAsset[];
  storage_integrity?: { ok: boolean; orphan_directories?: string[]; missing_project_records?: string[]; artifact_mismatches?: Array<Record<string, any>>; recovery_policy?: string };
  summary: {
    total: number;
    ready: number;
    blocked: number;
    missing_required_a: number;
    registered_ready?: number;
    production_ready?: number;
    artifact_count?: number;
    by_class?: Record<string, number>;
    by_status?: Record<string, number>;
  };
};

export type AssetAuditItem = {
  queue: string;
  queue_label: string;
  asset: LibraryAsset;
  artifact?: Record<string, any> | null;
  qa?: Record<string, any> | null;
  next_action?: string;
};

export type AssetAuditEnvelope = {
  project_id: string;
  queue: string;
  items: AssetAuditItem[];
  counts: Record<string, number>;
  total: number;
  summary: AssetLibraryEnvelope['summary'];
};
