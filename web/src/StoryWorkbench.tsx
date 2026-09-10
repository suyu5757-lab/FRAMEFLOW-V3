import { useState } from 'react';
import type { StoryDocument, StoryEnvelope, StoryRun, StoryShot, StorySpec } from './types';
import { parseStoryboardImport } from './storyboard-import';

type AssetPromptRunState = {
  status: 'idle' | 'preparing' | 'running' | 'success' | 'error';
  message: string;
  startedAt: number | null;
};

type AcceptScope = 'all' | 'script_only' | 'shots_only';

type StoryWorkbenchProps = {
  story: StoryEnvelope | null;
  storyRun: StoryRun | null;
  dirty: boolean;
  busy: boolean;
  notice: string;
  assetPromptRun: AssetPromptRunState;
  onChange: (story: StoryDocument) => void;
  onSave: () => void;
  onGenerateOptimized: () => void;
  onGenerateStoryboard: () => void;
  onRegenerate: (feedback: string, runId: string, mode: 'optimize' | 'direct') => void;
  onAccept: (scope?: AcceptScope, shotIds?: string[]) => void;
  onRollback: (versionId: string, scope: 'script' | 'shots') => void;
  onOpenAssetBoard: () => void;
  onGenerateAssetPrompts: () => void;
};

const displayValue = (item: unknown): string => {
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    return String(record.label || record.text || JSON.stringify(record));
  }
  return String(item ?? '');
};

const asText = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join('、');
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value ?? '');
};

const asLines = (value: unknown): string => {
  if (!Array.isArray(value)) return asText(value);
  return value.map(displayValue).filter(Boolean).join('\n');
};

const candidateOutputValue = (value: unknown): string => {
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value ?? '');
};

const candidateOutputLabel = (key: string): string => ({
  id: '镜头 ID',
  scene: '场景 ID',
  duration: '镜头时长',
  aspectRatio: '画幅',
  purpose: '镜头目的',
  size: '景别',
  camera: '机位 / 运镜',
  visibleEvent: '主可见事件',
  eventConsequence: '事件后果',
  subjectFocus: '主体焦点',
  action: '动作',
  performance: '表情 / 表演',
  characterDetailAnchors: '角色细节锚点',
  sceneDetailAnchors: '场景细节锚点',
  propsAndState: '道具与状态',
  spatialGeography: '空间地理',
  materialEvidence: '材质证据',
  lightingCausality: '光线因果',
  dialogue: '对白',
  narration: '旁白',
  sound: '声音设计',
  environment: '环境 / 空间状态',
  atmosphereBehavior: '空气与氛围',
  transitionFromPreviousShot: '与前镜头转场',
  editingRhythm: '剪辑节奏',
  generationMethod: '生成方式',
  difficulty: '生成难度',
  risks: '风险',
  optimizationAdvice: '优化建议',
  referenceRoles: '参考图职责',
  assetRequirements: '资产需求',
  continuity: '连续性合同',
  seedancePlan: 'Seedance Plan',
} as Record<string, string>)[key] || key;

const linesToValues = (value: string): string[] => value.split('\n').map((item) => item.trim()).filter(Boolean);

const makeBudget = (duration: number, spec: StorySpec) => {
  const automaticMin = Math.max(3, Math.ceil(duration / 10));
  const automaticMax = Math.max(3, Math.ceil(duration / 7.5));
  const min = Number(spec.shot_count_min || automaticMin);
  const max = Number(spec.shot_count_max || automaticMax);
  const target = Number(spec.shot_count_target || Math.round((min + max) / 2));
  return { automaticMin, automaticMax, min, target: Math.min(max, Math.max(min, target)), max, mode: max > automaticMax ? 'high_tempo' : (spec.shot_budget_mode || 'controlled') };
};

const nextId = (prefix: string, values: string[], fallback = 1): string => {
  const numbers = values.map((value) => Number(value.match(new RegExp(`^${prefix}(\\d+)$`, 'i'))?.[1] || 0));
  return `${prefix}${String(Math.max(fallback - 1, ...numbers) + 1).padStart(3, '0')}`;
};

const defaultSeedancePlan = (duration: number, generator: string) => ({
  model: generator || 'seedance2.5',
  generationMode: 'reference_to_video',
  targetDuration: duration,
  aspectRatio: '16:9',
  clipUnit: 'one_shot_one_reviewable_clip',
  promptTimeline: [],
  startState: '',
  playableChange: '',
  endState: '',
  continuityStrategy: '',
  referenceAssignments: [],
  audioStrategy: '',
  mustPreserve: [],
  mustAvoid: [],
  riskFlags: [],
  fallbackRoute: '拆分为单一事件镜头并减少参考输入',
});

const defaultContinuity = () => ({ screenDirection: '', eyeline: '', motionVector: '', cutIn: '', cutOut: '', matchAction: '', editBridge: '', preRoll: '', postRoll: '', firstFrame: '', lastFrame: '' });

const SCENE_LEDGER_FIELDS = ['id', 'name', 'description', 'interiorExterior', 'timeOfDay', 'location', 'characterIds', 'propIds', 'narrativeFunction', 'emotion', 'visualAnchors', 'spatialGeography', 'materialEvidence', 'lightingCausality', 'soundscape', 'productionDifficulty', 'relevantShots'];
const SCENE_LEDGER_LIST_FIELDS = new Set(['characterIds', 'propIds', 'visualAnchors', 'relevantShots']);

