import type { AgentPlan, GraphEnvelope, TimelineEnvelope, StoryEnvelope, AssetBoardEnvelope, AssetLibraryEnvelope, AudioStudioDocument, AudioStudioEnvelope, ProjectRecord, SettingsEnvelope, WorkflowManifest } from './types';

export type AssistantAttachment = {
  id: string;
  project_id: string;
  conversation_id?: string | null;
  message_id?: string | null;
  name: string;
  safe_name: string;
  mime_type: string;
  extension: string;
  byte_size: number;
  sha256: string;
  kind: 'image' | 'document' | 'audio' | 'video' | 'reference' | 'unsupported' | string;
  delivery_mode: 'pending' | 'multimodal' | 'extracted_text' | 'project_reference' | 'unsupported' | string;
  analysis_status: string;
  extracted_chars: number;
  extraction_error?: string | null;
  metadata?: Record<string, unknown>;
  url: string;
  created_at: string;
  updated_at: string;
};

export type AssistantConversation = {
  id: string;
  project_id: string;
  title: string;
  assistant_mode?: 'general' | 'voice-preparation' | string;
  status: string;
  last_contract_hash?: string | null;
  external_consent: string[];
  message_count: number;
  last_message?: string;
  pending_plan_count: number;
  created_at: string;
  updated_at: string;
};

export type AssistantMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system' | string;
  content: string;
  message_type?: string;
  client_message_id?: string | null;
  metadata?: Record<string, unknown>;
  attachments: AssistantAttachment[];
  created_at: string;
};

export type AssistantRunEvent = {
  id?: number;
  run_id: string;
  sequence: number;
  item_id?: string | null;
  event_type: string;
  status: string;
  data: Record<string, any>;
  created_at: string;
};

export type AssistantWorkspaceOperation = {
  id: string;
  workspace: 'story' | 'assets' | 'audio' | 'timeline' | 'workflow' | string;
  action: string;
  target_id?: string | null;
  title: string;
  summary: string;
  before?: any;
  after?: any;
  content?: any;
  source_attachment_ids: string[];
  source_refs: string[];
  contract_snapshot: Record<string, any>;
  risk: 'safe_draft' | 'review_required' | 'blocked' | string;
  requires_confirmation: boolean;
};

export type AssistantRunResult = {
  plan_id?: string;
  reply?: string;
  assistant_mode?: 'general' | 'voice-preparation' | string;
  audio_base_hash?: string;
  audio_revision?: number;
  audio_preparation?: AudioPreparationProposal;
  patch?: Record<string, any> & { workspace_operations?: AssistantWorkspaceOperation[] };
  preview?: Record<string, any>;
  attachment_ids?: string[];
  vision_analyzed_ids?: string[];
  apply?: Record<string, any>;
};

export type AssistantRun = {
  id: string;
  project_id: string;
  conversation_id: string;
  assistant_mode?: 'general' | 'voice-preparation' | string;
  source_message_id: string;
  client_message_id: string;
  status: string;
  contract_hash: string;
  contract_snapshot: Record<string, any>;
  skill: WorkflowManifest | Record<string, any>;
  provider_profile_id?: string | null;
  provider_model?: string | null;
  base_project_revision: number;
  base_graph_revision: number;
  base_timeline_revision?: number | null;
  checkpoint: Record<string, any>;
  result: AssistantRunResult;
  error?: Record<string, any> | null;
  awaiting_confirmation?: {
    provider_profile_id: string;
    provider_name: string;
    provider_type: string;
    model: string;
    purpose: string;
    attachments: Array<{ id: string; name: string; mime_type: string; byte_size: number; delivery_mode: string }>;
  } | null;
  attachments: AssistantAttachment[];
  created_at: string;
  updated_at: string;
  events?: AssistantRunEvent[];
};

export type AssistantContractBundle = {
  bundle_version: string;
  bundle_hash: string;
  prompt_contract: Record<string, any>;
  story_contract: Record<string, any>;
  audio_contract: Record<string, any>;
  voice_preparation_contract?: Record<string, any>;
  workflow_contract: Record<string, any>;
  workspace_capabilities?: Record<string, string[]>;
};

export type AudioAssistantFocus = {
  kind: 'project' | 'voice' | 'dialogue' | 'audition';
  target_id?: string | null;
  character_id?: string | null;
  shot_ids: string[];
};

