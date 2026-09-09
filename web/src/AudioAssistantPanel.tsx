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
} from './assistant-types';
import { mergeAssistantRunEvents, selectableAssistantOperationIds, toggleAssistantOperation } from './assistant-state';
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
  onNotice: (message: string) => void;
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

function VoiceCandidateCard({ candidate, operation, selected, onToggle }: { candidate: AudioPreparationVoiceCandidate; operation?: AssistantWorkspaceOperation; selected: boolean; onToggle: () => void }) {
  const disabled = !candidate.selectable || !operation || operation.risk === 'blocked';
  return <article className={'audio-assistant-candidate-card ' + (selected ? 'selected ' : '') + (!candidate.selectable ? 'documented' : '')}>
    <div className="audio-assistant-candidate-top">
      <div><span className="audio-assistant-rank">0{candidate.recommendation_rank}</span><strong>{candidate.provider_voice_name || candidate.provider_voice_id}</strong></div>
      <span className={'audio-assistant-source-chip ' + (candidate.catalog_source === 'documented' ? 'documented' : 'live')}>{candidate.catalog_source === 'documented' ? '仅参考' : candidate.catalog_source === 'cached' ? '缓存可执行' : '实时可执行'}</span>
    </div>
    <div className="audio-assistant-candidate-id">{candidate.provider_voice_id} · {candidate.language || '未指定语言'} · {candidate.provider_region}</div>
    <p>{candidate.rationale || candidate.description || '以实际试听结果为准。'}</p>
    <button type="button" className="audio-assistant-select-button" onClick={onToggle} disabled={disabled}>{!candidate.selectable ? '目录恢复后可应用' : selected ? '已选择草稿' : '选择此音色草稿'}</button>
  </article>;
}

