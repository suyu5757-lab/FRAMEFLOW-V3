import type { LibraryAsset } from './types';

export type GenerationReferenceAsset = {
  assetId: string;
  label: string;
  role?: string;
};

type ReferenceRecord = Record<string, unknown>;

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value || '').trim();
}

function isRecord(value: unknown): value is ReferenceRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function referenceId(value: ReferenceRecord): string {
  return stringValue(
    value.assetId
      || value.asset_id
      || value.referenceId
      || value.reference_id
      || value.logicalAssetId
      || value.logical_asset_id
      || value.id,
  );
}

function addReference(target: Map<string, GenerationReferenceAsset>, value: unknown, currentAssetId: string): void {
  if (Array.isArray(value)) {
    value.forEach((item) => addReference(target, item, currentAssetId));
    return;
  }
  if (typeof value === 'string') {
    const assetId = stringValue(value);
    if (assetId && assetId !== currentAssetId && !target.has(assetId)) target.set(assetId, { assetId, label: assetId });
    return;
  }
  if (!isRecord(value)) return;
  const assetId = referenceId(value);
  if (assetId && assetId !== currentAssetId) {
    target.set(assetId, {
      assetId,
      label: stringValue(value.name || value.label || value.asset_name || value.assetName) || assetId,
      role: stringValue(value.role || value.referenceRole || value.reference_role) || undefined,
    });
    return;
  }
  ['items', 'roles', 'references', 'referenceRoles', 'reference_roles', 'generationReferenceAssets', 'generation_reference_assets'].forEach((key) => {
    addReference(target, value[key], currentAssetId);
  });
}

/**
 * Read only the image-generation reference declaration from a Prompt Pack.
 * This intentionally does not read prerequisiteGate/prerequisiteDependencies:
 * reference images are instructions for the image agent, not production QA
 * blockers.
 */
export function generationReferenceAssetsFromConfig(config: Record<string, unknown>, currentAssetId = ''): GenerationReferenceAsset[] {
  const promptPack = isRecord(config.prompt_pack) ? config.prompt_pack : isRecord(config.promptPack) ? config.promptPack : {};
  const referenceStrategy = isRecord(promptPack.referenceStrategy)
    ? promptPack.referenceStrategy
    : isRecord(promptPack.reference_strategy)
      ? promptPack.reference_strategy
      : {};
  const target = new Map<string, GenerationReferenceAsset>();
  [
    config.generation_reference_assets,
    config.generationReferenceAssets,
    config.reference_asset_ids,
    config.referenceAssetIds,
    config.reference_roles,
    config.referenceRoles,
    promptPack.generationReferenceAssets,
    promptPack.generation_reference_assets,
    promptPack.referenceAssetIds,
    promptPack.reference_asset_ids,
    promptPack.referenceRoles,
    promptPack.reference_roles,
    referenceStrategy.generationReferenceAssets,
    referenceStrategy.generation_reference_assets,
    referenceStrategy.referenceRoles,
    referenceStrategy.reference_roles,
    referenceStrategy.roles,
    referenceStrategy.references,
  ].forEach((value) => addReference(target, value, currentAssetId));
  return [...target.values()];
}

/**
 * Collapse the two legacy declarations into the one list the image agent
 * needs to see.  The production gate still remains authoritative for
 * enabling upload/QA actions; this helper only normalises what the operator
 * should prepare as image references.
 */
export function mergeGenerationReferenceAssets(
  references: GenerationReferenceAsset[],
  prerequisiteAssets: unknown,
  currentAssetId = '',
): GenerationReferenceAsset[] {
  const target = new Map<string, GenerationReferenceAsset>();
  references.forEach((reference) => addReference(target, reference, currentAssetId));
  addReference(target, prerequisiteAssets, currentAssetId);
  return [...target.values()];
}

export function generationReferenceAssetsForAsset(asset: LibraryAsset | undefined): GenerationReferenceAsset[] {
  if (!asset) return [];
  const metadata = asset.assetMetadata || {};
  return generationReferenceAssetsFromConfig({
    prompt_pack: asset.promptPack || metadata.prompt_pack || {},
    reference_roles: asset.references || metadata.referenceRoles || metadata.reference_roles || [],
    generation_reference_assets: asset.generationReferenceAssets || asset.generation_reference_assets || metadata.generationReferenceAssets || metadata.generation_reference_assets,
  }, asset.id);
}
