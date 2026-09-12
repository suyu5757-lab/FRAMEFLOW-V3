export const PROMPT_CONTRACT_VERSION = '2.0';
export const PROMPT_WORKFLOW_ID = 'suyu-skill-v2';
export const PROMPT_FIELD_ORDER = [
  'promptIntent', 'referenceStrategy', 'generationReferenceAssets', 'identityAnchor', 'visibleEvent', 'spatialGeography',
  'materialEvidence', 'lightingCausality', 'cameraExecution', 'atmosphereBehavior',
  'continuityChecklist', 'mustPreserve', 'mustAvoid', 'generationNotes',
] as const;
const PROMPT_SUPPLEMENT_MARKER = '同时满足以下补充制作要求：';

export type PromptRecord = Record<string, unknown>;
export type PromptContext = {
  shots?: PromptRecord[];
  references?: unknown[];
};

export const AUDIO_PROMPT_SCHEMA_VERSION = 'minimax-speech-audio-v2';
export const AUDIO_PROMPT_FIELD_ORDER = [
  'sourceText', 'providerText', 'textStatus', 'voiceSource', 'voiceIdentity', 'language', 'locale', 'dialect',
  'providerVoiceId', 'providerVoiceName', 'providerRegion', 'performanceDirection',
  'emotion', 'intensity', 'pace', 'pausePlan', 'pronunciation', 'provider', 'model', 'voiceId',
  'speed', 'pitch', 'volume', 'languageBoost', 'format', 'targetDuration', 'relevantShots',
  'continuityChecklist', 'mustPreserve', 'mustAvoid',
] as const;
const audioConfirmedTextStatuses = new Set(['confirmed', 'user-confirmed', 'approved', 'locked', 'final']);

export type MiniMaxWebPromptPackage = {
  schemaVersion: string;
  provider: 'minimax';
  operation: string;
  sourceText: string;
  providerText: string;
  copyText: string;
  candidateText: string;
  textStatus: string;
  direction: string;
  settings: Record<string, string>;
  pausePlan: unknown;
  pronunciation: unknown;
  soundTags: unknown;
  targetDuration: unknown;
  relevantShots: unknown;
  candidates: Array<{ shotId: string; kind: string; text: string }>;
  continuity: string[];
  mustPreserve: string[];
  mustAvoid: string[];
  warnings: string[];
};

const audioLocaleLanguageBoosts: Record<string, string> = {
  ja: 'Japanese', 'ja-jp': 'Japanese', zh: 'Chinese', 'zh-cn': 'Chinese', 'zh-tw': 'Chinese',
  en: 'English', 'en-us': 'English', 'en-gb': 'English', ko: 'Korean', 'ko-kr': 'Korean',
  fr: 'French', 'fr-fr': 'French', de: 'German', 'de-de': 'German', es: 'Spanish', 'es-es': 'Spanish',
  it: 'Italian', 'it-it': 'Italian', pt: 'Portuguese', 'pt-br': 'Portuguese', 'pt-pt': 'Portuguese',
  ru: 'Russian', 'ru-ru': 'Russian', ar: 'Arabic', tr: 'Turkish', nl: 'Dutch', vi: 'Vietnamese',
  id: 'Indonesian', 'id-id': 'Indonesian', th: 'Thai', 'th-th': 'Thai', ms: 'Malay', 'ms-my': 'Malay',
  fil: 'Filipino', 'fil-ph': 'Filipino', uk: 'Ukrainian', 'uk-ua': 'Ukrainian', pl: 'Polish', 'pl-pl': 'Polish',
  ro: 'Romanian', 'ro-ro': 'Romanian', cs: 'Czech', 'cs-cz': 'Czech', el: 'Greek', 'el-gr': 'Greek',
  hu: 'Hungarian', 'hu-hu': 'Hungarian', sv: 'Swedish', 'sv-se': 'Swedish', da: 'Danish', 'da-dk': 'Danish',
  fi: 'Finnish', 'fi-fi': 'Finnish', no: 'Norwegian', 'no-no': 'Norwegian', sk: 'Slovak', 'sk-sk': 'Slovak',
  bg: 'Bulgarian', 'bg-bg': 'Bulgarian', hr: 'Croatian', 'hr-hr': 'Croatian', ta: 'Tamil', 'ta-in': 'Tamil',
  te: 'Telugu', 'te-in': 'Telugu', hi: 'Hindi', 'hi-in': 'Hindi', he: 'Hebrew', 'he-il': 'Hebrew',
  fa: 'Persian', 'fa-ir': 'Persian', bn: 'Bengali', 'bn-bd': 'Bengali', af: 'Afrikaans', 'af-za': 'Afrikaans',
  ca: 'Catalan', 'ca-es': 'Catalan', sr: 'Serbian', 'sr-rs': 'Serbian',
};

