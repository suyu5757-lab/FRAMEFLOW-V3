import { useEffect, useMemo, useState } from 'react';
import { studioApi } from './api';
import { MINIMAX_VOICE_DESIGN_URL, buildMinimaxVoiceDesignChecklist, copyToClipboard } from './audio-copy';
import type { AudioPreparationVoiceDesign } from './assistant-types';
import type { AudioStudioDocument, AudioTtsRoute, AudioVoiceDesignCandidate, MiniMaxRegion } from './types';

type AudioVoiceDesignWorkbenchProps = {
  projectId: string;
  document: AudioStudioDocument;
  routes: AudioTtsRoute[];
  defaultRoute?: AudioTtsRoute;
  designSeed?: AudioPreparationVoiceDesign | null;
  revision: number;
  dirty: boolean;
  saving: boolean;
  onServerDocument: (document: AudioStudioDocument) => void;
  onPersist: () => Promise<{ revision: number; document: AudioStudioDocument } | null>;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
};

const localeOptions = [
  ['zh-CN', 'Chinese · 简体中文'],
  ['ja-JP', 'Japanese · 日本語'],
  ['en-US', 'English · English'],
  ['ko-KR', 'Korean · 한국어'],
] as const;

const languageByLocale: Record<string, string> = {
  'zh-CN': 'Chinese',
  'ja-JP': 'Japanese',
  'en-US': 'English',
  'ko-KR': 'Korean',
};

function daysUntil(value?: string | null): string {
  if (!value) return '有效期由 MiniMax 返回';
  const milliseconds = new Date(value).valueOf() - Date.now();
  if (Number.isNaN(milliseconds)) return '有效期由 MiniMax 返回';
  if (milliseconds <= 0) return '候选可能已过期';
  return `约 ${Math.ceil(milliseconds / 86_400_000)} 天内需用于语音合成`;
}

function routeLabel(route?: AudioTtsRoute): string {
  if (!route) return 'MiniMax 路由未配置';
  if (!route.credential_configured) return `${route.region === 'global' ? '国际区' : '中国区'} · 可复制到网页`;
  return `${route.region === 'global' ? '国际区' : '中国区'} · ${route.ready ? '可生成' : '等待目录恢复'}`;
}

function candidateValue(value: Record<string, unknown>, key: string): string {
  return String(value[key] || '');
}

