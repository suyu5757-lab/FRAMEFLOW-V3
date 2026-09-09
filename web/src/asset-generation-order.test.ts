import { describe, expect, it } from 'vitest';
import { assetGenerationStatus, buildAssetGenerationOrder } from './asset-generation-order';
import type { LibraryAsset } from './types';

function asset(id: string, assetClass: string, patch: Record<string, unknown> = {}): LibraryAsset {
  return {
    id,
    name: id,
    assetClass,
    grade: 'B',
    readiness: {
      status: 'partial',
      required: true,
      ready: false,
      registered: false,
      has_file: false,
      missing: [],
    },
    workflow: { state: 'pending', kind: 'production', qa_type: 'image', next_action: { code: 'pending', label: '待制作', enabled: true }, allowed_actions: [], blockers: [] },
    references: [],
    dependencies: [],
    prerequisiteDependencies: [],
    comparisons: [],
    ...patch,
  } as LibraryAsset;
}

describe('asset generation order', () => {
  it('keeps prerequisites before dependent assets even when the dependent shot appears first', () => {
    const assets = [
      asset('P08', 'prop', { prerequisiteDependencies: [{ asset_id: 'P12' }] }),
      asset('P12', 'prop'),
      asset('P01', 'character'),
      asset('ENV01', 'scene'),
    ];
    const order = buildAssetGenerationOrder({ assets, storyShots: [{ id: 'S04' } as any, { id: 'S07' } as any] });
    expect(order.map((item) => item.assetId).indexOf('P12')).toBeLessThan(order.map((item) => item.assetId).indexOf('P08'));
  });

  it('excludes fusion outputs and non-visual assets from the base generation chain', () => {
    const assets = [asset('P01', 'character'), asset('ENV01', 'scene'), asset('FUSION_S02', 'fusion', { fusion_source_asset_ids: ['P01', 'ENV01'] }), asset('AUD01', 'audio')];
    const order = buildAssetGenerationOrder({ assets, storyShots: [{ id: 'S02' } as any] });
    expect(order.map((item) => item.assetId)).toEqual(['ENV01', 'P01']);
    expect(order.some((item) => item.assetId.startsWith('FUSION_'))).toBe(false);
  });

  it('uses prompt-card prerequisite metadata when the library projection is incomplete', () => {
    const assets = [asset('P08', 'prop'), asset('P12', 'prop')];
    const board = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      metadata: {},
      nodes: [
        { id: 'handoff:P08', node_type: 'handoff', asset_id: 'P08', label: 'P08 Prompt', position: { x: 0, y: 0 }, status: 'pending', config: { prompt_card: true, prerequisite_items: [{ asset_id: 'P12' }] } },
        { id: 'handoff:P12', node_type: 'handoff', asset_id: 'P12', label: 'P12 Prompt', position: { x: 0, y: 0 }, status: 'pending', config: { prompt_card: true } },
      ],
      edges: [],
    } as any;
    const order = buildAssetGenerationOrder({ assets, board, storyShots: [{ id: 'S04' } as any, { id: 'S07' } as any] });
    expect(order.map((item) => item.assetId)).toEqual(['P12', 'P08']);
  });

  it('accepts normalized prerequisite gate items that expose the asset id as id', () => {
    const assets = [
      asset('P08', 'prop', { prerequisiteGate: { allowed: false, items: [{ id: 'P12', name: 'P12' }] } }),
      asset('P12', 'prop'),
    ];
    const order = buildAssetGenerationOrder({ assets, storyShots: [{ id: 'S04' } as any, { id: 'S07' } as any] });
    expect(order.map((item) => item.assetId)).toEqual(['P12', 'P08']);
  });

  it('maps missing, pending and approved image states to the three indicator states', () => {
    const missing = asset('P01', 'character');
    const pending = asset('P02', 'character', { artifacts: [{ id: 'a2', mime_type: 'image/png', status: 'generated_pending_qa' }] });
    const approved = asset('ENV01', 'scene', { artifacts: [{ id: 'a3', mime_type: 'image/png', status: 'approved' }] });
    expect(assetGenerationStatus(missing)).toBe('missing');
    expect(assetGenerationStatus(pending)).toBe('pending_review');
    expect(assetGenerationStatus(approved)).toBe('approved');
  });

  it('falls back to stable first-shot order when dependencies form a cycle', () => {
    const assets = [
      asset('P08', 'prop', { prerequisiteDependencies: [{ asset_id: 'P12' }] }),
      asset('P12', 'prop', { prerequisiteDependencies: [{ asset_id: 'P08' }] }),
    ];
    const order = buildAssetGenerationOrder({ assets, storyShots: [{ id: 'S04' } as any, { id: 'S07' } as any] });
    expect(order.map((item) => item.assetId)).toEqual(['P08', 'P12']);
  });

  it('keeps a later-shot prerequisite ahead when a cross-shot reference creates a cycle', () => {
    const assets = [
      asset('P08', 'prop', {
        dependencies: [{ dependency_asset_id: 'P12', shot_id: 'S04', relation: 'prerequisite_asset', required: true }],
        prerequisiteDependencies: [{ asset_id: 'P12' }],
      }),
      asset('P12', 'prop', {
        dependencies: [{ dependency_asset_id: 'P08', shot_id: 'S07', relation: 'reference', required: true }],
        prerequisiteDependencies: [{ asset_id: 'P08' }],
      }),
    ];
    const order = buildAssetGenerationOrder({ assets, storyShots: [{ id: 'S04' } as any, { id: 'S07' } as any] });
    expect(order.map((item) => item.assetId)).toEqual(['P12', 'P08']);
  });
});
