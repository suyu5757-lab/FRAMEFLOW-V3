import type { AgentPlan, AudioStudioEnvelope, AudioStudioDocument, AssetAuditEnvelope, AssetBoard, AssetBoardEnvelope, AssetImageGenerate, AssetLibraryEnvelope, AssetPromptRunEnvelope, DashboardEnvelope, FusionPromptRunEnvelope, GraphEnvelope, MiniMaxRegion, MiniMaxVoiceCatalog, ProjectCreateInput, ProjectRecord, RenderEstimate, RenderJob, RunEstimate, SettingsEnvelope, SettingsProvider, SpeechGenerateInput, StoryDiff, StoryDocument, StoryEnvelope, StoryRun, TimelineDocument, TimelineEnvelope, TimelinePreflight, VoiceDesignGenerateInput, WorkflowGraph, WorkflowManifest, WorkflowRun, WorkflowRunDetail } from './types';
import type { AssistantAttachment, AssistantContractBundle, AssistantConversation, AssistantMessage, AssistantRun, AssistantRunEvent, AudioAssistantDraftApplyResult } from './assistant-types';

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
    const issueText = Array.isArray(body.details?.issues) ? body.details.issues.map((issue: unknown) => String(issue)).join('；') : '';
    const baseMessage = body.message || detail || body.error || `请求失败（${response.status}）`;
    const message = issueText && !String(baseMessage).includes(issueText) ? `${baseMessage}：${issueText}` : baseMessage;
    throw new StudioApiError(message, {
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

export type AssistantStreamEvent = AssistantRunEvent & { event_name?: string };

async function streamAssistantRequest(path: string, body: unknown, onEvent: (event: AssistantStreamEvent) => void, signal?: AbortSignal): Promise<{ run_id: string; status: string; sequence: number }> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new StudioApiError('无法连接到 FrameFlow 服务。', { category: 'connection', retryable: true, details: error });
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = typeof payload.detail === 'object' ? payload.detail?.message : payload.detail;
    throw new StudioApiError(payload.message || detail || payload.error || ('请求失败（' + response.status + '）'), { status: response.status, code: payload.code || 'http_error', category: payload.category || 'request', retryable: Boolean(payload.retryable), details: payload.details || payload.detail || {} });
  }
  if (!response.body) throw new StudioApiError('服务没有返回 Agent 事件流。', { category: 'connection', retryable: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let last = { run_id: '', status: 'preparing', sequence: 0 };
  const consume = (block: string) => {
    const lines = block.split(/\r?\n/);
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    try {
      const payload = JSON.parse(dataLines.join('\n')) as AssistantStreamEvent;
      payload.event_name = eventName;
      if (payload.run_id) last.run_id = payload.run_id;
      if (typeof payload.sequence === 'number') last.sequence = Math.max(last.sequence, payload.sequence);
      if (eventName === 'snapshot_complete' && typeof payload.status === 'string') last.status = payload.status;
      onEvent(payload);
    } catch {
      onEvent({ run_id: last.run_id, sequence: last.sequence, event_type: eventName, status: 'invalid', data: { raw: dataLines.join('\n') }, created_at: new Date().toISOString(), event_name: eventName });
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    blocks.filter(Boolean).forEach(consume);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  return last;
}

function uploadAssistantRequest<T>(path: string, form: FormData, onProgress?: (progress: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new StudioApiError('附件上传失败，请检查本地服务连接。', { category: 'connection', retryable: true }));
    xhr.onabort = () => reject(new DOMException('附件上传已中止。', 'AbortError'));
    xhr.onload = () => {
      const body = (xhr.response || {}) as Record<string, any>;
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve(body as T);
        return;
      }
      const detail = typeof body.detail === 'object' ? body.detail?.message : body.detail;
      reject(new StudioApiError(body.message || detail || body.error || `请求失败（${xhr.status}）`, { status: xhr.status, code: body.code || 'http_error', category: body.category || 'request', retryable: Boolean(body.retryable), details: body.details || body.detail || {} }));
    };
    xhr.send(form);
  });
}

export const studioApi = {
  // Project revisions are the optimistic-concurrency source of truth. Do not
  // let a browser cache return an older revision immediately after a write.
  projects: (includeArchived = false) => request<{ projects: ProjectRecord[] }>(`/api/v2/projects${includeArchived ? '?include_archived=true' : ''}`, { cache: 'no-store' }),
  workflows: () => request<{ workflows: WorkflowManifest[] }>('/api/v2/workflows'),
  contracts: () => request<AssistantContractBundle>('/api/v2/contracts', { cache: 'no-store' }),
  contract: (scope: 'prompt' | 'story' | 'audio' | 'workflow') => request<Record<string, any>>('/api/v2/contracts/' + scope, { cache: 'no-store' }),
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
  minimaxVoices: (providerId: string) => request<MiniMaxVoiceCatalog>(`/api/v2/providers/${encodeURIComponent(providerId)}/voices`, { cache: 'no-store' }),
  refreshMinimaxVoices: (providerId: string, region?: MiniMaxRegion) => request<{ catalog: MiniMaxVoiceCatalog; probe?: Record<string, unknown> }>(`/api/v2/providers/${encodeURIComponent(providerId)}/voices/refresh`, json('POST', region ? { region } : {})),
  saveAudioStudio: (projectId: string, document: AudioStudioDocument, expectedRevision: number) => request<AudioStudioEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/audio-studio`, json('PUT', { document, expected_revision: expectedRevision })),
  generateSpeech: (projectId: string, body: SpeechGenerateInput) => request<Record<string, any>>(`/api/v2/projects/${encodeURIComponent(projectId)}/audio/tts`, json('POST', body)),
  designVoice: (projectId: string, body: VoiceDesignGenerateInput) => request<{ project_id: string; revision: number; candidate: Record<string, unknown>; document: AudioStudioDocument; execution_status: string; next: string }>(`/api/v2/projects/${encodeURIComponent(projectId)}/audio/voice-design`, json('POST', body)),
  saveAssetBoard: (projectId: string, board: AssetBoard, expectedRevision: number) =>
    request<AssetBoardEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/asset-board`, json('PUT', { board, expected_revision: expectedRevision })),
  syncAssetBoard: (projectId: string, expectedRevision: number, preserveLayout = true) =>
    request<AssetBoardEnvelope & { project_revision?: number; story?: StoryDocument; library?: AssetLibraryEnvelope }>(`/api/v2/projects/${encodeURIComponent(projectId)}/asset-board/sync`, json('POST', { expected_revision: expectedRevision, preserve_layout: preserveLayout })),
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
  generateAssetPrompts: (projectId: string, body: { expected_revision?: number; target_asset_id?: string; review_feedback?: string; source_qa_run_id?: string; operator_idea?: string }) => request<AssetPromptRunEnvelope>(`/api/v2/projects/${encodeURIComponent(projectId)}/asset-prompt-runs`, json('POST', body)),
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
  deleteSettingsProvider: (providerId: string) => request<{ ok: boolean; provider_id?: string; removed_capabilities?: string[]; providers: SettingsProvider[] }>(`/api/v2/settings/providers/${encodeURIComponent(providerId)}`, { method: 'DELETE' }),
  writeSettingsCredential: (providerId: string, apiKey: string, region?: MiniMaxRegion) => request<{ ok: boolean; credential_configured: boolean; credential_mask?: string; storage: string; region?: MiniMaxRegion; credential_regions?: SettingsProvider['credential_regions'] }>(`/api/v2/settings/providers/${encodeURIComponent(providerId)}/credential`, json('POST', { api_key: apiKey, ...(region ? { region } : {}) })),
  importSettingsCredential: (providerId: string, environmentVariable: string, region?: MiniMaxRegion) => request<{ ok: boolean; credential_configured: boolean; credential_mask?: string; storage: string; region?: MiniMaxRegion; credential_regions?: SettingsProvider['credential_regions'] }>(`/api/v2/settings/providers/${encodeURIComponent(providerId)}/credential/import`, json('POST', { environment_variable: environmentVariable, ...(region ? { region } : {}) })),
  clearSettingsCredential: (providerId: string, region?: MiniMaxRegion) => request<{ ok: boolean; credential_configured: boolean; cleared_system_store: boolean; region?: MiniMaxRegion; credential_regions?: SettingsProvider['credential_regions'] }>(`/api/v2/settings/providers/${encodeURIComponent(providerId)}/credential${region ? `?region=${encodeURIComponent(region)}` : ''}`, { method: 'DELETE' }),
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
  projectStorage: (projectId: string) => request<Record<string, any>>(`/api/v2/projects/${encodeURIComponent(projectId)}/storage`),
  syncProjectStorage: (projectId: string) => request<{ ok: boolean; storage: Record<string, any> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/storage/sync`, { method: 'POST' }),
  generateAssetImage: (projectId: string, assetId: string, body: AssetImageGenerate) => request<Record<string, any>>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/generate-image`, json('POST', body)),
  assetQaRuns: (projectId: string, artifactId: string) => request<{ qa_runs: Array<Record<string, any>> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/qa-runs`),
  submitAssetQa: (projectId: string, qaRunId: string, body: Record<string, unknown>) => request<Record<string, any>>(`/api/v2/projects/${encodeURIComponent(projectId)}/qa-runs/${encodeURIComponent(qaRunId)}/submit`, json('POST', body)),
  registerAssetArtifact: (projectId: string, artifactId: string, replaceActive = false) => request<Record<string, any>>(`/api/v2/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/register`, json('POST', { replace_active: replaceActive })),
  archiveAssetArtifact: (projectId: string, artifactId: string) => request<{ ok: boolean; project_id: string; artifact_id: string; status: string; file_preserved?: boolean; project_revision?: number; artifact?: Record<string, any>; library: AssetLibraryEnvelope; asset_board?: AssetBoardEnvelope }>(`/api/v2/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`, { method: 'DELETE' }),
  removeActiveAssetVersion: (projectId: string, assetId: string, expectedRevision?: number) => request<Record<string, any>>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/active-version${expectedRevision === undefined ? '' : `?expected_revision=${expectedRevision}`}`, { method: 'DELETE' }),
  updateAssetMetadata: (projectId: string, assetId: string, body: Record<string, unknown>) => request<{ project_id: string; revision: number; asset: Record<string, unknown>; library?: AssetLibraryEnvelope; asset_board?: AssetBoardEnvelope }>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`, json('PATCH', body)),
  manualProductionApproval: (projectId: string, assetId: string, body: { expected_revision: number; approved: boolean; reason?: string; artifact_id: string }) => request<{ project_id: string; revision: number; asset: Record<string, any>; summary: Record<string, any> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/manual-production-approval`, json('POST', body)),
  assignAsset: (projectId: string, body: { expected_project_revision: number; expected_board_revision: number; asset_id: string; shot_id: string; mode?: 'assign' | 'move' | 'remove'; role?: string; required?: boolean; required_readiness?: 'registered' | 'production' }) => request<{ project_revision: number; board_revision: number; story: StoryEnvelope['story']; asset_board: AssetBoardEnvelope; library: AssetLibraryEnvelope }>(`/api/v2/projects/${encodeURIComponent(projectId)}/asset-assignments`, json('POST', body)),
  fusionGate: (projectId: string, assetId: string) => request<{ status: string; gate: Record<string, unknown> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/fusion-gate`, { method: 'POST' }),
  reviewComparison: (projectId: string, assetId: string, comparisonId: string, body: Record<string, unknown>) => request<{ comparison: Record<string, unknown> }>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/comparisons/${encodeURIComponent(comparisonId)}/review`, json('POST', body)),
  createAgentPlan: (body: Record<string, unknown>) => request<{ id: string; plan: AgentPlan; preview: Record<string, any> }>('/api/v2/agent/plans', json('POST', body)),
  applyAgentPlan: (planId: string, body: Record<string, unknown> = {}) => request<{ id: string; plan: AgentPlan; graph_revision: number; candidate_ids: string[] }>(`/api/v2/agent/plans/${encodeURIComponent(planId)}/apply`, json('POST', body)),
  rejectAgentPlan: (planId: string) => request<{ id: string; plan: AgentPlan }>(`/api/v2/agent/plans/${encodeURIComponent(planId)}/reject`, json('POST', {})),
  assistantConversations: (projectId: string) => request<{ project_id: string; conversations: AssistantConversation[] }>('/api/v2/projects/' + encodeURIComponent(projectId) + '/assistant/conversations', { cache: 'no-store' }),
  createAssistantConversation: (projectId: string, title = '') => request<{ conversation: AssistantConversation }>('/api/v2/projects/' + encodeURIComponent(projectId) + '/assistant/conversations', json('POST', { title })),
  audioAssistantConversations: (projectId: string) => request<{ project_id: string; conversations: AssistantConversation[] }>('/api/v2/projects/' + encodeURIComponent(projectId) + '/assistant/conversations?assistant_mode=voice-preparation', { cache: 'no-store' }),
  createAudioAssistantConversation: (projectId: string, title = '') => request<{ conversation: AssistantConversation }>('/api/v2/projects/' + encodeURIComponent(projectId) + '/assistant/conversations', json('POST', { title, assistant_mode: 'voice-preparation' })),
  updateAssistantConversation: (conversationId: string, title: string) => request<{ conversation: AssistantConversation }>('/api/v2/assistant/conversations/' + encodeURIComponent(conversationId), json('PATCH', { title })),
  assistantMessages: (conversationId: string) => request<{ conversation_id: string; messages: AssistantMessage[] }>('/api/v2/assistant/conversations/' + encodeURIComponent(conversationId) + '/messages', { cache: 'no-store' }),
  uploadAssistantAttachment: (projectId: string, file: File, conversationId?: string, onProgress?: (progress: number) => void) => {
    const form = new FormData();
    form.append('file', file);
    const query = conversationId ? '?conversation_id=' + encodeURIComponent(conversationId) : '';
    return uploadAssistantRequest<{ attachment: AssistantAttachment }>('/api/v2/projects/' + encodeURIComponent(projectId) + '/assistant/attachments' + query, form, onProgress);
  },
  assistantRun: (runId: string) => request<AssistantRun>('/api/v2/assistant/runs/' + encodeURIComponent(runId)),
  assistantRuns: (projectId: string, conversationId?: string) => request<{ project_id: string; runs: AssistantRun[] }>('/api/v2/projects/' + encodeURIComponent(projectId) + '/assistant/runs' + (conversationId ? '?conversation_id=' + encodeURIComponent(conversationId) : ''), { cache: 'no-store' }),
  assistantRunEvents: (runId: string, afterSequence = 0) => request<{ run_id: string; events: AssistantRunEvent[] }>('/api/v2/assistant/runs/' + encodeURIComponent(runId) + '/events?after_sequence=' + afterSequence, { cache: 'no-store' }),
  cancelAssistantRun: (runId: string) => request<AssistantRun>('/api/v2/assistant/runs/' + encodeURIComponent(runId) + '/cancel', json('POST', {})),
  archiveAssistantConversation: (conversationId: string) => request<{ conversation: AssistantConversation; message: string }>('/api/v2/assistant/conversations/' + encodeURIComponent(conversationId) + '/archive', json('POST', {})),
  restoreAssistantConversation: (conversationId: string) => request<{ conversation: AssistantConversation; message: string }>('/api/v2/assistant/conversations/' + encodeURIComponent(conversationId) + '/restore', json('POST', {})),
  streamAssistantRun: (projectId: string, body: { conversation_id?: string; message: string; attachment_ids: string[]; selected_node_ids: string[]; skill_id?: string; provider_profile_id?: string; model?: string; context: Record<string, unknown>; cost_boundary: Record<string, unknown>; client_message_id: string; assistant_mode?: 'general' | 'voice-preparation' }, onEvent: (event: AssistantStreamEvent) => void, signal?: AbortSignal) => streamAssistantRequest('/api/v2/projects/' + encodeURIComponent(projectId) + '/assistant/stream', { project_id: projectId, ...body }, onEvent, signal),
  streamAudioAssistantRun: (projectId: string, body: { conversation_id?: string; message: string; context: Record<string, unknown>; cost_boundary?: Record<string, unknown>; client_message_id: string }, onEvent: (event: AssistantStreamEvent) => void, signal?: AbortSignal) => streamAssistantRequest('/api/v2/projects/' + encodeURIComponent(projectId) + '/assistant/stream', { project_id: projectId, assistant_mode: 'voice-preparation', skill_id: 'voice-preparation-assistant', attachment_ids: [], selected_node_ids: [], ...body }, onEvent, signal),
  confirmAssistantExternal: (runId: string, decision: 'approve' | 'reject', providerProfileId?: string | null) => request<AssistantRun>('/api/v2/assistant/runs/' + encodeURIComponent(runId) + '/external-confirmation', json('POST', { decision, provider_profile_id: providerProfileId || undefined, detail: { approved_by: 'studio-user' } })),
  resetAssistantExternalConsent: (conversationId: string) => request<{ conversation: AssistantConversation; message: string }>('/api/v2/assistant/conversations/' + encodeURIComponent(conversationId) + '/external-consent/reset', json('POST', {})),
  applyAssistantRun: (runId: string, body: { plan_id?: string; selected_operation_ids: string[]; expected_project_revision: number; expected_graph_revision: number; expected_timeline_revision?: number | null; expected_contract_bundle_hash: string }) => request<{ run: AssistantRun; plan: AgentPlan; applied_operation_ids: string[]; project_revision: number; graph_revision: number; timeline_revision?: number | null }>('/api/v2/assistant/runs/' + encodeURIComponent(runId) + '/apply', json('POST', body)),
  applyAudioAssistantDraft: (runId: string, body: { selected_operation_ids: string[]; expected_project_revision: number; expected_audio_revision: number; expected_contract_bundle_hash: string; base_audio_hash: string; document: AudioStudioDocument }) => request<AudioAssistantDraftApplyResult>('/api/v2/assistant/runs/' + encodeURIComponent(runId) + '/audio-draft', json('POST', body)),
  confirmAudioText: (projectId: string, body: { target_type: 'dialogue' | 'audition'; target_id: string; source_text: string; provider_text?: string; expected_revision: number }) => request<{ project_id: string; revision: number; persisted: boolean; target_type: string; target_id: string; text_confirmation: Record<string, unknown>; document: AudioStudioDocument }>(`/api/v2/projects/${encodeURIComponent(projectId)}/audio/text-confirmation`, json('POST', body)),
  rejectAssistantRun: (runId: string, detail: Record<string, unknown> = {}) => request<AssistantRun>('/api/v2/assistant/runs/' + encodeURIComponent(runId) + '/reject', json('POST', { detail })),
  loadProjectSnapshot: async (projectId: string, signal: AbortSignal) => {
    const encoded = encodeURIComponent(projectId);
    const init: RequestInit = { cache: 'no-store', signal };
    const [graph, timeline, timelinePreflight, story, storyRuns, assetLibrary, assetBoard, dashboard, audioStudio] = await Promise.all([
      request<GraphEnvelope>(`/api/v2/projects/${encoded}/graph`, init),
      request<TimelineEnvelope>(`/api/v2/projects/${encoded}/timeline`, init),
      request<TimelinePreflight>(`/api/v2/projects/${encoded}/timeline/preflight`, init),
      request<StoryEnvelope>(`/api/v2/projects/${encoded}/story`, init),
      request<{ runs: StoryRun[] }>(`/api/v2/projects/${encoded}/story/runs`, init),
      request<AssetLibraryEnvelope>(`/api/v2/projects/${encoded}/assets`, init),
      request<AssetBoardEnvelope>(`/api/v2/projects/${encoded}/asset-board`, init),
      request<DashboardEnvelope>(`/api/v2/dashboard?project_id=${encoded}`, init),
      request<AudioStudioEnvelope>(`/api/v2/projects/${encoded}/audio-studio`, init),
    ]);
    return { graph, timeline, timelinePreflight, story, storyRuns, assetLibrary, assetBoard, dashboard, audioStudio, projectId };
  },
};
