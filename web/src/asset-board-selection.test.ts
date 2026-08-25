import { describe, expect, it } from 'vitest';
import { applyAssetBoardSelection, assetBoardSelectionKey, selectedAssetBoardCards, singleSelectedAssetBoardCard, type AssetBoardSelectionNode } from './asset-board-selection';

const node = (patch: Partial<AssetBoardSelectionNode> & { id: string; node_type: string }): AssetBoardSelectionNode => ({
  config: { grid_row_key: 'SH001' },
  ...patch,
});

describe('asset board card selection identity', () => {
  it('distinguishes an asset card from its prompt card', () => {
    const assetCard = node({ id: 'asset:S001', node_type: 'asset' });
    const promptCard = node({ id: 'handoff:S001', node_type: 'handoff' });
    expect(assetBoardSelectionKey(assetCard)).not.toBe(assetBoardSelectionKey(promptCard));
  });

  it('distinguishes repeated presentation cards by shot row', () => {
    const firstRow = node({ id: 'asset:S001', node_type: 'asset' });
    const secondRow = node({ id: 'asset:S001:row:SH002', sourceNodeId: 'asset:S001', node_type: 'asset', config: { grid_row_key: 'SH002' } });
    expect(assetBoardSelectionKey(firstRow)).not.toBe(assetBoardSelectionKey(secondRow));
  });

  it('restores only the exact card and does not select a same-asset sibling', () => {
    const assetCard = node({ id: 'asset:S001', node_type: 'asset' });
    const promptCard = node({ id: 'handoff:S001', node_type: 'handoff' });
    const restored = applyAssetBoardSelection([assetCard, promptCard], assetBoardSelectionKey(assetCard));
    expect(restored[0].selected).toBe(true);
    expect(restored[1].selected).toBe(false);
  });

  it('clears selection when the exact card is hidden instead of selecting a sibling', () => {
    const assetCard = node({ id: 'asset:S001', node_type: 'asset' });
    const hiddenPromptCard = node({ id: 'handoff:S001', node_type: 'handoff', hidden: true });
    const restored = applyAssetBoardSelection([assetCard, hiddenPromptCard], assetBoardSelectionKey(hiddenPromptCard));
    expect(restored[0].selected).toBe(false);
    expect(restored[1].selected).toBe(false);
    expect(selectedAssetBoardCards(restored)).toHaveLength(0);
  });

  it('does not choose an arbitrary inspector target during multi-selection', () => {
    const selected = selectedAssetBoardCards([
      node({ id: 'asset:S001', node_type: 'asset', selected: true }),
      node({ id: 'handoff:S001', node_type: 'handoff', selected: true }),
    ]);
    expect(selected).toHaveLength(2);
    expect(singleSelectedAssetBoardCard(selected)).toBeUndefined();
  });

  it('ignores non-card nodes when resolving selection', () => {
    expect(assetBoardSelectionKey(node({ id: 'asset-grid:table', node_type: 'table' }))).toBeNull();
  });
});
