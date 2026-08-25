import { describe, expect, it } from 'vitest';
import { assetMatchesFilter, assetStatusBucket, assetStatusFilterLabels, assetStatusPresentationOrder, filterAssets, parseJsonObject } from './asset-state';
import type { AssetLibraryEnvelope, LibraryAsset } from './types';

const asset = (patch: Partial<LibraryAsset>): LibraryAsset => ({
  id: patch.id || 'C001', name: patch.name || '角色一', assetClass: patch.assetClass || 'character', grade: patch.grade || 'A',
  readiness: { status: 'ready', required: true, ready: true, registered: true, has_file: true, registered_ready: true, production_ready: false, missing: [], production_missing: ['prompt'], next_action: '补 Prompt' },
  workflow: { state: 'ready', kind: 'production', qa_type: 'image', qa_owner: null, artifact_id: null, next_action: { code: 'none', label: '无', enabled: false }, allowed_actions: [], blockers: [] },
  references: [], dependencies: [], comparisons: [], ...patch,
});

const library: AssetLibraryEnvelope = { project_id: 'P1', assets: [asset({ id: 'C001', name: '陈继业', assetClass: 'character' }), asset({ id: 'S001', name: '祠堂', assetClass: 'scene', readiness: { status: 'missing', required: true, ready: false, registered: false, has_file: false, registered_ready: false, production_ready: false, missing: ['project_file'], production_missing: ['registered:project_file'], next_action: '上传候选文件' } })], summary: { total: 2, ready: 1, blocked: 0, missing_required_a: 1 } };
const scopedLibrary: AssetLibraryEnvelope = {
  ...library,
  assets: [
    ...library.assets,
    asset({ id: 'C002', name: '王大民', assetClass: 'character' }),
    asset({ id: 'S002', name: '山路', assetClass: 'scene', dependencies: [{ dependency_asset_id: 'S002', shot_id: 'SH006', relation: 'requires', required: true }] }),
    asset({ id: 'P001', name: '旧钢笔', assetClass: 'prop' }),
    asset({ id: 'F001', name: 'SH004 融合', assetClass: 'fusion' }),
    asset({ id: 'F002', name: '候选融合', assetClass: 'scene', comparisons: [{} as any] }),
  ],
  summary: { ...library.summary, total: 7 },
};

describe('asset library state helpers', () => {
  it('filters by semantic entry and searches shot dependencies', () => {
    expect(assetMatchesFilter(asset({ assetClass: 'scene', dependencies: [{ dependency_asset_id: 'C001', shot_id: 'SH006', relation: 'requires', required: true }] }), 'scene-prop', 'SH006')).toBe(true);
    expect(filterAssets(library, 'character', '', 'id').map((item) => item.id)).toEqual(['C001']);
  });

  it('keeps the explicit scope when the status filter is all', () => {
    expect(filterAssets(scopedLibrary, 'all', '', 'id', 'character').map((item) => item.id)).toEqual(['C001', 'C002']);
    expect(filterAssets(scopedLibrary, 'all', '', 'id', 'scene-prop').map((item) => item.id)).toEqual(['F002', 'P001', 'S001', 'S002']);
    expect(filterAssets(scopedLibrary, 'all', '', 'id', 'fusion').map((item) => item.id)).toEqual(['F001', 'F002']);
  });

  it('intersects scope with status and search filters', () => {
    expect(filterAssets(scopedLibrary, 'registered', 'SH006', 'id', 'scene-prop').map((item) => item.id)).toEqual(['S002']);
    expect(filterAssets(scopedLibrary, 'scene-prop', '', 'id').map((item) => item.id)).toEqual(['F002', 'P001', 'S001', 'S002']);
  });

  it('supports clickable readiness summary filters', () => {
    expect(filterAssets(library, 'registered', '', 'id').map((item) => item.id)).toEqual(['C001']);
    expect(filterAssets(library, 'production', '', 'id')).toHaveLength(0);
    expect(assetMatchesFilter(asset({ artifact_count: 1 }), 'candidate')).toBe(true);
    expect(assetMatchesFilter(asset({ readiness: { ...asset({}).readiness, status: 'blocked' } }), 'blocked')).toBe(true);
  });

  it('assigns each logical asset to one exclusive status bucket', () => {
    const base = asset({ artifact_count: 2 });
    expect(assetStatusBucket(asset({ ...base, readiness: { ...base.readiness, status: 'blocked', production_ready: true } }))).toBe('blocked');
    expect(assetStatusBucket(asset({ ...base, readiness: { ...base.readiness, production_ready: true } }))).toBe('production');
    expect(assetStatusBucket(asset({ ...base, readiness: { ...base.readiness, registered_ready: true, production_ready: false } }))).toBe('registered');
    const unregistered = asset({ ...base, readiness: { ...base.readiness, registered_ready: false, ready: false } });
    expect(assetStatusBucket(unregistered)).toBe('candidate');
    expect(assetStatusBucket(asset({ ...unregistered, artifact_count: 0 }), new Set(['C001']))).toBe('audit');
    expect(assetStatusBucket(asset({ ...unregistered, artifact_count: 0 }))).toBe('pending');
  });

  it('presents status filters in production workflow order', () => {
    expect(assetStatusPresentationOrder).toEqual(['all', 'pending', 'candidate', 'audit', 'registered', 'production', 'blocked']);
    expect(assetStatusPresentationOrder.map((status) => assetStatusFilterLabels[status])).toEqual(['资产', '待制作', '候选', '审计队列', '已登记', '可入镜', '阻塞']);
  });

  it('rejects invalid JSON instead of silently converting to an empty object', () => {
    expect(parseJsonObject('{"ok":true}').value).toEqual({ ok: true });
    expect(parseJsonObject('{oops}', '资产规格').error).toContain('资产规格');
    expect(parseJsonObject('[]', '资产规格').error).toContain('对象');
  });
});
