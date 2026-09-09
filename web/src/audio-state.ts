import type { AudioAudition, AudioStudioDocument, MiniMaxVoiceOption, StoryDocument } from './types';

export type AudioBriefEntry = {
  id: string;
  speaker: string;
  character_id?: string;
  text: string;
  shot_ids: string[];
  duration?: number;
  source: 'shot' | 'script';
  kind: 'dialogue' | 'narration';
};

export type AudioBrief = {
  structured: boolean;
  warnings: string[];
  entries: AudioBriefEntry[];
};

const asText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const universalVoiceLanguageTerms = new Set(['all', 'any', 'auto', 'common', 'generic', 'multilingual', 'universal', '通用', '多语言']);
const catalogLanguageAliases: Record<string, string[]> = {
  chinese: ['chinese', 'mandarin', 'cantonese', 'zh', '中文', '普通话', '粤语'],
  english: ['english', 'en', '英语', '英文'],
  japanese: ['japanese', 'ja', '日语', '日文', '日本語'],
  korean: ['korean', 'ko', '韩语', '韩文', '한국'],
  french: ['french', 'fr', '法语', '法文'],
  german: ['german', 'de', '德语', '德文'],
  spanish: ['spanish', 'es', '西班牙语'],
  portuguese: ['portuguese', 'pt', '葡萄牙语'],
  italian: ['italian', 'it', '意大利语'],
  russian: ['russian', 'ru', '俄语'],
};
const catalogLanguageMarkers: Array<[string, string[]]> = [
  ['japanese', ['japanese', '日语', '日文', '日本語']],
  ['korean', ['korean_', '한국', '韩语', '韩文']],
  ['spanish', ['spanish_', '西班牙语']],
  ['portuguese', ['portuguese_', '葡萄牙语']],
  ['french', ['french_', '法语']],
  ['german', ['german_', '德语']],
  ['russian', ['russian_', '俄语']],
  ['italian', ['italian_', '意大利语']],
  ['dutch', ['dutch_', '荷兰']],
  ['vietnamese', ['vietnamese_', '越南']],
  ['indonesian', ['indonesian_', '印尼', '印度尼西亚']],
  ['arabic', ['arabic_', '阿拉伯']],
  ['turkish', ['turkish_', '土耳其']],
  ['ukrainian', ['ukrainian_', '乌克兰']],
  ['malay', ['malay_', '马来']],
  ['filipino', ['filipino_', '菲律宾']],
  ['thai', ['thai_', '泰语', '泰文']],
  ['hindi', ['hindi_', '印地']],
  ['hebrew', ['hebrew_', '希伯来']],
  ['persian', ['persian_', '波斯']],
  ['bengali', ['bengali_', '孟加拉']],
  ['afrikaans', ['afrikaans_', '南非荷兰']],
  ['catalan', ['catalan_', '加泰罗尼亚']],
  ['serbian', ['serbian_', '塞尔维亚']],
  ['polish', ['polish_', '波兰']],
  ['romanian', ['romanian_', '罗马尼亚']],
  ['czech', ['czech_', '捷克']],
  ['greek', ['greek_', '希腊']],
  ['hungarian', ['hungarian_', '匈牙利']],
  ['swedish', ['swedish_', '瑞典']],
  ['danish', ['danish_', '丹麦']],
  ['finnish', ['finnish_', '芬兰']],
  ['norwegian', ['norwegian_', '挪威']],
  ['slovak', ['slovak_', '斯洛伐克']],
  ['bulgarian', ['bulgarian_', '保加利亚']],
  ['croatian', ['croatian_', '克罗地亚']],
  ['tamil', ['tamil_', '泰米尔']],
  ['telugu', ['telugu_', '泰卢固']],
  ['chinese', ['chinese', 'mandarin', 'cantonese', '中文', '普通话', '粤语', 'male-qn-', 'female-', 'clever_boy', 'cute_boy', 'lovely_girl', 'cartoon_pig', 'bingjiao', 'junlang', 'chun zhen', 'chunzhen', 'lengdan', 'badao_', 'tianxin', 'qiaopi', 'wumei', 'diadia', 'danya', 'arrogant_miss', 'robot_armor', '青涩', '少女音色']],
  ['english', ['english_', 'aussie', 'whispering', 'diligent man', 'gentle-voiced', 'trustworthy man', 'graceful lady', 'santa claus', 'grinch', 'rudolph', 'arnold', 'charming santa', 'charming lady', 'sweet girl', 'cute elf', 'attractive girl', 'serene woman']],
];

