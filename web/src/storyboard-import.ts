export type StoryboardImportOptions = {
  generator?: string;
  aspectRatio?: string;
  sceneId?: string;
  characterId?: string;
  propId?: string;
  audioId?: string;
};

export type StoryboardImportResult = {
  title: string;
  duration: number | null;
  sourceText: string;
  scenes: Array<Record<string, unknown>>;
  shots: Array<Record<string, unknown>>;
  warnings: string[];
};

const FIELD_ALIASES: Record<string, string> = {
  时间: 'time',
  景别: 'size',
  画面: 'visual',
  动作: 'action',
  摄影: 'camera',
  目的: 'purpose',
  转场: 'transition',
  声音: 'sound',
  对白: 'dialogue',
  旁白: 'narration',
};

const TIME_RANGE_RE = /(\d{2}:\d{2}(?:\.\d+)?)\s*[–—-]\s*(\d{2}:\d{2}(?:\.\d+)?)/;

const cleanLine = (value: string): string => value
  .replace(/\s*\\\s*$/, '')
  .replace(/^\s*[-*]\s+/, '')
  .trim();

const unique = (values: string[]): string[] => Array.from(new Set(values.map(cleanLine).filter(Boolean)));

const joinValues = (values: string[], separator = '；'): string => unique(values).join(separator);

const timeToSeconds = (value: string): number => {
  const [minuteText, secondText] = value.split(':');
  return Number(minuteText || 0) * 60 + Number(secondText || 0);
};

const parseDuration = (source: string): number | null => {
  const match = source.match(/总时长\s*[:：]\s*约?\s*(\d+(?:\.\d+)?)\s*秒/i);
  return match ? Number(match[1]) : null;
};

const parseTitle = (source: string): string => {
  const match = source.match(/标题\s*[:：]\s*(.+)/i);
  return cleanLine(match?.[1] || '未命名导入分镜');
};

const shotMarkers = (source: string): Array<{ number: number; start: number; end: number }> => {
  const matches = Array.from(source.matchAll(/(?:^|\n)\s*[【\[]?\s*镜头\s*0*(\d+)\s*[】\]]?\s*/g));
  return matches.map((match, index) => ({
    number: Number(match[1]),
    start: (match.index || 0) + match[0].length,
    end: index + 1 < matches.length ? (matches[index + 1].index || source.length) : source.length,
  }));
};

const extractFields = (source: string): Record<string, string[]> => {
  const fields: Record<string, string[]> = {};
  let active: string | null = null;
  for (const rawLine of source.replace(/\r/g, '').split('\n')) {
    const line = cleanLine(rawLine);
    if (!line || line === '---') continue;
    const labelMatch = line.match(/^([^：:]{1,12})\s*[:：]\s*(.*)$/);
    const key = labelMatch ? FIELD_ALIASES[labelMatch[1].trim()] : undefined;
    if (key) {
      active = key;
      const value = cleanLine(labelMatch?.[2] || '');
      if (value) (fields[key] ||= []).push(value);
      continue;
    }
    if (active) (fields[active] ||= []).push(line);
  }
  return fields;
};

const splitTimedBlocks = (source: string): Array<{ time: string; fields: Record<string, string[]> }> => {
  const matches = Array.from(source.matchAll(new RegExp(`(?:^|\\n)\\s*时间\\s*[:：]?\\s*(?:\\n\\s*)?(${TIME_RANGE_RE.source})`, 'g')));
  if (!matches.length) return [{ time: '', fields: extractFields(source) }];
  return matches.map((match, index) => {
    const start = match.index || 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index || source.length) : source.length;
    const block = source.slice(start, end);
    const fields = extractFields(block);
    if (!fields.time?.length) fields.time = [match[1]];
    return { time: match[1], fields };
  });
};

const rangeDuration = (time: string): number => {
  const match = time.match(TIME_RANGE_RE);
  if (!match) return 0;
  return Math.max(0, Math.round((timeToSeconds(match[2]) - timeToSeconds(match[1])) * 100) / 100);
};

