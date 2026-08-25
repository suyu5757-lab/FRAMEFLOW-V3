import { describe, expect, it } from 'vitest';
import { assetBoardCardHeight, assetBoardCardIsLocked, assetBoardFixedColumnBounds, assetBoardMinimumColumnWidth, assetBoardSafeColumnWidths, assetBoardToFlowNodes, resolveAssetProductionTarget } from './App';
import type { AssetBoard, LibraryAsset } from './types';

describe('asset board geometry', () => {
  it('reserves enough width for the asset-flow title and prompt cards', () => {
    expect(assetBoardMinimumColumnWidth('asset-flow', 286, 16, 'adaptive')).toBe(612);
    expect(assetBoardMinimumColumnWidth('fusion', 286, 16, 'adaptive')).toBe(612);

    const widths = assetBoardSafeColumnWidths({ shots: 260, 'asset-flow': 280, fusion: 280 }, 286, 16, 'adaptive');
    expect(widths).toEqual({ shots: 260, 'asset-flow': 612, fusion: 612 });
  });

  it('keeps flow cards before the fusion column boundary', () => {
    const widths = assetBoardSafeColumnWidths({ shots: 260, 'asset-flow': 640, fusion: 640 }, 286, 16, 'adaptive');
    const bounds = assetBoardFixedColumnBounds('adaptive', widths, 16, 1200, 286);
    const flow = bounds.find((bound) => bound.key === 'asset-flow');
    const fusion = bounds.find((bound) => bound.key === 'fusion');

    expect(flow).toBeDefined();
    expect(fusion).toBeDefined();
    const flowCardRight = flow!.x + flow!.width - 12;
    expect(flowCardRight).toBeLessThanOrEqual(fusion!.x - 16);
    expect(fusion!.x).toBe(flow!.x + flow!.width + 16);
  });

  it('does not widen the semantic columns because of the 1.5x outer frame', () => {
    const widths = assetBoardSafeColumnWidths({ shots: 260, 'asset-flow': 640, fusion: 640 }, 286, 16, 'adaptive');
    const bounds = assetBoardFixedColumnBounds('adaptive', widths, 16, 900, 286);
    const logicalRight = bounds.at(-1)!.x + bounds.at(-1)!.width + 24;
    const outerFrameWidth = Math.round(logicalRight * 1.5);

    expect(outerFrameWidth).toBeGreaterThan(logicalRight);
    expect(bounds.at(-1)!.x + bounds.at(-1)!.width).toBeLessThan(outerFrameWidth);
  });

  it('locks asset and prompt/image cards while keeping candidate cards movable', () => {
    expect(assetBoardCardIsLocked({ node_type: 'asset', config: {} })).toBe(true);
    expect(assetBoardCardIsLocked({ node_type: 'handoff', config: { prompt_card: true } })).toBe(true);
    expect(assetBoardCardIsLocked({ node_type: 'artifact', config: {} })).toBe(false);
    expect(assetBoardCardHeight({ node_type: 'asset', config: { asset_prompt: '', asset_artifact_count: 0 } })).toBe(150);
  });

  it('assigns both generated card types to the shot row from the shot dependency', () => {
    const board = {
      metadata: {},
      nodes: [
        { id: 'shot:SH001', node_type: 'shot', shot_id: 'SH001', label: 'SH001', status: 'ready', config: {} },
        { id: 'asset:S001', node_type: 'asset', asset_id: 'S001', label: '于村祠堂雨夜', status: 'ready', config: {} },
        { id: 'handoff:S001', node_type: 'handoff', asset_id: 'S001', label: '资产 Prompt', status: 'ready', config: { prompt_card: true } },
      ],
      edges: [{ id: 'dependency:1', source: 'shot:SH001', target: 'asset:S001', relation: 'shot_dependency' }],
    } as unknown as AssetBoard;
    const asset = { id: 'S001', name: '于村祠堂雨夜', assetClass: 'scene', readiness: {} } as unknown as LibraryAsset;
    const nodes = assetBoardToFlowNodes(board, [asset], 'all', true, [], { layoutMode: 'adaptive' });
    const cards = nodes.filter((node) => node.data.node_type === 'asset' || node.data.node_type === 'handoff');
    expect(cards).toHaveLength(2);
    expect(cards.every((node) => node.data.config.grid_row_key === 'SH001')).toBe(true);
    expect(cards.every((node) => node.draggable === false)).toBe(true);
    const assetCard = cards.find((node) => node.data.node_type === 'asset');
    const promptCard = cards.find((node) => node.data.node_type === 'handoff');
    expect(assetCard).toBeDefined();
    expect(promptCard).toBeDefined();
    expect(Math.abs(assetCard!.position.y - promptCard!.position.y)).toBeLessThanOrEqual(2);
  });

  it('resolves the production workspace target from prompt and media readiness', () => {
    expect(resolveAssetProductionTarget({ hasPrompt: false, hasMedia: false })).toBe('prompt');
    expect(resolveAssetProductionTarget({ hasPrompt: false, hasMedia: true })).toBe('prompt');
    expect(resolveAssetProductionTarget({ hasPrompt: true, hasMedia: false })).toBe('upload');
    expect(resolveAssetProductionTarget({ hasPrompt: true, hasMedia: true })).toBe('prompt');
  });
});