/** Match catalog declarations without hiding deliberately universal system voices. */
export function voiceSupportsLanguage(voice: MiniMaxVoiceOption, language: string): boolean {
  const target = asText(language).toLowerCase();
  if (!target) return true;
  const targetAliases = new Set([target, ...(catalogLanguageAliases[target] || [])]);
  const declared = [voice.language, ...(voice.languages || [])]
    .map((value) => asText(value).toLowerCase())
    .filter(Boolean);
  if (declared.length) return declared.some((value) => universalVoiceLanguageTerms.has(value) || value.includes('universal') || value.includes('multilingual') || [...targetAliases].some((alias) => value === alias || value.includes(alias) || alias.includes(value)));
  const identity = `${asText(voice.voice_id)} ${asText(voice.name)}`.toLowerCase();
  const inferred = catalogLanguageMarkers.find(([, markers]) => markers.some((marker) => identity.includes(marker)))?.[0];
  return !inferred || inferred === target;
}

function listValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean);
  return asText(value).split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
}

function shotText(shot: Record<string, unknown>): { text: string; kind: 'dialogue' | 'narration'; speaker: string; characterId: string } | null {
  const dialogue = shot.dialogue ?? shot.dialogues ?? shot.line ?? shot.lines;
  const narration = shot.narration ?? shot.voiceover ?? shot.voice_over;
  const raw = dialogue || narration;
  if (Array.isArray(raw)) {
    const first = raw.find((item) => typeof item === 'string' || (item && typeof item === 'object'));
    if (first && typeof first === 'object') {
      const record = first as Record<string, unknown>;
      return {
        text: asText(record.text ?? record.content ?? record.line),
        kind: narration ? 'narration' : 'dialogue',
        speaker: asText(record.speaker ?? record.character ?? record.role) || 'UNKNOWN_SPEAKER',
        characterId: asText(record.character_id ?? record.characterId ?? record.speaker_id),
      };
    }
    return first ? { text: asText(first), kind: narration ? 'narration' : 'dialogue', speaker: 'UNKNOWN_SPEAKER', characterId: '' } : null;
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    return {
      text: asText(record.text ?? record.content ?? record.line),
      kind: narration ? 'narration' : 'dialogue',
      speaker: asText(record.speaker ?? record.character ?? record.role) || (narration ? 'NARRATOR' : 'UNKNOWN_SPEAKER'),
      characterId: asText(record.character_id ?? record.characterId ?? record.speaker_id),
    };
  }
  const text = asText(raw);
  if (!text) return null;
  return {
    text,
    kind: narration ? 'narration' : 'dialogue',
    speaker: asText(shot.speaker ?? shot.character ?? shot.role) || (narration ? 'NARRATOR' : 'UNKNOWN_SPEAKER'),
    characterId: asText(shot.character_id ?? shot.characterId ?? shot.speaker_id),
  };
}

export function extractAudioBrief(story: StoryDocument | null | undefined): AudioBrief {
  const shots = story?.shots || [];
  const entries: AudioBriefEntry[] = [];
  let dialogueIndex = 1;
  let narrationIndex = 1;
  for (const shot of shots) {
    const record = shot as unknown as Record<string, unknown>;
    const extracted = shotText(record);
    if (!extracted?.text) continue;
    const kind = extracted.kind;
    entries.push({
      id: `${kind === 'narration' ? 'NAR' : 'DLG'}${String(kind === 'narration' ? narrationIndex++ : dialogueIndex++).padStart(3, '0')}`,
      speaker: extracted.speaker,
      character_id: extracted.characterId || undefined,
      text: extracted.text,
      shot_ids: [asText(record.id) || `SH${String(entries.length + 1).padStart(3, '0')}`],
      duration: typeof record.duration === 'number' ? record.duration : undefined,
      source: 'shot',
      kind,
    });
  }
  if (entries.length) return { structured: true, warnings: [], entries };
  if (asText(story?.script)) {
    return {
      structured: false,
      warnings: ['当前只有自由脚本，无法可靠推断角色和镜头引用。请先去“故事与分镜”整理，或手动添加对白并确认说话人。'],
      entries: [],
    };
  }
  return { structured: false, warnings: ['当前剧本为空。请先补充剧本或在此手动添加对白。'], entries: [] };
}

