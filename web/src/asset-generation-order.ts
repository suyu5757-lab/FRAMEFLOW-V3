import type { AssetBoard, LibraryAsset, StoryShot } from './types';

export type AssetGenerationStatus = 'missing' | 'pending_review' | 'approved';

export type AssetGenerationOrderItem = {
  assetId: string;
  label: string;
  status: AssetGenerationStatus;
  statusTitle: string;
};

type AssetGenerationOrderInput = {
  assets: LibraryAsset[];
  storyShots?: StoryShot[];
  board?: AssetBoard | null;
  boardNodes?: Array<{ asset_id?: string; config: Record<string, unknown> }>;
};

// The order chain is a production queue for base visual assets only. Fusion
// outputs are intentionally kept out of this list: they are a downstream
// operation that is already represented by the fusion cards and should not
// compete with the base assets in the recommended image-generation sequence.
const excludedAssetClasses = new Set(['audio', 'music', 'sfx', 'sound', 'video', 'post', 'fusion']);
const gradeWeight: Record<string, number> = { 'A+': 5, A: 4, B: 3, C: 2, optional: 1, Reject: 0 };
const approvedArtifactStatuses = new Set(['approved', 'approved_pending_registration', 'active', 'current', 'ready', 'registered', 'production']);
const pendingArtifactStatuses = new Set(['generated_pending_qa', 'qa_in_progress', 'reference_pending_review', 'audit_blocked', 'pending', 'pending_review', 'candidate', 'uploaded', 'uploading', 'needs_review']);
const rejectedArtifactStatuses = new Set(['rejected', 'needs_revision', 'superseded', 'archived']);

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value || '').trim();
}

function normalizedId(value: unknown): string {
  return stringValue(value);
}

function assetClassOf(asset: LibraryAsset): string {
  return stringValue(asset.assetClass || asset.asset_class).toLowerCase();
}

function isVisualAsset(asset: LibraryAsset): boolean {
  return !excludedAssetClasses.has(assetClassOf(asset));
}

function addKnownAssetId(target: Set<string>, value: unknown, knownIds: Set<string>): void {
  const id = normalizedId(value);
  if (id && knownIds.has(id)) target.add(id);
}

function collectIds(value: unknown, knownIds: Set<string>, target: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectIds(item, knownIds, target));
    return;
  }
  if (typeof value === 'string') {
    addKnownAssetId(target, value, knownIds);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  // The API normally uses asset_id, but prerequisite gate items from older
  // project revisions may be normalized to { id, name, ... }. Only accept
  // identifiers that belong to the current visual-asset set so a generic
  // metadata id cannot accidentally become a dependency edge.
  ['dependency_asset_id', 'dependencyAssetId', 'dependency_id', 'dependencyId', 'required_asset_id', 'requiredAssetId', 'asset_id', 'assetId', 'source_asset_id', 'sourceAssetId', 'source_id', 'sourceId', 'id'].forEach((key) => {
    addKnownAssetId(target, record[key], knownIds);
  });
}

function prerequisiteIdsFor(asset: LibraryAsset, knownIds: Set<string>): Set<string> {
  const ids = new Set<string>();
  const dependencies = Array.isArray(asset.dependencies) ? asset.dependencies : [];
  dependencies.forEach((dependency) => addKnownAssetId(ids, dependency?.dependency_asset_id, knownIds));
  collectIds(asset.prerequisiteDependencies, knownIds, ids);
  collectIds(asset.prerequisiteGate?.required_asset_ids, knownIds, ids);
  collectIds(asset.prerequisiteGate?.blocked_asset_ids, knownIds, ids);
  collectIds(asset.prerequisiteGate?.items, knownIds, ids);

  const fusionPlan = asset.fusionPlan && typeof asset.fusionPlan === 'object' ? asset.fusionPlan as Record<string, unknown> : {};
  [asset.fusion_source_asset_ids, asset.fusionSourceAssetIds, fusionPlan.source_asset_ids, fusionPlan.sourceAssetIds].forEach((value) => collectIds(value, knownIds, ids));
  ids.delete(asset.id);
  return ids;
}

