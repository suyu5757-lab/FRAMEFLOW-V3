export const PROMPT_CONTRACT_VERSION = '2.0';
export const PROMPT_WORKFLOW_ID = 'suyu-skill-v2';
export const PROMPT_FIELD_ORDER = [
  'promptIntent', 'referenceStrategy', 'identityAnchor', 'visibleEvent', 'spatialGeography',
  'materialEvidence', 'lightingCausality', 'cameraExecution', 'atmosphereBehavior',
  'continuityChecklist', 'mustPreserve', 'mustAvoid', 'generationNotes',
] as const;

export type PromptRecord = Record<string, unknown>;
export type PromptContext = {
  shots?: PromptRecord[];
  references?: unknown[];
};

const classAliases: Record<string, string> = {
  environment: 'scene', environment_prop: 'scene', environment_state: 'scene', background: 'scene', landscape: 'scene',
  item: 'prop', product: 'prop', vfx: 'prop', weapon_effect: 'prop', mechanical_effect: 'prop',
  dialogue: 'audio', voice: 'audio', mix: 'audio',
};

const keyLabels: Record<string, string> = {
  shotId: '镜头', shotPurpose: '镜头目的', framing: '景别', size: '景别', camera: '机位', focus: '焦点',
  depthOfField: '景深', depth: '景深', action: '动作', actionBeat: '动作节拍', visibleEvent: '可见事件',
  continuity: '连续性', continuityCheckpoint: '连续性检查点', screenDirection: '屏幕方向',
  faceAndExpression: '脸部与表情', hairAndHeadSilhouette: '发型与头部轮廓', costumeAndMaterials: '服装与材质', foreground: '前景', midground: '中景', background: '背景',
  detailAndMaterialBehavior: '细节与材质行为', bodyPoseAction: '身体比例与动作', visibleMoment: '可见瞬间',
  backgroundContext: '背景语境', identityAndPurpose: '地点与功能', spatialLayoutAndGeography: '空间布局与地理',
  foregroundMidgroundBackground: '前景中景背景', setDressingAndFixedAnchors: '陈设与固定锚点',
  materialsAndSurfaceState: '材质与表面状态', detailEvidenceAndAtmosphere: '细节证据与空气',
  lightingWeatherAtmosphere: '光线天气与空气', actionBlockingZones: '动作阻挡区', propPlacementZones: '道具预留区',
  objectIdentity: '物体身份', silhouetteAndProportions: '轮廓与比例', structureAndFunction: '结构与功能',
  materialAndCondition: '材质与状态', colorMarkingsAndLabelPolicy: '颜色标记与文字策略', scaleAndInteraction: '尺度与交互',
  fusionModule: '融合模块', shotUsage: '镜头用途', seedanceReferenceRole: 'Seedance 参考用途',
  styleAndLightingAuthority: '风格与光线权威', characterIdentityLock: '角色身份锁', itemIdentityLock: '道具身份锁',
  sceneIdentityLock: '场景身份锁', interactionAndContact: '交互与接触', placementScaleAndCamera: '位置尺度与摄影机',
  lightingShadowsAndMaterialIntegration: '光影与材质整合', compositionAndDepth: '构图与景深', motionContinuityNotes: '运动连续性',
  stableIdentityAnchors: '稳定身份锚点', shotSpecificDetail: '本镜头细节', optionalIncidentalDetail: '可选偶发细节', mayVary: '允许变化',
  role: '参考角色', controls: '控制范围', mustNotControl: '不控制范围', referenceId: '参考 ID',
  medium: '媒介', palette: '调色', style: '风格', lighting: '光线', opticalEffects: '光学效果', identityAnchors: '身份锚点', assetSpec: '生产规格',
};

function isRecord(value: unknown): value is PromptRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.some(hasValue);
  if (isRecord(value)) return Object.values(value).some(hasValue);
  return true;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('；');
  if (isRecord(value)) return Object.entries(value).filter(([, item]) => hasValue(item)).map(([key, item]) => `${keyLabel(key)}为${renderPromptValue(item)}`).join('；');
  return String(value).trim();
}

function copyRecord(value: unknown): PromptRecord {
  return isRecord(value) ? { ...value } : {};
}