export type AudioPreparationQuestion = {
  id: string;
  question: string;
  reason?: string;
  required?: boolean;
  options?: string[];
};

export type AudioPreparationVoiceCandidate = {
  candidate_id: string;
  provider_voice_id: string;
  provider_voice_name: string;
  catalog_source: 'live' | 'cached' | 'documented' | string;
  provider_region: 'cn' | 'global' | string;
  language: string;
  locale: string;
  description?: string;
  rationale?: string;
  recommendation_rank: number;
  selectable: boolean;
};

export type AudioPreparationDialogueCandidate = {
  candidate_id: string;
  source_idea?: string;
  meaning_cn?: string;
  source_text: string;
  provider_text: string;
  text_status: 'candidate' | 'conflict' | 'missing' | string;
  character_id?: string | null;
  shot_ids: string[];
  locale: string;
  language: string;
  dialect: string;
  language_boost?: string | null;
  operation: 'tts' | string;
};

export type AudioPreparationVoiceDesign = {
  prompt: string;
  preview_text: string;
  language?: string | null;
  locale?: string | null;
  provider_region?: 'cn' | 'global' | string | null;
  rationale?: string | null;
};

export type AudioPreparationAudition = {
  candidate_id: string;
  voice_candidate_id?: string;
  condition: 'neutral' | 'emotional' | 'pronunciation-stress' | string;
  source_text: string;
  provider_text: string;
  text_status: 'candidate' | 'confirmed' | 'missing' | string;
  locale?: string | null;
  language?: string | null;
  dialect?: string | null;
  language_boost?: string | null;
  direction?: {
    emotion?: string | null;
    intensity?: string | null;
    pace?: string | null;
    pause_plan?: Array<Record<string, unknown>>;
    pronunciation?: Record<string, unknown>;
    speed?: number;
    pitch?: number;
    volume?: number;
    sound_tags?: string[];
  };
};

export type AudioPreparationProposal = {
  proposal_version?: string;
  mode?: string;
  state: 'needs_clarification' | 'ready_for_review' | 'blocked' | string;
  source_idea?: string;
  intent_summary?: string;
  focus?: AudioAssistantFocus;
  questions?: AudioPreparationQuestion[];
  voice_candidates?: AudioPreparationVoiceCandidate[];
  voice_profiles?: Array<Record<string, any>>;
  voice_design?: AudioPreparationVoiceDesign | null;
  dialogue_candidates?: AudioPreparationDialogueCandidate[];
  audition_matrix?: AudioPreparationAudition[];
  preflight?: {
    provider?: string;
    model?: string;
    provider_region?: string;
    language_boost?: string | null;
    format?: string;
    text_chars?: number;
    planned_count?: number;
    requires_text_confirmation?: boolean;
    requires_cost_confirmation?: boolean;
    can_generate?: boolean;
    blockers?: string[];
  };
  checks?: Array<{ code: string; status: string; message: string; field?: string }>;
  operation_ids?: string[];
  contract_snapshot?: Record<string, any>;
};

export type AudioAssistantDraftApplyResult = {
  persisted: false;
  document: AudioStudioDocument;
  applied_operation_ids: string[];
  created_id_map: Record<string, string>;
  project_revision: number;
  audio_revision: number;
  audio_hash: string;
};

export type AssistantWorkspaceProps = {
  open: boolean;
  project?: ProjectRecord;
  mode: string;
  graph: GraphEnvelope | null;
  story: StoryEnvelope | null;
  assetBoard: AssetBoardEnvelope | null;
  assetLibrary: AssetLibraryEnvelope | null;
  audioStudio: AudioStudioEnvelope | null;
  timeline: TimelineEnvelope | null;
  settings: SettingsEnvelope | null;
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  selectedAssetId?: string | null;
  selectedShotId?: string | null;
  dirty: boolean;
  storyDirty: boolean;
  assetBoardDirty: boolean;
  audioDirty: boolean;
  timelineDirty: boolean;
  skills: WorkflowManifest[];
  selectedSkillId: string;
  onSkillChange: (skillId: string) => void;
  onClose: () => void;
  onNavigate: (mode: any) => void;
  onApplied: () => void;
  onNotice: (message: string) => void;
};
