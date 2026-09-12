import { useCallback, useEffect, useMemo, useState } from 'react';
import { studioApi } from './api';
import type { AssetIntentAsset, AssetIntentEnvelope, AssetIntentSystemPlan, PromptConsistencyReview } from './types';

type AssetIntentModalProps = {
  projectId: string;
  onClose: () => void;
  onGenerate: (assetIntentVersion: number) => Promise<boolean> | boolean;
};

type AssetIntentGroup = {
  id: 'character' | 'environment' | 'prop' | 'other';
  label: string;
  assets: AssetIntentAsset[];
};

const classLabels: Record<string, string> = {
  character: '角色',
  scene: '环境',
  prop: '道具',
  product: '产品',
  style: '风格',
  audio: '声音',
  music: '音乐',
  sfx: '音效',
  fusion: '融合',
};

const loadErrorText = (error: unknown): string => error instanceof Error ? error.message : '资产创作意图读取失败，请重试。';

const statusText = (asset: AssetIntentAsset, active: boolean): string => {
  if (asset.readOnly) return '系统规划';
  if (active) return '提交中';
  if (asset.status === 'failed') return '处理失败';
  if (asset.status === 'blocked') return '需要处理';
  if (asset.mode === 'user_input' && asset.status === 'submitted') return 'AI 已接收';
  if (asset.mode === 'script_only' && asset.status === 'submitted') return '按剧本生成';
  if (asset.mode === 'deferred' && asset.status === 'submitted') return '暂不补充';
  if (asset.mode === 'draft') return '草稿已保存';
  return '未处理';
};

const groupForAsset = (asset: AssetIntentAsset): AssetIntentGroup['id'] => {
  if (asset.assetClass === 'character') return 'character';
  if (asset.assetClass === 'scene') return 'environment';
  if (asset.assetClass === 'prop' || asset.assetClass === 'product') return 'prop';
  return 'other';
};

const promptReviewClass = (review: PromptConsistencyReview): string => {
  if (review.status === 'passed') return 'passed';
  if (review.status === 'blocked') return 'blocked';
  if (review.status === 'needs_intent_revision') return 'failed';
  return 'checking';
};