function languageBoostForAudio(locale: unknown, language: unknown, explicit: unknown): string | null {
  const explicitText = text(explicit);
  const languageText = text(language);
  const normalized = text(locale).toLowerCase().replaceAll('_', '-');
  const localeBoost = audioLocaleLanguageBoosts[normalized] || audioLocaleLanguageBoosts[normalized.split('-', 1)[0]];
  if (localeBoost) return localeBoost;
  if (languageText === 'Japanese' || /日语|日本語/i.test(languageText)) return 'Japanese';
  if (languageText === 'Chinese' || /中文|汉语|普通话/i.test(languageText)) return 'Chinese';
  if (explicitText && !['Chinese', 'auto', 'Auto', 'automatic', 'Automatic'].includes(explicitText)) return explicitText;
  const languageNormalized = languageText.toLowerCase().replaceAll('_', '-');
  return audioLocaleLanguageBoosts[languageNormalized] || audioLocaleLanguageBoosts[languageNormalized.split('-', 1)[0]] || null;
}

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

function spokenText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (isRecord(value)) {
    for (const key of ['text', 'content', 'line', 'spokenText', 'spoken_text', 'transcript']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return '';
  }
  if (Array.isArray(value)) return value.map(spokenText).filter(Boolean).join('\n');
  return '';
}

function audioFirst(source: PromptRecord, rawAudio: PromptRecord, keys: string[]): unknown {
  const nested = first({ audioDetails: rawAudio }, keys.map((key) => `audioDetails.${key}`));
  return hasValue(nested) ? nested : first(source, keys);
}

function audioTextStatus(value: unknown, sourceText: string): string {
  if (typeof value === 'boolean') return value && sourceText ? 'confirmed' : sourceText ? 'candidate' : 'missing';
  const raw = String(value || '').trim().toLowerCase().replaceAll('_', '-').replaceAll(' ', '-');
  const aliases: Record<string, string> = {
    'user-confirmed-text': 'confirmed', 'confirmed-text': 'confirmed', finalized: 'final',
    provisional: 'candidate', pending: 'candidate', 'user-confirmation-required': 'candidate', 'needs-confirmation': 'candidate',
  };
  const normalized = aliases[raw] || raw;
  if (audioConfirmedTextStatuses.has(normalized)) return sourceText ? 'confirmed' : 'missing';
  if (['candidate', 'conflict', 'missing'].includes(normalized)) return normalized === 'candidate' && !sourceText ? 'missing' : normalized;
  return sourceText ? 'candidate' : 'missing';
}

function looksLikeAudioMetadata(value: string): boolean {
  const textValue = String(value || '').trim();
  if (!textValue) return false;
  const markers = [
    'FRAMEFLOW', 'Prompt Contract', '可直接执行的自然语言 Prompt', '资产身份/生产规格',
    '同时满足以下补充制作要求', '连续性检查', '必须保留', '必须避免', '生成说明',
    '执行边界', '不制作最终音频', '镜头依赖', 'MiniMax Speech 2.8 Web：', '等待用户确认', '待用户确认', '当前台词为空',
  ];
  return textValue.length > 240 || markers.some((marker) => textValue.includes(marker));
}