function pathValue(source: PromptRecord, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => isRecord(current) ? current[part] : undefined, source);
}

function first(source: PromptRecord, paths: string[]): unknown {
  for (const path of paths) {
    const value = pathValue(source, path);
    if (hasValue(value)) return value;
  }
  return undefined;
}

function list(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const result: string[] = [];
  for (const item of values) {
    const valueText = text(item);
    if (valueText && !result.includes(valueText)) result.push(valueText);
  }
  return result;
}

function unique(values: unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const valueText = text(value);
    if (valueText && !result.includes(valueText)) result.push(valueText);
  }
  return result;
}

function keyLabel(key: string): string {
  return keyLabels[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, (value) => value.toUpperCase());
}

function mergeDetail(raw: PromptRecord, root: PromptRecord, aliases: Record<string, string[]>): PromptRecord {
  const result = { ...raw };
  for (const [canonical, paths] of Object.entries(aliases)) {
    if (hasValue(result[canonical])) continue;
    const value = first(raw, [canonical, ...paths]) ?? first(root, [canonical, ...paths]);
    if (hasValue(value)) result[canonical] = value;
  }
  return result;
}

function contextShots(context?: PromptContext): PromptRecord[] {
  return (context?.shots || []).filter(isRecord);
}

function shotPlan(value: unknown, context?: PromptContext): PromptRecord[] {
  const existing = Array.isArray(value) ? value.filter(isRecord).map((item) => ({ ...item })) : [];
  if (existing.length) return existing;
  return contextShots(context).map((shot) => ({
    shotId: String(shot.id || shot.shotId || shot.shot_id || ''),
    shotPurpose: shot.purpose || shot.shotPurpose || '',
    framing: shot.size || shot.framing || '',
    camera: shot.camera || '',
    focus: shot.focus || shot.scene || '',
    actionBeat: shot.action || shot.actionBeat || '',
    screenDirection: shot.screenDirection || '',
    continuity: shot.continuity || shot.lastFrame || shot.firstFrame || '',
  })).filter((item) => Boolean(item.shotId));
}

export function canonicalAssetClass(assetClass?: string): string {
  const value = String(assetClass || 'unknown').trim().toLowerCase();
  return classAliases[value] || value;
}