function boardPrerequisites(board: AssetBoard | null | undefined, assets: LibraryAsset[], knownIds: Set<string>, enrichedNodes: Array<{ asset_id?: string; config: Record<string, unknown> }> = []): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  if (!board) return result;
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const nodes = new Map(board.nodes.map((node) => [node.id, node]));
  const add = (targetId: string, sourceId: string) => {
    if (!knownIds.has(targetId) || !knownIds.has(sourceId) || targetId === sourceId) return;
    const current = result.get(targetId) || new Set<string>();
    current.add(sourceId);
    result.set(targetId, current);
  };
  [...board.nodes, ...enrichedNodes].forEach((node) => {
    const assetId = normalizedId(node.asset_id);
    if (!assetId || !knownIds.has(assetId)) return;
    const current = result.get(assetId) || new Set<string>();
    collectIds(node.config?.prerequisite_items, knownIds, current);
    collectIds(node.config?.prerequisite_blocked_dependencies, knownIds, current);
    collectIds(node.config?.prerequisite_asset_ids || node.config?.prerequisiteAssetIds, knownIds, current);
    collectIds(node.config?.fusion_source_asset_ids || node.config?.fusionSourceAssetIds, knownIds, current);
    current.delete(assetId);
    if (current.size) result.set(assetId, current);
  });
  board.edges.filter((edge) => edge.relation === 'fusion_input' || edge.relation === 'reference').forEach((edge) => {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    const sourceId = normalizedId(source?.asset_id);
    const targetId = normalizedId(target?.asset_id);
    if (!sourceId || !targetId) return;
    const sourceClass = assetMap.get(sourceId) ? assetClassOf(assetMap.get(sourceId)!) : stringValue(source?.config?.asset_class).toLowerCase();
    const targetClass = assetMap.get(targetId) ? assetClassOf(assetMap.get(targetId)!) : stringValue(target?.config?.asset_class).toLowerCase();
    if (targetClass === 'fusion' && sourceClass !== 'fusion') add(targetId, sourceId);
    if (sourceClass === 'fusion' && targetClass !== 'fusion') add(sourceId, targetId);
  });
  return result;
}

function shotOrder(storyShots: StoryShot[], board?: AssetBoard | null): string[] {
  const ids = storyShots.map((shot) => normalizedId(shot.id)).filter(Boolean);
  const seen = new Set(ids);
  board?.nodes.filter((node) => node.node_type === 'shot' && node.shot_id).forEach((node) => {
    const id = normalizedId(node.shot_id);
    if (id && !seen.has(id)) {
      ids.push(id);
      seen.add(id);
    }
  });
  return ids;
}

function firstShotRanks(assets: LibraryAsset[], storyShots: StoryShot[], board?: AssetBoard | null): Map<string, number> {
  const orderedShots = shotOrder(storyShots, board);
  const rankByShot = new Map(orderedShots.map((shotId, index) => [shotId.toUpperCase(), index]));
  const ranks = new Map(assets.map((asset) => [asset.id, Number.POSITIVE_INFINITY]));
  const setRank = (assetId: unknown, shotId: unknown) => {
    const id = normalizedId(assetId);
    const shot = normalizedId(shotId).toUpperCase();
    const rank = rankByShot.get(shot);
    if (id && rank !== undefined && ranks.has(id)) ranks.set(id, Math.min(ranks.get(id) || Number.POSITIVE_INFINITY, rank));
  };

  for (const shot of storyShots) {
    const requirements = (shot as Record<string, unknown>).assetRequirements || (shot as Record<string, unknown>).asset_requirements;
    if (Array.isArray(requirements)) requirements.forEach((requirement) => setRank((requirement as Record<string, unknown>)?.assetId || (requirement as Record<string, unknown>)?.asset_id, shot.id));
  }
  board?.edges.filter((edge) => edge.relation === 'shot_dependency').forEach((edge) => {
    const source = board.nodes.find((node) => node.id === edge.source);
    const target = board.nodes.find((node) => node.id === edge.target);
    if (source?.shot_id && target?.asset_id) setRank(target.asset_id, source.shot_id);
    if (target?.shot_id && source?.asset_id) setRank(source.asset_id, target.shot_id);
  });
  assets.forEach((asset) => {
    asset.dependencies?.forEach((dependency) => setRank(asset.id, dependency.shot_id));
    const metadata = asset.assetMetadata || {};
    [asset.promptRelevantShots, asset.relevant_shots, metadata.relevant_shots, metadata.relevantShots, asset.fusionPlan?.shot_id].forEach((value) => {
      if (Array.isArray(value)) value.forEach((shotId) => setRank(asset.id, shotId));
      else setRank(asset.id, value);
    });
  });
  return ranks;
}