const quoteText = (source: string): string[] => unique(Array.from(source.matchAll(/[“"]([^”"]{1,120})[”"]/g)).map((match) => match[1]));

const makeReferences = (characterId: string, propId: string, sceneId: string, audioId: string) => [
  { assetId: characterId, role: 'character_identity_and_performance', controls: '少女脸部、发型、白色驾驶手套、表演基线和眼神方向', doesNotControl: '机甲结构、机库空间和镜头运动', required: true, readinessRequired: 'planned' },
  { assetId: propId, role: 'mecha_structure_and_scale', controls: '机械手、肩甲、头部、装甲缝隙、青蓝光学系统和尺度关系', doesNotControl: '少女身份、面部表演和对白', required: true, readinessRequired: 'planned' },
  { assetId: sceneId, role: 'scene_geography_and_light', controls: '机库、出击舱门、前后景层次、逆光和空间方向', doesNotControl: '角色身份和机械细节', required: true, readinessRequired: 'planned' },
  { assetId: audioId, role: 'dialogue_and_sound_timing', controls: '系统音、机械确认声、核心低频和重拍时机', doesNotControl: '角色外观、场景材质和镜头构图', required: false, readinessRequired: 'planned' },
];

const makeAssetRequirements = (shotId: string, characterId: string, propId: string, sceneId: string, audioId: string) => [
  { assetId: characterId, assetClass: 'character', role: '少女驾驶员身份、白色驾驶手套与面部表演', priority: 'A', required: true, productionRole: 'base_asset', relevantShots: [shotId], requiredReadiness: 'production' },
  { assetId: propId, assetClass: 'prop', role: '巨型机甲机械手、肩甲、头部与光学系统', priority: 'A', required: true, productionRole: 'base_asset', relevantShots: [shotId], requiredReadiness: 'production' },
  { assetId: sceneId, assetClass: 'scene', role: '机库、出击舱门、逆光和前后景空间', priority: 'A', required: true, productionRole: 'base_asset', relevantShots: [shotId], requiredReadiness: 'production' },
  { assetId: audioId, assetClass: 'audio', role: '系统音、机械确认声、核心低频和对白', priority: 'B', required: false, productionRole: 'sound_asset', relevantShots: [shotId], requiredReadiness: 'planned' },
];

const makeContinuity = (index: number): Record<string, string> => index === 0 ? {
  screenDirection: '少女手套从画面侧面进入，机甲机械手保持主体占位。',
  eyeline: '待确认；手部段落不依赖视线。',
  motionVector: '接触后由手指沿手掌、前臂和肩部向上移动。',
  cutIn: '巨大机械手局部与少女手套进入画面。',
  cutOut: '大型机甲肩甲完全遮挡镜头 0.2–0.3 秒。',
  matchAction: '接触动作和青蓝能源点亮作为下一镜的连续依据。',
  editBridge: '机甲装甲遮挡完成隐藏剪辑，保持近似一镜到底感。',
  preRoll: '机械确认声先于青蓝接口完全亮起。',
  postRoll: '遮挡后的系统同步声继续延续。',
  firstFrame: '巨大机甲机械手局部占据画面，少女白色驾驶手套尚未完全入画。',
  lastFrame: '大型机甲肩甲完全遮挡画面，准备从另一侧重新出现。',
} : {
  screenDirection: '少女和机甲从画面同一侧关系转为共同朝向出击舱门。',
  eyeline: '少女抬眼，视线指向机甲和出击方向。',
  motionVector: '焦点在少女与机甲之间往返，后段共同向前推进。',
  cutIn: '从深色肩甲遮挡中重新出现，少女位于前景、机甲头部位于后景。',
  cutOut: '出击舱门白光进入，轮廓形成逆光剪影后切黑。',
  matchAction: '机甲光学系统亮起、抬头与少女抬眼和嘴角上扬同步。',
  editBridge: '延续遮挡隐藏剪辑后的运动方向，不重新建立角色身份。',
  preRoll: '系统音先于光学系统完全亮起。',
  postRoll: '机甲核心重低频与音乐重拍压过切黑。',
  firstFrame: '少女三分之二侧脸位于前景，机甲巨大头部轮廓位于后方且仍暗。',
  lastFrame: '少女与机甲形成逆光剪影，出击舱门白光进入，画面切黑并出现 LINK。',
};

export function parseStoryboardImport(source: string, options: StoryboardImportOptions = {}): StoryboardImportResult {
  const normalized = source.replace(/\r/g, '').trim();
  if (!normalized) throw new Error('请先粘贴要导入的分镜内容。');
  const markers = shotMarkers(normalized);
  if (!markers.length) throw new Error('没有识别到“【镜头01】”这样的主体镜头标题。');

  const title = parseTitle(normalized);
  const duration = parseDuration(normalized);
  const sceneId = options.sceneId || 'S001';
  const characterId = options.characterId || 'C001';
  const propId = options.propId || 'P001';
  const audioId = options.audioId || 'AUDIO001';
  const shotIds = markers.map((_, index) => `SH${String(index + 1).padStart(3, '0')}`);
  const references = makeReferences(characterId, propId, sceneId, audioId);
  const warnings: string[] = [];

  const shots = markers.map((marker, index) => {
    const section = normalized.slice(marker.start, marker.end).replace(/【核心关键帧】[\s\S]*$/u, '');
    const blocks = splitTimedBlocks(section);
    const fields = blocks.flatMap((block) => Object.entries(block.fields).map(([key, values]) => [key, values] as const));
    const values = (key: string): string[] => fields.filter(([field]) => field === key).flatMap(([, items]) => items);
    const timeRanges = blocks.map((block) => block.time).filter(Boolean);
    const shotDuration = timeRanges.reduce((sum, time) => sum + rangeDuration(time), 0) || (duration ? duration / markers.length : 7);
    const visual = joinValues(values('visual'));
    const action = joinValues(values('action'));
    const camera = joinValues(values('camera'));
    const purpose = joinValues(values('purpose'));
    const dialogue = joinValues([...values('dialogue'), ...quoteText(section)], '；');
    const sound = joinValues(values('sound')) || (index === 0 ? '机械确认声、接口提示音。' : 'SYSTEM SYNC COMPLETE；机甲核心重低频；音乐第一次出现明确重拍。');
    const size = joinValues(values('size'), ' → ');
    const hiddenCut = /遮挡|隐藏剪辑/.test(section);
    const visibleEvent = index === 0
      ? `少女白色驾驶手套从侧面进入并触碰巨大机甲机械手，青蓝能源沿手指、手掌、前臂和肩部逐层点亮；摄影机继续向上揭示少女侧脸。`
      : `摄影机从装甲遮挡后重新出现，焦点在少女眼睛与机甲光学系统之间切换；机甲亮起、抬头，少女抬眼并与机甲共同朝向出击舱门。`;
    const eventConsequence = index === 0
      ? '接触建立人机关系，机械确认声响起，少女腕部接口和机甲能源状态产生可见的青蓝光响应。'
      : '青蓝光倒映进少女瞳孔，机甲完成系统同步并与少女形成同向、同节奏的出击准备状态。';
    const continuity = makeContinuity(index);
    const riskFlags = unique([
      '浅景深下手指接触与材质细节容易丢失，需要锁定接触点。',
      '机甲尺度依赖前后景和局部结构，不应在生成中完整展示机甲全貌。',
      hiddenCut ? '遮挡隐藏剪辑必须保持运动方向、光线和音频连续。' : '',
      dialogue.includes('SYSTEM') ? '英文系统文字/对白需在生成或后期中单独确认可读性。' : '',
    ]);
    const seedancePlan = {
      model: options.generator || 'seedance2.5',
      generationMode: 'reference_to_video',
      targetDuration: Math.round(shotDuration * 100) / 100,
      aspectRatio: options.aspectRatio || '16:9',
      clipUnit: 'one_shot_one_reviewable_clip',
      promptTimeline: blocks.map((block) => ({ time: block.time, visual: joinValues(block.fields.visual || []), action: joinValues(block.fields.action || []), camera: joinValues(block.fields.camera || []), sound: joinValues(block.fields.sound || []) })),
      startState: continuity.firstFrame,
      playableChange: visibleEvent,
      endState: continuity.lastFrame,
      continuityStrategy: continuity.editBridge,
      referenceAssignments: references,
      audioStrategy: sound,
      mustPreserve: ['白色驾驶手套与巨大黑色机械手指的体积反差', '深灰、石墨黑、钛灰装甲材质', '青蓝同步光和稳定克制的镜头运动', '少女眼睛中的机甲光学倒影'],
      mustAvoid: ['完整展示机甲全貌', '快速剪辑', '摇晃手持感', '传统从脚到头的商品式扫描', '夸张表情'],
      riskFlags,
      fallbackRoute: hiddenCut ? '将遮挡转为 first_last_frame 连接，必要时拆成两个独立可审阅片段。' : '保留单一主体事件并减少无职责参考输入。',
    };
    return {
      id: shotIds[index],
      scene: sceneId,
      duration: Math.round(shotDuration * 100) / 100,
      purpose: purpose || (index === 0 ? '建立机甲尺度并完成少女与机甲的第一次接触' : '完成同步回应并建立少女与机甲共同出击的 Hero Shot'),
      size: size || (index === 0 ? '超近景 → 面部侧脸特写' : '三分之二侧脸特写 → 英雄特写 → 逆光剪影'),
      camera: camera || (index === 0 ? '85–100mm 长焦感，极浅景深，缓慢 Push-In、Slide、Tilt Up、轻微 Orbit' : '50–85mm 中长焦感，缓慢 Orbit、Rack Focus、Push-In 后切黑'),
      action: action || visibleEvent,
      visibleEvent,
      eventConsequence,
      subjectFocus: index === 0 ? '少女白色驾驶手套、机甲机械手接触点和青蓝能源路径' : '少女眼睛、机甲光学系统、共同朝向和逆光剪影',
      performance: index === 0 ? '少女保持克制平静，第一次揭示侧脸时不夸张表演。' : '少女眼神由平视转为抬眼，嘴角轻微上扬，头部不跟随摄影机。',
      dialogue,
      narration: '',
      sound,
      environment: '机库与出击舱门前的暗空间；后段由白色舱门强光形成逆光。',
      spatialGeography: index === 0 ? '少女手部位于前景，机甲机械手占据主体区域，能源路径向肩部和人物侧脸上移。' : '少女位于前景，机甲头部位于后景；焦点在二者之间转换，最终共同朝向出击舱门。',
      materialEvidence: '深灰、石墨黑、钛灰装甲，关节、连接结构、装甲缝隙和轻微使用痕迹；白色驾驶手套提供材质与尺度反差。',
      lightingCausality: '青蓝能源从接触点沿机甲结构逐层点亮，并反射进入少女瞳孔；出击舱门白光在结尾形成逆光剪影。',
      cameraExecution: { framing: size, movement: camera, lens: index === 0 ? '85–100mm 长焦特写感' : '50–85mm 中长焦特写感', depthOfField: '极浅景深，焦点按叙事目的转移' },
      atmosphereBehavior: '机甲散热气流使少女鬓角附近几根头发轻微摆动；机库空气保持安静、稳定、克制。',
      generationMethod: 'reference_to_video',
      difficulty: hiddenCut || index === 1 ? 'high' : 'medium',
      risks: riskFlags,
      referenceRoles: references,
      assetRequirements: makeAssetRequirements(shotIds[index], characterId, propId, sceneId, audioId),
      seedancePlan,
      continuity,
    };
  });

  if (duration !== null && Math.abs(shots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0) - duration) > 0.2) warnings.push('导入文本的总时长与主体镜头时间范围略有差异，已以镜头时间范围作为实际镜头时长。');
  if (markers.length > 8) warnings.push(`导入识别到 ${markers.length} 个主体镜头，超过受控建议上限，请在生产检查中合并或拆分审阅。`);

  const scene: Record<string, unknown> = {
    id: sceneId,
    name: `${title} · 机甲同步机库`,
    description: '少女通过手套接触、青蓝能源和眼神回应与巨大机甲完成同步，最后共同面向出击舱门。',
    interiorExterior: '内景',
    timeOfDay: '待确认',
    location: '机库 / 出击舱门前',
    characterIds: [characterId],
    propIds: [propId],
    narrativeFunction: '建立少女与机甲的伙伴关系、尺度差异和同步出击钩子。',
    emotion: '克制、期待、同步完成前的静默张力',
    visualAnchors: ['白色驾驶手套指尖接触巨大黑色机械手指', '青蓝能源沿机甲结构点亮', '青蓝光倒映在少女眼睛中', '少女前景与机甲头部后景同框', '出击舱门白光形成逆光剪影'],
    spatialGeography: '前景为少女手部和面部，中景为机甲局部结构，后景为机甲头部与出击舱门；肩甲遮挡负责隐藏剪辑。',
    materialEvidence: '机甲深灰、石墨黑、钛灰装甲具有关节、缝隙、连接件和使用痕迹；白色驾驶手套形成清晰材质反差。',
    lightingCausality: '接触点触发青蓝能源逐级点亮，随后机甲光学系统亮起并反射到少女瞳孔，结尾由舱门白光完成逆光。',
    soundscape: '机械确认声、系统同步音、散热气流、机甲核心重低频和结尾音乐重拍。',
    productionDifficulty: 'high',
    relevantShots: shotIds,
  };
  return { title, duration, sourceText: normalized, scenes: [scene], shots, warnings };
}