function normalizeAudioDetails(source: PromptRecord, enabled: boolean): PromptRecord {
  if (!enabled) return {};
  const rawAudio = copyRecord(first(source, ['audioDetails', 'audio_details']));
  const sourceText = spokenText(audioFirst(source, rawAudio, ['sourceText', 'source_text', 'spokenText', 'spoken_text', 'dialogueText', 'dialogue_text', 'line', 'transcript', 'text']));
  const providerText = spokenText(audioFirst(source, rawAudio, ['providerText', 'provider_text', 'providerInput', 'provider_input'])) || sourceText;
  const details: PromptRecord = { ...rawAudio };
  details.schemaVersion = AUDIO_PROMPT_SCHEMA_VERSION;
  details.operation = String(audioFirst(source, rawAudio, ['operation', 'audioOperation', 'audio_operation']) || 'tts');
  details.sourceText = sourceText;
  details.providerText = providerText;
  details.textStatus = audioTextStatus(audioFirst(source, rawAudio, ['textStatus', 'text_status', 'dialogueStatus', 'dialogue_status', 'sourceTextStatus']), sourceText);
  const setIfMissing = (key: string, value: unknown) => { if (!hasValue(details[key]) && hasValue(value)) details[key] = value; };
  setIfMissing('voiceSource', audioFirst(source, rawAudio, ['voiceSource', 'voice_source', 'sourceType', 'source_type']) || 'system-preset');
  setIfMissing('voiceIdentity', audioFirst(source, rawAudio, ['voiceIdentity', 'voice_identity', 'voiceProfile', 'voice_profile', 'voiceTraits', 'voice_traits']) || text(first(source, ['identityAnchor', 'identityLock', 'identity'])));
  setIfMissing('language', audioFirst(source, rawAudio, ['language', 'lang']));
  setIfMissing('locale', audioFirst(source, rawAudio, ['locale', 'languageLocale', 'language_locale']));
  setIfMissing('dialect', audioFirst(source, rawAudio, ['dialect', 'accent']));
  setIfMissing('performanceDirection', audioFirst(source, rawAudio, ['performanceDirection', 'performance_direction', 'voiceDirection', 'voice_direction', 'instructions', 'delivery', 'direction']));
  setIfMissing('emotion', audioFirst(source, rawAudio, ['emotion', 'mood']));
  setIfMissing('intensity', audioFirst(source, rawAudio, ['intensity', 'energy']));
  setIfMissing('pace', audioFirst(source, rawAudio, ['pace', 'register', 'speechRate', 'speech_rate']));
  setIfMissing('pausePlan', audioFirst(source, rawAudio, ['pausePlan', 'pause_plan', 'pauses', 'pause']));
  setIfMissing('pronunciation', audioFirst(source, rawAudio, ['pronunciation', 'pronunciationDict', 'pronunciation_dict', 'pronunciationNotes', 'pronunciation_notes']));
  setIfMissing('soundTags', audioFirst(source, rawAudio, ['soundTags', 'sound_tags', 'interjections', 'nonVerbal', 'non_verbal']));
  setIfMissing('distance', audioFirst(source, rawAudio, ['distance', 'projectionDistance', 'projection_distance']));
  setIfMissing('targetDuration', audioFirst(source, rawAudio, ['targetDuration', 'target_duration', 'duration']));
  setIfMissing('provider', audioFirst(source, rawAudio, ['provider']) || 'minimax');
  setIfMissing('model', audioFirst(source, rawAudio, ['model']) || 'speech-2.8-hd');
  setIfMissing('voiceId', audioFirst(source, rawAudio, ['voiceId', 'voice_id', 'providerVoiceId', 'provider_voice_id']));
  setIfMissing('providerVoiceId', audioFirst(source, rawAudio, ['providerVoiceId', 'provider_voice_id', 'voiceId', 'voice_id']));
  setIfMissing('providerVoiceName', audioFirst(source, rawAudio, ['providerVoiceName', 'provider_voice_name']));
  setIfMissing('providerRegion', audioFirst(source, rawAudio, ['providerRegion', 'provider_region', 'region']) || 'cn');
  setIfMissing('speed', hasValue(audioFirst(source, rawAudio, ['speed'])) ? audioFirst(source, rawAudio, ['speed']) : 1);
  setIfMissing('pitch', hasValue(audioFirst(source, rawAudio, ['pitch'])) ? audioFirst(source, rawAudio, ['pitch']) : 0);
  setIfMissing('volume', hasValue(audioFirst(source, rawAudio, ['volume', 'vol'])) ? audioFirst(source, rawAudio, ['volume', 'vol']) : 1);
  const languageBoost = languageBoostForAudio(details.locale, details.language, audioFirst(source, rawAudio, ['languageBoost', 'language_boost']));
  if (!hasValue(details.languageBoost)) details.languageBoost = languageBoost;
  setIfMissing('format', audioFirst(source, rawAudio, ['format', 'audioFormat', 'audio_format']) || 'wav');
  setIfMissing('sampleRate', audioFirst(source, rawAudio, ['sampleRate', 'sample_rate']));
  setIfMissing('bitrate', audioFirst(source, rawAudio, ['bitrate']));
  setIfMissing('channel', audioFirst(source, rawAudio, ['channel', 'channels']));
  setIfMissing('stems', audioFirst(source, rawAudio, ['stems', 'tracks', 'mixStems', 'mix_stems']));
  return details;
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
  const audioDetails = normalizeAudioDetails(source, cls === 'audio' || hasValue(first(source, ['audioDetails', 'audio_details'])));
  const identity = text(options.identityAnchor) || text(first(source, ['identityAnchor', 'identityLock', 'identity', 'identity_anchors']));
  if (identity && !hasValue(audioDetails.voiceIdentity)) audioDetails.voiceIdentity = identity;
  const preserve = list(options.mustPreserve !== undefined ? options.mustPreserve : first(source, ['mustPreserve', 'preserve']));
  const avoid = list(options.mustAvoid !== undefined ? options.mustAvoid : first(source, ['mustAvoid', 'negativePrompt', 'avoid']));
  const references = copyRecord(first(source, ['referenceStrategy', 'reference_strategy']));
  const referenceRoles = first(source, ['referenceRoles', 'referenceImageRoles', 'reference_image_roles']);
  if (hasValue(referenceRoles) && !hasValue(references.roles)) references.roles = referenceRoles;
  if (hasValue(options.context?.references) && !hasValue(references.roles)) references.roles = options.context?.references;
  if (!Object.keys(references).length) references.status = 'no_reference_assets';
  const rawGenerationReferences = first(source, ['generationReferenceAssets', 'generation_reference_assets', 'referenceAssetIds', 'reference_asset_ids', 'imageReferenceAssets', 'image_reference_assets']) || references.roles || references.references || [];
  const generationReferenceAssets: PromptRecord[] = [];
  const seenReferenceIds = new Set<string>();
  const collectGenerationReferences = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(collectGenerationReferences); return; }
    if (typeof value === 'string') {
      const assetId = value.trim();
      if (assetId && !seenReferenceIds.has(assetId)) { seenReferenceIds.add(assetId); generationReferenceAssets.push({ assetId, name: assetId }); }
      return;
    }
    if (!isRecord(value)) return;
    const assetId = String(value.assetId || value.asset_id || value.referenceId || value.reference_id || value.logicalAssetId || value.logical_asset_id || value.id || '').trim();
    if (assetId) {
      if (!seenReferenceIds.has(assetId)) { seenReferenceIds.add(assetId); generationReferenceAssets.push({ ...value, assetId, name: value.name || value.label || assetId }); }
      return;
    }
    ['items', 'roles', 'references', 'referenceRoles', 'reference_roles', 'generationReferenceAssets', 'generation_reference_assets'].forEach((key) => collectGenerationReferences(value[key]));
  };
  collectGenerationReferences(rawGenerationReferences);
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
    audioDetails,
    shotPlan: shotPlan(first(source, ['shotPlan', 'shots', 'shot_plan']), options.context), visualStyle, referenceStrategy: references, generationReferenceAssets,
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