function compareAssets(left: LibraryAsset, right: LibraryAsset, ranks: Map<string, number>): number {
  const leftRank = ranks.get(left.id) ?? Number.POSITIVE_INFINITY;
  const rightRank = ranks.get(right.id) ?? Number.POSITIVE_INFINITY;
  if (leftRank !== rightRank) return leftRank - rightRank;
  const leftGrade = gradeWeight[stringValue(left.grade || left.readiness?.grade) || 'B'] || 0;
  const rightGrade = gradeWeight[stringValue(right.grade || right.readiness?.grade) || 'B'] || 0;
  if (leftGrade !== rightGrade) return rightGrade - leftGrade;
  return left.id.localeCompare(right.id);
}

function compareCycleAssets(left: LibraryAsset, right: LibraryAsset, ranks: Map<string, number>, prerequisites: Map<string, Set<string>>): number {
  const leftDependsOnRight = prerequisites.get(left.id)?.has(right.id) === true;
  const rightDependsOnLeft = prerequisites.get(right.id)?.has(left.id) === true;
  const leftRank = ranks.get(left.id) ?? Number.POSITIVE_INFINITY;
  const rightRank = ranks.get(right.id) ?? Number.POSITIVE_INFINITY;

  // A cross-shot circular reference usually means the earlier-shot asset
  // mentions a later-shot reference image as a real production prerequisite,
  // while the later-shot asset mentions the earlier one for continuity. In
  // that specific ambiguous case, preserve the explicit prerequisite needed
  // by the earlier shot (for example P12 -> P08) instead of silently falling
  // back to the chronological order (P08 -> P12). Unranked cycles still use
  // the normal stable fallback below.
  if (leftDependsOnRight && rightDependsOnLeft && Number.isFinite(leftRank) && Number.isFinite(rightRank) && leftRank !== rightRank) {
    return leftRank > rightRank ? -1 : 1;
  }
  return compareAssets(left, right, ranks);
}

function imageArtifactsFor(asset: LibraryAsset): Record<string, unknown>[] {
  const artifacts = Array.isArray(asset.artifacts) ? asset.artifacts.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  return artifacts.filter((artifact) => {
    const mime = stringValue(artifact.mime_type || artifact.mimeType || artifact.type).toLowerCase();
    return !mime || mime.startsWith('image/') || mime === 'image';
  });
}