export function normalizePromptPack(assetClass: string | undefined, rawPack: unknown = {}, options: { identityAnchor?: unknown; mustPreserve?: unknown; mustAvoid?: unknown; context?: PromptContext } = {}): PromptRecord {
  const cls = canonicalAssetClass(assetClass);
  const source = copyRecord(rawPack);
  const character = mergeDetail(copyRecord(source.characterDetails), cls === 'character' ? source : {}, {
    faceAndExpression: ['faceExpression', 'face', 'face_identity'], hairAndHeadSilhouette: ['hairSilhouette', 'hair', 'headSilhouette'],
    costumeAndMaterials: ['wardrobeMaterial', 'wardrobe', 'costume', 'materials'], detailAndMaterialBehavior: ['characterDetail', 'microExpressions', 'materialBehavior'],
    bodyPoseAction: ['bodyAndPosture', 'poseAction', 'body', 'action'], visibleMoment: ['visibleEvent', 'event', 'actionBeat'],
    backgroundContext: ['sceneContext', 'background'], stableAnchors: ['identityAnchor', 'identity'], mayVary: ['variableDetails', 'optionalDetails'],
  });
  const scene = mergeDetail(copyRecord(source.sceneDetails), cls === 'scene' ? source : {}, {
    identityAndPurpose: ['locationAndFunction', 'location', 'sceneIdentity'], spatialLayoutAndGeography: ['geography', 'layout', 'spatialLayout'],
    foregroundMidgroundBackground: ['foreground', 'midground', 'background', 'depthLayers'], setDressingAndFixedAnchors: ['propsAndSetDressing', 'props', 'landmarks', 'fixedAnchors'],
    materialsAndSurfaceState: ['surfacesAndMaterials', 'surfaceMaterials', 'materials', 'surfaceState'], detailEvidenceAndAtmosphere: ['sceneDetailEvidence', 'atmosphereBehavior'],
    lightingWeatherAtmosphere: ['lightingAndAtmosphere', 'lightingAtmosphere', 'lighting', 'weather'], actionBlockingZones: ['actionSpace', 'blocking', 'blockingMap'],
    propPlacementZones: ['propPlacement', 'placementZones'], continuityLocks: ['continuityAnchors', 'continuity'], stableAnchors: ['continuityAnchors', 'landmarks'],
    mayVary: ['variableDetails', 'optionalDetails'],
  });
  const propSource = copyRecord(source.propDetails || source.itemDetails);
  const prop = mergeDetail(propSource, cls === 'prop' ? source : {}, {
    objectIdentity: ['identity', 'identityAnchor', 'category', 'function'], silhouetteAndProportions: ['silhouette', 'proportions'],
    structureAndFunction: ['structure', 'functionalDetails'], materialAndCondition: ['materials', 'materialFinish', 'condition', 'state'],
    detailAndMaterialBehavior: ['detailEvidence', 'materialBehavior'], colorMarkingsAndLabelPolicy: ['color', 'markings', 'labelPolicy'],
    scaleAndInteraction: ['scale', 'interaction', 'contact'], mayVary: ['variableDetails', 'optionalDetails'],
  });
  const fusion = mergeDetail(copyRecord(source.fusionDetails), cls === 'fusion' ? source : {}, {
    fusionModule: ['module'], shotUsage: ['usage', 'shot_usage'], seedanceReferenceRole: ['referenceRole', 'seedance_role'], styleAndLightingAuthority: ['styleAuthority', 'lightingAuthority'],
    characterIdentityLock: ['characterLock'], itemIdentityLock: ['propIdentityLock', 'itemLock'], sceneIdentityLock: ['sceneLock'],
    characterDetailAndMaterialBehavior: ['characterDetail'], sceneDetailAndAtmosphere: ['sceneDetail', 'sceneDetailEvidence'], interactionAndContact: ['interaction', 'contact'],
    placementScaleAndCamera: ['placement', 'scale', 'camera'], lightingShadowsAndMaterialIntegration: ['lightingIntegration', 'shadows', 'materialIntegration'],
    compositionAndDepth: ['composition', 'depth', 'occlusion'], motionContinuityNotes: ['motionContinuity', 'continuity'],
  });
  const identity = text(options.identityAnchor) || text(first(source, ['identityAnchor', 'identityLock', 'identity', 'identity_anchors']));
  const preserve = list(options.mustPreserve !== undefined ? options.mustPreserve : first(source, ['mustPreserve', 'preserve']));
  const avoid = list(options.mustAvoid !== undefined ? options.mustAvoid : first(source, ['mustAvoid', 'negativePrompt', 'avoid']));
  const references = copyRecord(first(source, ['referenceStrategy', 'reference_strategy']));
  const referenceRoles = first(source, ['referenceRoles', 'referenceImageRoles', 'reference_image_roles']);
  if (hasValue(referenceRoles) && !hasValue(references.roles)) references.roles = referenceRoles;
  if (hasValue(options.context?.references) && !hasValue(references.roles)) references.roles = options.context?.references;
  if (!Object.keys(references).length) references.status = 'no_reference_assets';
  const visualStyleSource = first(source, ['visualStyle', 'style']);
  const visualStyle = copyRecord(visualStyleSource);
  if (!Object.keys(visualStyle).length && hasValue(visualStyleSource)) visualStyle.style = visualStyleSource;
  if (!Object.keys(visualStyle).length && hasValue(first(source, ['lighting', 'renderingStyle']))) visualStyle.lighting = first(source, ['lighting']);
  const continuity = list(first(source, ['continuityChecklist', 'continuity', 'continuityLocks']));
  const registry = copyRecord(first(source, ['detailAnchorRegistry', 'detailAnchors', 'anchorRegistry']));
  if (identity && !hasValue(registry.stableIdentityAnchors)) registry.stableIdentityAnchors = identity;
  const shotSpecific = first(source, ['shotSpecificDetail', 'shot_specific_detail']);
  if (hasValue(shotSpecific) && !hasValue(registry.shotSpecificDetail)) registry.shotSpecificDetail = shotSpecific;
  const optional = first(source, ['optionalDetails', 'optionalDetail']);
  if (hasValue(optional) && !hasValue(registry.optionalIncidentalDetail)) registry.optionalIncidentalDetail = optional;
  const mayVary = first(source, ['mayVary', 'variableDetails']);
  if (hasValue(mayVary) && !hasValue(registry.mayVary)) registry.mayVary = mayVary;
  const visibleEvent = first(source, ['visibleEvent', 'event', 'actionBeat', 'bodyAction'])
    || (cls === 'character' ? first(character, ['visibleMoment', 'bodyPoseAction']) : cls === 'scene' ? first(scene, ['detailEvidenceAndAtmosphere']) : first(prop, ['materialAndCondition']));
  return {
    ...source,
    schemaVersion: PROMPT_CONTRACT_VERSION,
    workflow: PROMPT_WORKFLOW_ID,
    assetType: cls,
    promptIntent: text(first(source, ['promptIntent', 'intent', 'purpose', 'generationGoal'])),
    identityAnchor: identity,
    identityLock: text(first(source, ['identityLock', 'identityAnchor', 'identity'])) || identity,
    visibleEvent: text(visibleEvent),
    spatialGeography: first(source, ['spatialGeography', 'geography', 'spatialLayout', 'layout']) || (cls === 'scene' ? scene.spatialLayoutAndGeography || '' : ''),
    materialEvidence: first(source, ['materialEvidence', 'materials', 'surfaceMaterials']) || (cls === 'scene' ? scene.materialsAndSurfaceState || '' : cls === 'prop' ? prop.materialAndCondition || '' : ''),
    lightingCausality: first(source, ['lightingCausality', 'lighting', 'lightingAtmosphere']) || (cls === 'scene' ? scene.lightingWeatherAtmosphere || '' : ''),
    cameraExecution: first(source, ['cameraExecution', 'camera', 'compositionCamera']) || {},
    atmosphereBehavior: first(source, ['atmosphereBehavior', 'atmosphere', 'weather']) || (cls === 'scene' ? scene.detailEvidenceAndAtmosphere || '' : ''),
    characterDetails: character, sceneDetails: scene, propDetails: prop, itemDetails: prop, fusionDetails: fusion,
    shotPlan: shotPlan(first(source, ['shotPlan', 'shots', 'shot_plan']), options.context), visualStyle, referenceStrategy: references,
    detailAnchorRegistry: registry, continuityChecklist: continuity, mustPreserve: preserve, mustAvoid: avoid, negativePrompt: avoid,
    generationNotes: text(first(source, ['generationNotes', 'notes', 'generation_notes'])), suggestedSize: text(first(source, ['suggestedSize', 'size', 'suggested_size'])),
  };
}

