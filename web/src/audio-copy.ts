export const MINIMAX_VOICE_DESIGN_URL = 'https://www.minimax.io/audio/voice-design';
export const MINIMAX_TTS_URL = 'https://www.minimax.io/audio/text-to-speech';

export async function copyToClipboard(value: string): Promise<boolean> {
  const text = value.trim();
  if (!text || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function buildMinimaxVoiceDesignChecklist(input: {
  characterId?: string;
  voiceName?: string;
  language?: string;
  locale?: string;
  region?: string;
  prompt: string;
  previewText: string;
}): string {
  return [
    'MiniMax Voice Design 网页填写清单',
    '',
    `角色：${input.characterId || '未绑定角色'}`,
    `声音名称：${input.voiceName || '未命名'}`,
    `语言：${input.language || '由 MiniMax 自动识别'}`,
    `Locale：${input.locale || '未指定'}`,
    `执行区域：${input.region || '当前 MiniMax 区域'}`,
    '',
    '请分别粘贴到 MiniMax Voice Design 页面：',
    '',
    '【Prompt / 音色描述】',
    input.prompt.trim(),
    '',
    '【Text to Preview / 试听文本】',
    input.previewText.trim(),
    '',
    '当前状态：待在 MiniMax 中生成候选；复制本清单不会产生费用。',
  ].join('\n');
}

export function buildMinimaxSpeechChecklist(input: {
  characterId?: string;
  characterName?: string;
  model?: string;
  voiceId?: string;
  language?: string;
  locale?: string;
  dialect?: string;
  languageBoost?: string;
  region?: string;
  speed: string;
  pitch: string;
  volume: string;
  emotion?: string;
  shotIds?: string;
  format?: string;
}): string {
  return [
    'MiniMax Text to Speech 网页填写清单',
    '',
    `角色：${input.characterId || '未绑定角色'}${input.characterName ? ` · ${input.characterName}` : ''}`,
    `模型：${input.model || 'speech-2.8-hd'}`,
    `Voice ID：${input.voiceId || '未绑定'}`,
    `语言：${input.language || '自动识别'}`,
    `Locale：${input.locale || '未指定'}`,
    `方言 / 口音：${input.dialect || '未指定'}`,
    `Language Boost：${input.languageBoost || 'auto'}`,
    `区域：${input.region || '当前 MiniMax 区域'}`,
    `速度：${input.speed || '1.0'}`,
    `音调：${input.pitch || '0'}`,
    `音量：${input.volume || '1.0'}`,
    `情绪：${input.emotion || '基础'}`,
    `输出格式：${input.format || 'wav'}`,
    `关联镜头：${input.shotIds || '未关联'}`,
    '',
    '请把“可朗读文本”单独粘贴到 MiniMax 文本框。',
    '本清单只用于人工核对，不要粘贴到 MiniMax 文本框。',
  ].join('\n');
}