export function assetGenerationStatus(asset: LibraryAsset): AssetGenerationStatus {
  const artifacts = imageArtifactsFor(asset).filter((artifact) => stringValue(artifact.status).toLowerCase() !== 'archived');
  const approved = artifacts.some((artifact) => approvedArtifactStatuses.has(stringValue(artifact.status).toLowerCase()) || stringValue(artifact.qa_decision || artifact.decision).toLowerCase() === 'approved');
  const assetArtifactStatus = stringValue(asset.artifactStatus || asset.artifact_status).toLowerCase();
  const assetArtifactQa = stringValue(asset.artifactQaDecision || asset.artifact_qa_decision).toLowerCase();
  if (approved || assetArtifactQa === 'approved' || approvedArtifactStatuses.has(assetArtifactStatus) || asset.readiness?.production_ready === true || asset.readiness?.registered_ready === true) return 'approved';

  const generationStatus = stringValue(asset.generationStatus || asset.generation_status).toLowerCase();
  const hasPendingArtifact = artifacts.some((artifact) => pendingArtifactStatuses.has(stringValue(artifact.status).toLowerCase()));
  const hasCandidate = artifacts.length > 0 || Number(asset.artifact_count || 0) > 0 || asset.readiness?.has_file === true || Boolean(asset.artifactId || asset.artifact_id || asset.filePath || asset.file_path || asset.previewUrl);
  if (hasPendingArtifact || hasCandidate || pendingArtifactStatuses.has(assetArtifactStatus) || pendingArtifactStatuses.has(generationStatus)) return 'pending_review';

  const onlyRejected = artifacts.length > 0 && artifacts.every((artifact) => rejectedArtifactStatuses.has(stringValue(artifact.status).toLowerCase()));
  return onlyRejected ? 'missing' : 'missing';
}

export function assetGenerationStatusTitle(status: AssetGenerationStatus): string {
  if (status === 'approved') return '已审核通过';
  if (status === 'pending_review') return '已上传候选，等待审核';
  return '未上传或审核未通过';
}

export function buildAssetGenerationOrder({ assets, storyShots = [], board = null, boardNodes = [] }: AssetGenerationOrderInput): AssetGenerationOrderItem[] {
  const visualAssets = assets.filter(isVisualAsset);
  const knownIds = new Set(visualAssets.map((asset) => asset.id));
  const ranks = firstShotRanks(visualAssets, storyShots, board);
  const prerequisites = new Map<string, Set<string>>();
  visualAssets.forEach((asset) => prerequisites.set(asset.id, prerequisiteIdsFor(asset, knownIds)));
  boardPrerequisites(board, visualAssets, knownIds, boardNodes).forEach((ids, assetId) => {
    const current = prerequisites.get(assetId) || new Set<string>();
    ids.forEach((id) => current.add(id));
    prerequisites.set(assetId, current);
  });

  const byId = new Map(visualAssets.map((asset) => [asset.id, asset]));
  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  visualAssets.forEach((asset) => indegree.set(asset.id, 0));
  prerequisites.forEach((ids, assetId) => {
    const validIds = [...ids].filter((id) => byId.has(id));
    indegree.set(assetId, validIds.length);
    validIds.forEach((dependencyId) => {
      const current = dependents.get(dependencyId) || new Set<string>();
      current.add(assetId);
      dependents.set(dependencyId, current);
    });
  });

  const queue = visualAssets.filter((asset) => indegree.get(asset.id) === 0).sort((left, right) => compareAssets(left, right, ranks));
  const ordered: LibraryAsset[] = [];
  while (queue.length) {
    const next = queue.shift()!;
    ordered.push(next);
    dependents.get(next.id)?.forEach((dependentId) => {
      const nextDegree = (indegree.get(dependentId) || 0) - 1;
      indegree.set(dependentId, nextDegree);
      if (nextDegree === 0) {
        const dependent = byId.get(dependentId);
        if (dependent) {
          queue.push(dependent);
          queue.sort((left, right) => compareAssets(left, right, ranks));
        }
      }
    });
  }
  if (ordered.length < visualAssets.length) {
    const orderedIds = new Set(ordered.map((asset) => asset.id));
    ordered.push(...visualAssets.filter((asset) => !orderedIds.has(asset.id)).sort((left, right) => compareCycleAssets(left, right, ranks, prerequisites)));
  }
  return ordered.map((asset) => {
    const status = assetGenerationStatus(asset);
    return { assetId: asset.id, label: stringValue(asset.name) || asset.id, status, statusTitle: assetGenerationStatusTitle(status) };
  });
}