export function renderPromptValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  if (Array.isArray(value)) return value.map(renderPromptValue).filter(Boolean).join('、');
  if (isRecord(value)) return Object.entries(value).filter(([, item]) => hasValue(item)).map(([key, item]) => `${keyLabel(key)}为${renderPromptValue(item)}`).join('；');
  return String(value).trim();
}

function sentence(value: unknown, prefix: string): string {
  const rendered = renderPromptValue(value);
  if (!rendered) return '';
  const full = rendered.startsWith(prefix) ? rendered : `${prefix}${rendered}`;
  return `${full.replace(/[。；]+$/g, '')}。`;
}

function shotProse(plan: PromptRecord[]): { event: string; camera: string; continuity: string } {
  const event: string[] = [], camera: string[] = [], continuity: string[] = [];
  for (const shot of plan) {
    const tag = shot.shotId ? `镜头 ${String(shot.shotId)} ` : '镜头 ';
    const action = renderPromptValue(shot.actionBeat || shot.action || shot.visibleEvent);
    if (action) event.push(`${tag}可见动作是${action}`);
    const cameraValue = renderPromptValue({ 景别: shot.framing || shot.size, 机位: shot.camera, 焦点: shot.focus, 景深: shot.depthOfField || shot.depth });
    if (cameraValue) camera.push(`${tag}${cameraValue}`);
    const continuityValue = renderPromptValue(shot.continuity || shot.continuityCheckpoint || shot.screenDirection);
    if (continuityValue) continuity.push(`${tag}连续性检查为${continuityValue}`);
  }
  return { event: event.join('；'), camera: camera.join('；'), continuity: continuity.join('；') };
}