export function AudioVoiceDesignWorkbench({
  projectId,
  document,
  routes,
  defaultRoute,
  designSeed,
  revision,
  dirty,
  saving,
  onServerDocument,
  onPersist,
  onRefresh,
  onNotice,
}: AudioVoiceDesignWorkbenchProps) {
  const [prompt, setPrompt] = useState('');
  const [previewText, setPreviewText] = useState('');
  const [locale, setLocale] = useState('');
  const [region, setRegion] = useState<MiniMaxRegion>((defaultRoute?.region === 'global' ? 'global' : 'cn'));
  const [busy, setBusy] = useState(false);
  const [selectedCandidateId, setSelectedCandidateId] = useState('');
  const candidates = useMemo(() => (document.voice_design_candidates || []) as AudioVoiceDesignCandidate[], [document.voice_design_candidates]);
  const route = useMemo(
    () => routes.find((item) => item.region === region && (item.active || item.ready)) || routes.find((item) => item.region === region) || defaultRoute,
    [defaultRoute, region, routes],
  );
  const language = languageByLocale[locale] || '';

  useEffect(() => {
    if (!designSeed?.prompt && !designSeed?.preview_text) return;
    setPrompt(designSeed.prompt || '');
    setPreviewText(designSeed.preview_text || '');
    if (designSeed.locale) setLocale(designSeed.locale);
    if (designSeed.provider_region === 'cn' || designSeed.provider_region === 'global') setRegion(designSeed.provider_region);
  }, [designSeed?.locale, designSeed?.preview_text, designSeed?.prompt, designSeed?.provider_region]);

  useEffect(() => {
    if (designSeed || prompt || !candidates.length) return;
    const latest = candidates[candidates.length - 1];
    if (!latest) return;
    setPrompt(latest.prompt || '');
    setPreviewText(latest.preview_text || '');
    setLocale(latest.locale || '');
    if (latest.provider_region === 'cn' || latest.provider_region === 'global') setRegion(latest.provider_region);
  }, [candidates, designSeed, prompt]);

  const copyField = async (label: string, value: string) => {
    const copied = await copyToClipboard(value);
    onNotice(copied ? `已复制${label}；尚未创建音色，也没有产生费用。` : `无法复制${label}；请从字段中手动复制。`);
  };

  const copyPackage = () => {
    const value = buildMinimaxVoiceDesignChecklist({
      language,
      locale,
      region: route?.region || region,
      prompt,
      previewText,
    });
    void copyField('MiniMax Voice Design 填写包', value);
  };

  const chooseCandidate = (candidate: AudioVoiceDesignCandidate) => {
    setSelectedCandidateId(candidate.id);
    setPrompt(candidate.prompt || '');
    setPreviewText(candidate.preview_text || '');
    setLocale(candidate.locale || '');
    if (candidate.provider_region === 'cn' || candidate.provider_region === 'global') setRegion(candidate.provider_region);
    onNotice('已选中这个音色候选；你可以继续试听，或复制它的 Voice ID。尚未登记为角色声音。');
  };

  const createCandidate = async () => {
    const nextPrompt = prompt.trim();
    const nextPreviewText = previewText.trim();
    if (!nextPrompt) {
      onNotice('请先填写或让 AI 整理一段音色 Prompt。');
      return;
    }
    if (!nextPreviewText) {
      onNotice('请先填写一条实际要试听的台词。');
      return;
    }
    if (nextPreviewText.length > 500) {
      onNotice('MiniMax Voice Design 的试听文本不能超过 500 个字符。');
      return;
    }
    if (!route?.credential_configured) {
      onNotice('当前没有可用的 MiniMax 凭据；可以直接复制 Prompt 和试听文本到 MiniMax 网页生成。');
      return;
    }
    if (!window.confirm([
      '确认生成一个 MiniMax Voice Design 音色候选？',
      '',
      `区域：${route.region === 'global' ? '国际区' : '中国区'}`,
      `语言：${language || '由 MiniMax 判断'}${locale ? ` · ${locale}` : ''}`,
      `试听字符数：${nextPreviewText.length}`,
      '',
      '这会产生 MiniMax 费用并返回一个候选 Voice ID；不会自动登记或锁定角色声音。',
    ].join('\n'))) return;

    setBusy(true);
    try {
      let expectedRevision = revision;
      if (dirty) {
        const saved = await onPersist();
        if (!saved) return;
        expectedRevision = saved.revision;
      }
      const result = await studioApi.designVoice(projectId, {
        prompt: nextPrompt,
        preview_text: nextPreviewText,
        provider_profile_id: route.provider_profile_id,
        provider_region: route.region as MiniMaxRegion,
        locale: locale || undefined,
        language: language || undefined,
        expected_revision: expectedRevision,
        confirmed: true,
      });
      onServerDocument(result.document);
      setSelectedCandidateId(candidateValue(result.candidate, 'id'));
      onNotice('音色候选已返回。先试听候选，再决定是否进入后续角色声音流程。');
      await onRefresh();
    } catch (error) {
      onNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return <section className="audio-voice-design-workbench" aria-label="MiniMax Voice Design 创作台">
    <header className="audio-voice-design-header">
      <div>
        <span>MINIMAX VOICE DESIGN</span>
        <h3>把想法变成可试听的音色</h3>
        <p>AI 负责把自然语言整理成生成 Prompt；MiniMax 负责根据 Prompt 和试听台词生成候选。</p>
      </div>
      <div className={`audio-voice-design-route ${route?.credential_configured && route.ready ? 'ready' : 'neutral'}`}>
        <b>{routeLabel(route)}</b>
        <small>当前模型 · {route?.model || 'speech-2.8-hd'}</small>
      </div>
    </header>

    {designSeed && <div className="audio-voice-design-ai-note"><span>AI 已整理</span><p>下面两段内容来自上方对话。先审核文字，再复制到 MiniMax；不会自动调用生成。</p></div>}

    <section className="audio-voice-design-input-card">
      <div className="audio-voice-design-section-heading"><span>01 · PROMPT</span><div><h4>你想要什么样的声音？</h4><p>只描述声音身份和整体感觉，不要把台词混进这里。</p></div></div>
      <textarea aria-label="MiniMax Voice Design Prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：A young Japanese female high-school student with a sweet, soft voice and lively youthful energy. Natural conversational delivery, clear articulation, not an exaggerated anime-style performance." rows={6} />
      <div className="audio-voice-design-field-footer"><small>{prompt.length} 字符 · 将整段粘贴到 MiniMax 的 Prompt</small><button type="button" onClick={() => void copyField('音色 Prompt', prompt)} disabled={!prompt.trim()}>复制音色 Prompt</button></div>
    </section>

    <section className="audio-voice-design-input-card preview">
      <div className="audio-voice-design-section-heading"><span>02 · TEXT TO PREVIEW</span><div><h4>让这个声音说什么？</h4><p>只放实际要试听的短台词，最多 500 个字符。</p></div></div>
      <textarea aria-label="MiniMax Voice Design Text to Preview" value={previewText} onChange={(event) => setPreviewText(event.target.value)} placeholder="例如：先輩、今日の放課後、一緒に帰りませんか？" rows={4} maxLength={500} />
      <div className="audio-voice-design-field-footer"><small className={previewText.length > 500 ? 'over' : ''}>{previewText.length} / 500 字符 · 将整段粘贴到 MiniMax 的 Text to Preview</small><button type="button" onClick={() => void copyField('试听台词', previewText)} disabled={!previewText.trim()}>复制试听台词</button></div>
    </section>

    <section className="audio-voice-design-options">
      <label>试听语言 / 地区<select aria-label="Voice Design 语言和地区" value={locale} onChange={(event) => setLocale(event.target.value)}><option value="">由 MiniMax 自动判断</option>{localeOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>MiniMax 执行区域<select aria-label="Voice Design 执行区域" value={region} onChange={(event) => setRegion(event.target.value as MiniMaxRegion)}><option value="cn">中国区 MiniMax</option><option value="global">国际区 MiniMax</option></select></label>
      <div className="audio-voice-design-option-status"><span>只改两件事</span><b>Prompt + 试听台词</b><small>音色候选生成前仍需单独确认费用。</small></div>
    </section>

    <div className="audio-voice-design-actions">
      <button type="button" onClick={copyPackage} disabled={!prompt.trim() || !previewText.trim()}>复制完整填写包</button>
      <a className="audio-external-link" href={MINIMAX_VOICE_DESIGN_URL} target="_blank" rel="noreferrer">打开 MiniMax Voice Design ↗</a>
      <button type="button" className="audio-primary-button" onClick={() => void createCandidate()} disabled={busy || saving}>{busy ? '正在生成候选…' : '生成音色候选'}</button>
    </div>
    <p className="audio-voice-design-safety">复制不会产生费用。点击“生成音色候选”才会调用 MiniMax；返回的 Voice ID 仍是候选，需要试听后再进入角色声音流程。</p>

    {candidates.length > 0 && <section className="audio-voice-design-candidates">
      <div className="audio-voice-design-candidates-heading"><div><span>03 · CANDIDATES</span><h4>最近的音色候选</h4></div><small>试听后再决定是否保留</small></div>
      <div className="audio-voice-design-candidate-grid">{candidates.slice().reverse().slice(0, 6).map((candidate) => <article key={candidate.id} className={selectedCandidateId === candidate.id ? 'selected' : ''}>
        <div className="audio-voice-design-candidate-top"><div><b>{candidate.provider_voice_name || 'MiniMax Voice'}</b><small>{candidate.provider_region === 'global' ? '国际区' : '中国区'} · {candidate.status === 'adopted' ? '已采用' : '候选'}</small></div><span>{candidate.id}</span></div>
        {candidate.url ? <audio controls preload="none" src={candidate.url} /> : <div className="audio-voice-design-audio-empty">等待 MiniMax 返回试听文件</div>}
        <code>{candidate.provider_voice_id}</code>
        <small className="audio-voice-design-expiry">{daysUntil(candidate.expires_at)}</small>
        <div><button type="button" onClick={() => void copyField('Voice ID', candidate.provider_voice_id)}>复制 Voice ID</button><button type="button" className="selected-action" onClick={() => chooseCandidate(candidate)}>{selectedCandidateId === candidate.id ? '已选中' : '选中这个候选'}</button></div>
      </article>)}</div>
    </section>}
  </section>;
}