const sceneLedgerComplete = (scene: Record<string, unknown>): boolean => SCENE_LEDGER_FIELDS.every((key) => {
  if (!(key in scene) || scene[key] === null || scene[key] === undefined) return false;
  if (SCENE_LEDGER_LIST_FIELDS.has(key)) return Array.isArray(scene[key]);
  return String(scene[key]).trim().length > 0;
});

function Field({ label, value, onChange, multiline = false, placeholder = '', help = '' }: { label: string; value: unknown; onChange: (value: string) => void; multiline?: boolean; placeholder?: string; help?: string }) {
  return <label className="story-v2-field"><span>{label}</span>{multiline ? <textarea value={asText(value)} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /> : <input value={asText(value)} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />}{help && <small>{help}</small>}</label>;
}

export function StoryWorkbench({ story, storyRun, dirty, busy, notice, assetPromptRun, onChange, onSave, onGenerateOptimized, onGenerateStoryboard, onRegenerate, onAccept, onRollback, onOpenAssetBoard, onGenerateAssetPrompts }: StoryWorkbenchProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [openShots, setOpenShots] = useState<Record<string, boolean>>({});
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [revisionFeedback, setRevisionFeedback] = useState('');
  if (!story) return <section className="story-workbench-v2 story-v2-empty"><h2>故事与分镜</h2><p>请选择一个项目开始前期制作。</p></section>;

  const document = story.story;
  const spec = document.spec;
  const duration = Math.max(1, Number(spec.duration || 30));
  const budget = makeBudget(duration, spec);
  const shots = document.shots || [];
  const issues = story.checks.issues || [];
  const blockers = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity !== 'error');
  const shotDuration = shots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0);
  const budgetNearLimit = shots.length >= budget.min && shots.length >= budget.max - 1;
  const budgetState = shots.length > budget.max ? '超预算' : budgetNearLimit ? '接近上限' : '正常';
  const budgetTone = shots.length > budget.max ? 'blocked' : budgetNearLimit ? 'near' : 'clear';
  const budgetExceeded = shots.length > budget.max;
  const blockingCount = blockers.length + (budgetExceeded ? 1 : 0);
  const output = (storyRun?.storyboard_output || {}) as Record<string, unknown>;
  const runInput = (storyRun?.input || {}) as Record<string, unknown>;
  const workflowMode = String(runInput.workflow_mode || output.workflowMode || 'optimize_script_and_storyboard');
  const directMode = workflowMode === 'storyboard_from_source';
  const proposedScript = String(output.proposedScript || '');
  const proposedShots = Array.isArray(output.shots) ? output.shots.filter((item): item is StoryShot => Boolean(item && typeof item === 'object' && (item as StoryShot).id)) : [];
  const proposedScenes = Array.isArray(output.scenes) ? output.scenes.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  const proposedScenesComplete = proposedScenes.filter(sceneLedgerComplete).length;
  const runShotBudget = (runInput.shot_budget && typeof runInput.shot_budget === 'object' ? runInput.shot_budget : output.shotBudgetAssessment && typeof output.shotBudgetAssessment === 'object' ? output.shotBudgetAssessment : {}) as Record<string, unknown>;
  const candidateBudgetMin = Number(runShotBudget.shot_count_min ?? runShotBudget.minimum ?? budget.min);
  const candidateBudgetTarget = Number(runShotBudget.shot_count_target ?? runShotBudget.target ?? budget.target);
  const candidateBudgetMax = Number(runShotBudget.shot_count_max ?? runShotBudget.maximum ?? budget.max);
  const candidateDuration = Number(runInput.duration || (output.shotBudgetAssessment as Record<string, unknown> | undefined)?.duration || duration);
  const candidateDurationSource = String(runInput.duration_source || (output.shotBudgetAssessment as Record<string, unknown> | undefined)?.durationSource || 'reference');
  const candidateOverBudget = proposedShots.length > candidateBudgetMax;
  const candidateNearBudget = !candidateOverBudget && proposedShots.length >= candidateBudgetMin && proposedShots.length >= candidateBudgetMax - 1;
  const candidateBudgetStatus = candidateOverBudget ? '超预算' : candidateNearBudget ? '接近上限' : '正常';
  const durationSource = String(spec.duration_source || 'reference');
  const scriptDuration = spec.script_duration && typeof spec.script_duration === 'object' ? spec.script_duration : null;
  const storyboardReviewReady = storyRun?.status === 'storyboard_review_required';
  const regulatorReviewReady = storyRun?.status === 'regulator_review_required';
  const regulatorOutput = (storyRun?.regulator_output || {}) as Record<string, unknown>;
  const regulatorAssets = Array.isArray(regulatorOutput.assetExtraction) ? regulatorOutput.assetExtraction : [];
  const regulatorRequirements = Array.isArray(regulatorOutput.assetRequirements) ? regulatorOutput.assetRequirements : [];
  const regulatorReceipt = document.asset_handoff_receipt || (document as StoryDocument & { assetHandoffReceipt?: Record<string, unknown> }).assetHandoffReceipt;

  const updateDocument = (updater: (current: StoryDocument) => StoryDocument) => onChange(updater(document));
  const updateSpec = (key: keyof StorySpec, value: unknown) => updateDocument((current) => {
    const nextSpec = { ...current.spec, [key]: value };
    const currentBudgetSource = current.spec.shot_budget_source || 'automatic';
    if (key === 'duration' && currentBudgetSource !== 'manual' && current.spec.shot_budget_mode !== 'high_tempo') {
      const nextDuration = Math.max(1, Number(value) || 1);
      const automaticMin = Math.max(3, Math.ceil(nextDuration / 10));
      const automaticMax = Math.max(3, Math.ceil(nextDuration / 7.5));
      nextSpec.shot_count_min = automaticMin;
      nextSpec.shot_count_target = Math.round((automaticMin + automaticMax) / 2);
      nextSpec.shot_count_max = automaticMax;
      nextSpec.shot_budget_source = 'automatic';
      nextSpec.shot_budget_mode = 'controlled';
    } else if (key === 'shot_count_min' || key === 'shot_count_target' || key === 'shot_count_max') {
      nextSpec.shot_budget_source = 'manual';
      const automaticMax = Math.max(3, Math.ceil(Number(current.spec.duration || 30) / 7.5));
      nextSpec.shot_budget_mode = Number(nextSpec.shot_count_max || automaticMax) > automaticMax ? 'high_tempo' : 'controlled';
    }
    return { ...current, spec: nextSpec };
  });
  const updateScene = (sceneId: string, key: string, value: unknown) => updateDocument((current) => ({ ...current, scenes: current.scenes.map((scene) => String(scene.id) === sceneId ? { ...scene, [key]: value } : scene) }));
  const updateShot = (shotId: string, key: string, value: unknown) => updateDocument((current) => ({ ...current, shots: current.shots.map((shot) => shot.id === shotId ? { ...shot, [key]: value } : shot) }));

  const sceneIds = document.scenes.map((scene) => String(scene.id || '')).filter(Boolean);
  const addScene = () => updateDocument((current) => ({ ...current, scenes: [...current.scenes, { id: nextId('S', current.scenes.map((scene) => String(scene.id || ''))), name: '新场景', description: '', interiorExterior: '', timeOfDay: '', location: '', characterIds: [], propIds: [], narrativeFunction: '', emotion: '', visualAnchors: [], spatialGeography: '', materialEvidence: '', lightingCausality: '', soundscape: '', productionDifficulty: '', relevantShots: [] }] }));
  const removeScene = (sceneId: string) => updateDocument((current) => ({ ...current, scenes: current.scenes.filter((scene) => String(scene.id) !== sceneId) }));
  const addShot = () => updateDocument((current) => {
    const id = nextId('SH', current.shots.map((shot) => shot.id));
    const scene = String(current.scenes[0]?.id || 'S001');
    const newShot: StoryShot = { id, scene, duration: 8, purpose: '', size: '中景', camera: '固定或轻微推进', action: '', visibleEvent: '', eventConsequence: '', subjectFocus: '', performance: '', dialogue: '', narration: '', sound: '', environment: '', spatialGeography: '', materialEvidence: '', lightingCausality: '', cameraExecution: '', atmosphereBehavior: '', generationMethod: 'reference_to_video', difficulty: 'medium', risks: [], referenceRoles: [], assetRequirements: [], seedancePlan: defaultSeedancePlan(8, spec.generator_profile || ''), continuity: defaultContinuity() };
    return { ...current, shots: [...current.shots, newShot] };
  });
  const removeShot = (shotId: string) => updateDocument((current) => ({ ...current, shots: current.shots.filter((shot) => shot.id !== shotId) }));
  const duplicateShot = (shotId: string) => updateDocument((current) => {
    const source = current.shots.find((shot) => shot.id === shotId);
    if (!source) return current;
    const id = nextId('SH', current.shots.map((shot) => shot.id));
    const copy = { ...source, id, purpose: `${source.purpose || '镜头'} · 复制` };
    const index = current.shots.findIndex((shot) => shot.id === shotId);
    return { ...current, shots: [...current.shots.slice(0, index + 1), copy, ...current.shots.slice(index + 1)] };
  });
  const splitShot = (shotId: string) => updateDocument((current) => {
    const index = current.shots.findIndex((shot) => shot.id === shotId);
    const source = current.shots[index];
    if (!source) return current;
    const id = nextId('SH', current.shots.map((shot) => shot.id));
    const firstDuration = Math.max(0.5, Math.round(Number(source.duration || 2) / 2 * 10) / 10);
    const sourceContinuity = typeof source.continuity === 'object' && source.continuity ? source.continuity as Record<string, unknown> : {};
    const sourceLastFrame = String(source.lastFrame || sourceContinuity.lastFrame || '');
    const second = { ...source, id, duration: Math.max(0.5, Number(source.duration || 2) - firstDuration), purpose: `${source.purpose || '镜头'} · 后半段`, continuity: { ...sourceContinuity, firstFrame: sourceLastFrame } };
    return { ...current, shots: [...current.shots.slice(0, index), { ...source, duration: firstDuration }, second, ...current.shots.slice(index + 1)] };
  });
  const moveShot = (shotId: string, offset: number) => updateDocument((current) => {
    const index = current.shots.findIndex((shot) => shot.id === shotId);
    const next = index + offset;
    if (index < 0 || next < 0 || next >= current.shots.length) return current;
    const items = [...current.shots];
    [items[index], items[next]] = [items[next], items[index]];
    return { ...current, shots: items };
  });

  const importStoryboard = () => {
    try {
      const imported = parseStoryboardImport(importText, { generator: spec.generator_profile || 'seedance2.5', aspectRatio: spec.ratio || '16:9' });
      updateDocument((current) => ({
        ...current,
        spec: imported.duration ? { ...current.spec, duration: imported.duration, duration_source: 'storyboard_import', reference_duration: current.spec.reference_duration ?? current.spec.duration } : current.spec,
        scenes: imported.scenes,
        shots: imported.shots as StoryShot[],
        asset_handoff_receipt: null,
      }));
      setImportError('');
      setImportOpen(false);
      setImportText('');
      // Let the parent commit the new document first, then persist it through
      // the same revision-protected save path used by manual edits.
      window.setTimeout(() => { void onSave(); }, 0);
    } catch (error) {
      setImportError((error as Error).message || '无法解析这份分镜内容。');
    }
  };

  const shotGroups = (() => {
    const groups = document.scenes.map((scene) => ({ scene, shots: shots.filter((shot) => shot.scene === scene.id || shot.scene === scene.name) }));
    const groupedIds = new Set(groups.flatMap((group) => group.shots.map((shot) => shot.id)));
    const unassigned = shots.filter((shot) => !groupedIds.has(shot.id));
    if (unassigned.length) groups.push({ scene: { id: 'UNASSIGNED', name: '未归档场景', description: '这些镜头引用的场景尚未登记。' }, shots: unassigned });
    return groups;
  })();

  const sceneField = (scene: Record<string, unknown>, key: string, label: string, multiline = false) => <Field label={label} value={SCENE_LEDGER_LIST_FIELDS.has(key) ? asLines(scene[key]) : scene[key]} multiline={multiline} onChange={(value) => updateScene(String(scene.id), key, SCENE_LEDGER_LIST_FIELDS.has(key) ? linesToValues(value) : value)} />;
  const shotField = (shot: StoryShot, key: string, label: string, multiline = false) => <Field label={label} value={shot[key]} multiline={multiline} onChange={(value) => updateShot(shot.id, key, key === 'risks' || key === 'assetRequirements' || key === 'referenceRoles' ? linesToValues(value) : value)} />;

  const seedanceListFields = new Set(['mustPreserve', 'mustAvoid', 'riskFlags']);
  const seedanceJsonFields = new Set(['promptTimeline', 'referenceAssignments']);
  const seedanceValue = (key: string, value: unknown) => seedanceJsonFields.has(key) ? (value ? JSON.stringify(value, null, 2) : '') : seedanceListFields.has(key) ? asLines(value) : value;
  const updateSeedance = (shot: StoryShot, key: string, value: string) => {
    let nextValue: unknown = value;
    if (key === 'targetDuration') nextValue = Number(value) || shot.duration;
    if (seedanceListFields.has(key)) nextValue = linesToValues(value);
    if (seedanceJsonFields.has(key)) {
      try { nextValue = value.trim() ? JSON.parse(value) : []; } catch { nextValue = value; }
    }
    updateShot(shot.id, 'seedancePlan', { ...(shot.seedancePlan && typeof shot.seedancePlan === 'object' ? shot.seedancePlan : {}), [key]: nextValue });
  };
  const acceptCandidate = (scope: AcceptScope, ids = selectedCandidateIds) => onAccept(directMode && scope === 'script_only' ? 'shots_only' : scope, ids);

  return <section className="story-workbench-v2" aria-busy={busy}>
    <header className="story-v2-header">
      <div><span className="story-v2-eyebrow">DESKTOP PRE-PRODUCTION DESK</span><h2>故事与分镜</h2><p>从锁定剧本到可生成镜头，再到资产依赖与参考图交接。</p></div>
      <div className="story-v2-header-actions">
        <div className="story-v2-statuses"><span className={`story-v2-pill ${budgetTone}`}>镜头 {shots.length} · 建议 {budget.automaticMin}–{budget.automaticMax} · {budgetState}</span><span className={`story-v2-pill ${blockingCount ? 'blocked' : 'clear'}`}>{blockingCount ? `阻塞 ${blockingCount}` : '生产检查通过'}</span><span className="story-v2-pill">提醒 {warnings.length}</span>{regulatorReceipt && <span className="story-v2-pill asset">交接已回执</span>}</div>
        <button type="button" onClick={onSave} disabled={!dirty || busy}>{dirty ? '保存更改' : '已保存'}</button>
        <button type="button" className="story-v2-asset-button" onClick={onOpenAssetBoard} disabled={busy || blockingCount > 0 || !shots.length}>进入资产生产</button>
      </div>
    </header>
    {assetPromptRun.status !== 'idle' && <section className={`story-v2-runtime ${assetPromptRun.status}`} role="status"><strong>{assetPromptRun.status === 'success' ? '资产 Prompt 已更新' : assetPromptRun.status === 'error' ? '资产 Prompt 生成失败' : '资产 Prompt 处理中'}</strong><span>{assetPromptRun.message}</span></section>}
    {notice && <div className="story-v2-notice" role="status">{notice}</div>}

    <section className="story-v2-stage story-v2-source-stage">
      <div className="story-v2-stage-heading"><div><span>STAGE 01 · SOURCE</span><h3>创作来源</h3></div><small>原始想法或现有剧本是整个制作链的唯一来源。点击任一 AI 工作流后，系统会根据这段内容自动生成场景账本、导演分镜、声音与资产交接；下方字段只用于补充和修订。</small></div>
      <textarea className="story-v2-source-editor" aria-label="初始想法或现有剧本" value={document.script} onChange={(event) => updateDocument((current) => ({ ...current, script: event.target.value }))} placeholder="输入想法、剧情梗概或已有剧本……" />
      <div className="story-v2-source-actions"><button type="button" className="primary" onClick={onGenerateOptimized} disabled={busy || !document.script.trim()}>✦ AI 整合并优化为拍摄剧本</button><button type="button" className="secondary" onClick={onGenerateStoryboard} disabled={busy || !document.script.trim()}>▦ 剧本直接整合为分镜</button><span>{busy ? '正在生成候选，请稍候…' : '两条工作流都会保留版本快照；直转分镜不会改写原文。'}</span></div>
      <details className="story-v2-settings" open={settingsOpen} onToggle={(event) => setSettingsOpen(event.currentTarget.open)}><summary>制作设置 <small>{spec.generator_profile || 'Seedance 2.5'} · {durationSource === 'script_explicit' ? `剧本 ${duration}s` : `参考 ${duration}s`} · 建议 {budget.automaticMin}–{budget.automaticMax} 镜头</small></summary><div className="story-v2-settings-grid"><Field label="创意目标" value={spec.creative_goal} multiline onChange={(value) => updateSpec('creative_goal', value)} /><Field label="平台" value={spec.platform} onChange={(value) => updateSpec('platform', value)} /><Field label={durationSource === 'script_explicit' ? '剧本明确时长（秒）' : '参考时长（秒）'} value={duration} help={durationSource === 'script_explicit' ? `已从原始剧本识别：${String(scriptDuration?.raw || `${duration}秒`)}；生成时以剧本为准，页面参考时长不覆盖它。` : '仅用于没有明确剧本时长时的初始镜头数量建议，不限制最终片长；最终以已审阅镜头总时长为准。'} onChange={(value) => updateSpec('duration', Math.max(1, Number(value) || 1))} /><Field label="画幅" value={spec.ratio} onChange={(value) => updateSpec('ratio', value)} /><Field label="语言" value={spec.language} onChange={(value) => updateSpec('language', value)} /><Field label="结构 / 节拍" value={asLines(spec.beats)} multiline onChange={(value) => updateSpec('beats', linesToValues(value).map((text, index) => ({ id: `B${String(index + 1).padStart(3, '0')}`, label: text })))} /><Field label="目标生成器" value={spec.generator_profile || ''} placeholder="seedance2.0 / seedance2.5" onChange={(value) => updateSpec('generator_profile', value)} /></div><div className={`story-v2-budget-note ${budget.mode === 'high_tempo' ? 'warning' : ''}`}>{durationSource === 'script_explicit' ? `本次 AI 分镜以剧本明确时长为准（${String(scriptDuration?.raw || `${duration}秒`)}），参考时长仅保留为页面设置；最终以实际审阅的镜头总时长为准。` : budget.mode === 'high_tempo' ? '高节奏提醒：当前项目已有较高镜头上限，会增加角色一致性、场景重建、参考图、声音衔接与重试成本。' : `镜头数量由系统按参考时长给出建议（${budget.automaticMin}–${budget.automaticMax}）；最终以实际审阅的镜头数和总时长为准。`}</div></details>
    </section>

    <section className="story-v2-stage story-v2-script-stage">
      <div className="story-v2-stage-heading"><div><span>STAGE 02 · SHOOTING SCRIPT</span><h3>{directMode ? '锁定原文 · 拍摄脚本来源' : 'AI 拍摄剧本'}</h3></div><small>{directMode ? '原文直转分镜模式：候选永远不能替换左侧原稿。' : proposedScript ? '候选独立于原稿，只有明确接受后才会写入项目。' : '生成优化候选后，这里会出现可审阅的拍摄剧本。'}</small></div>
      <textarea className={`story-v2-script-editor ${directMode ? 'locked' : ''}`} aria-label="AI 优化后的拍摄剧本" value={directMode ? document.script : proposedScript} readOnly placeholder="AI 优化后的拍摄剧本将显示在这里……" />
      {directMode && <div className="story-v2-locked-note">🔒 原文已锁定：接受候选时仅写入场景和镜头，服务端也会再次阻止源剧本覆盖。</div>}
    </section>

    <section className="story-v2-stage story-v2-board-stage">
      <div className="story-v2-board-heading"><div><span>STAGE 03 · SCENE LEDGER + DIRECTOR SHOTS</span><h3>场景与导演分镜</h3><p>每个场景下面直接管理空间、资产、镜头执行、声音和连续性。</p></div><div className="story-v2-board-actions"><span className={`story-v2-budget-chip ${budgetTone}`}>当前 {shots.length} 镜头 · 建议 {budget.automaticMin}–{budget.automaticMax} · {shotDuration.toFixed(1)}s</span><button type="button" className="secondary" onClick={() => { setImportError(''); setImportOpen(true); }} disabled={busy}>＋ 直接导入</button><button type="button" onClick={addScene} disabled={busy}>＋ 场景</button><button type="button" onClick={addShot} disabled={busy}>＋ 镜头</button><button type="button" className="secondary" onClick={() => { void onGenerateAssetPrompts(); }} disabled={busy || blockingCount > 0}>生成资产 Prompt</button></div></div>
      <div className="story-v2-board-summary"><span>模型：{spec.generator_profile || 'Seedance 2.5'}</span><span>场景：{document.scenes.length}</span><span>总时长：{shotDuration.toFixed(1)}s</span><span>资产待登记：{issues.filter((issue) => issue.code === 'asset_gap' || issue.code === 'asset_requirements_missing').length}</span></div>
      <div className="story-v2-scene-stack">{shotGroups.map(({ scene, shots: sceneShots }) => { const sceneId = String(scene.id || 'UNASSIGNED'); return <article className="story-v2-scene-card" data-story-scene-id={sceneId} key={sceneId}>
        <header className="story-v2-scene-header"><div className="story-v2-scene-title"><b>{sceneId}</b><div><h4>{String(scene.name || '未命名场景')}</h4><span>{String(scene.interiorExterior || '内/外景未定')} · {String(scene.timeOfDay || '时间未定')} · {String(scene.location || scene.description || '空间待补充')}</span></div></div><div className="story-v2-scene-meta"><span>{sceneShots.length} 镜头</span><span className={`story-v2-scene-ledger-status ${sceneLedgerComplete(scene) ? 'complete' : 'pending'}`}>{sceneLedgerComplete(scene) ? 'AI 场景账本已填充' : '待 AI 补齐'}</span><span>{scene.productionDifficulty ? `难度 ${String(scene.productionDifficulty)}` : '资产待检查'}</span>{sceneId !== 'UNASSIGNED' && <button type="button" onClick={() => removeScene(sceneId)} disabled={busy}>删除场景</button>}</div></header>
        {sceneId !== 'UNASSIGNED' && <div className="story-v2-scene-fields"><div className="story-v2-field-grid">{sceneField(scene, 'name', '场景名称')}{sceneField(scene, 'description', '场景摘要', true)}{sceneField(scene, 'interiorExterior', '内外景')}{sceneField(scene, 'timeOfDay', '时间')}{sceneField(scene, 'location', '地点')}{sceneField(scene, 'emotion', '情绪')}{sceneField(scene, 'narrativeFunction', '叙事功能')}{sceneField(scene, 'productionDifficulty', '生产难度')}</div><div className="story-v2-field-grid wide">{sceneField(scene, 'characterIds', '人物 ID（每行一个）', true)}{sceneField(scene, 'propIds', '道具 ID（每行一个）', true)}{sceneField(scene, 'relevantShots', '关联镜头（每行一个）', true)}{sceneField(scene, 'spatialGeography', '空间地理', true)}{sceneField(scene, 'visualAnchors', '视觉锚点（每行一个）', true)}{sceneField(scene, 'materialEvidence', '材质证据', true)}{sceneField(scene, 'lightingCausality', '光线因果', true)}{sceneField(scene, 'soundscape', '环境声音', true)}</div></div>}
        <div className="story-v2-shot-stack">{sceneShots.map((shot, index) => { const isOpen = Boolean(openShots[shot.id]); const seedance = (shot.seedancePlan && typeof shot.seedancePlan === 'object' ? shot.seedancePlan : {}) as Record<string, unknown>; const continuity = (shot.continuity && typeof shot.continuity === 'object' ? shot.continuity : {}) as Record<string, unknown>; return <article className={`story-v2-shot-card${isOpen ? ' open' : ''}`} data-story-shot-id={shot.id} key={shot.id}>
          <header className="story-v2-shot-summary"><button type="button" className="story-v2-shot-toggle" aria-expanded={isOpen} onClick={() => setOpenShots((current) => ({ ...current, [shot.id]: !isOpen }))}><span className="story-v2-shot-id">{shot.id}</span><span className="story-v2-shot-scene">{sceneId}</span><span className="story-v2-shot-duration">{Number(shot.duration || 0)}s</span><span className="story-v2-shot-purpose">{String(shot.purpose || shot.visibleEvent || '未填写叙事目的')}</span><span className="story-v2-shot-summary-detail">{String(shot.size || '景别未定')} · {String(shot.camera || '机位未定')} · {String(shot.action || '动作未定')}</span></button><div className="story-v2-shot-badges"><span>{String(shot.difficulty || 'medium')}</span><span>{String(seedance.model || spec.generator_profile || 'Seedance 2.5')}</span><span className={budgetState === '超预算' ? 'danger' : ''}>{budgetState}</span></div><div className="story-v2-shot-actions"><button type="button" aria-label={`上移 ${shot.id}`} onClick={() => moveShot(shot.id, -1)} disabled={busy || index === 0}>↑</button><button type="button" aria-label={`下移 ${shot.id}`} onClick={() => moveShot(shot.id, 1)} disabled={busy || index === sceneShots.length - 1}>↓</button><button type="button" onClick={() => duplicateShot(shot.id)} disabled={busy}>复制</button><button type="button" onClick={() => splitShot(shot.id)} disabled={busy}>拆分</button><button type="button" onClick={() => removeShot(shot.id)} disabled={busy}>删除</button></div></header>
        {isOpen && <div className="story-v2-shot-editor"><section><h5>叙事与表演</h5><div className="story-v2-field-grid">{shotField(shot, 'purpose', '镜头目的', true)}{shotField(shot, 'visibleEvent', '主可见事件', true)}{shotField(shot, 'eventConsequence', '事件后果', true)}{shotField(shot, 'action', '动作', true)}{shotField(shot, 'performance', '表情 / 表演', true)}{shotField(shot, 'subjectFocus', '主体焦点')}{shotField(shot, 'dialogue', '对白', true)}{shotField(shot, 'narration', '旁白', true)}</div></section><section><h5>画面与连续性</h5><div className="story-v2-field-grid">{shotField(shot, 'size', '景别')}{shotField(shot, 'camera', '机位 / 运镜', true)}{shotField(shot, 'cameraExecution', '摄影机执行', true)}{shotField(shot, 'spatialGeography', '空间地理', true)}{shotField(shot, 'materialEvidence', '材质证据', true)}{shotField(shot, 'lightingCausality', '光线因果', true)}{shotField(shot, 'environment', '环境 / 空间状态', true)}{shotField(shot, 'atmosphereBehavior', '空气与氛围', true)}</div><div className="story-v2-continuity-grid">{['firstFrame', 'lastFrame', 'screenDirection', 'eyeline', 'motionVector', 'cutIn', 'cutOut', 'matchAction', 'editBridge', 'preRoll', 'postRoll'].map((key) => <Field key={key} label={key} value={continuity[key] || shot[key]} multiline={['firstFrame', 'lastFrame', 'editBridge'].includes(key)} onChange={(value) => updateShot(shot.id, 'continuity', { ...continuity, [key]: value })} />)}</div></section><section><h5>声音与资产</h5><div className="story-v2-field-grid">{shotField(shot, 'sound', '声音 / 音效 / 音乐', true)}{shotField(shot, 'generationMethod', '生成方式')}{shotField(shot, 'difficulty', '生成难度')}{shotField(shot, 'risks', '风险（每行一个）', true)}{shotField(shot, 'referenceRoles', '参考图职责（每行一个）', true)}{shotField(shot, 'assetRequirements', '资产需求（每行一个）', true)}</div><div className="story-v2-seedance-grid">{['model', 'generationMode', 'targetDuration', 'aspectRatio', 'clipUnit', 'promptTimeline', 'startState', 'playableChange', 'endState', 'continuityStrategy', 'referenceAssignments', 'audioStrategy', 'mustPreserve', 'mustAvoid', 'riskFlags', 'fallbackRoute'].map((key) => <Field key={key} label={`Seedance · ${key}`} value={seedanceValue(key, seedance[key])} multiline={['promptTimeline', 'startState', 'playableChange', 'endState', 'continuityStrategy', 'referenceAssignments', 'mustPreserve', 'mustAvoid', 'riskFlags', 'fallbackRoute'].includes(key)} onChange={(value) => updateSeedance(shot, key, value)} />)}</div><div className="story-v2-shot-footer"><span>首帧 / 尾帧与连续性会被传递到后续镜头生成和融合计划。</span><button type="button" onClick={() => onSave()} disabled={busy || !dirty}>保存当前镜头</button></div></section></div>}
        </article>; })}</div>
      </article>; })}{!shotGroups.length && <div className="story-v2-empty">暂无场景或镜头。使用上方按钮建立制作链。</div>}</div>
    </section>

    {importOpen && <div className="story-v2-import-backdrop"><section className="story-v2-import-dialog" role="dialog" aria-modal="true" aria-labelledby="story-v2-import-title"><header><div><span>DIRECT IMPORT · SOURCE STORYBOARD</span><h3 id="story-v2-import-title">直接导入现有分镜</h3></div><button type="button" aria-label="关闭直接导入" onClick={() => setImportOpen(false)}>×</button></header><p>粘贴带有“标题 / 总时长 / 【镜头01】 / 时间 / 景别 / 画面 / 摄影 / 目的”等字段的分镜文本。导入会替换当前场景和镜头，不会覆盖上方原始剧本；系统会生成场景账本、连续性、Seedance Plan 和资产需求。</p><textarea aria-label="分镜导入内容" value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="例如：\n标题：LINK / 同步\n总时长：约14秒\n【镜头01】\n时间：00:00–00:07.10\n景别：超近景\n画面：……" />{importError && <div className="story-v2-import-error" role="alert">{importError}</div>}<div className="story-v2-import-footnote">识别到的主体镜头会按 SH001、SH002…建立；同一主体镜头内的时间段会汇总进 Prompt Timeline，不会隐性拆成更多镜头。</div><footer><button type="button" onClick={() => setImportOpen(false)}>取消</button><button type="button" className="primary" onClick={importStoryboard} disabled={!importText.trim()}>导入并替换当前分镜</button></footer></section></div>}

    {storyboardReviewReady && <section className="story-v2-review"><div className="story-v2-subheading"><div><span>REVIEW CANDIDATE</span><h3>{directMode ? '锁定原文的分镜候选' : 'AI 候选审阅'}</h3></div><span>{proposedShots.length} 个候选镜头 · {directMode ? '原文不可变' : '候选不覆盖当前版本'}</span></div><div className="story-v2-review-metrics"><span>{candidateDurationSource === 'script_explicit' ? `剧本时长 ${candidateDuration}s` : `参考时长 ${candidateDuration}s`}</span><span>建议镜头 {candidateBudgetMin}–{candidateBudgetMax} · 目标 {candidateBudgetTarget}</span><span>候选总时长 {proposedShots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0).toFixed(1)}s</span><span>当前模型 {String((output.shotBudgetAssessment as Record<string, unknown> | undefined)?.targetGenerator || (output.shotBudgetAssessment as Record<string, unknown> | undefined)?.generator_profile || spec.generator_profile || 'Seedance 2.5')}</span><span className={candidateOverBudget ? 'danger' : ''}>{candidateOverBudget ? '超出当前上限：不可接受' : `镜头预算${candidateBudgetStatus}`}</span></div>{candidateDurationSource === 'script_explicit' && <div className="story-v2-review-lock">⏱️ 已识别剧本明确时长：本次候选按剧本时长规划，页面参考时长不会覆盖剧本要求。</div>}{!directMode && <div className="story-v2-candidate-script-output"><strong>候选拍摄剧本</strong><pre>{proposedScript || '候选未提供剧本改动'}</pre></div>}{directMode && <div className="story-v2-review-lock">🔒 直转分镜接受范围仅包含场景和镜头，不提供“仅接受剧本”。</div>}<div className="story-v2-candidate-list">{proposedShots.map((candidate, index) => { const selected = selectedCandidateIds.includes(candidate.id); return <label className={`story-v2-candidate${selected ? ' selected' : ''}`} key={candidate.id}><div className="story-v2-candidate-summary"><input type="checkbox" checked={selected} onChange={(event) => setSelectedCandidateIds((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))} /><b>{String(index + 1).padStart(2, '0')}</b><span><strong>{candidate.id} · {String(candidate.purpose || candidate.visibleEvent || '未填写目的')}</strong><small>{Number(candidate.duration || 0)}s · {String(candidate.scene || '')} · {String(candidate.size || '')} · {String(candidate.camera || '')}</small></span><em>{selected ? '已选择' : '待选择'}</em></div><div className="story-v2-candidate-full-output" aria-label={`${candidate.id} 完整输出`}>{Object.entries(candidate).map(([key, value]) => <div className="story-v2-candidate-output-field" key={key}><b>{candidateOutputLabel(key)}</b><pre>{candidateOutputValue(value)}</pre></div>)}</div></label>; })}</div><div className="story-v2-review-actions">{!directMode && <button type="button" onClick={() => acceptCandidate('script_only')} disabled={busy}>仅接受剧本</button>}<button type="button" onClick={() => acceptCandidate('shots_only')} disabled={busy || !selectedCandidateIds.length || candidateOverBudget}>接受选中镜头</button><button type="button" className="primary" onClick={() => acceptCandidate('all')} disabled={busy || !proposedShots.length || candidateOverBudget}>接受全部候选</button></div><div className="story-v2-revision-panel"><div><span>REVISION FEEDBACK</span><strong>不满意？告诉 AI 你希望怎么改</strong></div><p>修订会保留当前原始剧本、上一版候选和稳定资产/镜头上下文，生成新的可审阅候选；不会自动覆盖已接受内容。</p><textarea aria-label="AI 分镜修订意见" value={revisionFeedback} onChange={(event) => setRevisionFeedback(event.target.value)} placeholder="例如：保留两镜头结构；把镜头01的推进改成更克制的横向滑动；不要新增角色；让镜头02的 Hero Shot 保持青蓝光倒映眼睛。" /><div className="story-v2-revision-actions"><small>旧候选会保留在运行记录中，可继续回看。</small><button type="button" className="primary" onClick={() => { const feedback = revisionFeedback.trim(); if (!feedback || !storyRun?.id) return; onRegenerate(feedback, storyRun.id, directMode ? 'direct' : 'optimize'); setRevisionFeedback(''); }} disabled={busy || !revisionFeedback.trim() || !storyRun?.id}>按我的想法重新生成</button></div></div>{proposedScenes.length > 0 && <small className="story-v2-review-scenes">候选场景 {proposedScenes.length} 个 · 场景账本完整 {proposedScenesComplete}/{proposedScenes.length}：接受镜头时按实际引用写入场景卡；AI 已填字段仍可人工修订。</small>}</section>}

    {regulatorReviewReady && <section className="story-v2-review story-v2-regulator-review"><div className="story-v2-subheading"><div><span>ASSET HANDOFF REVIEW</span><h3>资产总控交接审阅</h3></div><span>分镜已接受 · 等待交接确认</span></div><div className="story-v2-review-metrics"><span>待登记资产 {regulatorAssets.length}</span><span>镜头—资产依赖 {regulatorRequirements.length}</span><span>交接目标 video-asset-regulator</span></div><p className="story-v2-review-lock">分镜接受已完成，当前只审阅资产依赖、参考图职责和声音交接；这里不会再次修改剧本或候选镜头。</p><div className="story-v2-review-actions"><button type="button" className="primary" onClick={() => onAccept('all')} disabled={busy}>接受资产交接并生成回执</button></div></section>}

    <details className="story-v2-tools" open={checksOpen} onToggle={(event) => setChecksOpen(event.currentTarget.open)}><summary>生产检查与交接 <small>{blockingCount} 阻塞 · {warnings.length} 提醒 · {regulatorReceipt ? '已有回执' : '待交接'}</small></summary><div className="story-v2-issues">{budgetExceeded && <div className="story-v2-issue error"><b>阻塞</b><span>当前 {shots.length} 个镜头超过上限 {budget.max} 个；请合并、删除或主动提高预算后才能进入资产生产。</span></div>}{issues.length ? issues.map((issue, index) => <div className={`story-v2-issue ${issue.severity === 'error' ? 'error' : 'warning'}`} key={`${issue.code}-${issue.shot_id || 'project'}-${index}`}><b>{issue.severity === 'error' ? '阻塞' : '提醒'}</b><span>{issue.message}{issue.shot_id ? ` · ${issue.shot_id}` : ''}</span></div>) : !budgetExceeded && <div className="story-v2-clear">当前没有生产检查问题。</div>}{regulatorReceipt && <pre className="story-v2-receipt">{JSON.stringify(regulatorReceipt, null, 2)}</pre>}</div></details>
    <details className="story-v2-tools" open={versionsOpen} onToggle={(event) => setVersionsOpen(event.currentTarget.open)}><summary>版本快照与回退 <small>保留审计与回退能力</small></summary><div className="story-v2-version-list">{document.script_versions.filter((version) => version.status !== 'active').slice(-6).map((version) => <div key={String(version.id)}><span>{String(version.id)} · {String(version.source || 'unknown')}</span><button type="button" onClick={() => onRollback(String(version.id), 'script')} disabled={busy}>回退剧本</button></div>)}{document.storyboard_versions.filter((version) => version.status !== 'active').slice(-6).map((version) => <div key={String(version.id)}><span>{String(version.id)} · 分镜快照</span><button type="button" onClick={() => onRollback(String(version.id), 'shots')} disabled={busy}>回退分镜</button></div>)}{!document.script_versions.length && !document.storyboard_versions.length && <span>暂无历史版本。</span>}</div></details>
  </section>;
}
