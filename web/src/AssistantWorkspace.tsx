import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type AssistantStreamEvent, studioApi } from './api';
import type { AssistantAttachment, AssistantConversation, AssistantContractBundle, AssistantMessage, AssistantRun, AssistantRunEvent, AssistantWorkspaceOperation, AssistantWorkspaceProps } from './assistant-types';
import { mergeAssistantRunEvents, selectableAssistantOperationIds, toggleAssistantOperation } from './assistant-state';

const modeLabels: Record<string, string> = {
  home: '项目总览',
  story: '故事与分镜',
  canvas: '资产生产工作区',
  timeline: '后期时间线',
  audio: '声音资产工坊',
  settings: '设置与 Provider',
};

const workspaceLabels: Record<string, string> = {
  story: '故事 / 分镜',
  assets: '资产 Prompt',
  audio: '声音工作区',
  timeline: '时间线',
  workflow: '工作流图',
};

const eventLabels: Record<string, string> = {
  run_started: '运行开始',
  item_started: '开始处理',
  item_progress: '处理进度',
  item_completed: '处理完成',
  run_interrupted: '运行暂停',
  approval_request: '等待确认',
  source_citation: '来源引用',
  external_attachment_confirmation: '外发确认',
  workspace_apply: '应用到工作台',
  run_completed: '运行完成',
  run_failed: '运行失败',
  context_loading: '上下文读取',
  attachment_preparing: '附件准备',
  vision_analysis: '图片分析',
  provider_request: 'Provider 请求',
  assistant_message: '助手回复',
  contract_validation: '规范校验',
  plan_preview: '计划预览',
};

