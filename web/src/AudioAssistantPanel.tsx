import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type AssistantStreamEvent, studioApi } from './api';
import type {
  AssistantConversation,
  AssistantMessage,
  AssistantRun,
  AssistantRunEvent,
  AssistantWorkspaceOperation,
  AudioAssistantFocus,
  AudioPreparationAudition,
  AudioPreparationDialogueCandidate,
  AudioPreparationProposal,
  AudioPreparationVoiceCandidate,
  AudioPreparationVoiceDesign,
} from './assistant-types';
import { mergeAssistantRunEvents, selectableAssistantOperationIds, toggleAssistantOperation } from './assistant-state';
import { MINIMAX_TTS_URL, MINIMAX_VOICE_DESIGN_URL, buildMinimaxVoiceDesignChecklist, copyToClipboard } from './audio-copy';
import type { AudioStudioDocument, AudioStudioEnvelope } from './types';

type AudioAssistantPanelProps = {
  projectId: string;
  projectName: string;
  envelope: AudioStudioEnvelope;
  audioDocument: AudioStudioDocument;
  focus: AudioAssistantFocus;
  providerProfileId?: string | null;
  providerRegion?: string | null;
  dirty: boolean;
  busy?: boolean;
  onDraftApplied: (document: AudioStudioDocument) => void;
  onSave: (document: AudioStudioDocument) => Promise<AudioStudioEnvelope | null>;
  onVoiceDesignPackage?: (design: AudioPreparationVoiceDesign) => void;
  onNotice: (message: string) => void;
  voiceDesignOnly?: boolean;
};

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'stale_contract']);
const focusLabels: Record<string, string> = {
  project: '当前声音项目',
  voice: '当前人物声音',
  dialogue: '当前对白',
  audition: '当前试听',
};
const conditionLabels: Record<string, string> = {
  neutral: 'Neutral · 基线',
  emotional: 'Emotional · 轻微情绪',
  'pronunciation-stress': 'Pronunciation · 发音压力',
};

function randomClientMessageId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'audio-client-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function formatDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { month: 'numeric', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function operationCandidateId(operation: AssistantWorkspaceOperation): string {
  return String(operation.content?.candidate_id || operation.content?.candidateId || '');
}

function operationLabel(operation: AssistantWorkspaceOperation): string {
  const target = String(operation.content?.audio_target || operation.content?.audioTarget || '');
  return target === 'voice_profile' ? '人物声音草稿' : target === 'audition' ? '试听草稿' : target === 'dialogue' ? '逐句对白草稿' : operation.title;
}

function operationPreview(operation: AssistantWorkspaceOperation): string {
  const record = operation.content?.record || operation.after || operation.content;
  if (!record || typeof record !== 'object') return operation.summary || '无新增内容';
  const text = String((record as Record<string, unknown>).source_text || (record as Record<string, unknown>).text || '');
  if (text) return text;
  return String((record as Record<string, unknown>).provider_voice_name || (record as Record<string, unknown>).provider_voice_id || operation.summary || '声音草稿');
}

function eventLabel(event: AssistantRunEvent): string {
  const labels: Record<string, string> = {
    context_loading: '读取声音上下文',
    provider_request: 'OpenCode 方案分析',
    contract_validation: '声音规则校验',
    plan_preview: '形成可审阅方案',
    assistant_message: 'AI 回复',
    audio_draft_apply: '回填声音草稿',
    run_completed: '运行完成',
    run_failed: '运行失败',
  };
  return labels[event.item_id || ''] || labels[event.event_type] || event.event_type;
}

function eventDetail(event: AssistantRunEvent): string {
  const data = event.data || {};
  if (typeof data.message === 'string') return data.message;
  if (typeof data.summary === 'string') return data.summary;
  if (typeof data.operation_count === 'number') return `${data.operation_count} 项声音草稿操作`;
  return '';
}

function proposalFromRun(run: AssistantRun | null): AudioPreparationProposal | null {
  const proposal = run?.result?.audio_preparation;
  return proposal && typeof proposal === 'object' ? proposal : null;
}

function operationForCandidate(operations: AssistantWorkspaceOperation[], candidateId: string): AssistantWorkspaceOperation | undefined {
  return operations.find((operation) => operationCandidateId(operation) === candidateId);
}

function isCompleteDialogueOperation(operation: AssistantWorkspaceOperation): boolean {
  const target = String(operation.content?.audio_target || operation.content?.audioTarget || '');
  if (target !== 'dialogue') return true;
  const record = operation.content?.record || operation.after || operation.content;
  if (!record || typeof record !== 'object') return false;
  const dialogue = record as Record<string, unknown>;
  return Boolean(
    String(dialogue.source_text || dialogue.text || '').trim()
    && String(dialogue.provider_text || dialogue.source_text || dialogue.text || '').trim()
    && String(dialogue.language || '').trim()
    && String(dialogue.locale || '').trim(),
  );
}

