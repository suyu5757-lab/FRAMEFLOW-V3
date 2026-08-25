import { describe, expect, it } from 'vitest';
import { auditionReady, buildProviderNeutralPackage, extractAudioBrief } from './audio-state';
import type { AudioStudioDocument } from './types';

describe('audio workflow helpers', () => {
  it('extracts structured dialogue and shot references without guessing speakers', () => {
    const brief = extractAudioBrief({ script: '自由脚本', shots: [{ id: 'SH001', duration: 2, dialogue: { speaker: 'C001', text: '慢点' } }, { id: 'SH002', duration: 3, narration: '镜头向前推进' }] } as any);
    expect(brief.structured).toBe(true);
    expect(brief.entries.map((entry) => entry.id)).toEqual(['DLG001', 'NAR001']);
    expect(brief.entries[0].speaker).toBe('C001');
    expect(brief.entries[0].shot_ids).toEqual(['SH001']);
  });

  it('reports the free-script gap instead of inferring a character or shot', () => {
    const brief = extractAudioBrief({ script: '小孩在前面奔跑，母亲在后面追逐。', shots: [] } as any);
    expect(brief.structured).toBe(false);
    expect(brief.entries).toHaveLength(0);
    expect(brief.warnings[0]).toContain('无法可靠推断角色和镜头');
  });

  it('requires all three approved audition conditions', () => {
    const base = (condition: string, status = 'approved', artifact_id: string | null = condition) => ({ id: `AUD-${condition}`, voice_id: 'V001', condition, text: '测试', status, artifact_id });
    expect(auditionReady([base('neutral'), base('emotional')], 'V001')).toBe(false);
    expect(auditionReady([base('neutral'), base('emotional'), base('pronunciation-stress')], 'V001')).toBe(true);
    expect(auditionReady([base('neutral'), base('emotional'), base('pronunciation-stress', 'approved', null)], 'V001')).toBe(false);
  });

  it('exports provider-neutral instructions without pretending an artifact exists', () => {
    const document = { version: 1, voices: [{ id: 'V001', name: '主角', source_type: 'design', consent_status: 'not-required', status: 'draft' }], auditions: [{ id: 'AUD001', voice_id: 'V001', condition: 'neutral', text: '你好', status: 'external-execution-pending' }], dialogues: [], music_cues: [], sound_design: [], handoff: { status: 'provisional', approved_asset_ids: [] } } as unknown as AudioStudioDocument;
    const pack = buildProviderNeutralPackage('P1', document);
    expect(pack.provider_neutral).toBe(true);
    expect(pack.auditions[0].artifact_id).toBeNull();
    expect(pack.auditions[0].status).toBe('external-execution-pending');
  });
});