function audioContextCandidates(context?: PromptContext): Array<{ shotId: string; kind: string; text: string }> {
  return contextShots(context).flatMap((shot) => {
    const shotId = String(shot.id || shot.shotId || shot.shot_id || '').trim();
    const rawDialogue = first(shot, ['dialogue', 'dialogues', 'narration', 'voiceover', 'voice_over', 'line', 'lines']);
    const spoken = spokenText(rawDialogue);
    if (!spoken) return [];
    const kind = hasValue(first(shot, ['narration', 'voiceover', 'voice_over'])) ? '旁白' : '对白';
    return [{ shotId, kind, text: spoken }];
  });
}

export function buildMiniMaxWebPromptPackage(rawPack: unknown, fallbackPrompt = '', context?: PromptContext): MiniMaxWebPromptPackage {
  const pack = normalizePromptPack('audio', rawPack, { context });
  const details = isRecord(pack.audioDetails) ? pack.audioDetails : {};
  let sourceText = spokenText(details.sourceText);
  let providerText = spokenText(details.providerText) || sourceText;
  const fallback = String(fallbackPrompt || '').trim();
  let textStatus = audioTextStatus(details.textStatus, sourceText);
  if (!sourceText && fallback && !looksLikeAudioMetadata(fallback)) {
    sourceText = fallback;
    providerText = fallback;
    textStatus = 'candidate';
  }
  const candidates = audioContextCandidates(context);
  const uniqueCandidateTexts = [...new Set(candidates.map((item) => item.text))];
  const contextShotIds = contextShots(context).map((shot) => String(shot.id || shot.shotId || shot.shot_id || '').trim()).filter(Boolean);
  const directionParts = [
    text(details.voiceIdentity), text(details.language), text(details.dialect), text(details.performanceDirection),
    hasValue(details.emotion) ? `情绪为${text(details.emotion)}` : '',
    hasValue(details.intensity) ? `强度为${text(details.intensity)}` : '',
    hasValue(details.pace) ? `语速为${text(details.pace)}` : '',
    hasValue(details.distance) ? `投射距离为${text(details.distance)}` : '',
  ].filter(Boolean);
  const warnings: string[] = [];
  if (textStatus !== 'confirmed') warnings.push('朗读文本尚未标记为 confirmed；请先确认每个镜头的唯一台词，再复制到 MiniMax Web。');
  if (uniqueCandidateTexts.length > 1) warnings.push('关联镜头存在多条不同文本；必须拆成多次生成，不能拼成一段。');
  if (contextShotIds.length > candidates.length && candidates.length > 0) warnings.push('部分关联镜头没有明确朗读文本；请逐镜头确认台词或明确该镜头无对白。');
  if (textStatus === 'conflict') warnings.push('当前文本存在镜头/台词冲突，暂不提供可复制的朗读文本。');
  return {
    schemaVersion: AUDIO_PROMPT_SCHEMA_VERSION,
    provider: 'minimax',
    operation: text(details.operation) || 'tts',
    sourceText,
    providerText,
    copyText: providerText && audioConfirmedTextStatuses.has(textStatus) ? providerText : '',
    candidateText: providerText && !audioConfirmedTextStatuses.has(textStatus) ? providerText : '',
    textStatus,
    direction: directionParts.join('；'),
    settings: {
      provider: text(details.provider) || 'minimax',
      model: text(details.model) || 'speech-2.8-hd',
      voiceId: text(details.providerVoiceId) || text(details.voiceId) || '在 MiniMax Web 中选择固定系统音色',
      voiceName: text(details.providerVoiceName) || '以实际试听结果为准',
      region: text(details.providerRegion) || 'cn',
      languageBoost: text(details.languageBoost) || '自动识别（未发送固定语言增强）',
      emotion: text(details.emotion) || '留空（先建立基础音色基线）',
      speed: text(details.speed) || '1.0',
      pitch: text(details.pitch) || '0',
      volume: text(details.volume) || '1.0',
      format: text(details.format) || '按 Web 下载选项；工作台归档默认 wav',
    },
    pausePlan: hasValue(details.pausePlan) ? details.pausePlan : [],
    pronunciation: hasValue(details.pronunciation) ? details.pronunciation : {},
    soundTags: hasValue(details.soundTags) ? details.soundTags : [],
    targetDuration: details.targetDuration,
    relevantShots: hasValue(details.relevantShots) ? details.relevantShots : contextShotIds,
    candidates,
    continuity: list(pack.continuityChecklist),
    mustPreserve: list(pack.mustPreserve),
    mustAvoid: list(pack.mustAvoid),
    warnings,
  };
}