function VoiceCandidateCard({ candidate, operation, selected, onToggle, onCopy }: { candidate: AudioPreparationVoiceCandidate; operation?: AssistantWorkspaceOperation; selected: boolean; onToggle: () => void; onCopy?: () => void }) {
  const disabled = !candidate.selectable || !operation || operation.risk === 'blocked';
  return <article className={'audio-assistant-candidate-card ' + (selected ? 'selected ' : '') + (!candidate.selectable ? 'documented' : '')}>
    <div className="audio-assistant-candidate-top">
      <div><span className="audio-assistant-rank">0{candidate.recommendation_rank}</span><strong>{candidate.provider_voice_name || candidate.provider_voice_id}</strong></div>
      <span className={'audio-assistant-source-chip ' + (candidate.catalog_source === 'documented' ? 'documented' : 'live')}>{candidate.catalog_source === 'documented' ? '仅参考' : candidate.catalog_source === 'cached' ? '缓存可执行' : '实时可执行'}</span>
    </div>
    <div className="audio-assistant-candidate-id">{candidate.provider_voice_id} · {candidate.language || '未指定语言'} · {candidate.provider_region}</div>
    <p>{candidate.rationale || candidate.description || '以实际试听结果为准。'}</p>
    <div className="audio-assistant-card-actions"><button type="button" className="audio-assistant-select-button" onClick={onToggle} disabled={disabled}>{!candidate.selectable ? '目录恢复后可应用' : selected ? '已选择草稿' : '选择此音色草稿'}</button>{onCopy && <button type="button" className="audio-assistant-copy-button" onClick={onCopy}>复制 Voice ID</button>}</div>
  </article>;
}

function DialogueCandidateCard({ candidate, operation, selected, onToggle, onCopy }: { candidate: AudioPreparationDialogueCandidate; operation?: AssistantWorkspaceOperation; selected: boolean; onToggle: () => void; onCopy?: () => void }) {
  const disabled = !operation || operation.risk === 'blocked';
  return <article className={'audio-assistant-dialogue-card ' + (selected ? 'selected' : '')}>
    <div className="audio-assistant-dialogue-head"><span>{candidate.candidate_id}</span><b>{candidate.text_status === 'candidate' ? '候选 · 待确认' : candidate.text_status}</b></div>
    <strong>{candidate.source_text || '尚未形成目标语言台词'}</strong>
    {candidate.meaning_cn && <small>中文含义：{candidate.meaning_cn}</small>}
    <small>{candidate.language || '未指定语言'} · {candidate.locale || '未指定 locale'} · {candidate.dialect || '未指定方言'} · language_boost：{candidate.language_boost || '自动'}</small>
    <div className="audio-assistant-card-actions"><button type="button" className="audio-assistant-select-button" onClick={onToggle} disabled={disabled}>{selected ? '已选择台词草稿' : '选择此台词草稿'}</button>{onCopy && <button type="button" className="audio-assistant-copy-button" onClick={onCopy}>复制可朗读文本</button>}</div>
  </article>;
}

function AuditionSummary({ auditions }: { auditions: AudioPreparationAudition[] }) {
  const groups = auditions.reduce<Record<string, number>>((result, item) => {
    result[item.condition] = (result[item.condition] || 0) + 1;
    return result;
  }, {});
  return <div className="audio-assistant-audition-summary">
    {Object.entries(conditionLabels).map(([condition, label]) => <div key={condition}><b>{groups[condition] || 0}</b><span>{label}</span></div>)}
  </div>;
}

function VoiceDesignCard({ design, onUse, onNotice }: { design: AudioPreparationVoiceDesign; onUse: () => void; onNotice: (message: string) => void }) {
  const copyField = async (label: string, value: string) => {
    const copied = await copyToClipboard(value);
    onNotice(copied ? `已复制${label}；尚未创建音色，也没有产生费用。` : `无法复制${label}；请从字段中手动复制。`);
  };
  const checklist = buildMinimaxVoiceDesignChecklist({ language: design.language || '', locale: design.locale || '', region: design.provider_region || '', prompt: design.prompt, previewText: design.preview_text });
  return <section className="audio-assistant-section audio-assistant-design-section"><div className="audio-assistant-subhead"><span>VOICE DESIGN 输入</span><small>审核后可复制到 MiniMax</small></div><div className="audio-assistant-design-card"><label>Prompt · 音色描述<textarea readOnly value={design.prompt} /><button type="button" className="audio-inline-copy" onClick={() => void copyField('音色 Prompt', design.prompt)}>复制音色 Prompt</button></label><label>Text to Preview · 试听台词<textarea readOnly value={design.preview_text} /><small>{design.preview_text.length} / 500 字符 · {design.language || '未指定语言'} · {design.provider_region === 'global' ? '国际区' : '中国区'}</small><button type="button" className="audio-inline-copy" onClick={() => void copyField('试听台词', design.preview_text)}>复制试听台词</button></label><p>{design.rationale || 'AI 已把自然语言整理成 MiniMax 的两段输入；这仍是草案，不代表已生成音色。'}</p><div className="audio-assistant-card-actions"><button type="button" className="audio-assistant-copy-button" onClick={() => void copyField('MiniMax Voice Design 填写包', checklist)}>复制完整填写包</button><a className="audio-external-link" href={MINIMAX_VOICE_DESIGN_URL} target="_blank" rel="noreferrer">打开 MiniMax Voice Design ↗</a><button type="button" className="audio-primary-button" onClick={onUse}>带入下方音色设计</button></div></div></section>;
}

function VoiceDesignMissingCard({ onRequest, disabled }: { onRequest: () => void; disabled: boolean }) {
  return <section className="audio-assistant-section audio-assistant-design-section"><div className="audio-assistant-design-empty"><strong>还没有形成可复制的音色输入</strong><p>请补充声音的年龄感、质感、语言和一条实际试听台词。AI 会只整理成 MiniMax 的 Prompt 和 Text to Preview。</p><button type="button" className="audio-assistant-copy-button" onClick={onRequest} disabled={disabled}>让 AI 重新整理音色</button></div></section>;
}

