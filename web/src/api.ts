import type { AgentPlan, AudioStudioEnvelope, AudioStudioDocument, AssetAuditEnvelope, AssetBoard, AssetBoardEnvelope, AssetImageGenerate, AssetLibraryEnvelope, AssetPromptRunEnvelope, DashboardEnvelope, FusionPromptRunEnvelope, GraphEnvelope, ProjectCreateInput, ProjectRecord, RenderEstimate, RenderJob, RunEstimate, SettingsEnvelope, SettingsProvider, SpeechGenerateInput, StoryDiff, StoryDocument, StoryEnvelope, StoryRun, TimelineDocument, TimelineEnvelope, TimelinePreflight, WorkflowGraph, WorkflowManifest, WorkflowRun, WorkflowRunDetail } from './types';

export class StudioApiError extends Error {
  status: number;
  code: string;
  category: string;
  retryable: boolean;
  details: unknown;

  constructor(message: string, init: { status?: number; code?: string; category?: string; retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = 'StudioApiError';
    this.status = init.status || 0;
    this.code = init.code || 'request_failed';
    this.category = init.category || 'request';
    this.retryable = Boolean(init.retryable);
    this.details = init.details || {};
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new StudioApiError('无法连接到 FrameFlow 服务。', { category: 'connection', retryable: true, details: error });
  }
  const body = await response.json().catch(() => ({ message: '服务返回无法解析的响应。' }));
  if (!response.ok) {
    const detail = typeof body.detail === 'object' ? body.detail?.message : body.detail;
    throw new StudioApiError(body.message || detail || body.error || `请求失败（${response.status}）`, {
      status: response.status,
      code: body.code || 'http_error',
      category: body.category || 'request',
      retryable: Boolean(body.retryable),
      details: body.details || body.detail || {},
    });
  }
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const studioApi = {
  projects: (includeArchived = false) => request<{ projects: ProjectRecord[] }>(`/api/v2/projects${includeArchived ? '?include_archived=true' : ''}`),
  workflows: () => request<{ workflows: WorkflowManifest[] }>('/api/v2/workflows'),
  createProject: (body: ProjectCreateInput) => request<{ ok: boolean; document: ProjectRecord['document']; revision: number; updated_at: string }>('/api/v2/projects', json('POST', body)),
  dashboard: (projectId?: string) => request<DashboardEnvelope>(`/api/v2/dashboard${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`, { cache: 'no-store' }),
  updateProjectMetadata: (projectId: string, body: { expected_revision: number; name?: string; productionStatus?: 'in_progress' | 'completed'; lifecycleStatus?: 'active' | 'archived'; sortOrder?: number }) =>
    request<{ ok: boolean; document: ProjectRecord['document']; revision: number; updated_at: string; lifecycle_status?: 'active' | 'archived' }>(`/api/v2/projects/${encodeURIComponent(projectId)}`, json('PATCH', body)),
  deleteProject: (projectId: string) => request<{ ok: boolean; project_id: string; project_files_preserved?: boolean }>(`/api/v2/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
  graph: (projectId: string) => request<GraphEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/graph`),
  saveGraph: (projectId: string, graph: WorkflowGraph, expectedRevision: number) =>
    request<GraphEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/graph`, json('PUT', { graph, expected_revision: expectedRevision })),
  assetBoard: (projectId: string) => request<AssetBoardEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/asset-board`, { cache: 'no-store' }),
  audioStudio: (projectId: string) => request<AudioStudioEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/audio-studio`, { cache: 'no-store' }),
  saveAudioStudio: (projectId: string, document: AudioStudioDocument, expectedRevision: number) => request<AudioStudioEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/audio-studio`, json('PUT', { document, expected_revision: expectedRevision })),
  generateSpeech: (projectId: string, body: SpeechGenerateInput) => request<Record<string, any>>(`/api/v2/projects/${encodeURIComponent(projectId)}/audio/tts`, json('POST', body)),
  saveAssetBoard: (projectId: string, board: AssetBoard, expectedRevision: number) =>
    request<AssetBoardEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/asset-board`, json('PUT', { board, expected_revision: expectedRevision })),
  syncAssetBoard: (projectId: string, expectedRevision: number, preserveLayout = true) =>
    request<AssetBoardEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/asset-board/sync`, json('POST', { expected_revision: expectedRevision, preserve_layout: preserveLayout })),
  estimate: (projectId: string, nodeIds: string[] = []) =>
    request<{ project_id: string; graph_revision: number; estimate: RunEstimate }>('/api/v2/runs/estimate', json('POST', { project_id: projectId, node_ids: nodeIds })),
  run: (projectId: string, graphRevision: number, confirmed: boolean, nodeIds: string[] = []) =>
    request<WorkflowRun>('/api/v2/runs', json('POST', { project_id: projectId, graph_revision: graphRevision, node_ids: nodeIds, max_parallel: 3, confirmed })),
  runDetail: (runId: string) => request<WorkflowRunDetail>(`/api/v2/runs/${encodeURIComponent(runId)}`),
  approveRun: (runId: string) => request<WorkflowRun>(`/api/v2/runs/${encodeURIComponent(runId)}/approve`, json('POST', { detail: { approved_by: 'studio-user' } })),
  pauseRun: (runId: string) => request<WorkflowRunDetail>(`/api/v2/runs/${encodeURIComponent(runId)}/pause`, { method: 'POST' }),
  resumeRun: (runId: string) => request<WorkflowRunDetail>(`/api/v2/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' }),
  cancelRun: (runId: string) => request<WorkflowRunDetail>(`/api/v2/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),
  story: (projectId: string) => request<StoryEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/story`),
  saveStory: (projectId: string, story: StoryDocument, expectedRevision: number) => request<StoryEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/story`, json('PUT', {
    // The API accepts only the editable story fields. Version history is
    // returned by the API for display, but it is maintained by the server.
    expected_revision: expectedRevision,
    spec: story.spec,
    script: story.script,
    scenes: story.scenes,
    shots: story.shots,
  })),
  storyRuns: (projectId: string) => request<{ runs: StoryRun[] }>(`/api/v2/projects/${encodeURIComponent(projectId)}/story/runs`),
  createStoryRun: (projectId: string, input: Record<string, unknown>) => request<StoryRun>(`/api/v2/projects/${encodeURIComponent(projectId)}/story/runs`, json('POST', input)),
  startStoryRun: (runId: string) => request<{ run: StoryRun }>(`/api/v2/story-runs/${encodeURIComponent(runId)}/start`, { method: 'POST' }),
  acceptStoryboard: (runId: string, scope: 'all' | 'script_only' | 'shots_only' = 'all', shotIds: string[] = []) => request<{ run: StoryRun }>(`/api/v2/story-runs/${encodeURIComponent(runId)}/accept-storyboard`, json('POST', { scope, shot_ids: shotIds })),
  acceptRegulator: (runId: string) => request<{ run: StoryRun }>(`/api/v2/story-runs/${encodeURIComponent(runId)}/accept-regulator`, { method: 'POST' }),
  storyDiff: (projectId: string, fromVersionId: string, toVersionId: string) => request<StoryDiff>(`/api/v2/projects/${encodeURIComponent(projectId)}/story/diff?from_version_id=${encodeURIComponent(fromVersionId)}&to_version_id=${encodeURIComponent(toVersionId)}`),
  rollbackStory: (projectId: string, versionId: string, expectedRevision: number, scope: 'script' | 'shots' | 'all' = 'all') => request<StoryEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/story/rollback`, json('POST', { version_id: versionId, expected_revision: expectedRevision, scope })),
  generateAssetPrompts: (projectId: string, body: { expected_revision?: number; target_asset_id?: string }) => request<AssetPromptRunEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/asset-prompt-runs`, json('POST', body)),
  generateFusionPrompt: (projectId: string, body: { expected_project_revision: number; expected_board_revision: number; fusion_asset_id: string; shot_id: string; source_asset_ids: string[]; confirmed: boolean; provider_profile_id?: string; model?: string }) => request<FusionPromptRunEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/fusion-prompt-runs`, json('POST', body)),
  approveAssetPrompt: (projectId: string, promptVersionId: string) => request<Record<string, unknown>>(`/api/v2/projects/${encodeURIComponent(projectId)}/prompt-versions/${encodeURIComponent(promptVersionId)}/qa`, json('POST', { decision: 'Approved', report: { manual_review: true, review_source: 'asset-prompt-card', note: '用户在无限画布中确认 Prompt 卡内容。' } })),
  timeline: (projectId: string) => request<TimelineEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/timeline`),
  timelinePreflight: (projectId: string) => request<TimelinePreflight>(`/api/v2/projects/${encodeURIComponent(projectId)}/timeline/preflight`, { cache: 'no-store' }),
  saveTimeline: (projectId: string, document: TimelineDocument, expectedRevision: number) =>
    request<TimelineEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/timeline`, json('PUT', { document, expected_revision: expectedRevision })),
  assembleTimeline: (projectId: string, expectedRevision: number, replaceExisting = false) =>
    request<TimelineEnvelope & { assembly: Record<string, unknown> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/timeline/assemble`, json('POST', { expected_revision: expectedRevision, include_audio: true, replace_existing: replaceExisting })),
  estimateRender: (projectId: string, timelineRevision?: number) =>
    request<{ project_id: string; timeline_revision: number; estimate: RenderEstimate; manifest: Record<string, any> }>('/api/v2/renders/estimate', json('POST', { project_id: projectId, timeline_revision: timelineRevision, delivery_set: 'master_clean_srt', subtitle_mode: 'burn_in' })),
  createRender: (projectId: string, timelineRevision: number, confirmed = false) =>
    request<RenderJob>('/api/v2/renders', json('POST', { project_id: projectId, timeline_revision: timelineRevision, confirmed, delivery_set: 'master_clean_srt', subtitle_mode: 'burn_in' })),
  previewTimeline: (projectId: string, expectedRevision: number, resolution = '960x540') =>
    request<RenderJob>(`/api/v2/projects/${encodeURIComponent(projectId)}/timeline/preview`, json('POST', { expected_revision: expectedRevision, resolution, use_proxies: true })),
  approveRender: (renderId: string) => request<RenderJob>(`/api/v2/renders/${encodeURIComponent(renderId)}/approve`, json('POST', { detail: { approved_by: 'studio-user' } })),
  render: (renderId: string) => request<RenderJob>(`/api/v2/renders/${encodeURIComponent(renderId)}`),
  createProxy: (projectId: string, artifactId: string, preset: 'preview_360p' | 'preview_540p' | 'preview_720p' = 'preview_540p') =>
    request<Record<string, unknown>>(`/api/v2/projects/${encodeURIComponent(projectId)}/proxies`, json('POST', { artifact_id: artifactId, preset })),
  proxy: (proxyId: string) => request<Record<string, unknown>>(`/api/v2/proxies/${encodeURIComponent(proxyId)}`),
  providers: () => request<{ providers: Array<Record<string, unknown>>; capability_contract: string[] }>('/api/v2/providers/catalog'),
  settings: () => request<SettingsEnvelope>('/api/v2/settings', { cache: 'no-store' }),
  settingsProviders: () => request<{ providers: SettingsProvider[]; presets: SettingsEnvelope['presets'] }>('/api/v2/settings/providers'),
  createSettingsProvider: (body: Record<string, unknown>) => request<{ provider: SettingsProvider }>('/api/v2/settings/providers', json('POST', body)),
  addSettingsProviderPreset: (presetId: string) => request<{ provider: SettingsProvider; preset_id: string }>(`/api/v2/settings/providers/from-preset/${encodeURIComponent(presetId)}`, json('POST', {})),
  updateSettingsProvider: (providerId: string, body: Record<string, unknown>) => request<{ provider: SettingsProvider }>(`/api/v2/settings/providers/${encodeURIComponent(providerId)}`, json('PATCH', body)),
  deleteSettingsProvider: (providerId: string) => request<{ ok: boolean; providers: SettingsProvider[] }>(`/api/v2/settings/providers/${encodeURIComponent(providerId)}`, { method: 'DELETE' }),
  writeSettingsCredential: (providerId: string, apiKey: string) => request<{ ok: boolean; credential_configured: boolean; credential_mask?: string; storage: string }>(`/api/v2/settings/providers/${encodeURIComponent(providerId)}/credential`, json('POST', { api_key: apiKey })),
  importSettingsCredential: (providerId: string, environmentVariable: string) => request<{ ok: boolean; credential_configured: boolean; credential_mask?: string; storage: string }>(`/api/v2/settings/providers/${encodeURIComponent(providerId)}/credential/import`, json('POST', { environment_variable: environmentVariable })),
  clearSettingsCredential: (providerId: string) => request<{ ok: boolean; credential_configured: boolean; cleared_system_store: boolean }>(`/api/v2/settings/providers/${encodeURIComponent(providerId)}/credential`, { method: 'DELETE' }),
  probeSettingsProvider: (providerId: string) => request<{ provider: SettingsProvider; probe: Record<string, unknown> }>(`/api/v2/settings/providers/${encodeURIComponent(providerId)}/probe`, json('POST', {})),
  settingsModels: (providerId: string) => request<{ provider_id: string; models: string[]; model_catalog: Array<Record<string, unknown>>; model_readiness: Record<string, boolean>; last_probe?: number }>(`/api/v2/settings/providers/${encodeURIComponent(providerId)}/models`),
  settingsBindings: () => request<{ bindings: SettingsEnvelope['bindings'] }>('/api/v2/settings/capability-bindings'),
  updateSettingsBinding: (body: { capability: string; provider_profile_id: string; model?: string | null }) => request<{ ok: boolean; binding: SettingsEnvelope['bindings'][number] }>('/api/v2/settings/capability-bindings', json('PUT', body)),
  autoMatchSettingsBindings: () => request<{ ok: boolean; changes: Array<{ capability: string; provider_profile_id: string; model?: string | null }>; bindings: SettingsEnvelope['bindings'] }>('/api/v2/settings/capability-bindings/auto-match', json('POST', {})),
  assetLibrary: (projectId: string) => request<AssetLibraryEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets`),
  assetAudit: (projectId: string, queue = 'all') => request<AssetAuditEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/asset-audit?queue=${encodeURIComponent(queue)}`),
  artifactDetail: (projectId: string, artifactId: string) => request<{ project_id: string; artifact: Record<string, any>; url?: string }>(`/api/v2/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`),
  promptVersions: (projectId: string, assetId: string) => request<{ prompt_versions: Array<Record<string, any>> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/prompt-versions`),
  createPromptVersion: (projectId: string, assetId: string, body: { prompt: string; source?: string; change_reason?: string; skill_id?: string; source_qa_run_id?: string }) => request<{ project_id: string; revision: number; prompt_version: Record<string, any> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/prompt-versions`, json('POST', body)),
  createAsset: (projectId: string, body: { expected_revision: number; name: string; asset_class: string; asset_role?: string; grade?: string; required?: boolean }) => request<{ project_id: string; revision: number; asset: Record<string, any>; library: AssetLibraryEnvelope }>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets`, json('POST', body)),
  duplicateAsset: (projectId: string, assetId: string, body: { expected_revision: number; name?: string }) => request<{ project_id: string; revision: number; asset: Record<string, any>; source_asset_id: string; library: AssetLibraryEnvelope }>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/duplicate`, json('POST', body)),
  deleteAsset: (projectId: string, assetId: string, expectedRevision?: number) => request<{ ok: boolean; project_id: string; asset_id: string; revision: number; library: AssetLibraryEnvelope; asset_board?: AssetBoardEnvelope | null; story: StoryDocument }>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}${expectedRevision === undefined ? '' : `?expected_revision=${expectedRevision}`}`, { method: 'DELETE' }),
  intakeAsset: (projectId: string, form: FormData) => request<Record<string, any>>(`/api/v2/projects/${encodeURIComponent(projectId)}/asset-intake`, { method: 'POST', body: form }),
    startAssetQa: (projectId: string, artifactId: string, qaType: 'prompt' | 'image' | 'video' | 'audio' | 'reference' = 'prompt', manualReview = false) => request<Record<string, any>>(`/api/v2/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/qa-runs`, json('POST', { qa_type: qaType, manual_review: manualReview })),
    mapArtifact: (projectId: string, artifactId: string, body: Record<string, unknown> = {}) => request<Record<string, any>>(`/api/v2/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/map`, json('POST', body)),
    resolveArtifact: (projectId: string, artifactId: string, body: Record<string, unknown> = {}) => request<Record<string, any>>(`/api/v2/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/resolution`, json('POST', body)),
    assetWorkflow: (projectId: string, assetId: string) => request<Record<string, any>>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/workflow`),
    projectStorageIntegrity: (projectId?: string) => request<Record<string, any>>(projectId ? `/api/v2/projects/${encodeURIComponent(projectId)}/integrity` : '/api/v2/projects/integrity'),
  generateAssetImage: (projectId: string, assetId: string, body: AssetImageGenerate) => request<Record<string, any>>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/generate-image`, json('POST', body)),
  assetQaRuns: (projectId: string, artifactId: string) => request<{ qa_runs: Array<Record<string, any>> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/qa-runs`),
  submitAssetQa: (projectId: string, qaRunId: string, body: Record<string, unknown>) => request<Record<string, any>>(`/api/v2/projects/${encodeURIComponent(projectId)}/qa-runs/${encodeURIComponent(qaRunId)}/submit`, json('POST', body)),
  registerAssetArtifact: (projectId: string, artifactId: string, replaceActive = false) => request<Record<string, any>>(`/api/v2/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/register`, json('POST', { replace_active: replaceActive })),
  updateAssetMetadata: (projectId: string, assetId: string, body: Record<string, unknown>) => request<{ project_id: string; revision: number; asset: Record<string, unknown> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`, json('PATCH', body)),
  manualProductionApproval: (projectId: string, assetId: string, body: { expected_revision: number; approved: boolean; reason?: string; artifact_id: string }) => request<{ project_id: string; revision: number; asset: Record<string, any>; summary: Record<string, any> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/manual-production-approval`, json('POST', body)),
  assignAsset: (projectId: string, body: { expected_project_revision: number; expected_board_revision: number; asset_id: string; shot_id: string; mode?: 'assign' | 'move' | 'remove'; role?: string; required?: boolean; required_readiness?: 'registered' | 'production' }) => request<{ project_revision: number; board_revision: number; story: StoryEnvelope['story']; asset_board: AssetBoardEnvelope; library: AssetLibraryEnvelope }>(`/api/v2/projects/${encodeURIComponent(projectId)}/asset-assignments`, json('POST', body)),
  fusionGate: (projectId: string, assetId: string) => request<{ status: string; gate: Record<string, unknown> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/fusion-gate`, { method: 'POST' }),
  reviewComparison: (projectId: string, assetId: string, comparisonId: string, body: Record<string, unknown>) => request<{ comparison: Record<string, unknown> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/comparisons/${encodeURIComponent(comparisonId)}/review`, json('POST', body)),
  createAgentPlan: (body: Record<string, unknown>) => request<{ id: string; plan: AgentPlan; preview: Record<string, any> }>('/api/v2/agent/plans', json('POST', body)),
  applyAgentPlan: (planId: string, body: Record<string, unknown> = {}) => request<{ id: string; plan: AgentPlan; graph_revision: number; candidate_ids: string[] }>(`/api/v2/agent/plans/${encodeURIComponent(planId)}/apply`, json('POST', body)),
  rejectAgentPlan: (planId: string) => request<{ id: string; plan: AgentPlan }>(`/api/v2/agent/plans/${encodeURIComponent(planId)}/reject`, json('POST', {})),
  loadProjectSnapshot: async (projectId: string, signal: AbortSignal) => {
    const encoded = encodeURIComponent(projectId);
    const init: RequestInit = { cache: 'no-store', signal };
    const [graph, timeline, timelinePreflight, story, storyRuns, assetLibrary, assetBoard, dashboard, assetAudit, audioStudio] = await Promise.all([
      request<GraphEnvelope>(`/api/v2/projects/${encoded}/graph`, init),
      request<TimelineEnvelope>(`/api/v2/projects/${encoded}/timeline`, init),
      request<TimelinePreflight>(`/api/v2/projects/${encoded}/timeline/preflight`, init),
      request<StoryEnvelope>(`/api/v2/projects/${encoded}/story`, init),
      request<{ runs: StoryRun[] }>(`/api/v2/projects/${encoded}/story/runs`, init),
      request<AssetLibraryEnvelope>(`/api/v2/projects/${encoded}/assets`, init),
      request<AssetBoardEnvelope>(`/api/v2/projects/${encoded}/asset-board`, init),
      request<DashboardEnvelope>(`/api/v2/dashboard?project_id=${encoded}`, init),
      request<AssetAuditEnvelope>(`/api/v2/projects/${encoded}/asset-audit?queue=all`, init),
      request<AudioStudioEnvelope>(`/api/v2/projects/${encoded}/audio-studio`, init),
    ]);
    return { graph, timeline, timelinePreflight, story, storyRuns, assetLibrary, assetBoard, dashboard, assetAudit, audioStudio, projectId };
  },
};
