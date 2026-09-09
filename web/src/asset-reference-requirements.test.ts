import { describe, expect, it } from 'vitest';
import { generationReferenceAssetsFromConfig } from './asset-reference-requirements';

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
});