export function formatMiniMaxWebPromptPackage(packageValue: MiniMaxWebPromptPackage, assetName = '', assetId = ''): string {
  const settingLabels: Record<string, string> = { provider: 'Provider', model: '模型', voiceId: '音色 ID', voiceName: '音色名称', region: '执行区域', languageBoost: '语言增强', emotion: '情绪', speed: '语速', pitch: '音调', volume: '音量', format: '下载格式' };
  const settingLines = Object.entries(packageValue.settings).map(([key, value]) => `${settingLabels[key] || key}：${value}`);
  const candidateLines = packageValue.candidates.map((candidate) => `${candidate.shotId || '未绑定镜头'} · ${candidate.kind}：${candidate.text}`);
  const pauseText = renderPromptValue(packageValue.pausePlan);
  const pronunciationText = renderPromptValue(packageValue.pronunciation);
  const soundTagText = renderPromptValue(packageValue.soundTags);
  return [
    'MiniMax Speech 2.8 Web · 声音测试包',
    assetName || assetId ? `资产：${assetName || assetId}${assetName && assetId ? ` · ${assetId}` : ''}` : '',
    '【1｜MiniMax 实际朗读文本：只有这一段可以粘贴到 MiniMax 文本框】',
    packageValue.copyText || '（当前不可复制：先在工作台确认唯一台词；以下候选仅供核对）',
    packageValue.candidateText && !packageValue.copyText ? `候选 providerText：${packageValue.candidateText}` : '',
    '【2｜MiniMax Web 页面设置：逐项填写，不要粘贴到 MiniMax 文本框】',
    ...settingLines,
    '【3｜当前声音与语言身份：只用于核对，不要粘贴到 MiniMax】',
    packageValue.direction ? `演绎方向：${packageValue.direction}` : '',
    pauseText ? `停顿计划：${pauseText}` : '',
    pronunciationText ? `发音标注：${pronunciationText}` : '',
    soundTagText ? `语气/声音标签：${soundTagText}` : '',
    packageValue.targetDuration ? `目标时长：${String(packageValue.targetDuration)} 秒（用于听审，不强行拉伸）` : '',
    '【4｜FRAMEFLOW 内部 QA / 版本信息：不要粘贴】',
    `schemaVersion：${packageValue.schemaVersion}`,
    `文本状态：${packageValue.textStatus}`,
    hasValue(packageValue.relevantShots) ? `关联镜头：${renderPromptValue(packageValue.relevantShots)}` : '',
    packageValue.candidates.length ? `镜头候选：\n${candidateLines.join('\n')}` : '',
    packageValue.warnings.length ? `生成前检查：${packageValue.warnings.join('；')}` : '生成前检查：文本已确认，可开始 Web 试听。',
    packageValue.continuity.length ? `连续性：${packageValue.continuity.join('、')}` : '',
    packageValue.mustPreserve.length ? `必须保留：${packageValue.mustPreserve.join('、')}` : '',
    packageValue.mustAvoid.length ? `必须避免：${packageValue.mustAvoid.join('、')}` : '',
    '说明：MiniMax Web 文本框只接收实际朗读文本；资产 ID、镜头、QA、授权、环境声和混音说明留在 FRAMEFLOW。',
  ].filter(Boolean).join('\n');
}

