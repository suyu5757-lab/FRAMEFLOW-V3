import { describe, expect, it } from 'vitest';
import { generationReferenceAssetsFromConfig, mergeGenerationReferenceAssets } from './asset-reference-requirements';

describe('image-generation reference assets', () => {
  it('reads reference roles without turning them into production gate dependencies', () => {
    const references = generationReferenceAssetsFromConfig({
      prompt_pack: {
        referenceStrategy: {
          referenceRoles: [
            { referenceId: 'P02', role: 'connected_character' },
            { referenceId: 'ENV01', role: 'connected_scene' },
          ],
        },
        prerequisiteGate: { items: [{ asset_id: 'P12' }] },
      },
      prerequisite_items: [{ asset_id: 'P12' }],
    }, 'P10');

    expect(references.map((item) => item.assetId)).toEqual(['P02', 'ENV01']);
    expect(references.map((item) => item.label)).toEqual(['P02', 'ENV01']);
    expect(references.some((item) => item.assetId === 'P12')).toBe(false);
  });

  it('accepts the explicit generationReferenceAssets field and removes the current asset', () => {
    const references = generationReferenceAssetsFromConfig({
      generationReferenceAssets: [{ assetId: 'P02', name: 'P02' }, { assetId: 'P10' }],
    }, 'P10');
    expect(references).toEqual([{ assetId: 'P02', label: 'P02', role: undefined }]);
  });

  it('merges prerequisite assets that are missing from the reference list without duplicating them', () => {
    const merged = mergeGenerationReferenceAssets([
      { assetId: 'ENV01', label: 'ENV01' },
      { assetId: 'P01', label: 'P01' },
    ], [
      { asset_id: 'P01', name: 'P01' },
      { asset_id: 'P12', name: 'P12' },
      { asset_id: 'P08', name: '当前资产' },
    ], 'P08');

    expect(merged.map((item) => item.assetId)).toEqual(['ENV01', 'P01', 'P12']);
    expect(merged.map((item) => item.label)).toEqual(['ENV01', 'P01', 'P12']);
  });
});
