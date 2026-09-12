import { describe, expect, it } from 'vitest';
import { buildMiniMaxWebPromptPackage, buildNaturalLanguagePrompt, formatMiniMaxWebPromptPackage, normalizePromptPack } from './prompt-design';

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

  it('prints image-generation reference assets in a separate prompt section', () => {
    const prompt = buildNaturalLanguagePrompt('prop', {
      promptIntent: '锁定 P10 的机械结构',
      referenceRoles: [{ referenceId: 'P02', role: 'connected_character' }],
      identityAnchor: 'P10 是围绕 P02 的六翼机械道具',
    });
    expect(prompt).toContain('图片生成时需要提供的参考图资产：P02');
  });

  it('compiles a base character into one static same-character turnaround', () => {
    const prompt = buildNaturalLanguagePrompt('character', {
      promptIntent: '建立可跨镜头复用的角色基础身份参考板',
      identityAnchor: 'C001 是 20–22 岁东亚成年女性驾驶员',
      visibleEvent: '同一张合成参考板静态展示同一角色的四个视图',
      characterDetails: {
        faceAndExpression: '窄鹅蛋脸、深棕近黑杏仁眼、轻微眼睑不对称和少量可见毛孔，表情自然放松',
        hairAndHeadSilhouette: '黑色偏冷棕中短层次发，后侧固定为低位短束发',
        bodyPoseAction: '纤细修长成年女性比例，双手可见的中性站姿，不接触机甲',
        costumeAndMaterials: '冷白驾驶服、石墨黑结构、白色驾驶手套、双腕青蓝同步接口',
        detailAndMaterialBehavior: '中性棚灯显示皮肤、发丝、织物和磨砂装甲的材质差异',
      },
      cameraExecution: { framing: '结构参考板', camera: '中性设计记录视角' },
      visualStyle: { medium: '写实角色设计参考' },
      continuityChecklist: ['SH001 与 SH002 复用同一张脸'],
      mustPreserve: ['C001 原始资产 ID', '白色驾驶手套'],
      mustAvoid: ['文字和水印'],
    }, '旧 Prompt\n\n同时满足以下补充制作要求：触碰机甲并说走吧。', undefined, 'base_asset');
    expect(prompt).toContain('38%');
    expect(prompt).toContain('16:9 横向角色设定参考板');
    expect(prompt.match(/画布与基础资产输出要求：/g)?.length).toBe(1);
    expect(prompt).toContain('严格 90° 左侧面全身');
    expect(prompt).toContain('严格 180° 背面全身');
    expect(prompt).toContain('不是四名相似角色');
    expect(prompt).not.toContain('C001');
    expect(prompt).not.toContain('SH001');
    expect(prompt).not.toContain('同时满足以下补充制作要求');
    expect(prompt).not.toContain('允许变化：');
  });

  it('keeps fusion on the legacy supplement path even if base mode is passed', () => {
    const prompt = buildNaturalLanguagePrompt('fusion', {
      promptIntent: '将已确认资产按镜头关系融合',
      identityAnchor: '角色、道具和环境身份',
      visibleEvent: '角色握住道具并进入环境',
      fusionDetails: { interactionAndContact: '手部接触可信' },
    }, '旧融合 Prompt', undefined, 'base_asset');
    expect(prompt).toContain('同时满足以下补充制作要求');
    expect(prompt).toContain('旧融合 Prompt');
  });

  it('keeps the scene base prompt focused on the real environment background', () => {
    const prompt = buildNaturalLanguagePrompt('scene', {
      promptIntent: '建立可跨镜头复用的空环境',
      identityAnchor: '同一座山腰祠堂',
      visibleEvent: '角色进入画面并在门前放置道具',
      sceneDetails: {
        spatialLayoutAndGeography: '前景湿石阶，中景空院落，背景木门与山体消失方向',
        actionBlockingZones: '院落中央保持空白',
      },
    }, '', undefined, 'base_asset');
    expect(prompt).toContain('背景边界必须展示实际环境的后景层');
    expect(prompt).toContain('16:9 横向空环境设计参考图');
    expect(prompt).not.toContain('使用白色、米白或中性浅灰的干净设计背景，不加入具体生活场景。');
    expect(prompt).not.toContain('角色进入画面');
    expect(prompt).not.toContain('放置道具');
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

  it('uses MiniMax Web fields and blocks candidate dialogue from direct copy', () => {
    const pack = {
      promptIntent: '为 P01 建立一条 MiniMax Speech 2.8 Web 试听',
      identityAnchor: 'P01 的成年女性低沉中文声音',
      audioDetails: {
        sourceText: '看招。', textStatus: 'candidate',
        voiceIdentity: '成年女性中文普通话，低沉、冷峻、近距离',
        performanceDirection: '咬字清楚，句尾收住，保留短停顿', language: '中文', dialect: '普通话',
        emotion: 'calm', pace: '略慢',
      },
      continuityChecklist: ['与口型同步'], mustAvoid: ['环境声覆盖辅音'],
    };
    const prompt = buildNaturalLanguagePrompt('audio', pack);
    const packageValue = buildMiniMaxWebPromptPackage(pack, '', { shots: [{ id: 'S03', dialogue: '看招。' }, { id: 'S16' }] });
    expect(packageValue.textStatus).toBe('candidate');
    expect(packageValue.copyText).toBe('');
    expect(packageValue.candidateText).toBe('看招。');
    expect(prompt).toContain('候选朗读文本待用户确认');
    expect(prompt).not.toContain('空间关系与地理');
    expect(prompt).not.toContain('FRAMEFLOW');
  });

  it('exposes only confirmed text as the MiniMax Web copy text', () => {
    const packageValue = buildMiniMaxWebPromptPackage({ audioDetails: { sourceText: '看招。<#0.35#>', textStatus: 'confirmed' } });
    expect(packageValue.copyText).toBe('看招。<#0.35#>');
    expect(packageValue.candidateText).toBe('');
  });

  it('keeps sourceText and providerText separate and derives Japanese language boost from locale', () => {
    const packageValue = buildMiniMaxWebPromptPackage({ audioDetails: {
      sourceText: '先輩、今日の放課後、一緒に帰りませんか？',
      providerText: '先輩、今日の放課後、(breath) 一緒に帰りませんか？',
      textStatus: 'confirmed', locale: 'ja-JP', language: 'Japanese',
      providerVoiceId: 'Japanese_SportyStudent', providerRegion: 'cn',
    } });
    expect(packageValue.sourceText).not.toContain('(breath)');
    expect(packageValue.providerText).toContain('(breath)');
    expect(packageValue.copyText).toBe(packageValue.providerText);
    expect(packageValue.settings.languageBoost).toBe('Japanese');
    expect(packageValue.settings.languageBoost).not.toBe('Chinese');
  });

  it('keeps MiniMax text, web settings, and FrameFlow metadata in separate blocks', () => {
    const packageValue = buildMiniMaxWebPromptPackage({ audioDetails: { textStatus: 'missing', voiceIdentity: '成年女性中文普通话，低沉、冷峻' } }, '', {
      shots: [{ id: 'S03', dialogue: '看招。' }, { id: 'S16' }],
    });
    const rendered = formatMiniMaxWebPromptPackage(packageValue, 'AUD02', 'AUD02');
    expect(rendered).toContain('只有这一段可以粘贴到 MiniMax 文本框');
    expect(rendered).toContain('S03');
    expect(rendered).toContain('S16');
    expect(rendered).toContain('不要粘贴到 MiniMax');
    expect(rendered).toContain('部分关联镜头没有明确朗读文本');
  });
});