function DialogueCandidateCard({ candidate, operation, selected, onToggle }: { candidate: AudioPreparationDialogueCandidate; operation?: AssistantWorkspaceOperation; selected: boolean; onToggle: () => void }) {
  const disabled = !operation || operation.risk === 'blocked';
  return <article className={'audio-assistant-dialogue-card ' + (selected ? 'selected' : '')}>
    <div className="audio-assistant-dialogue-head"><span>{candidate.candidate_id}</span><b>{candidate.text_status === 'candidate' ? '候选 · 待确认' : candidate.text_status}</b></div>
    <strong>{candidate.source_text || '尚未形成目标语言台词'}</strong>
    {candidate.meaning_cn && <small>中文含义：{candidate.meaning_cn}</small>}
    <small>{candidate.language || '未指定语言'} · {candidate.locale || '未指定 locale'} · {candidate.dialect || '未指定方言'} · language_boost：{candidate.language_boost || '自动'}</small>
    <button type="button" className="audio-assistant-select-button" onClick={onToggle} disabled={disabled}>{selected ? '已选择台词草稿' : '选择此台词草稿'}</button>
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

export function AudioAssistantPanel({ projectId, projectName, envelope, audioDocument, focus, providerProfileId, providerRegion, dirty, busy: parentBusy = false, onDraftApplied, onSave, onNotice }: AudioAssistantPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [conversations, setConversations] = useState<AssistantConversation[]>([]);
  const [conversationId, setConversationId] = useState('');
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [message, setMessage] = useState('');
  const [run, setRun] = useState<AssistantRun | null>(null);
  const [events, setEvents] = useState<AssistantRunEvent[]>([]);
  const [selectedOperationIds, setSelectedOperationIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [applied, setApplied] = useState(false);
  const [focusKey, setFocusKey] = useState('project');
  const streamAbortRef = useRef<AbortController | null>(null);
  const projectKey = projectId;

  const operations = useMemo(() => (run?.result?.patch?.workspace_operations || []) as AssistantWorkspaceOperation[], [run?.result?.patch?.workspace_operations]);
  const proposal = proposalFromRun(run);
  const latestSequence = events.at(-1)?.sequence || 0;
  const currentConversation = conversations.find((item) => item.id === conversationId);
  const requiredQuestions = (proposal?.questions || []).filter((item) => item.required !== false);
  const preflight = proposal?.preflight;
  const currentContractHash = String(run?.contract_snapshot?.bundle_hash || run?.result?.preview?.contract_hash || '');
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

  const loadConversation = useCallback(async (id: string) => {
    if (!id) {
      setMessages([]);
      setRun(null);
      setEvents([]);
      return;
    }
    try {
      const [messageResult, runResult] = await Promise.all([studioApi.assistantMessages(id), studioApi.assistantRuns(projectKey, id)]);
      setMessages(messageResult.messages);
      const latestRun = runResult.runs[0];
      if (!latestRun) {
        setRun(null);
        setEvents([]);
        return;
      }
      const [detail, eventResult] = await Promise.all([studioApi.assistantRun(latestRun.id), studioApi.assistantRunEvents(latestRun.id)]);
      setRun(detail);
      setEvents(mergeAssistantRunEvents([], eventResult.events || detail.events || []));
      setApplied(Boolean(detail.result?.apply));
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
    setRun(null);
    setEvents([]);
    setSelectedOperationIds(new Set());
    setApplied(false);
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
  }, [run?.id, operations]);

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
      setRun(null);
      setEvents([]);
      setSelectedOperationIds(new Set());
      setApplied(false);
      setLocalNotice('已创建新的声音准备会话。');
    } catch (error) {
      setLocalNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const value = message.trim();
    if (!value || busy || parentBusy || !conversationId || currentConversation?.status === 'archived') return;
    setBusy(true);
    setNotice('');
    const localMessage: AssistantMessage = { id: 'local-' + Date.now(), role: 'user', content: value, attachments: [], created_at: new Date().toISOString(), metadata: { assistant_mode: 'voice-preparation' } };
    setMessages((current) => [...current, localMessage]);
    setMessage('');
    setRun(null);
    setEvents([]);
    setApplied(false);
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
    if (!run || run.status !== 'succeeded' || !selectedOperationIds.size || busy || parentBusy) return;
    if (!run.result.audio_base_hash || !currentContractHash) {
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
      onDraftApplied(result.document);
      setApplied(true);
      setLocalNotice(`已回填 ${result.applied_operation_ids.length} 项声音草稿；当前仍未保存、未生成音频。`);
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

  const displayMessages = messages;
  const busyState = busy || parentBusy || loading;
  const statusText = loading ? '读取会话' : run?.status === 'running' || run?.status === 'preparing' ? '分析中' : run?.status === 'succeeded' ? applied ? '草稿已回填' : '待审阅' : run?.status === 'failed' ? '分析失败' : '等待输入';
  const toggleCandidate = (operation?: AssistantWorkspaceOperation) => {
    if (!operation) return;
    setSelectedOperationIds((current) => toggleAssistantOperation(current, operation));
  };

  return <section className={'audio-assistant-panel ' + (collapsed ? 'collapsed' : '')}>
    <header className="audio-assistant-panel-header">
      <div className="audio-assistant-brand"><span>VOICE PREP AI</span><h3>声音前置准备</h3><p>OpenCode 负责方案完善 · MiniMax 负责实际生成</p></div>
      <div className="audio-assistant-responsibility"><span className="audio-assistant-owner">规划 <b>OpenCode</b></span><span className="audio-assistant-owner">生成 <b>MiniMax</b></span><span className="audio-assistant-status"><i />{statusText}</span><button type="button" onClick={() => setCollapsed((current) => !current)}>{collapsed ? '展开' : '收起'}</button></div>
    </header>
    {collapsed ? <button type="button" className="audio-assistant-collapsed-bar" onClick={() => setCollapsed(false)}>AI 声音方案 · {requiredQuestions.length ? `${requiredQuestions.length} 个待确认项` : proposal ? '方案可审阅' : '等待输入'} <span>展开继续 ↗</span></button> : <>
      <div className="audio-assistant-toolbar">
        <div><span>当前焦点</span><b>{focusLabels[activeFocus.kind] || activeFocus.kind}</b>{activeFocus.target_id && <small>{activeFocus.target_id}</small>}{activeFocus.shot_ids.length > 0 && <small>镜头 {activeFocus.shot_ids.join('、')}</small>}</div>
        <div><label>焦点入口<select value={focusKey} onChange={(event) => setFocusKey(event.target.value)} disabled={busyState}>{focusOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label><label>声音准备会话<select value={conversationId} onChange={(event) => { const next = event.target.value; setConversationId(next); void loadConversation(next); }} disabled={busyState}>{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title || '未命名声音会话'}</option>)}</select></label><button type="button" onClick={() => void createConversation()} disabled={busyState}>＋ 新会话</button></div>
      </div>
      <div className="audio-assistant-body">
        <div className="audio-assistant-chat" aria-live="polite">
          {displayMessages.map((item) => <article className={'audio-assistant-message ' + item.role} key={item.id}><span className="audio-assistant-avatar">{item.role === 'user' ? '你' : 'F'}</span><div><div className="audio-assistant-message-meta"><b>{item.role === 'user' ? '你' : '声音 AI'}</b><small>{formatDate(item.created_at)}</small></div><p>{item.content}</p></div></article>)}
          {!displayMessages.length && <div className="audio-assistant-welcome"><span>✦</span><strong>把一个声音想法交给我</strong><p>描述角色、语言、关系、情绪和想说的话。我会按当前声音规则拆成音色候选、目标语言台词、试听矩阵和生成前检查。</p><button type="button" onClick={() => setMessage('我想要一位来自日本的女高中生，声音甜甜的、比较轻柔，同时有高中生的活力和朝气，不要太像动漫配音。她想说：前辈，今天放学要一起回家吗？')} disabled={busyState}>使用当前日本女高中生示例</button></div>}
          {events.length > 0 && <div className="audio-assistant-events"><div className="audio-assistant-subhead"><span>RUN TRACE</span><small>sequence {latestSequence}</small></div>{events.slice(-8).map((event) => <div className={'audio-assistant-event ' + event.status} key={event.run_id + ':' + event.sequence}><i /><div><b>{eventLabel(event)}</b><small>{formatDate(event.created_at)}</small>{eventDetail(event) && <p>{eventDetail(event)}</p>}</div></div>)}</div>}
          {run?.error && <div className="audio-assistant-error" role="alert"><b>声音方案分析失败</b><p>{String(run.error.message || 'OpenCode 或本地解析失败')}</p><button type="button" onClick={retry} disabled={busyState}>重新分析</button></div>}
        </div>
        {proposal && <div className="audio-assistant-proposal" aria-label="声音 AI 方案">
          <div className="audio-assistant-proposal-head"><div><span>PREPARATION PROPOSAL · {proposal.state}</span><h4>{proposal.intent_summary || '声音目标理解'}</h4></div><small>候选不等于确认 · 草稿不等于生成</small></div>
          {requiredQuestions.length > 0 && <section className="audio-assistant-section audio-assistant-question-section"><div className="audio-assistant-subhead"><span>待确认问题</span><b>{requiredQuestions.length}</b></div>{requiredQuestions.map((question) => <div className="audio-assistant-question" key={question.id}><b>{question.question}</b>{question.reason && <small>{question.reason}</small>}{question.options?.length ? <div>{question.options.map((option) => <span key={option}>{option}</span>)}</div> : null}</div>)}</section>}
          <section className="audio-assistant-section"><div className="audio-assistant-subhead"><span>MiniMax 系统音色候选</span><small>{proposal.voice_candidates?.length || 0} 个 · 实际试听后锁定</small></div><div className="audio-assistant-candidate-grid">{(proposal.voice_candidates || []).map((candidate) => { const operation = operationForCandidate(operations, candidate.candidate_id); return <VoiceCandidateCard key={candidate.candidate_id} candidate={candidate} operation={operation} selected={Boolean(operation && selectedOperationIds.has(operation.id))} onToggle={() => toggleCandidate(operation)} />; })}</div>{!proposal.voice_candidates?.length && <p className="audio-assistant-muted">暂未形成可执行音色候选；请补充语言、地区或修复目录连接。</p>}</section>
          <section className="audio-assistant-section"><div className="audio-assistant-subhead"><span>目标语言台词候选</span><small>{proposal.dialogue_candidates?.length || 0} 条 · 需用户确认</small></div><div className="audio-assistant-dialogue-grid">{(proposal.dialogue_candidates || []).map((candidate) => { const operation = operationForCandidate(operations, candidate.candidate_id); return <DialogueCandidateCard key={candidate.candidate_id} candidate={candidate} operation={operation} selected={Boolean(operation && selectedOperationIds.has(operation.id))} onToggle={() => toggleCandidate(operation)} />; })}</div>{!proposal.dialogue_candidates?.length && <p className="audio-assistant-muted">尚未形成逐句台词候选。</p>}</section>
          <section className="audio-assistant-section"><div className="audio-assistant-subhead"><span>Audition 三组试听方向</span><small>同一音色、同一句台词、一次只改变一个变量</small></div><AuditionSummary auditions={proposal.audition_matrix || []} /></section>
          <section className="audio-assistant-preflight"><div><span>MINIMAX PREFLIGHT</span><strong>{preflight?.provider || 'minimax'} · {preflight?.model || 'speech-2.8-hd'}</strong></div><div><small>语言增强</small><b>{preflight?.language_boost || '自动识别'}</b></div><div><small>文本字符数</small><b>{preflight?.text_chars ?? '—'}</b></div><div><small>计划条数</small><b>{preflight?.planned_count ?? '—'}</b></div><div className="audio-assistant-preflight-blockers"><small>执行前门禁</small><b>{preflight?.can_generate === false ? '台词确认 + 费用确认' : '等待校验'}</b>{preflight?.blockers?.map((blocker) => <span key={blocker}>{blocker}</span>)}</div></section>
        </div>}
      </div>
      {operations.length > 0 && <section className="audio-assistant-operations"><div className="audio-assistant-plan-head"><div><span>DRAFT OPERATIONS · {operations.length} ITEMS</span><h4>选择要回填到声音草稿的内容</h4></div><div><button type="button" onClick={() => setSelectedOperationIds(selectableAssistantOperationIds(operations))} disabled={busyState || applied}>全选可用</button><button type="button" onClick={() => setSelectedOperationIds(new Set())} disabled={busyState || applied}>清空</button></div></div><div className="audio-assistant-operation-list">{operations.map((operation) => { const blocked = operation.risk === 'blocked'; return <label className={'audio-assistant-operation ' + (selectedOperationIds.has(operation.id) ? 'selected ' : '') + (blocked ? 'blocked' : '')} key={operation.id}><input type="checkbox" checked={selectedOperationIds.has(operation.id)} disabled={blocked || busyState || applied} onChange={() => setSelectedOperationIds((current) => toggleAssistantOperation(current, operation))} /><span className="audio-assistant-operation-copy"><b>{operationLabel(operation)}</b><strong>{operationPreview(operation)}</strong><small>{operation.summary} · {blocked ? '受保护，不能应用' : '仅草稿回填'}</small></span></label>; })}</div><div className="audio-assistant-apply-row"><small>{applied ? '草稿已回填到下方声音表单；保存仍由声音工坊负责。' : '应用只改变当前页面本地草稿，不写入项目、不生成 Take。'}</small><button type="button" className="audio-primary-button" onClick={() => void applyDraft()} disabled={busyState || applied || !selectedOperationIds.size || run?.status !== 'succeeded'}>{busy ? '处理中…' : applied ? '已回填到本地草稿' : `应用已选 ${selectedOperationIds.size} 项`}</button></div></section>}
      <footer className="audio-assistant-composer"><div className="audio-assistant-composer-label"><span>VOICE PREPARATION CHAT</span><small>只讨论声音方案 · 不直接生成音频</small></div><div className="audio-assistant-composer-box"><textarea value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={currentConversation?.status === 'archived' ? '会话已归档，请新建声音准备会话' : '描述你的角色声音、语言、关系、情绪或台词想法…'} disabled={busyState || currentConversation?.status === 'archived'} rows={2} aria-label="声音前置准备对话" /><button type="button" className="audio-assistant-send" onClick={() => void send()} disabled={busyState || !message.trim() || currentConversation?.status === 'archived'}>↑</button></div>{notice && <div className="audio-assistant-notice" role="status">{notice}</div>}</footer>
    </>}
  </section>;
}
