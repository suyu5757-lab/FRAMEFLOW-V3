import type { AudioAudition, AudioStudioDocument, StoryDocument } from './types';

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
    package_version: 'audio-voice-package.v1',
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