function isCreativeVoiceBrief(value: string): boolean {
  const text = value.trim();
  return Boolean(text && text.length >= 12 && !text.includes('请只完成 Voice Design') && !text.startsWith('上一条声音想法：'));
}

export function AudioAssistantPanel({ projectId, projectName, envelope, audioDocument, focus, providerProfileId, providerRegion, dirty, busy: parentBusy = false, onDraftApplied, onSave, onVoiceDesignPackage, onNotice, voiceDesignOnly = false }: AudioAssistantPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [conversations, setConversations] = useState<AssistantConversation[]>([]);
  const [conversationId, setConversationId] = useState('');
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [message, setMessage] = useState('');
  const [voiceBrief, setVoiceBrief] = useState('');
  const [run, setRun] = useState<AssistantRun | null>(null);
  const [events, setEvents] = useState<AssistantRunEvent[]>([]);
  const [selectedOperationIds, setSelectedOperationIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [applied, setApplied] = useState(false);
  const [appliedDocument, setAppliedDocument] = useState<AudioStudioDocument | null>(null);
  const [appliedSaved, setAppliedSaved] = useState(false);
  const [applyIssue, setApplyIssue] = useState<'stale' | 'error' | ''>('');
  const [focusKey, setFocusKey] = useState('project');
  const streamAbortRef = useRef<AbortController | null>(null);
  const projectKey = projectId;

  const rawOperations = useMemo(() => (run?.result?.patch?.workspace_operations || []) as AssistantWorkspaceOperation[], [run?.result?.patch?.workspace_operations]);
  const operations = useMemo(() => rawOperations.filter(isCompleteDialogueOperation), [rawOperations]);
  const proposal = proposalFromRun(run);
  const voiceDesign = proposal?.voice_design;
  const latestSequence = events.at(-1)?.sequence || 0;
  const runHasProblem = Boolean(
    run?.error
    || run?.status === 'failed'
    || events.some((event) => ['failed', 'error', 'blocked'].includes(String(event.status).toLowerCase()) || event.event_type === 'run_failed'),
  );
  const currentConversation = conversations.find((item) => item.id === conversationId);
  const requiredQuestions = (proposal?.questions || []).filter((item) => item.required !== false);
  const allDialogueCandidates = proposal?.dialogue_candidates || [];
  const dialogueCandidates = useMemo(() => allDialogueCandidates.filter((candidate) => Boolean(
    candidate.source_text?.trim()
    && candidate.provider_text?.trim()
    && candidate.language?.trim()
    && candidate.locale?.trim(),
  )), [allDialogueCandidates]);
  const incompleteDialogueCount = allDialogueCandidates.length - dialogueCandidates.length;
  const allAuditions = proposal?.audition_matrix || [];
  const auditionMatrix = useMemo(() => allAuditions.filter((audition) => Boolean(
    audition.source_text?.trim()
    && audition.provider_text?.trim()
    && audition.language?.trim()
    && audition.locale?.trim(),
  )), [allAuditions]);
  const preflight = proposal?.preflight;
  const displayProposalState = incompleteDialogueCount || rawOperations.length !== operations.length ? 'needs_clarification' : proposal?.state;
  const displayLanguageBoost = dialogueCandidates[0]?.language_boost || auditionMatrix[0]?.language_boost || preflight?.language_boost;
  const displayTextChars = dialogueCandidates.reduce((total, candidate) => total + (candidate.provider_text || candidate.source_text || '').length, 0);
  const displayPlannedCount = dialogueCandidates.length + auditionMatrix.length;
  const currentContractHash = String(run?.contract_snapshot?.bundle_hash || run?.result?.preview?.contract_hash || '');
  const staleRun = Boolean(run?.status === 'succeeded' && run.base_project_revision !== envelope.revision);
  const applyBlockedByStale = staleRun || applyIssue === 'stale';
  const focusOptions = useMemo(() => [
    { key: 'project', label: '当前声音项目', focus: { kind: 'project' as const, target_id: null, character_id: null, shot_ids: focus.shot_ids } },
    ...(audioDocument.voices || []).map((item) => ({ key: `voice:${item.id}`, label: `${item.id} · ${item.name}`, focus: { kind: 'voice' as const, target_id: item.id, character_id: item.character_id, shot_ids: focus.shot_ids } })),
    ...(audioDocument.dialogues || []).map((item) => ({ key: `dialogue:${item.id}`, label: `${item.id} · ${item.source_text || item.text || '对白'}`, focus: { kind: 'dialogue' as const, target_id: item.id, character_id: item.character_id, shot_ids: item.shot_ids || focus.shot_ids } })),
    ...(audioDocument.auditions || []).map((item) => ({ key: `audition:${item.id}`, label: `${item.id} · ${conditionLabels[item.condition] || item.condition}`, focus: { kind: 'audition' as const, target_id: item.id, character_id: item.character_id, shot_ids: focus.shot_ids } })),
  ], [audioDocument.auditions, audioDocument.dialogues, audioDocument.voices, focus.shot_ids]);
  const activeFocus = useMemo(() => focusOptions.find((item) => item.key === focusKey)?.focus || focus, [focus, focusKey, focusOptions]);

  const setLocalNotice = useCallback((value: string) => {
    setNotice(value);
    onNotice(value);
  }, [onNotice]);

  const copyAssistantValue = useCallback(async (label: string, value: string) => {
    const copied = await copyToClipboard(value);
    setLocalNotice(copied ? `已复制${label}；请在 MiniMax 网页端对应输入框中粘贴。` : `无法复制${label}；请从候选卡片中手动复制。`);
  }, [setLocalNotice]);

  const loadConversation = useCallback(async (id: string) => {
    if (!id) {
      setMessages([]);
      setRun(null);
      setEvents([]);
      setAppliedDocument(null);
      setAppliedSaved(false);
      setApplyIssue('');
      return;
    }
    try {
      const [messageResult, runResult] = await Promise.all([studioApi.assistantMessages(id), studioApi.assistantRuns(projectKey, id)]);
      setMessages(messageResult.messages);
      const latestRun = runResult.runs[0];
      if (!latestRun) {
        setRun(null);
        setEvents([]);
        setAppliedDocument(null);
        setAppliedSaved(false);
        setApplyIssue('');
        return;
      }
      const [detail, eventResult] = await Promise.all([studioApi.assistantRun(latestRun.id), studioApi.assistantRunEvents(latestRun.id)]);
      setRun(detail);
      setEvents(mergeAssistantRunEvents([], eventResult.events || detail.events || []));
      setApplied(Boolean(detail.result?.apply));
      setAppliedDocument(null);
      setAppliedSaved(false);
      setApplyIssue('');
    } catch (error) {
      setLocalNotice((error as Error).message);
    }
  }, [projectKey, setLocalNotice]);

  useEffect(() => {
    let cancelled = false;
    streamAbortRef.current?.abort();
    setLoading(true);
    setConversations([]);
    setConversationId('');
    setMessages([]);
    setVoiceBrief('');
    setRun(null);
    setEvents([]);
    setSelectedOperationIds(new Set());
    setApplied(false);
    setApplyIssue('');
    studioApi.audioAssistantConversations(projectKey).then(async (result) => {
      if (cancelled) return;
      let nextConversations = result.conversations;
      let nextConversationId = nextConversations[0]?.id || '';
      if (!nextConversationId) {
        const created = await studioApi.createAudioAssistantConversation(projectKey, `声音准备 · ${projectName}`);
        if (cancelled) return;
        nextConversations = [created.conversation];
        nextConversationId = created.conversation.id;
      }
      setConversations(nextConversations);
      setConversationId(nextConversationId);
      await loadConversation(nextConversationId);
    }).catch((error: Error) => {
      if (!cancelled) setLocalNotice(error.message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectKey, projectName, loadConversation, setLocalNotice]);

  useEffect(() => {
    if (!run || !operations.length) {
      setSelectedOperationIds(new Set());
      return;
    }
    setSelectedOperationIds(selectableAssistantOperationIds(operations));
    setApplied(false);
    setApplyIssue('');
  }, [run?.id, operations]);

  useEffect(() => {
    if (applied && appliedDocument && !dirty) setAppliedSaved(true);
  }, [applied, appliedDocument, dirty]);

  useEffect(() => {
    if (!voiceDesignOnly || !voiceDesign || !onVoiceDesignPackage) return;
    // The assistant is the preparation step; the single visible editor below
    // is the MiniMax step. Keep the two surfaces synchronized without making
    // the user copy the same Prompt into a second duplicate card.
    onVoiceDesignPackage(voiceDesign);
  }, [onVoiceDesignPackage, voiceDesign?.locale, voiceDesign?.preview_text, voiceDesign?.prompt, voiceDesign?.provider_region, voiceDesignOnly]);

  useEffect(() => {
    if (!voiceDesignOnly || voiceBrief.trim()) return;
    const seed = [...messages].reverse().find((item) => item.role === 'user' && isCreativeVoiceBrief(item.content));
    if (seed) setVoiceBrief(seed.content);
  }, [messages, voiceBrief, voiceDesignOnly]);

  useEffect(() => () => streamAbortRef.current?.abort(), []);

  useEffect(() => {
    setFocusKey(focus.kind === 'project' ? 'project' : `${focus.kind}:${focus.target_id || ''}`);
  }, [focus.kind, focus.target_id]);

  const createConversation = async () => {
    if (busy || parentBusy) return;
    setBusy(true);
    try {
      const result = await studioApi.createAudioAssistantConversation(projectKey, `声音准备 · ${projectName}`);
      setConversations((current) => [result.conversation, ...current]);
      setConversationId(result.conversation.id);
      setMessages([]);
      setVoiceBrief('');
      setRun(null);
      setEvents([]);
      setSelectedOperationIds(new Set());
      setApplied(false);
      setAppliedDocument(null);
      setAppliedSaved(false);
      setApplyIssue('');
      setLocalNotice('已创建新的声音准备会话。');
    } catch (error) {
      setLocalNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const send = async (preparedMessage?: string) => {
    const value = (preparedMessage ?? message).trim();
    if (!value || busy || parentBusy || !conversationId || currentConversation?.status === 'archived') return;
    setBusy(true);
    setNotice('');
    const localMessage: AssistantMessage = { id: 'local-' + Date.now(), role: 'user', content: value, attachments: [], created_at: new Date().toISOString(), metadata: { assistant_mode: 'voice-preparation' } };
    setMessages((current) => [...current, localMessage]);
    setMessage('');
    setRun(null);
    setEvents([]);
    setApplied(false);
    setAppliedDocument(null);
    setAppliedSaved(false);
    setApplyIssue('');
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    try {
      const result = await studioApi.streamAudioAssistantRun(projectKey, {
        conversation_id: conversationId,
        message: value,
        context: {
          active_view: 'audio',
          audio_focus: activeFocus,
          audio_provider_profile_id: providerProfileId || null,
          audio_provider_region: providerRegion || null,
          voice_design_only: voiceDesignOnly,
          audio_draft: audioDocument,
          revisions: { project: envelope.revision, audio: envelope.revision },
          pending_changes: { audio: dirty },
        },
        cost_boundary: { currency: 'USD', confirmation_required: true, generation_requires_separate_confirmation: true },
        client_message_id: randomClientMessageId(),
      }, (event: AssistantStreamEvent) => {
        if (!event.run_id || event.event_name === 'snapshot_complete') return;
        setEvents((current) => mergeAssistantRunEvents(current, [event]));
      }, controller.signal);
      if (result.run_id) {
        const detail = await studioApi.assistantRun(result.run_id);
        setRun(detail);
        setEvents((current) => mergeAssistantRunEvents(current, detail.events || []));
        if (detail.status === 'succeeded') setLocalNotice('声音 AI 已形成可审阅方案；尚未修改声音草稿，也未调用 MiniMax。');
      }
      const refreshedMessages = await studioApi.assistantMessages(conversationId);
      setMessages(refreshedMessages.messages);
      const refreshedConversations = await studioApi.audioAssistantConversations(projectKey);
      setConversations(refreshedConversations.conversations);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setLocalNotice((error as Error).message);
    } finally {
      setBusy(false);
      streamAbortRef.current = null;
    }
  };

  const applyDraft = async () => {
    if (!run || run.status !== 'succeeded' || !selectedOperationIds.size || busy || parentBusy || applyBlockedByStale) return;
    if (!run.result.audio_base_hash || !currentContractHash) {
      setApplyIssue('stale');
      setLocalNotice('当前声音方案缺少草稿基线或规范版本，请重新分析。');
      return;
    }
    setBusy(true);
    try {
      const result = await studioApi.applyAudioAssistantDraft(run.id, {
        selected_operation_ids: [...selectedOperationIds],
        expected_project_revision: envelope.revision,
        expected_audio_revision: envelope.revision,
        expected_contract_bundle_hash: currentContractHash,
        base_audio_hash: run.result.audio_base_hash,
        document: audioDocument,
      });
      if (!result.applied_operation_ids?.length) {
        setLocalNotice('当前没有成功加入任何声音草稿；请重新分析当前声音方案。');
        return;
      }
      onDraftApplied(result.document);
      setAppliedDocument(result.document);
      setAppliedSaved(false);
      setApplied(true);
      setApplyIssue('');
      setLocalNotice(`已回填 ${result.applied_operation_ids.length} 项声音草稿；当前仍未保存、未生成音频。`);
    } catch (error) {
      const detail = (error as { details?: unknown; status?: number; message?: string }).details;
      const kind = detail && typeof detail === 'object' ? String((detail as Record<string, unknown>).kind || '') : '';
      const errorMessage = String((error as Error).message || '');
      const stale = kind === 'audio_draft_stale' || kind === 'contract_stale' || errorMessage.includes('重新分析') || errorMessage.includes('版本已变化');
      setApplyIssue(stale ? 'stale' : 'error');
      setLocalNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveAppliedDraft = async () => {
    if (!appliedDocument || busy || parentBusy) return;
    setBusy(true);
    try {
      const saved = await onSave(appliedDocument);
      if (saved) {
        setAppliedDocument(saved.document);
        setAppliedSaved(true);
        setLocalNotice('声音草稿已保存到工作区；生成音频仍需逐条确认文本与费用。');
      }
    } catch (error) {
      setLocalNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const retry = () => {
    const last = [...messages].reverse().find((item) => item.role === 'user');
    if (last) {
      setMessage(last.content);
      setLocalNotice('已带回上一条声音准备消息，可以修改后重新分析。');
    }
  };

  const reanalyzeCurrentDraft = () => {
    const last = [...messages].reverse().find((item) => item.role === 'user');
    if (!last) {
      setLocalNotice('当前会话还没有可重新分析的用户消息，请先描述声音目标。');
      return;
    }
    setApplyIssue('');
    void send(last.content);
  };

  const requestDialogueCompletion = () => {
    void send('请基于本会话已经确认的角色设定，补全目标语言台词候选。每一条都必须给出实际可朗读的 source_text 与 provider_text，以及 language、locale、dialect 和中文含义；如果目标语言仍无法确定，请只提出一个明确的必答问题，不要返回空候选。');
  };

  const requestVoiceDesign = () => {
    const last = [...messages].reverse().find((item) => item.role === 'user');
    const brief = last?.content ? `上一条声音想法：${last.content.slice(0, 2200)}` : '请根据当前会话中最近一次声音想法';
    void send(`${brief}\n\n请只完成 Voice Design：把这段想法整理成一个可直接粘贴到 MiniMax Voice Design 的英文音色 Prompt，并提供一条不超过 500 个字符的实际试听台词。不要输出系统音色、角色登记、三组 audition、逐句对白、QA、资产或交接操作。`);
  };

  const submitVoiceBrief = () => {
    const value = voiceBrief.trim();
    if (!value) {
      setLocalNotice('请先描述你想要的声音，以及让它说的一句试听台词。');
      return;
    }
    void send(value);
  };

  const displayMessages = messages;
  const busyState = busy || parentBusy || loading;
  const statusText = loading ? '读取会话' : run?.status === 'running' || run?.status === 'preparing' ? '分析中' : run?.status === 'succeeded' ? applied ? '草稿已回填' : '待审阅' : run?.status === 'failed' ? '分析失败' : '等待输入';
  const toggleCandidate = (operation?: AssistantWorkspaceOperation) => {
    if (!operation) return;
    setSelectedOperationIds((current) => toggleAssistantOperation(current, operation));
  };

  return <section className={'audio-assistant-panel ' + (collapsed ? 'collapsed ' : '') + (voiceDesignOnly ? 'voice-design-only' : '')}>
    <header className="audio-assistant-panel-header">
      <div className="audio-assistant-brand"><span>{voiceDesignOnly ? 'VOICE DESIGN AI' : 'VOICE PREP AI'}</span><h3>{voiceDesignOnly ? '先把想法整理好' : '声音前置准备'}</h3><p>{voiceDesignOnly ? 'OpenCode 整理 Prompt 和试听台词 · MiniMax 生成音色候选' : 'OpenCode 负责方案完善 · MiniMax 负责实际生成'}</p></div>
      <div className="audio-assistant-responsibility"><span className="audio-assistant-owner">规划 <b>OpenCode</b></span><span className="audio-assistant-owner">生成 <b>MiniMax</b></span><span className="audio-assistant-status"><i />{statusText}</span><button type="button" onClick={() => setCollapsed((current) => !current)}>{collapsed ? '展开' : '收起'}</button></div>
    </header>
    {collapsed ? <button type="button" className="audio-assistant-collapsed-bar" onClick={() => setCollapsed(false)}>{voiceDesignOnly ? 'AI 音色输入' : 'AI 声音方案'} · {requiredQuestions.length ? `${requiredQuestions.length} 个待确认项` : proposal ? '方案可审阅' : '等待输入'} <span>展开继续 ↗</span></button> : voiceDesignOnly ? <div className="audio-assistant-direct-design">
      <section className="audio-assistant-brief-editor">
        <div className="audio-assistant-brief-heading"><div><span>VOICE IDEA</span><h4>描述你想要的声音</h4><p>把角色的声音感觉、语言和一条试听台词写在这里。AI 会把它整理成下方 MiniMax 可以直接使用的输入。</p></div><small>只需一次 AI 整理</small></div>
        <textarea aria-label="声音想法输入" value={voiceBrief} onChange={(event) => setVoiceBrief(event.target.value)} placeholder="例如：我想要一位来自日本的女高中生，声音甜甜的、比较轻柔，有高中生的活力和朝气，但不要太像动漫配音。她想说：前辈，今天放学要一起回家吗？" rows={7} disabled={busyState || currentConversation?.status === 'archived'} />
        <div className="audio-assistant-brief-footer"><small>{voiceBrief.length} 字符 · 这是给 AI 的原始想法，不会直接发送给 MiniMax</small><button type="button" className="audio-primary-button" onClick={submitVoiceBrief} disabled={busyState || currentConversation?.status === 'archived' || !voiceBrief.trim()}>{busyState ? 'AI 正在整理…' : '✦ AI 整理音色 Prompt'}</button></div>
      </section>
      {proposal && <div className="audio-assistant-direct-status">{voiceDesign ? <><div><span>AI VOICE DESIGN</span><strong>已同步到下方 MiniMax 创作台</strong><small>请在下方唯一的 Prompt 和 Text to Preview 区审核、编辑、复制或生成候选。</small></div><b>输入已就绪</b></> : <><div><strong>AI 还没有形成完整的 Voice Design 输入</strong><small>请补充一条实际试听台词，再点击上面的 AI 整理按钮。</small></div><button type="button" onClick={submitVoiceBrief} disabled={busyState || !voiceBrief.trim()}>重新整理</button></>}</div>}
      {run?.error && <div className="audio-assistant-error" role="alert"><b>声音方案分析失败</b><p>{String(run.error.message || 'OpenCode 或本地解析失败')}</p><button type="button" onClick={submitVoiceBrief} disabled={busyState || !voiceBrief.trim()}>重新分析</button></div>}
      {notice && <div className="audio-assistant-notice" role="status">{notice}</div>}
    </div> : <>
      <div className="audio-assistant-toolbar">
        {!voiceDesignOnly && <div><span>当前焦点</span><b>{focusLabels[activeFocus.kind] || activeFocus.kind}</b>{activeFocus.target_id && <small>{activeFocus.target_id}</small>}{activeFocus.shot_ids.length > 0 && <small>镜头 {activeFocus.shot_ids.join('、')}</small>}</div>}
        <div><label className={voiceDesignOnly ? 'audio-assistant-session-label' : ''}>{voiceDesignOnly ? '对话' : '焦点入口'}{!voiceDesignOnly && <select value={focusKey} onChange={(event) => setFocusKey(event.target.value)} disabled={busyState}>{focusOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select>}</label><label>声音准备会话<select value={conversationId} onChange={(event) => { const next = event.target.value; setConversationId(next); setVoiceBrief(''); void loadConversation(next); }} disabled={busyState}>{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title || '未命名声音会话'}</option>)}</select></label><button type="button" onClick={() => void createConversation()} disabled={busyState}>＋ 新会话</button></div>
      </div>
      <div className="audio-assistant-body">
        <div className="audio-assistant-chat" aria-live="polite">
          {displayMessages.map((item) => <article className={'audio-assistant-message ' + item.role} key={item.id}><span className="audio-assistant-avatar">{item.role === 'user' ? '你' : 'F'}</span><div><div className="audio-assistant-message-meta"><b>{item.role === 'user' ? '你' : '声音 AI'}</b><small>{formatDate(item.created_at)}</small></div><p>{item.content}</p></div></article>)}
          {!displayMessages.length && <div className="audio-assistant-welcome"><span>✦</span><strong>{voiceDesignOnly ? '先说说你想要的声音' : '把一个声音想法交给我'}</strong><p>{voiceDesignOnly ? '描述年龄感、声音质感、语言、情绪和一条想让它说的台词。我会整理成两段可以直接放进 MiniMax Voice Design 的内容。' : '描述角色、语言、关系、情绪和想说的话。我会按当前声音规则拆成音色候选、目标语言台词、试听矩阵和生成前检查。'}</p><button type="button" onClick={() => setMessage('我想要一位来自日本的女高中生，声音甜甜的、比较轻柔，同时有高中生的活力和朝气，不要太像动漫配音。她想说：前辈，今天放学要一起回家吗？')} disabled={busyState}>使用当前日本女高中生示例</button></div>}
          {runHasProblem && events.length > 0 && <div className="audio-assistant-events audio-assistant-events-problem"><div className="audio-assistant-subhead"><span>运行提示</span><small>sequence {latestSequence}</small></div>{events.slice(-8).map((event) => <div className={'audio-assistant-event ' + event.status} key={event.run_id + ':' + event.sequence}><i /><div><b>{eventLabel(event)}</b><small>{formatDate(event.created_at)}</small>{eventDetail(event) && <p>{eventDetail(event)}</p>}</div></div>)}</div>}
          {run?.error && <div className="audio-assistant-error" role="alert"><b>声音方案分析失败</b><p>{String(run.error.message || 'OpenCode 或本地解析失败')}</p><button type="button" onClick={retry} disabled={busyState}>重新分析</button></div>}
        </div>
        {proposal && <div className="audio-assistant-proposal" aria-label="声音 AI 方案">
          <div className="audio-assistant-proposal-head"><div><span>{voiceDesignOnly ? 'AI VOICE DESIGN DRAFT' : `PREPARATION PROPOSAL · ${displayProposalState}`}</span><h4>{voiceDesignOnly ? '可复制到 MiniMax 的音色输入' : proposal.intent_summary || '声音目标理解'}</h4></div><small>{voiceDesignOnly ? '先审核 Prompt 和试听台词' : '候选不等于确认 · 草稿不等于生成'}</small></div>
          {voiceDesignOnly ? voiceDesign ? <section className="audio-assistant-section audio-assistant-design-sync"><div className="audio-assistant-design-sync-copy"><span>AI VOICE DESIGN</span><strong>已同步到下方 MiniMax 创作台</strong><small>请在下方唯一的 Prompt 和 Text to Preview 区审核、编辑、复制或生成候选。</small></div><span className="audio-assistant-design-sync-state">输入已就绪</span></section> : <VoiceDesignMissingCard onRequest={requestVoiceDesign} disabled={busyState || currentConversation?.status === 'archived'} /> : <>
            {requiredQuestions.length > 0 && <section className="audio-assistant-section audio-assistant-question-section"><div className="audio-assistant-subhead"><span>待确认问题</span><b>{requiredQuestions.length}</b></div>{requiredQuestions.map((question) => <div className="audio-assistant-question" key={question.id}><b>{question.question}</b>{question.reason && <small>{question.reason}</small>}{question.options?.length ? <div>{question.options.map((option) => <span key={option}>{option}</span>)}</div> : null}</div>)}</section>}
            <section className="audio-assistant-section"><div className="audio-assistant-subhead"><span>MiniMax 系统音色候选</span><small>{proposal.voice_candidates?.length || 0} 个 · 实际试听后锁定</small></div><div className="audio-assistant-candidate-grid">{(proposal.voice_candidates || []).map((candidate) => { const operation = operationForCandidate(operations, candidate.candidate_id); return <VoiceCandidateCard key={candidate.candidate_id} candidate={candidate} operation={operation} selected={Boolean(operation && selectedOperationIds.has(operation.id))} onToggle={() => toggleCandidate(operation)} onCopy={() => void copyAssistantValue('Voice ID', candidate.provider_voice_id)} />; })}</div>{!proposal.voice_candidates?.length && <p className="audio-assistant-muted">暂未形成可执行音色候选；请补充语言、地区或修复目录连接。</p>}</section>
            {proposal.voice_design && <VoiceDesignCard design={proposal.voice_design} onUse={() => onVoiceDesignPackage?.(proposal.voice_design as AudioPreparationVoiceDesign)} onNotice={setLocalNotice} />}
            <section className="audio-assistant-section"><div className="audio-assistant-subhead"><span>目标语言台词候选</span><small>{dialogueCandidates.length} 条 · 需用户确认</small></div><div className="audio-assistant-dialogue-grid">{dialogueCandidates.map((candidate) => { const operation = operationForCandidate(operations, candidate.candidate_id); return <DialogueCandidateCard key={candidate.candidate_id} candidate={candidate} operation={operation} selected={Boolean(operation && selectedOperationIds.has(operation.id))} onToggle={() => toggleCandidate(operation)} onCopy={() => void copyAssistantValue('可朗读文本', candidate.provider_text || candidate.source_text)} />; })}</div>{!dialogueCandidates.length && <div className="audio-assistant-muted"><p>{incompleteDialogueCount ? `已拦截 ${incompleteDialogueCount} 条不完整候选：它们没有可复制的目标语言台词，不能回填或发送到 MiniMax。` : '尚未形成逐句台词候选。'}</p><button type="button" className="audio-assistant-copy-button" onClick={requestDialogueCompletion} disabled={busyState || currentConversation?.status === 'archived'}>补全目标语言台词</button></div>}</section>
            <section className="audio-assistant-section"><div className="audio-assistant-subhead"><span>Audition 三组试听方向</span><small>同一音色、同一句台词、一次只改变一个变量</small></div><AuditionSummary auditions={auditionMatrix} /></section>
            <section className="audio-assistant-preflight"><div><span>MINIMAX PREFLIGHT</span><strong>{preflight?.provider || 'minimax'} · {preflight?.model || 'speech-2.8-hd'}</strong></div><div><small>语言增强</small><b>{displayLanguageBoost || '自动识别'}</b></div><div><small>文本字符数</small><b>{displayTextChars}</b></div><div><small>计划条数</small><b>{displayPlannedCount}</b></div><div className="audio-assistant-preflight-blockers"><small>执行前门禁</small><b>{preflight?.can_generate === false ? '台词确认 + 费用确认' : '等待校验'}</b>{preflight?.blockers?.map((blocker) => <span key={blocker}>{blocker}</span>)}</div></section>
          </>}
        </div>}
      </div>
      {!voiceDesignOnly && operations.length > 0 && <section className="audio-assistant-operations"><div className="audio-assistant-plan-head"><div><span>DRAFT OPERATIONS · {operations.length} ITEMS</span><h4>选择要加入声音工坊草稿的内容</h4></div><div><button type="button" onClick={() => setSelectedOperationIds(selectableAssistantOperationIds(operations))} disabled={busyState || applied}>全选可用</button><button type="button" onClick={() => setSelectedOperationIds(new Set())} disabled={busyState || applied}>清空</button></div></div>{applyBlockedByStale && !applied && <div className="audio-assistant-apply-issue" role="alert"><div><b>这份方案基于旧的声音草稿版本</b><span>为避免覆盖你当前的修改，已暂停回填。重新分析会读取当前草稿并生成新的可审阅操作，不会调用 MiniMax。</span></div><button type="button" onClick={reanalyzeCurrentDraft} disabled={busyState}>重新分析当前草稿</button></div>}<div className="audio-assistant-operation-list">{operations.map((operation) => { const blocked = operation.risk === 'blocked'; return <label className={'audio-assistant-operation ' + (selectedOperationIds.has(operation.id) ? 'selected ' : '') + (blocked ? 'blocked' : '')} key={operation.id}><input type="checkbox" checked={selectedOperationIds.has(operation.id)} disabled={blocked || busyState || applied} onChange={() => setSelectedOperationIds((current) => toggleAssistantOperation(current, operation))} /><span className="audio-assistant-operation-copy"><b>{operationLabel(operation)}</b><strong>{operationPreview(operation)}</strong><small>{operation.summary} · {blocked ? '受保护，不能应用' : '加入草稿后仍需在下方审核'}</small></span></label>; })}</div><div className="audio-assistant-apply-row"><small>{applied ? appliedSaved ? '已保存到声音工坊工作区；生成音频仍需单独确认。' : '已加入下方声音工坊草稿；点击“保存到工作区”后持久化，生成音频仍需单独确认。' : applyBlockedByStale ? '当前方案已暂停回填；请先重新分析当前声音草稿。' : '点击后会把已选候选加入下方声音工坊草稿，不会直接调用 MiniMax 或生成 Take。'}</small><div className="audio-assistant-apply-actions"><button type="button" className={'audio-primary-button audio-assistant-apply-button ' + (applied ? 'applied' : '')} onClick={() => void applyDraft()} disabled={busyState || applied || applyBlockedByStale || !selectedOperationIds.size || run?.status !== 'succeeded'}>{busy ? '正在加入…' : applied ? '已加入声音草稿' : applyBlockedByStale ? '需重新分析' : `加入已选 ${selectedOperationIds.size} 项`}</button>{applied && <button type="button" className="audio-assistant-save-button" onClick={() => void saveAppliedDraft()} disabled={busyState || !appliedDocument || appliedSaved}>{busy ? '正在保存…' : appliedSaved ? '已保存到工作区' : '保存到工作区'}</button>}</div></div></section>}
      <footer className="audio-assistant-composer"><div className="audio-assistant-composer-label"><span>{voiceDesignOnly ? 'VOICE DESIGN CHAT' : 'VOICE PREPARATION CHAT'}</span><small>{voiceDesignOnly ? '只整理音色 Prompt 和试听台词 · 不直接生成音频' : '只讨论声音方案 · 不直接生成音频'}</small></div><div className="audio-assistant-composer-box"><textarea value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={currentConversation?.status === 'archived' ? '会话已归档，请新建声音准备会话' : voiceDesignOnly ? '描述你想要的音色，以及让它说的一句台词…' : '描述你的角色声音、语言、关系、情绪或台词想法…'} disabled={busyState || currentConversation?.status === 'archived'} rows={2} aria-label="声音前置准备对话" /><button type="button" className="audio-assistant-send" onClick={() => void send()} disabled={busyState || !message.trim() || currentConversation?.status === 'archived'}>↑</button></div>{notice && <div className="audio-assistant-notice" role="status">{notice}</div>}</footer>
    </>}
  </section>;
}