function formatBytes(value: number): string {
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function randomClientMessageId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'client-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

type AssistantUploadItem = {
  key: string;
  name: string;
  file: File;
  progress: number;
  status: 'uploading' | 'saved' | 'failed';
  error?: string;
};

function uploadFileKey(file: File): string {
  return file.name + ':' + file.size + ':' + file.lastModified;
}

function operationPreview(operation: AssistantWorkspaceOperation): string {
  const value = operation.after ?? operation.content;
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return operation.summary || '无新增内容';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function operationDiff(operation: AssistantWorkspaceOperation): string {
  if (operation.before === undefined || operation.before === null) return operationPreview(operation);
  const before = typeof operation.before === 'string' ? operation.before : JSON.stringify(operation.before, null, 2);
  const after = operation.after === undefined || operation.after === null ? '' : typeof operation.after === 'string' ? operation.after : JSON.stringify(operation.after, null, 2);
  return '- 修改前\n' + before + '\n\n+ 修改后\n' + after;
}

function attachmentModeLabel(attachment: AssistantAttachment): string {
  return ({
    pending: '发送时判断',
    multimodal: 'vision 图片',
    extracted_text: '本地抽取文本',
    project_reference: '仅本地引用',
    unsupported: '不分析',
  } as Record<string, string>)[attachment.delivery_mode] || attachment.delivery_mode;
}

function eventDetail(event: AssistantRunEvent): string {
  const data = event.data || {};
  if (typeof data.message === 'string') return data.message;
  if (typeof data.summary === 'string' && data.summary) return data.summary;
  if (typeof data.label === 'string') return data.label;
  if (event.event_type === 'item_completed' && data.operation_count !== undefined) return '生成 ' + data.operation_count + ' 项候选';
  if (event.event_type === 'run_completed') return '运行状态已保存，可在下方审阅计划';
  return '';
}

function AttachmentCard({ attachment, onRemove, removable }: { attachment: AssistantAttachment; onRemove?: () => void; removable?: boolean }) {
  return <article className="assistant-attachment-card">
    {attachment.kind === 'image' ? <img src={attachment.url} alt={attachment.name} /> : <span className="assistant-attachment-icon">{attachment.kind === 'document' ? 'DOC' : attachment.kind === 'audio' ? 'AUD' : attachment.kind === 'video' ? 'VID' : 'FILE'}</span>}
    <div className="assistant-attachment-info">
      <strong title={attachment.name}>{attachment.name}</strong>
      <small>{formatBytes(attachment.byte_size)} · {attachmentModeLabel(attachment)}</small>
      <small className={'assistant-attachment-status ' + attachment.analysis_status}>{attachment.analysis_status === 'succeeded' || attachment.analysis_status === 'ready' ? '已准备' : attachment.analysis_status === 'not_analyzed' ? '仅保存' : attachment.analysis_status === 'pending' ? '待分析' : attachment.extraction_error || attachment.analysis_status}</small>
    </div>
    {removable && <button type="button" onClick={onRemove} aria-label={'移除 ' + attachment.name}>×</button>}
  </article>;
}

function OperationCard({ operation, checked, onToggle, disabled = false }: { operation: AssistantWorkspaceOperation; checked: boolean; onToggle: () => void; disabled?: boolean }) {
  const blocked = operation.risk === 'blocked';
  return <article className={'assistant-operation-card ' + (blocked ? 'blocked ' : '') + (disabled ? 'disabled ' : '') + (checked ? 'selected' : '')}>
    <label className="assistant-operation-check">
      <input type="checkbox" checked={checked} disabled={blocked || disabled} onChange={onToggle} />
      <span />
    </label>
    <div className="assistant-operation-body">
      <div className="assistant-operation-heading">
        <div><span>{workspaceLabels[operation.workspace] || operation.workspace}</span><strong>{operation.title}</strong></div>
        <b>{blocked ? '受保护' : operation.risk === 'review_required' ? '需审阅' : '草稿'}</b>
      </div>
      <p>{operation.summary || 'Agent 生成的工作台候选。'}</p>
      {operation.target_id && <small className="assistant-operation-target">目标：{operation.target_id}</small>}
      {operation.source_attachment_ids.length > 0 && <small className="assistant-operation-source">来源附件：{operation.source_attachment_ids.join('、')}</small>}
      {(operation.before !== undefined || operation.after !== undefined || operation.content !== undefined) && <details>
        <summary>{operation.before !== undefined && operation.before !== null ? '查看差异' : '查看新增内容'}</summary>
        <pre>{operationDiff(operation)}</pre>
      </details>}
      {blocked && <small className="assistant-operation-warning">该操作涉及受保护状态或媒体执行，不允许由 Agent 直接应用。</small>}
    </div>
  </article>;
}

export function AssistantWorkspace({ open, project, mode, graph, story, assetBoard, assetLibrary, audioStudio, timeline, settings, selectedNodeIds, selectedEdgeIds, selectedAssetId, selectedShotId, dirty, storyDirty, assetBoardDirty, audioDirty, timelineDirty, skills, selectedSkillId, onSkillChange, onClose, onNavigate, onApplied, onNotice }: AssistantWorkspaceProps) {
  const [contracts, setContracts] = useState<AssistantContractBundle | null>(null);
  const [conversations, setConversations] = useState<AssistantConversation[]>([]);
  const [conversationId, setConversationId] = useState('');
  const [conversationQuery, setConversationQuery] = useState('');
  const [editingConversationId, setEditingConversationId] = useState('');
  const [editingTitle, setEditingTitle] = useState('');
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [message, setMessage] = useState('');
  const [composerAttachments, setComposerAttachments] = useState<AssistantAttachment[]>([]);
  const [uploadQueue, setUploadQueue] = useState<AssistantUploadItem[]>([]);
  const [run, setRun] = useState<AssistantRun | null>(null);
  const [events, setEvents] = useState<AssistantRunEvent[]>([]);
  const [selectedOperationIds, setSelectedOperationIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [contextOpen, setContextOpen] = useState(true);
  const [optimisticMessage, setOptimisticMessage] = useState<AssistantMessage | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const projectKey = project?.document.id || '';
  // Voice preparation is an embedded AudioStudioView surface, not a
  // selectable mode in the general Agent workspace.  Keep the manifest
  // available to the backend and contract view, but hide the internal skill
  // from this global picker so the two conversations cannot be mixed.
  const availableSkills = (skills.length ? skills : []).filter((item) => item.skill_id !== 'voice-preparation-assistant');
  const selectedSkill = availableSkills.find((item) => item.skill_id === selectedSkillId) || availableSkills[0];

  const operations = useMemo(() => (run?.result?.patch?.workspace_operations || []) as AssistantWorkspaceOperation[], [run?.result?.patch?.workspace_operations]);
  const latestSequence = events.at(-1)?.sequence || 0;
  const currentConversation = conversations.find((item) => item.id === conversationId);
  const visibleConversations = useMemo(() => {
    const query = conversationQuery.trim().toLowerCase();
    if (!query) return conversations;
    return conversations.filter((item) => `${item.title} ${item.last_message || ''}`.toLowerCase().includes(query));
  }, [conversationQuery, conversations]);
  const orchestratorBinding = settings?.bindings.find((item) => item.capability === 'orchestrator');
  const visionBinding = settings?.bindings.find((item) => item.capability === 'vision');
  const orchestratorProvider = settings?.providers.find((item) => item.id === (run?.provider_profile_id || orchestratorBinding?.provider_profile_id));
  const visionProvider = visionBinding ? settings?.providers.find((item) => item.id === visionBinding.provider_profile_id) : settings?.providers.find((item) => item.enabled && item.capabilities.includes('vision'));
  const providerStatus = (provider: typeof orchestratorProvider, binding: typeof orchestratorBinding) => {
    if (!provider && !binding) return '未绑定';
    const name = provider?.display_name || binding?.provider?.name || binding?.provider_profile_id || '当前 Provider';
    if (provider?.healthy === false) return `${name} · 未就绪`;
    return `${name} · ${binding?.model || '能力已绑定'}`;
  };
  const planStale = Boolean(run && contracts && (run.status === 'stale_contract' || run.error?.kind === 'contract_stale' || run.contract_hash !== contracts.bundle_hash));

  const refreshConversationMessages = useCallback(async (id: string) => {
    if (!id) {
      setMessages([]);
      return;
    }
    try {
      const [result, runResult] = await Promise.all([studioApi.assistantMessages(id), projectKey ? studioApi.assistantRuns(projectKey, id) : Promise.resolve({ project_id: '', runs: [] })]);
      setMessages(result.messages);
      setOptimisticMessage(null);
      const latestRun = runResult.runs[0];
      if (latestRun) {
        const [detailed, eventResult] = await Promise.all([
          studioApi.assistantRun(latestRun.id),
          studioApi.assistantRunEvents(latestRun.id),
        ]);
        setRun(detailed);
        setEvents(mergeAssistantRunEvents([], eventResult.events || detailed.events || []));
      } else {
        setRun(null);
        setEvents([]);
      }
    } catch (error) {
      onNotice((error as Error).message);
    }
  }, [onNotice, projectKey]);

  useEffect(() => {
    if (!open || !projectKey) return;
    let cancelled = false;
    setBusy(true);
    Promise.all([studioApi.assistantConversations(projectKey), studioApi.contracts()])
      .then(([conversationResult, contractResult]) => {
        if (cancelled) return;
        setConversations(conversationResult.conversations);
        setContracts(contractResult);
        setConversationId(conversationResult.conversations[0]?.id || '');
        setConversationQuery('');
        setEditingConversationId('');
        setEditingTitle('');
        setRun(null);
        setEvents([]);
        setComposerAttachments([]);
        setUploadQueue([]);
        setOptimisticMessage(null);
      })
      .catch((error: Error) => { if (!cancelled) onNotice(error.message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [open, projectKey, onNotice]);

  useEffect(() => {
    if (!open || !conversationId) {
      setMessages([]);
      return;
    }
    void refreshConversationMessages(conversationId);
  }, [conversationId, open, refreshConversationMessages]);

  useEffect(() => {
    if (!open) {
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
      return;
    }
    return () => streamAbortRef.current?.abort();
  }, [open]);

  useEffect(() => {
    if (!run || !operations.length) {
      setSelectedOperationIds(new Set());
      return;
    }
    setSelectedOperationIds(selectableAssistantOperationIds(operations));
  }, [run?.id, operations.length]);

  const setLocalNotice = (value: string) => {
    setNotice(value);
    onNotice(value);
  };

  const createConversationIfNeeded = async (title: string): Promise<string> => {
    if (!project) return '';
    if (conversationId) return conversationId;
    const result = await studioApi.createAssistantConversation(project.document.id, title.slice(0, 80));
    setConversations((current) => [result.conversation, ...current]);
    setConversationId(result.conversation.id);
    return result.conversation.id;
  };

  const uploadFiles = async (files: File[]) => {
    if (!project || !files.length || currentConversation?.status === 'archived') return;
    const unique = files.filter((file, index, all) => all.findIndex((item) => uploadFileKey(item) === uploadFileKey(file)) === index);
    const queueItems = unique.map((file) => ({ key: uploadFileKey(file), name: file.name, file, progress: 0, status: 'uploading' as const }));
    setUploadQueue((current) => [...current.filter((item) => !queueItems.some((next) => next.key === item.key)), ...queueItems]);
    setBusy(true);
    try {
      const results = await Promise.allSettled(unique.map((file) => studioApi.uploadAssistantAttachment(project.document.id, file, conversationId || undefined, (progress) => {
        const key = uploadFileKey(file);
        setUploadQueue((current) => current.map((item) => item.key === key ? { ...item, progress } : item));
      })));
      const uploaded = results.filter((result): result is PromiseFulfilledResult<{ attachment: AssistantAttachment }> => result.status === 'fulfilled').map((result) => result.value);
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const key = uploadFileKey(unique[index]);
          setUploadQueue((current) => current.map((item) => item.key === key ? { ...item, progress: 100, status: 'saved', error: undefined } : item));
        } else {
          const key = uploadFileKey(unique[index]);
          setUploadQueue((current) => current.map((item) => item.key === key ? { ...item, status: 'failed', error: result.reason instanceof Error ? result.reason.message : '上传失败' } : item));
        }
      });
      setComposerAttachments((current) => {
        const ids = new Set(current.map((item) => item.id));
        return [...current, ...uploaded.map((item) => item.attachment).filter((item) => !ids.has(item.id))];
      });
      const failed = results.filter((result) => result.status === 'rejected').length;
      setLocalNotice(failed ? `${uploaded.length} 个附件已保存，${failed} 个上传失败，可在队列中重试。` : uploaded.length + ' 个附件已保存到项目资料，点击发送后才会按当前 Provider 判断外发。');
    } finally {
      setBusy(false);
    }
  };

  const retryUpload = (item: AssistantUploadItem) => {
    if (busy || item.status !== 'failed') return;
    void uploadFiles([item.file]);
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const fileList = [...event.clipboardData.files];
    const itemFiles = [...event.clipboardData.items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const files = [...fileList, ...itemFiles].filter((file, index, all) => file.type.startsWith('image/') && all.findIndex((candidate) => candidate.name + ':' + candidate.size + ':' + candidate.lastModified === file.name + ':' + file.size + ':' + file.lastModified) === index);
    if (files.length) {
      event.preventDefault();
      void uploadFiles(files);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    void uploadFiles([...event.dataTransfer.files]);
  };

  const applyIncomingEvent = (incoming: AssistantStreamEvent) => {
    if (!incoming.run_id || incoming.event_name === 'snapshot_complete' || incoming.event_type === 'snapshot_complete') return;
    setEvents((current) => mergeAssistantRunEvents(current, [incoming]));
  };

  const send = async () => {
    const value = message.trim();
    if ((!value && !composerAttachments.length) || busy || !project) return;
    setBusy(true);
    setNotice('');
    const id = await createConversationIfNeeded(value || '附件分析会话');
    const localMessage: AssistantMessage = { id: 'local-' + Date.now(), role: 'user', content: value || '请分析我上传的资料，并按 FRAMEFLOW 规范生成可审阅的工作台候选。', attachments: composerAttachments, created_at: new Date().toISOString(), metadata: {} };
    setOptimisticMessage(localMessage);
    setMessage('');
    const attachments = composerAttachments;
    setComposerAttachments([]);
    setEvents([]);
    setRun(null);
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    try {
      const streamResult = await studioApi.streamAssistantRun(project.document.id, {
        conversation_id: id || undefined,
        message: localMessage.content,
        attachment_ids: attachments.map((item) => item.id),
        selected_node_ids: selectedNodeIds,
        skill_id: selectedSkill?.skill_id || selectedSkillId || undefined,
        context: {
          active_view: mode,
          selected_node_ids: selectedNodeIds,
          selected_edge_ids: selectedEdgeIds,
          revisions: { project: project.revision, graph: graph?.revision || null, story: story?.revision || null, asset_board: assetBoardDirty ? 'dirty' : null, timeline: timeline?.revision || null, audio: audioStudio?.revision || null },
          pending_changes: { graph: dirty, story: storyDirty, asset_board: assetBoardDirty, audio: audioDirty, timeline: timelineDirty },
        },
        cost_boundary: { currency: 'USD', confirmation_required: true },
        client_message_id: randomClientMessageId(),
      }, applyIncomingEvent, controller.signal);
      const runId = streamResult.run_id;
      if (runId) {
        const nextRun = await studioApi.assistantRun(runId);
        setRun(nextRun);
        setEvents((current) => mergeAssistantRunEvents(current, nextRun.events || []));
        if (nextRun.status === 'awaiting_external_confirmation') setLocalNotice('附件已准备，等待你确认本次向 Provider 外发的范围。');
        else if (nextRun.status === 'succeeded') setLocalNotice('Agent 已生成自然语言回复和结构化计划，请在右侧逐项审阅。');
      }
      if (id) {
        const refreshed = await studioApi.assistantMessages(id);
        setMessages(refreshed.messages);
        setOptimisticMessage(null);
      }
      const refreshedConversations = await studioApi.assistantConversations(project.document.id);
      setConversations(refreshedConversations.conversations);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setLocalNotice((error as Error).message);
      setOptimisticMessage(localMessage);
    } finally {
      setBusy(false);
      streamAbortRef.current = null;
    }
  };

  const pollRunAfterConfirmation = async (runId: string) => {
    let sequence = events.at(-1)?.sequence || 0;
    for (let index = 0; index < 120; index += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      const nextEvents = await studioApi.assistantRunEvents(runId, sequence);
      if (nextEvents.events.length) {
        sequence = Math.max(sequence, ...nextEvents.events.map((event) => event.sequence));
        setEvents((existing) => mergeAssistantRunEvents(existing, nextEvents.events));
      }
      const current = await studioApi.assistantRun(runId);
      setRun(current);
      if (['succeeded', 'failed', 'canceled', 'stale_contract'].includes(current.status)) return;
    }
  };

  const cancelRun = async () => {
    if (!run || ['succeeded', 'failed', 'canceled', 'stale_contract'].includes(run.status)) return;
    setBusy(true);
    try {
      const next = await studioApi.cancelAssistantRun(run.id);
      streamAbortRef.current?.abort();
      setRun(next);
      const replay = await studioApi.assistantRunEvents(run.id, events.at(-1)?.sequence || 0);
      setEvents((existing) => mergeAssistantRunEvents(existing, replay.events));
      setLocalNotice('Agent 运行已中止；用户消息、附件和运行事件仍已保存。');
    } catch (error) {
      setLocalNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirmExternal = async (decision: 'approve' | 'reject') => {
    if (!run || busy) return;
    setBusy(true);
    try {
      const next = await studioApi.confirmAssistantExternal(run.id, decision, run.awaiting_confirmation?.provider_profile_id);
      setRun(next);
      if (decision === 'approve' && next.status === 'preparing') {
        setLocalNotice('外发已确认，正在继续同一个 Agent run…');
        await pollRunAfterConfirmation(run.id);
        setLocalNotice('Agent run 已恢复，右侧显示可审阅计划。');
      } else {
        setLocalNotice('已拒绝外发；附件仍保存在本地项目资料中。');
      }
    } catch (error) {
      setLocalNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const applySelected = async () => {
    if (!run || !project || !contracts || planStale || !run.result?.plan_id || !selectedOperationIds.size || busy) return;
    setBusy(true);
    try {
      const result = await studioApi.applyAssistantRun(run.id, {
        plan_id: run.result.plan_id,
        selected_operation_ids: [...selectedOperationIds],
        expected_project_revision: project.revision,
        expected_graph_revision: graph?.revision || run.base_graph_revision,
        expected_timeline_revision: timeline?.revision || run.base_timeline_revision,
        expected_contract_bundle_hash: contracts.bundle_hash,
      });
      setRun(result.run);
      setLocalNotice('已应用 ' + result.applied_operation_ids.length + ' 项工作台修改；未勾选内容仍保留为候选。');
      onApplied();
      await refreshConversationMessages(run.conversation_id);
    } catch (error) {
      setLocalNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rejectPlan = async () => {
    if (!run || busy) return;
    setBusy(true);
    try {
      const next = await studioApi.rejectAssistantRun(run.id, { rejected_from: 'assistant-workspace' });
      setRun(next);
      setLocalNotice('计划已拒绝，工作台内容没有改变。');
    } catch (error) {
      setLocalNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const newConversation = async () => {
    if (!project || busy) return;
    try {
      const result = await studioApi.createAssistantConversation(project.document.id);
      setConversations((current) => [result.conversation, ...current]);
      setConversationId(result.conversation.id);
      setRun(null);
      setEvents([]);
      setOptimisticMessage(null);
      setLocalNotice('已创建新的项目级会话。');
    } catch (error) {
      setLocalNotice((error as Error).message);
    }
  };

  const selectConversation = (conversation: AssistantConversation) => {
    setConversationId(conversation.id);
    setRun(null);
    setEvents([]);
    setOptimisticMessage(null);
    setNotice('');
  };

  const beginConversationRename = (conversation: AssistantConversation) => {
    setEditingConversationId(conversation.id);
    setEditingTitle(conversation.title || '');
  };

  const cancelConversationRename = () => {
    setEditingConversationId('');
    setEditingTitle('');
  };

  const saveConversationRename = async (conversation: AssistantConversation) => {
    const title = editingTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const result = await studioApi.updateAssistantConversation(conversation.id, title);
      setConversations((current) => current.map((item) => item.id === result.conversation.id ? result.conversation : item));
      cancelConversationRename();
      setLocalNotice('会话标题已更新。');
    } catch (error) {
      setLocalNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleConversationArchive = async (conversation: AssistantConversation) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = conversation.status === 'archived'
        ? await studioApi.restoreAssistantConversation(conversation.id)
        : await studioApi.archiveAssistantConversation(conversation.id);
      setConversations((current) => current.map((item) => item.id === result.conversation.id ? result.conversation : item));
      setLocalNotice(result.message);
    } catch (error) {
      setLocalNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const resetExternalConsent = async () => {
    if (!currentConversation || busy) return;
    setBusy(true);
    try {
      const result = await studioApi.resetAssistantExternalConsent(currentConversation.id);
      setConversations((current) => current.map((item) => item.id === result.conversation.id ? result.conversation : item));
      setLocalNotice(result.message);
    } catch (error) {
      setLocalNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const retryLastMessage = () => {
    const lastUserMessage = [...messages].reverse().find((item) => item.role === 'user');
    if (!lastUserMessage) return;
    setMessage(lastUserMessage.content);
    setLocalNotice('已带回上一条消息；可以编辑后重新发送，新运行会使用最新规范。');
  };

  if (!open) return null;

  const displayMessages = optimisticMessage ? [...messages, ...(messages.some((item) => item.content === optimisticMessage.content) ? [] : [optimisticMessage])] : messages;
  const currentSkillLabel = selectedSkill ? selectedSkill.skill_id + ' · v' + selectedSkill.skill_version : selectedSkillId || '当前 Skill';
  return <div className="assistant-workspace-backdrop" role="presentation">
    <section className="assistant-workspace" role="dialog" aria-modal="true" aria-label="FRAMEFLOW AI Agent 工作台" onDragOver={(event) => { event.preventDefault(); setDragActive(true); }} onDragLeave={() => setDragActive(false)} onDrop={handleDrop}>
      <header className="assistant-workspace-header">
        <div className="assistant-workspace-brand"><span>FRAMEFLOW AI</span><h1>创作助手 Agent 工作台</h1><p>项目级会话 · 监督式修改 · 本地优先资料</p></div>
        <div className="assistant-workspace-controls">
          <label>Skill<select value={selectedSkill?.skill_id || selectedSkillId} onChange={(event) => onSkillChange(event.target.value)} disabled={busy}>{availableSkills.map((skill) => <option key={skill.skill_id} value={skill.skill_id}>{skill.skill_id} · v{skill.skill_version}</option>)}</select></label>
          <span className="assistant-workspace-status"><i />{planStale ? '规范已更新' : run?.status === 'awaiting_external_confirmation' ? '等待外发确认' : run?.status === 'succeeded' ? '待审阅' : run?.status === 'canceled' ? '已中止' : 'SUPERVISED'}</span>
          {run && !['succeeded', 'failed', 'canceled', 'stale_contract'].includes(run.status) && <button type="button" className="assistant-abort-button" onClick={() => void cancelRun()} disabled={busy && run.status === 'awaiting_external_confirmation'}>中止运行</button>}
          <button type="button" className="assistant-workspace-close" onClick={onClose} aria-label="关闭创作助手">×</button>
        </div>
      </header>

      {dragActive && <div className="assistant-drop-overlay">松开以上传到当前项目资料</div>}
      <div className="assistant-workspace-grid">
        <aside className="assistant-conversation-column">
          <div className="assistant-column-heading"><div><span>PROJECT THREADS</span><h2>项目会话</h2></div><button type="button" onClick={() => void newConversation()} disabled={busy} aria-label="新建会话">＋</button></div>
          <button type="button" className="assistant-new-conversation" onClick={() => void newConversation()} disabled={busy}>＋ 新建会话 <small>按项目隔离</small></button>
          <label className="assistant-conversation-search"><span>搜索会话</span><input type="search" value={conversationQuery} onChange={(event) => setConversationQuery(event.target.value)} placeholder="标题或最近消息" aria-label="搜索会话" /></label>
          <nav className="assistant-conversation-list" aria-label="项目会话列表">
            {visibleConversations.map((conversation) => <div className={'assistant-conversation-row ' + (conversation.id === conversationId ? 'active' : '')} key={conversation.id}>
              {editingConversationId === conversation.id ? <form className="assistant-conversation-edit" onSubmit={(event) => { event.preventDefault(); void saveConversationRename(conversation); }}>
                <input value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} maxLength={200} autoFocus aria-label={'会话标题 ' + (conversation.title || '未命名会话')} />
                <button type="submit" disabled={busy || !editingTitle.trim()} aria-label="保存会话标题">保存</button>
                <button type="button" onClick={cancelConversationRename} disabled={busy} aria-label="取消重命名">取消</button>
              </form> : <button type="button" className="assistant-conversation-entry" onClick={() => selectConversation(conversation)}>
                <span className="assistant-thread-dot" /><div><strong>{conversation.title || '未命名会话'}</strong><small title={conversation.last_message || ''}>{conversation.status === 'archived' ? '已归档 · ' : ''}{conversation.last_message ? conversation.last_message.replace(/\s+/g, ' ').slice(0, 42) + (conversation.last_message.length > 42 ? '…' : '') : '暂无消息'} · {conversation.message_count} 条</small></div>{conversation.pending_plan_count > 0 && <b>{conversation.pending_plan_count}</b>}
              </button>}
              {editingConversationId !== conversation.id && <button type="button" className="assistant-conversation-rename" onClick={() => beginConversationRename(conversation)} disabled={busy} aria-label={'重命名 ' + (conversation.title || '未命名会话')}>改名</button>}
              <button type="button" className="assistant-conversation-archive" onClick={() => void toggleConversationArchive(conversation)} disabled={busy || editingConversationId === conversation.id} aria-label={(conversation.status === 'archived' ? '恢复 ' : '归档 ') + (conversation.title || '未命名会话')}>{conversation.status === 'archived' ? '恢复' : '归档'}</button>
            </div>)}
            {!conversations.length && <p className="assistant-empty-state">还没有项目会话。<br />从下方输入框开始。</p>}
            {conversations.length > 0 && !visibleConversations.length && <p className="assistant-empty-state">没有匹配的项目会话。</p>}
          </nav>
          <div className="assistant-storage-note"><span>LOCAL PROJECT MATERIALS</span><strong>附件保存在当前项目资源目录</strong><small>发送时才会按 Provider 能力决定是否外发</small></div>
        </aside>

        <main className="assistant-chat-column">
          <div className="assistant-chat-heading"><div><span>{project?.document.name || '尚未选择项目'} · {modeLabels[mode] || mode}</span><h2>{currentConversation?.title || '新项目级会话'}</h2></div><div><span className="assistant-chip">项目 v{project?.revision || 0}</span><span className="assistant-chip">{currentSkillLabel}</span></div></div>
          <div className="assistant-chat-scroll" aria-live="polite">
            {displayMessages.map((item) => <article className={'assistant-message-row ' + item.role} key={item.id}>
              <div className="assistant-message-avatar">{item.role === 'user' ? '你' : item.role === 'assistant' ? 'F' : '!'}</div>
              <div className="assistant-message-content"><div className="assistant-message-meta"><strong>{item.role === 'user' ? '你' : item.role === 'assistant' ? 'FRAMEFLOW AI' : '系统'}</strong><small>{formatDate(item.created_at)}</small></div><p>{item.content}</p>{item.attachments?.length > 0 && <div className="assistant-message-attachments">{item.attachments.map((attachment) => <AttachmentCard key={attachment.id} attachment={attachment} />)}</div>}</div>
            </article>)}
            {!displayMessages.length && <div className="assistant-chat-welcome"><span>✦</span><h3>把想法和资料交给工作台</h3><p>我会读取当前项目、工作区版本和实时 FRAMEFLOW 规范，返回自然回复与可逐项审阅的候选修改。</p><div><button type="button" onClick={() => setMessage('检查当前故事、资产、声音和时间线之间的连续性，生成可审阅的修复候选。')}>检查全流程</button><button type="button" onClick={() => setMessage('根据当前 Skill 完善项目内容，保留现有稳定 ID 和历史版本。')}>完善当前阶段</button></div></div>}
            {events.length > 0 && <section className="assistant-event-timeline"><div className="assistant-section-heading"><span>AGENT RUN EVENTS</span><small>sequence {latestSequence}</small></div>{events.map((event) => <article key={event.run_id + ':' + event.sequence} className={'assistant-event-item ' + event.status}><i /><div><strong>{eventLabels[event.item_id || ''] || eventLabels[event.event_type] || event.event_type || '运行事件'}</strong><small>{event.item_id || '#' + event.sequence} · {formatDate(event.created_at)}</small>{eventDetail(event) && <p>{eventDetail(event)}</p>}</div></article>)}</section>}
            {run?.error && <div className="assistant-run-error" role="alert"><strong>本次运行失败</strong><p>{String(run.error.message || 'Provider 或本地解析失败')}</p><small>原始附件和用户消息已保留，可以修正后重试。</small><div className="assistant-run-error-actions"><button type="button" onClick={retryLastMessage} disabled={busy || !messages.some((item) => item.role === 'user')}>重新生成</button></div></div>}
            {run?.awaiting_confirmation && <section className="assistant-external-confirmation"><div><span>EXTERNAL SEND GATE</span><h3>确认附件外发</h3><p>以下内容准备发送给 {run.awaiting_confirmation.provider_name} · {run.awaiting_confirmation.model}。这只授权本次资料分析，不授权媒体生成、资产替换或发布。</p></div><ul>{run.awaiting_confirmation.attachments.map((attachment) => <li key={attachment.id}><strong>{attachment.name}</strong><span>{formatBytes(attachment.byte_size)} · {attachment.delivery_mode === 'multimodal' ? '图片 vision' : '文档抽取文本'}</span></li>)}</ul><div className="assistant-confirm-actions"><button type="button" onClick={() => void confirmExternal('reject')} disabled={busy}>拒绝并保留本地</button><button type="button" className="primary" onClick={() => void confirmExternal('approve')} disabled={busy}>确认外发并继续</button></div></section>}
            {run?.result?.reply && <section className="assistant-reply-card"><div className="assistant-section-heading"><span>ASSISTANT RESPONSE</span><div><small>{run.provider_model || 'Provider'} · {run.status}</small><button type="button" onClick={retryLastMessage} disabled={busy}>重新生成</button></div></div><p>{run.result.reply}</p></section>}
            {run?.result?.plan_id && !run.result.apply && operations.length > 0 && <section className={'assistant-plan-section ' + (planStale ? 'stale' : '')}><div className="assistant-plan-section-heading"><div><span>PLAN REVIEW · {operations.length} ITEMS</span><h3>选择要应用到工作台的修改</h3></div><div><button type="button" onClick={() => setSelectedOperationIds(selectableAssistantOperationIds(operations))} disabled={busy || planStale}>全选安全项</button><button type="button" onClick={() => setSelectedOperationIds(new Set())} disabled={busy}>清空</button></div></div>{planStale && <div className="assistant-plan-stale" role="alert"><strong>规范已更新，计划已冻结</strong><span>本计划基于 {run.contract_hash.slice(0, 12)}，当前规范为 {contracts?.bundle_hash.slice(0, 12)}。不能继续应用；请点击“重新生成”带回原消息并按当前规范重新运行。</span><button type="button" onClick={retryLastMessage} disabled={busy}>重新生成</button></div>}<p className="assistant-plan-help">候选已按当前规范校验；只会应用你勾选的内容，active 资产、媒体和历史版本保持不变。</p><div className="assistant-operation-list">{operations.map((operation) => <OperationCard key={operation.id} operation={operation} checked={selectedOperationIds.has(operation.id)} onToggle={() => setSelectedOperationIds((current) => toggleAssistantOperation(current, operation))} disabled={planStale} />)}</div><div className="assistant-plan-actions"><button type="button" onClick={() => void rejectPlan()} disabled={busy}>拒绝计划</button><button type="button" className="primary" onClick={() => void applySelected()} disabled={busy || planStale || !selectedOperationIds.size}>{busy ? '处理中…' : planStale ? '规范已更新' : '应用已选 ' + selectedOperationIds.size + ' 项'}</button></div></section>}
          </div>
          <footer className="assistant-composer-v2">
            <div className="assistant-composer-toolbar"><span>{selectedSkill?.skill_id || selectedSkillId || '当前 Skill'} · Enter 发送，Shift + Enter 换行</span><button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy || !project || currentConversation?.status === 'archived'}>＋ 添加图片 / 文件</button><input ref={fileInputRef} type="file" hidden multiple accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.xlsx,.csv,.txt,.md,.markdown,.wav,.mp3,.m4a,.aac,.flac,.ogg,.mp4,.webm,.mov,.mkv,.srt,.vtt" onChange={(event) => { void uploadFiles([...(event.target.files || [])]); event.currentTarget.value = ''; }} /></div>
            {uploadQueue.length > 0 && <div className="assistant-upload-queue" aria-label="附件上传队列">{uploadQueue.map((item) => <div className={'assistant-upload-row ' + item.status} key={item.key}><span title={item.name}>{item.name}</span>{item.status === 'uploading' && <><progress max="100" value={item.progress} /><small>{item.progress}%</small></>}{item.status === 'saved' && <small>已保存</small>}{item.status === 'failed' && <><small title={item.error}>{item.error || '上传失败'}</small><button type="button" onClick={() => retryUpload(item)} disabled={busy}>重试</button></>}</div>)}</div>}
            {composerAttachments.length > 0 && <div className="assistant-composer-attachments">{composerAttachments.map((attachment) => <AttachmentCard key={attachment.id} attachment={attachment} removable onRemove={() => setComposerAttachments((current) => current.filter((item) => item.id !== attachment.id))} />)}</div>}
            <div className="assistant-composer-box-v2"><textarea value={message} onChange={(event) => setMessage(event.target.value)} onPaste={handlePaste} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={currentConversation?.status === 'archived' ? '会话已归档，请先在左侧恢复' : project ? '描述你希望工作台如何变化，或先添加图片 / 文档…' : '先选择一个项目'} disabled={busy || !project || currentConversation?.status === 'archived'} rows={3} aria-label="向 FRAMEFLOW Agent 提问" /><button type="button" className="assistant-send-button" onClick={() => void send()} disabled={busy || !project || currentConversation?.status === 'archived' || (!message.trim() && !composerAttachments.length)} aria-label="发送消息">↑</button></div>
            {notice && <div className="assistant-composer-notice" role="status">{notice}</div>}
          </footer>
        </main>

        <aside className={'assistant-context-column ' + (contextOpen ? 'open' : 'collapsed')}>
          <div className="assistant-column-heading"><div><span>FRAMEFLOW CONTEXT</span><h2>工作区上下文</h2></div><button type="button" onClick={() => setContextOpen((current) => !current)}>{contextOpen ? '收起' : '展开'}</button></div>
          {contextOpen && <>
            <section className="assistant-context-section assistant-project-context"><span>当前项目</span><strong>{project?.document.name || '尚未选择项目'}</strong><small>{modeLabels[mode] || mode} · 本地桌面工作台</small></section>
            <section className="assistant-context-section"><div className="assistant-context-section-head"><span>规范版本</span><b>{contracts ? contracts.bundle_hash.slice(0, 12) : '加载中'}</b></div>{contracts ? <dl><div><dt>Bundle</dt><dd>v{contracts.bundle_version}</dd></div><div><dt>Prompt</dt><dd>v{contracts.prompt_contract?.version || '—'}</dd></div><div><dt>Story</dt><dd>v{contracts.story_contract?.version || '—'}</dd></div><div><dt>Audio</dt><dd>{contracts.audio_contract?.version || '—'}</dd></div></dl> : <p className="muted">正在读取实时规范…</p>}<small className="assistant-context-note">每次运行重新读取；历史候选保留生成时的 contract snapshot。</small></section>
            <section className="assistant-context-section"><div className="assistant-context-section-head"><span>Provider 能力</span><b>{run?.provider_model || '当前绑定'}</b></div><dl><div><dt>orchestrator</dt><dd>{providerStatus(orchestratorProvider, orchestratorBinding)}</dd></div><div><dt>vision</dt><dd>{providerStatus(visionProvider, visionBinding)}</dd></div></dl><small className="assistant-context-note">图片只有在当前 Provider 支持 vision 且完成外发确认后才会发送。</small></section>
            <section className="assistant-context-section"><div className="assistant-context-section-head"><span>工作区修订</span><b>LIVE</b></div><dl><div><dt>项目</dt><dd>v{project?.revision || 0}{dirty ? ' · 未保存' : ''}</dd></div><div><dt>流程图</dt><dd>v{graph?.revision || 0}</dd></div><div><dt>故事</dt><dd>v{story?.revision || 0}{storyDirty ? ' · 未保存' : ''}</dd></div><div><dt>资产库</dt><dd>{assetLibrary?.summary.total || 0}</dd></div><div><dt>资产画布</dt><dd>v{assetBoard?.revision || 0}{assetBoardDirty ? ' · 未保存' : ''}</dd></div><div><dt>声音</dt><dd>v{audioStudio?.revision || 0}{audioDirty ? ' · 未保存' : ''}</dd></div><div><dt>时间线</dt><dd>v{timeline?.revision || 0}{timelineDirty ? ' · 未保存' : ''}</dd></div></dl></section>
            <section className="assistant-context-section"><div className="assistant-context-section-head"><span>当前选择</span><b>{selectedNodeIds.length || selectedEdgeIds.length || selectedAssetId || selectedShotId ? '已选择' : '全项目'}</b></div><p>{selectedAssetId ? '资产：' + selectedAssetId : '未选择特定资产'}</p><p>{selectedShotId ? '镜头：' + selectedShotId : '未选择特定镜头'}</p><p>{selectedNodeIds.length ? '工作流节点：' + selectedNodeIds.join('、') : '未选择特定工作流节点'}</p><p>{selectedEdgeIds.length ? '工作流连接：' + selectedEdgeIds.join('、') : '未选择工作流连接'}</p></section>
            <section className="assistant-context-section"><div className="assistant-context-section-head"><span>附件策略</span><b>{composerAttachments.length} 个待发送</b></div><p>图片：支持 vision 时使用结构化图片输入。</p><p>文档：先在本机抽取，再在首次外发确认后交给 orchestrator。</p><p>音视频 / 字幕：第一版仅保存为项目资料引用。</p></section>
            {currentConversation?.external_consent?.length ? <section className="assistant-context-section"><div className="assistant-context-section-head"><span>外发授权</span><b>已记住 {currentConversation.external_consent.length} 个 Provider</b></div><p>当前会话的同一 Provider 后续附件可复用确认。</p><button type="button" className="assistant-reconfirm-button" onClick={() => void resetExternalConsent()} disabled={busy}>重新确认外发范围</button></section> : null}
            <section className="assistant-context-section assistant-boundary-card"><span>SUPERVISED BOUNDARY</span><ul><li>只生成候选，不自动覆盖 active 资产</li><li>只应用已勾选操作</li><li>不执行图片、音频、视频或发布</li><li>Provider 失败不删除本地资料</li></ul></section>
          </>}
          <button type="button" className="assistant-return-workspace" onClick={() => { onNavigate(mode); onClose(); }}>返回当前工作区 <span>↗</span></button>
        </aside>
      </div>
    </section>
  </div>;
}
