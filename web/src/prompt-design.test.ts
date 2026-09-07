import { describe, expect, it } from 'vitest';
import { buildNaturalLanguagePrompt, normalizePromptPack } from './prompt-design';

describe('shared prompt workflow compiler', () => {
  it('compiles legacy character aliases into the skill-v2 order', () => {
    const pack = normalizePromptPack('character', {
      identity: '成年女性黑甲忍者',
      faceExpression: '窄脸、低颧骨、锐利眉眼，嘴角轻微下压',
      hairSilhouette: '高束长发，侧发丝受右向风吹开',
      wardrobeMaterial: '哑光分层黑甲，肩部有细密磨损',
      poseAction: '左脚前探，右手压住刀柄',
      camera: { framing: '中近景', lens: '50mm', focus: '眼睛' },
      lighting: '左后方冷蓝边缘光在湿润甲片上形成窄高光',
      continuity: ['发束位置和刀柄朝向不变'],
      mustAvoid: ['多余手指', '文字水印'],
      referenceRoles: [{ referenceId: '@Image1', role: 'identity', controls: '只控制脸部身份' }],
    });
    const prompt = buildNaturalLanguagePrompt('character', pack, '保持可复用的角色结构参考板。');
    expect(prompt).toContain('窄脸、低颧骨、锐利眉眼');
    expect(prompt).toContain('参考图角色保持明确');
    expect(prompt).toContain('必须避免');
    expect(prompt.indexOf('保持以下身份与结构锚点不变')).toBeLessThan(prompt.indexOf('材质证据与表面状态表现为'));
    expect(prompt.indexOf('材质证据与表面状态表现为')).toBeLessThan(prompt.indexOf('摄影机执行为'));
    expect(prompt).not.toContain('"faceExpression"');
  });

  it('adds explicit scene geography, material evidence, and camera-visible shot context', () => {
    const prompt = buildNaturalLanguagePrompt('scene', {
      promptIntent: '建立雨夜祠堂的空环境和动作空间',
      identityAnchor: '同一座山腰祠堂',
      sceneDetails: {
        geography: { foreground: '湿石阶', midground: '中央空院', background: '开裂山门' },
        propsAndSetDressing: ['左侧铜钟', '檐下暖灯'],
        surfacesAndMaterials: '湿黑石板，雨水沿台阶凹槽向下汇流',
        lightingAndAtmosphere: '檐下暖灯向外衰减，冷雨雾从右向左横移',
        actionSpace: '院心保持空白，台阶是唯一进入路径',
      },
      continuityChecklist: ['铜钟在画面左侧，山门裂缝不漂移'],
    }, '', { shots: [{ id: 'S001', purpose: '建立空间', size: '大全景', camera: '低机位 28mm', action: '雨水沿台阶汇流' }] });
    expect(prompt).toContain('建立雨夜祠堂');
    expect(prompt).toContain('前景为');
    expect(prompt).toContain('湿黑石板');
    expect(prompt).toContain('镜头 S001');
    expect(prompt).toContain('连续性检查');
  });

  it('keeps a persisted compiled prompt idempotent while preserving its supplement', () => {
    const pack = { promptIntent: '建立可复用的声音身份参考', identityAnchor: 'P01 的成年女性低沉中文声音' };
    const first = buildNaturalLanguagePrompt('audio', pack, '等待用户确认台词和录音方式。');
    const second = buildNaturalLanguagePrompt('audio', pack, first);
    expect(second).toBe(first);
    expect(second.match(/同时满足以下补充制作要求：/g)).toHaveLength(1);
  });
});
