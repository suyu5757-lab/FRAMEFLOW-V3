import type { AssetLibraryEnvelope, LibraryAsset } from './types';

export const assetClassLabels: Record<string, string> = {
  character: '角色', scene: '场景', prop: '道具', fusion: '融合', product: '产品', style: '风格',
  audio: '声音', music: '音乐', sfx: '音效', video: '视频', post: '后期', unknown: '待分类',
};

export const assetStatusLabels: Record<string, string> = {
  ready: '已登记', partial: '部分完成', missing: '待制作', blocked: '已阻塞', generated_pending_qa: '待图片 QA',
  revision_required: '需修订', approved_pending_registration: '待登记', archived: '已归档', reference_pending_review: '待参考审核', reference: '仅参考',
};

export const productionStatusLabels: Record<string, string> = {
  registered: '已登记', production: '可入镜', prompt: '待补 Prompt', prompt_qa: '待 Prompt QA',
  image_qa: '待图片 QA', video_qa: '待视频 QA', reference_review: '待参考审核', asset_registration: '待登记', authorization: '待授权', fusion_gate: '融合门阻塞', reference_only: '仅参考，不可入镜',
  blocked: '已阻塞', pending: '待制作', audit: '审计队列', candidate: '候选', unknown: '待检查',
};

export type AssetLibraryScope = 'all' | 'character' | 'scene-prop' | 'fusion';
export type AssetLibraryStatusFilter = 'all' | 'registered' | 'production' | 'blocked' | 'candidate' | 'audit' | 'pending';

/**
 * Presentation order follows the production lifecycle.  The bucket logic
 * remains independent so a blocked asset still wins over every other state.
 */
export const assetStatusPresentationOrder: readonly AssetLibraryStatusFilter[] = [
  'all', 'pending', 'candidate', 'audit', 'registered', 'production', 'blocked',
];

export const assetStatusFilterLabels: Record<AssetLibraryStatusFilter, string> = {
  all: '资产',
  pending: '待制作',
  candidate: '候选',
  audit: '审计队列',
  registered: '已登记',
  production: '可入镜',
  blocked: '阻塞',
};
/**
 * Kept as a union for compatibility with the pre-v3 callers. New callers
 * should pass a status filter and a separate AssetLibraryScope.
 */
export type AssetLibraryFilter = AssetLibraryStatusFilter | AssetLibraryScope;
export type AssetSort = 'priority' | 'grade' | 'updated' | 'id';

// These are the legacy category values that may still be passed through the
// `filter` argument. `all` is a status value in the v3 API and must not
// override an explicitly selected scope.
const legacyScopeFilters = new Set<Exclude<AssetLibraryScope, 'all'>>(['character', 'scene-prop', 'fusion']);

export function assetMatchesScope(asset: LibraryAsset, scope: AssetLibraryScope): boolean {
  if (scope === 'character') return asset.assetClass === 'character';
  if (scope === 'scene-prop') return asset.assetClass === 'scene' || asset.assetClass === 'prop';
  if (scope === 'fusion') return asset.assetClass === 'fusion' || Boolean(asset.comparisons?.length);
  return true;
}

/**
 * Return exactly one logical-asset bucket. The order is intentional: an
 * asset which is both registered and has candidates is still registered;
 * candidate files never inflate the logical-asset count.
 */
export function assetStatusBucket(asset: LibraryAsset, auditAssetIds: Set<string> = new Set()): Exclude<AssetLibraryStatusFilter, 'all'> {
  if (asset.readiness.status === 'blocked') return 'blocked';
  if (asset.readiness.kind === 'reference' || asset.workflow?.kind === 'reference') return 'candidate';
  if (asset.readiness.production_ready) return 'production';
  if (asset.readiness.registered_ready || asset.readiness.ready) return 'registered';
  if (Number(asset.artifact_count ?? asset.artifacts?.length ?? 0) > 0) return 'candidate';
  if (auditAssetIds.has(asset.id)) return 'audit';
  return 'pending';
}

export function assetProductionStatus(asset: LibraryAsset): 'production' | 'registered' | 'blocked' | 'pending' {
  if (asset.readiness.status === 'blocked') return 'blocked';
  if (asset.readiness.production_ready) return 'production';
  if (asset.readiness.registered_ready || asset.readiness.ready) return 'registered';
  return 'pending';
}

