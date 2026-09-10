import { describe, expect, it } from 'vitest';
import { parseStoryboardImport } from './storyboard-import';

const sample = `标题：LINK / 同步
总时长：约14秒
镜头结构：2个主体镜头，通过机甲装甲遮挡完成隐藏剪辑。

【镜头01】
时间：00:00–00:01.30
景别：超近景 / Extreme Close-Up
画面：巨大机甲机械手占据画面主要区域，少女戴着白色驾驶手套的右手缓慢进入。
摄影：85–100mm长焦特写感，极浅景深，摄影机缓慢Push-In。
目的：建立机甲尺度和机械质感。

时间：00:01.30–00:07.10
景别：手部极近景 → 人物面部侧脸特写
动作：少女食指触碰机甲机械手指，青蓝能源沿机甲逐层点亮。
摄影：缓慢Slide + Tilt Up，随后轻微Orbit。
目的：完成少女与机甲关系建立和角色揭示。
转场：大型机甲肩甲快速经过，完全遮挡约0.2秒，完成隐藏剪辑。

【镜头02】
时间：00:07.10–00:10.80
景别：人物三分之二侧脸特写
画面：少女位于前景，机甲巨大头部轮廓位于后方，机甲光学系统突然亮起。
摄影：50–65mm，缓慢Orbit，Rack Focus回到少女眼睛。
目的：建立少女与机甲同框关系并完成系统回应。

时间：00:10.80–00:14.00
景别：少女面部英雄特写 → 逆光剪影
动作：少女抬眼，轻声“走吧”，机甲头部同步抬起，出击舱门打开。
声音：SYSTEM SYNC COMPLETE；机甲核心重低频；音乐出现重拍。
目的：完成同步出击的Hero Shot。
`;

describe('storyboard import parser', () => {
  it('maps two主体镜头 into complete scene and shot contracts', () => {
    const result = parseStoryboardImport(sample, { generator: 'seedance2.5', aspectRatio: '16:9' });
    expect(result.title).toBe('LINK / 同步');
    expect(result.duration).toBe(14);
    expect(result.scenes).toHaveLength(1);
    expect(result.shots).toHaveLength(2);
    expect(result.shots.map((shot) => shot.id)).toEqual(['SH001', 'SH002']);
    expect(result.shots.map((shot) => shot.duration)).toEqual([7.1, 6.9]);
    expect(result.scenes[0].relevantShots).toEqual(['SH001', 'SH002']);
    expect(result.shots[0].continuity).toMatchObject({ editBridge: expect.stringContaining('隐藏剪辑') });
    expect(result.shots[1].seedancePlan).toMatchObject({ model: 'seedance2.5', generationMode: 'reference_to_video', targetDuration: 6.9 });
    expect((result.shots[1].assetRequirements as Array<Record<string, unknown>>).map((item) => item.assetId)).toContain('C001');
  });

  it('rejects text without a主体镜头 heading instead of silently creating empty shots', () => {
    expect(() => parseStoryboardImport('标题：没有镜头\n总时长：5秒')).toThrow('没有识别到');
  });
});