export function auditionConditions(auditions: AudioAudition[], voiceId: string): Record<string, AudioAudition | undefined> {
  const result: Record<string, AudioAudition | undefined> = {};
  for (const condition of ['neutral', 'emotional', 'pronunciation-stress']) {
    result[condition] = auditions.find((item) => item.voice_id === voiceId && item.condition === condition);
  }
  return result;
}

export function auditionReady(auditions: AudioAudition[], voiceId: string): boolean {
  const grouped = auditionConditions(auditions, voiceId);
  return ['neutral', 'emotional', 'pronunciation-stress'].every((condition) => {
    const item = grouped[condition];
    return item?.status === 'approved' && Boolean(item.artifact_id);
  });
}

export function buildProviderNeutralPackage(projectId: string, document: AudioStudioDocument) {
  const auditions = document.auditions || [];
  return {
    package_version: 'audio-voice-package.v2',
    project_id: projectId,
    provider_neutral: true,
    generated_at: new Date().toISOString(),
    instructions: '本包只描述声音身份、试听条件和执行约束，不代表已经生成试听结果，也不会发起付费请求。',
    voices: (document.voices || []).map((voice) => ({
      id: voice.id,
      character_id: voice.character_id || null,
      role: voice.role || 'character',
      name: voice.name,
      source_type: voice.source_type,
      voice_source: voice.source_type === 'preset' ? 'system-preset' : voice.source_type,
      provider: voice.provider || 'minimax',
      provider_voice_id: voice.provider_voice_id || null,
      provider_voice_name: voice.provider_voice_name || '',
      provider_region: voice.provider_region || 'cn',
      locale: voice.locale || '',
      language: voice.language || '',
      dialect: voice.dialect || '',
      traits: voice.traits || [],
      pronunciation_risks: voice.pronunciation_risks || [],
      register: voice.register || '',
      age_range: voice.age_range || '',
      pitch_energy: voice.pitch_energy || '',
      breath_noise_profile: voice.breath_noise_profile || '',
      continuity_anchor: voice.continuity_anchor || {},
      consent: {
        status: voice.consent_status,
        evidence_ref: voice.consent_evidence_ref || '',
        allowed_use: voice.allowed_use || '',
        geography: voice.geography || '',
        term: voice.term || '',
      },
    })),
    auditions: auditions.map((audition) => ({
      id: audition.id,
      voice_id: audition.voice_id || null,
      character_id: audition.character_id || null,
      condition: audition.condition,
      text: audition.text,
      source_text: audition.source_text || audition.text,
      provider_text: audition.provider_text || audition.text,
      text_status: audition.text_status || 'candidate',
      locale: audition.locale || null,
      language: audition.language || null,
      dialect: audition.dialect || null,
      language_boost: audition.language_boost || null,
      provider_region: audition.provider_region || null,
      settings: audition.settings || {},
      emotion: audition.emotion || '',
      instructions: audition.instructions || '',
      target_duration: audition.target_duration ?? null,
      status: 'external-execution-pending',
      artifact_id: null,
    })),
    dialogues: (document.dialogues || []).map((dialogue) => ({
      id: dialogue.id,
      character_id: dialogue.character_id || null,
      voice_id: dialogue.voice_id || null,
      shot_ids: dialogue.shot_ids,
      text: dialogue.text,
      source_text: dialogue.source_text || dialogue.text,
      provider_text: dialogue.provider_text || dialogue.text,
      text_status: dialogue.text_status || 'candidate',
      locale: dialogue.locale || null,
      language: dialogue.language || null,
      dialect: dialogue.dialect || null,
      language_boost: dialogue.language_boost || null,
      provider_region: dialogue.provider_region || null,
      settings: dialogue.settings || {},
      emotion: dialogue.emotion || '',
      target_duration: dialogue.target_duration ?? null,
      operation: dialogue.operation,
    })),
    blockers: ['provider_voice_id 未绑定或 Provider 未探测时，audition 需要外部执行；请导入 artifact 后进行音频 QA。'],
  };
}

export function audioAssetArtifactId(asset: { artifactId?: string; artifacts?: Array<Record<string, unknown>> }): string {
  if (asset.artifactId) return asset.artifactId;
  const artifact = (asset.artifacts || []).find((item) => item.id || item.artifact_id);
  return asText(artifact?.id ?? artifact?.artifact_id);
}

export function normalizeSpeaker(value: string): string {
  return value.trim().replace(/^角色[：:]\s*/, '').replace(/^人物[：:]\s*/, '') || 'UNKNOWN_SPEAKER';
}