export function assetNextAction(asset: LibraryAsset): string {
  return String(asset.readiness.next_action || '检查资产状态');
}

export function assetMatchesFilter(asset: LibraryAsset, filter: AssetLibraryFilter, search = ''): boolean {
  const normalized = search.trim().toLowerCase();
  const haystack = [asset.id, asset.name, asset.assetClass, asset.assetRole, asset.prompt, ...(asset.dependencies || []).map((item) => item.shot_id || '')].join(' ').toLowerCase();
  if (normalized && !haystack.includes(normalized)) return false;
  if (filter === 'character' || filter === 'scene-prop' || filter === 'fusion') return assetMatchesScope(asset, filter);
  if (filter === 'registered') return Boolean(asset.readiness.registered_ready || asset.readiness.ready);
  if (filter === 'production') return Boolean(asset.readiness.production_ready);
  if (filter === 'blocked') return asset.readiness.status === 'blocked';
  if (filter === 'candidate') return Number(asset.artifact_count ?? asset.artifacts?.length ?? 0) > 0;
  if (filter === 'audit') return assetProductionStatus(asset) !== 'production';
  if (filter === 'pending') return assetStatusBucket(asset) === 'pending';
  return true;
}

const gradeWeight: Record<string, number> = { 'A+': 4, A: 3, B: 2, C: 1, optional: 0, Reject: -1 };

export function sortAssets(assets: LibraryAsset[], sort: AssetSort): LibraryAsset[] {
  return [...assets].sort((left, right) => {
    if (sort === 'grade') return (gradeWeight[right.grade || 'B'] || 0) - (gradeWeight[left.grade || 'B'] || 0) || left.id.localeCompare(right.id);
    if (sort === 'updated') return String(right.updatedAt || right.updated_at || '').localeCompare(String(left.updatedAt || left.updated_at || '')) || left.id.localeCompare(right.id);
    if (sort === 'id') return left.id.localeCompare(right.id);
    const state = (assetProductionStatus(right) === 'production' ? 0 : assetProductionStatus(right) === 'blocked' ? 1 : 2) - (assetProductionStatus(left) === 'production' ? 0 : assetProductionStatus(left) === 'blocked' ? 1 : 2);
    return state || (gradeWeight[right.grade || 'B'] || 0) - (gradeWeight[left.grade || 'B'] || 0) || left.id.localeCompare(right.id);
  });
}

export function filterAssets(
  library: AssetLibraryEnvelope,
  filter: AssetLibraryFilter,
  search: string,
  sort: AssetSort,
  scope: AssetLibraryScope = 'all',
  auditAssetIds: Set<string> = new Set(),
): LibraryAsset[] {
  // Compatibility: the old API used the category as its primary filter.
  const legacyScope = legacyScopeFilters.has(filter as Exclude<AssetLibraryScope, 'all'>) ? filter as AssetLibraryScope : scope;
  const status = legacyScopeFilters.has(filter as Exclude<AssetLibraryScope, 'all'>) ? 'all' : filter as AssetLibraryStatusFilter;
  return sortAssets(library.assets.filter((asset) => assetMatchesScope(asset, legacyScope) && assetMatchesFilterWithAudit(asset, status, search, auditAssetIds)), sort);
}

function assetMatchesFilterWithAudit(asset: LibraryAsset, filter: AssetLibraryStatusFilter, search: string, auditAssetIds: Set<string>): boolean {
  const normalized = search.trim().toLowerCase();
  const haystack = [asset.id, asset.name, asset.assetClass, asset.assetRole, asset.prompt, ...(asset.dependencies || []).map((item) => item.shot_id || '')].join(' ').toLowerCase();
  if (normalized && !haystack.includes(normalized)) return false;
  return filter === 'all' || assetStatusBucket(asset, auditAssetIds) === filter;
}

export function parseJsonObject(value: string, field = 'JSON'): { value?: Record<string, unknown>; error?: string } {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: `${field} 必须是 JSON 对象。` };
    return { value: parsed as Record<string, unknown> };
  } catch (error) {
    const message = error instanceof Error ? error.message : '格式无效';
    return { error: `${field} 格式无效：${message}` };
  }
}