function hasStructuredContent(pack: PromptRecord): boolean {
  return Object.entries(pack).some(([key, value]) => key !== 'schemaVersion' && key !== 'workflow' && key !== 'assetType' && key !== 'promptQuality' && !(key === 'referenceStrategy' && JSON.stringify(value) === JSON.stringify({ status: 'no_reference_assets' })) && hasValue(value));
}

export function buildNaturalLanguagePrompt(assetClass: string | undefined, rawPack: unknown, fallbackPrompt = '', context?: PromptContext): string {
  const cls = canonicalAssetClass(assetClass);
  const pack = normalizePromptPack(cls, rawPack, { context });
  const fallback = String(fallbackPrompt || '').trim();
  if (!hasStructuredContent(pack)) return fallback;
  const plan = Array.isArray(pack.shotPlan) ? pack.shotPlan.filter(isRecord) : [];
  const shot = shotProse(plan);
  const paragraphs: string[] = [];
  const intent = text(pack.promptIntent);
  if (intent) paragraphs.push(sentence(intent, '这张图/这个镜头的生产目标是：'));
  const roles = renderPromptValue((pack.referenceStrategy as PromptRecord | undefined)?.roles);
  if (roles) paragraphs.push(sentence(roles, '参考图角色保持明确：'));
  const identity = unique([
    pack.identityAnchor, pack.identityLock,
    cls === 'character' ? (pack.characterDetails as PromptRecord).faceAndExpression : undefined,
    cls === 'character' ? (pack.characterDetails as PromptRecord).hairAndHeadSilhouette : undefined,
    cls === 'character' ? (pack.characterDetails as PromptRecord).costumeAndMaterials : undefined,
    cls === 'character' ? (pack.characterDetails as PromptRecord).bodyPoseAction : undefined,
    cls === 'scene' ? (pack.sceneDetails as PromptRecord).identityAndPurpose : undefined,
    cls === 'scene' ? (pack.sceneDetails as PromptRecord).setDressingAndFixedAnchors : undefined,
    cls === 'prop' ? (pack.propDetails as PromptRecord).objectIdentity : undefined,
    cls === 'prop' ? (pack.propDetails as PromptRecord).silhouetteAndProportions : undefined,
    cls === 'prop' ? (pack.propDetails as PromptRecord).structureAndFunction : undefined,
    cls === 'fusion' ? (pack.fusionDetails as PromptRecord).characterIdentityLock : undefined,
    cls === 'fusion' ? (pack.fusionDetails as PromptRecord).itemIdentityLock : undefined,
    cls === 'fusion' ? (pack.fusionDetails as PromptRecord).sceneIdentityLock : undefined,
  ]);
  if (identity.length) paragraphs.push(sentence(identity.join('；'), '保持以下身份与结构锚点不变：'));
  const event = unique([text(pack.visibleEvent), text(pack.eventConsequence), shot.event, cls === 'character' ? text((pack.characterDetails as PromptRecord).visibleMoment) : '', cls === 'fusion' ? text((pack.fusionDetails as PromptRecord).interactionAndContact) : '']).join('；');
  if (event) paragraphs.push(sentence(event, '此刻画面中只发生一个主事件：'));
  const spatial = unique([
    pack.spatialGeography,
    cls === 'scene' ? (pack.sceneDetails as PromptRecord).spatialLayoutAndGeography : undefined,
    cls === 'scene' ? (pack.sceneDetails as PromptRecord).foregroundMidgroundBackground : undefined,
    cls === 'scene' ? (pack.sceneDetails as PromptRecord).actionBlockingZones : undefined,
    cls === 'scene' ? (pack.sceneDetails as PromptRecord).propPlacementZones : undefined,
    cls === 'character' ? (pack.characterDetails as PromptRecord).backgroundContext : undefined,
    cls === 'fusion' ? (pack.fusionDetails as PromptRecord).placementScaleAndCamera : undefined,
    cls === 'fusion' ? (pack.fusionDetails as PromptRecord).compositionAndDepth : undefined,
  ]);
  if (spatial.length) paragraphs.push(sentence(spatial.join('；'), '空间关系与地理保持清晰：'));
  const material = unique([
    pack.materialEvidence,
    cls === 'character' ? (pack.characterDetails as PromptRecord).detailAndMaterialBehavior : undefined,
    cls === 'character' ? (pack.characterDetails as PromptRecord).costumeAndMaterials : undefined,
    cls === 'scene' ? (pack.sceneDetails as PromptRecord).materialsAndSurfaceState : undefined,
    cls === 'scene' ? (pack.sceneDetails as PromptRecord).detailEvidenceAndAtmosphere : undefined,
    cls === 'prop' ? (pack.propDetails as PromptRecord).materialAndCondition : undefined,
    cls === 'prop' ? (pack.propDetails as PromptRecord).detailAndMaterialBehavior : undefined,
    cls === 'fusion' ? (pack.fusionDetails as PromptRecord).characterDetailAndMaterialBehavior : undefined,
    cls === 'fusion' ? (pack.fusionDetails as PromptRecord).sceneDetailAndAtmosphere : undefined,
    cls === 'fusion' ? (pack.fusionDetails as PromptRecord).lightingShadowsAndMaterialIntegration : undefined,
  ]);
  if (material.length) paragraphs.push(sentence(material.join('；'), '材质证据与表面状态表现为：'));
  const lighting = text(pack.lightingCausality) || (cls === 'scene' ? text((pack.sceneDetails as PromptRecord).lightingWeatherAtmosphere) : cls === 'fusion' ? text((pack.fusionDetails as PromptRecord).styleAndLightingAuthority) : '');
  if (lighting) paragraphs.push(sentence(lighting, '光线必须有明确来源、方向、色温和可见后果：'));
  const camera = text(pack.cameraExecution) || shot.camera;
  if (camera) paragraphs.push(sentence(camera, '摄影机执行为：'));
  const style = text(pack.visualStyle);
  if (style) paragraphs.push(sentence(style, '视觉媒介与渲染克制为：'));
  const atmosphere = text(pack.atmosphereBehavior);
  if (atmosphere) paragraphs.push(sentence(atmosphere, '空气、天气和克制的视觉效果表现为：'));
  const continuity = list(pack.continuityChecklist);
  if (shot.continuity) continuity.push(shot.continuity);
  const registry = isRecord(pack.detailAnchorRegistry) ? pack.detailAnchorRegistry : {};
  if (hasValue(registry.mayVary)) continuity.push(`允许变化：${renderPromptValue(registry.mayVary)}`);
  if (continuity.length) paragraphs.push(sentence(continuity.join('；'), '连续性检查：'));
  const preserve = list(pack.mustPreserve);
  if (preserve.length) paragraphs.push(sentence(preserve.join('、'), '必须保留：'));
  const avoid = list(pack.mustAvoid || pack.negativePrompt);
  if (avoid.length) paragraphs.push(sentence(avoid.join('、'), '必须避免：'));
  const notes = [text(pack.generationNotes), pack.suggestedSize ? `建议尺寸为${text(pack.suggestedSize)}` : ''].filter(Boolean).join('；');
  if (notes) paragraphs.push(sentence(notes, '生成说明：'));
  let compiled = paragraphs.filter(Boolean).join('\n\n');
  if (fallback && !compiled.includes(fallback)) compiled = compiled ? `${compiled}\n\n同时满足以下补充制作要求：${fallback}` : fallback;
  return compiled.trim();
}

export function canonicalizePromptOutput(assetClass: string | undefined, rawPack: unknown, prompt: string, context?: PromptContext): { prompt: string; promptPack: PromptRecord; promptContractVersion: string; promptWorkflow: string; promptFieldOrder: readonly string[] } {
  const promptPack = normalizePromptPack(assetClass, rawPack, { context });
  return { prompt: buildNaturalLanguagePrompt(assetClass, promptPack, prompt, context), promptPack, promptContractVersion: PROMPT_CONTRACT_VERSION, promptWorkflow: PROMPT_WORKFLOW_ID, promptFieldOrder: PROMPT_FIELD_ORDER };
}