export function AssetIntentModal({ projectId, onClose, onGenerate }: AssetIntentModalProps) {
  const [envelope, setEnvelope] = useState<AssetIntentEnvelope | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingDraft, setSavingDraft] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ character: true, environment: true, prop: true, other: true });

  const loadEnvelope = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await studioApi.assetIntents(projectId);
      setEnvelope(result);
      setDrafts(Object.fromEntries(result.assets.map((asset) => [asset.assetId, asset.userText || ''])));
    } catch (loadError) {
      setError(loadErrorText(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadEnvelope(); }, [loadEnvelope]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingDraft && !generating) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [generating, onClose, savingDraft]);

  const groups = useMemo<AssetIntentGroup[]>(() => {
    const grouped: Record<AssetIntentGroup['id'], AssetIntentAsset[]> = { character: [], environment: [], prop: [], other: [] };
    for (const asset of envelope?.assets || []) grouped[groupForAsset(asset)].push(asset);
    return ([
      { id: 'character', label: '角色资产', assets: grouped.character },
      { id: 'environment', label: '环境资产', assets: grouped.environment },
      { id: 'prop', label: '道具 / 物品资产', assets: grouped.prop },
      { id: 'other', label: '其他基础资产', assets: grouped.other },
    ] as AssetIntentGroup[]).filter((group) => group.assets.length > 0);
  }, [envelope?.assets]);

  const systemPlans = envelope?.systemPlans || [];

  const draftChanged = useMemo(() => (envelope?.assets || []).some((asset) => !asset.readOnly && (drafts[asset.assetId] || '') !== (asset.userText || '')), [drafts, envelope?.assets]);

  const applyResult = (result: AssetIntentEnvelope) => {
    setEnvelope(result);
    setDrafts(Object.fromEntries(result.assets.map((asset) => [asset.assetId, asset.userText || ''])));
  };

  const refreshEnvelope = async () => {
    if (!envelope) return;
    setLoading(true);
    setError('');
    try {
      const result = envelope.manifestStale
        ? await studioApi.rebaseAssetIntents(projectId, envelope.revision)
        : await studioApi.assetIntents(projectId);
      applyResult(result);
    } catch (refreshError) {
      setError(loadErrorText(refreshError));
    } finally {
      setLoading(false);
    }
  };

  const submitAsset = async (asset: AssetIntentAsset, mode: 'user_input' | 'script_only' | 'deferred') => {
    if (!envelope || asset.readOnly || envelope.manifestStale || activeAssetId) return;
    const userText = drafts[asset.assetId] || '';
    if (mode === 'user_input' && !userText.trim()) {
      setError(`请先填写 ${asset.assetId} 的创作想法，或选择“按剧本生成”。`);
      return;
    }
    setActiveAssetId(asset.assetId);
    setError('');
    try {
      const result = await studioApi.interpretAssetIntent(projectId, asset.assetId, { expected_revision: envelope.revision, user_text: userText, mode });
      applyResult(result);
    } catch (submitError) {
      setError(loadErrorText(submitError));
      await loadEnvelope();
    } finally {
      setActiveAssetId(null);
    }
  };

  const saveDraft = async () => {
    if (!envelope || envelope.manifestStale || savingDraft || activeAssetId || !draftChanged) return;
    setSavingDraft(true);
    setError('');
    try {
      let current = envelope;
      for (const asset of current.assets) {
        if (asset.readOnly || (drafts[asset.assetId] || '') === (asset.userText || '')) continue;
        current = await studioApi.interpretAssetIntent(projectId, asset.assetId, { expected_revision: current.revision, user_text: drafts[asset.assetId] || '', mode: 'draft' });
        setEnvelope(current);
      }
    } catch (saveError) {
      setError(loadErrorText(saveError));
      await loadEnvelope();
    } finally {
      setSavingDraft(false);
    }
  };

  const confirmAndGenerate = async () => {
    if (!envelope?.progress.allHandled || envelope.manifestStale || generating) return;
    if (draftChanged) {
      setError('有资产想法尚未提交给 AI；请先点击对应资产的“提交给 AI”，或使用“保存草稿”后再继续。');
      return;
    }
    setGenerating(true);
    setError('');
    try {
      const generated = await onGenerate(envelope.assetIntentVersion);
      if (generated === false) setError('资产 Prompt 生成未完成，请查看页面提示并重试。');
      else await loadEnvelope();
    } catch (generateError) {
      setError(loadErrorText(generateError));
    } finally {
      setGenerating(false);
    }
  };

  return <div className="asset-intent-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingDraft && !generating) onClose(); }}>
    <section className="asset-intent-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-intent-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="asset-intent-header">
        <div><span>ASSET CREATIVE INTENT · PRE-PROMPT GATE</span><h3 id="asset-intent-title">资产创作意图</h3><p>这里只确认角色、环境、道具等基础资产的首次视觉定义。OpenCode API 只在后台整理意图；融合、首尾帧 / 连续性和声音不会在此阶段要求填写。</p></div>
        <button type="button" className="asset-intent-close" aria-label="关闭资产创作意图" onClick={onClose} disabled={savingDraft || generating}>×</button>
      </header>
      {loading && <div className="asset-intent-loading">正在读取当前资产清单…</div>}
      {!loading && <>
        <div className="asset-intent-summary"><div><span>待确认基础资产</span><strong>{envelope?.assets.length || 0} 项</strong></div><div><span>系统后续规划</span><strong>{systemPlans.length} 项</strong></div><div className="asset-intent-progress"><div><span>意图确认进度</span><b>{envelope?.progress.percent || 0}%</b></div><i><em style={{ width: `${envelope?.progress.percent || 0}%` }} /></i></div></div>
        {envelope?.warnings.map((warning) => <div className="asset-intent-warning" role="alert" key={warning}>⚠ {warning}</div>)}
        {error && <div className="asset-intent-error" role="alert">{error}</div>}
        {envelope?.manifestStale && <div className="asset-intent-stale"><strong>故事或资产清单已变化</strong><span>请刷新并重新确认；已有原始想法会保留为草稿，不会继续绑定旧版本。</span><button type="button" onClick={() => void refreshEnvelope()}>刷新并重新确认</button></div>}
        {!envelope?.assetManifestReady && <div className="asset-intent-empty"><strong>暂时没有可确认的资产</strong><span>请先在故事与分镜流程中完成 AI 资产总控交接。</span></div>}
        <div className="asset-intent-groups">
          {systemPlans.length > 0 && <details className="asset-intent-system-plans">
            <summary><span>系统后续规划（无需填写）</span><b>{systemPlans.length}</b></summary>
            <div className="asset-intent-system-plan-copy">融合关系、镜头首尾帧 / 连续性和声音内容由后续流程自动处理，不计入本轮基础资产确认数量。</div>
            <div className="asset-intent-system-plan-list">{systemPlans.map((plan: AssetIntentSystemPlan) => <div className="asset-intent-system-plan" key={plan.assetId}>
              <div><code>{plan.assetId}</code><strong>{plan.assetName}</strong><span>{plan.label}{plan.relevantShots.length ? ` · 关联镜头 ${plan.relevantShots.join('、')}` : ''}</span></div>
              <em>自动生成</em>
            </div>)}</div>
          </details>}
          {envelope?.assetManifestReady && envelope.assets.length === 0 && systemPlans.length > 0 && <div className="asset-intent-empty asset-intent-empty-base"><strong>当前没有需要你填写的基础资产</strong><span>系统后续规划已保留；基础资产确认数量为 0 项，暂不能进入资产 Prompt 生成。</span></div>}
          {groups.map((group) => <details key={group.id} open={openGroups[group.id]} onToggle={(event) => { const isOpen = event.currentTarget.open; setOpenGroups((current) => ({ ...current, [group.id]: isOpen })); }}>
            <summary><span>{group.label}</span><b>{group.assets.length}</b></summary>
            <div className="asset-intent-card-list">{group.assets.map((asset) => {
              const active = activeAssetId === asset.assetId;
              const assetClassLabel = classLabels[asset.assetClass] || asset.assetClass || '资产';
              return <article className={`asset-intent-card${asset.readOnly ? ' readonly' : ''}`} key={asset.assetId}>
                <div className="asset-intent-card-heading"><div><code>{asset.assetId}</code><strong>{asset.assetName}</strong><span>{assetClassLabel}{asset.assetRole ? ` · ${asset.assetRole}` : ''}</span></div><em className={`asset-intent-status ${active ? 'processing' : asset.status}`}>{statusText(asset, active)}</em></div>
                <div className="asset-intent-card-meta"><span>关联镜头 {asset.relevantShots.length ? asset.relevantShots.join('、') : '待确认'}</span><span>等级 {asset.grade || 'B'}</span>{asset.assetAspectRatio && <span>基础参考画幅 {asset.assetAspectRatio}</span>}</div>
                {asset.readOnly ? <div className="asset-intent-readonly">系统根据当前基础资产和镜头关系自动规划，不需要单独填写。</div> : <>
                  <textarea aria-label={`${asset.assetId} 资产创作想法`} value={drafts[asset.assetId] || ''} onChange={(event) => setDrafts((current) => ({ ...current, [asset.assetId]: event.target.value }))} placeholder="输入你对这个资产的整体想法……例如身份、外观、材质、气质、状态或必须保留的特征。" disabled={Boolean(activeAssetId) || Boolean(envelope?.manifestStale)} />
                  <div className="asset-intent-card-actions"><button type="button" className="primary" onClick={() => void submitAsset(asset, 'user_input')} disabled={Boolean(activeAssetId) || Boolean(envelope?.manifestStale) || !((drafts[asset.assetId] || '').trim())}>提交给 AI</button><button type="button" onClick={() => void submitAsset(asset, 'script_only')} disabled={Boolean(activeAssetId) || Boolean(envelope?.manifestStale)}>按剧本生成</button><button type="button" className="text-button" onClick={() => void submitAsset(asset, 'deferred')} disabled={Boolean(activeAssetId) || Boolean(envelope?.manifestStale)}>暂不补充</button></div>
                </>}
                {asset.warningSummary.map((warning) => <div className="asset-intent-card-warning" key={warning}>⚠ {warning}</div>)}
                {asset.promptConsistencyReview && <div className={`asset-intent-card-prompt-review ${promptReviewClass(asset.promptConsistencyReview)}`} role={asset.promptConsistencyReview.status === 'passed' ? 'status' : 'alert'}> {asset.promptConsistencyReview.status === 'passed' ? '✓' : '⚠'} {asset.promptConsistencyReview.message}</div>}
              </article>;
            })}</div>
          </details>)}
        </div>
        <footer className="asset-intent-footer"><div><strong>已确认基础资产 {envelope?.progress.handled || 0} / {envelope?.progress.total || 0} 项</strong><small>{draftChanged ? '有未保存的想法草稿。' : '融合、首尾帧 / 连续性和声音由后续流程自动规划，不计入本步骤。'}</small></div><div className="asset-intent-footer-actions"><button type="button" onClick={() => void saveDraft()} disabled={!draftChanged || savingDraft || Boolean(activeAssetId) || Boolean(envelope?.manifestStale)}>保存草稿</button><button type="button" onClick={onClose} disabled={savingDraft || generating}>关闭</button><button type="button" className="primary" onClick={() => void confirmAndGenerate()} disabled={!envelope?.progress.allHandled || draftChanged || Boolean(envelope?.manifestStale) || savingDraft || Boolean(activeAssetId) || generating}>{generating ? '正在生成…' : '确认资产意图并生成资产 Prompt'}</button></div></footer>
      </>}
    </section>
  </div>;
}