export function buildNaturalLanguagePrompt(assetClass: string | undefined, rawPack: unknown, fallbackPrompt = '', context?: PromptContext): string {
  const cls = canonicalAssetClass(assetClass);
  const pack = normalizePromptPack(cls, rawPack, { context });
  const fallback = String(fallbackPrompt || '').trim();
  if (!hasStructuredContent(pack)) return fallback;
  if (cls === 'audio') {
    const packageValue = buildMiniMaxWebPromptPackage(pack, fallback, context);
    if (packageValue.copyText) return packageValue.copyText;
    return packageValue.candidateText ? `MiniMax Speech 2.8 Web：候选朗读文本待用户确认：${packageValue.candidateText}` : 'MiniMax Speech 2.8 Web：尚未确认唯一朗读文本，暂不生成。';
  }
  const plan = Array.isArray(pack.shotPlan) ? pack.shotPlan.filter(isRecord) : [];
  const shot = shotProse(plan);
  const paragraphs: string[] = [];
  const intent = text(pack.promptIntent);
  if (intent) paragraphs.push(sentence(intent, '这张图/这个镜头的生产目标是：'));
  const roles = renderPromptValue((pack.referenceStrategy as PromptRecord | undefined)?.roles);
  if (roles) paragraphs.push(sentence(roles, '参考图角色保持明确：'));
  const referenceAssetIds = (Array.isArray(pack.generationReferenceAssets) ? pack.generationReferenceAssets : [])
    .map((item) => isRecord(item) ? String(item.assetId || item.asset_id || '').trim() : String(item || '').trim())
    .filter(Boolean);
  if (referenceAssetIds.length) paragraphs.push(sentence([...new Set(referenceAssetIds)].join('、'), '图片生成时需要提供的参考图资产：'));
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
  if (fallback) {
    // The persisted prompt is fed back through the compiler when the asset
    // library is read. Remove exact compiler layers so the result is
    // idempotent while keeping the user-authored supplement at the tail.
    let supplement = fallback;
    while (compiled && supplement.startsWith(compiled)) {
      supplement = supplement.slice(compiled.length).trim();
      if (supplement.startsWith(PROMPT_SUPPLEMENT_MARKER)) {
        supplement = supplement.slice(PROMPT_SUPPLEMENT_MARKER.length).trim();
        continue;
      }
      break;
    }
    if (supplement && supplement !== compiled) compiled = compiled ? `${compiled}\n\n${PROMPT_SUPPLEMENT_MARKER}${supplement}` : supplement;
  }
  return compiled.trim();
}

export function canonicalizePromptOutput(assetClass: string | undefined, rawPack: unknown, prompt: string, context?: PromptContext): { prompt: string; promptPack: PromptRecord; promptContractVersion: string; promptWorkflow: string; promptFieldOrder: readonly string[] } {
  const promptPack = normalizePromptPack(assetClass, rawPack, { context });
  const fieldOrder = canonicalAssetClass(assetClass) === 'audio' ? AUDIO_PROMPT_FIELD_ORDER : PROMPT_FIELD_ORDER;
  return { prompt: buildNaturalLanguagePrompt(assetClass, promptPack, prompt, context), promptPack, promptContractVersion: PROMPT_CONTRACT_VERSION, promptWorkflow: PROMPT_WORKFLOW_ID, promptFieldOrder: fieldOrder };
}
