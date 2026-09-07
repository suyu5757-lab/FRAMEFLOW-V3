import { describe, expect, it } from 'vitest';
import { assetBoardAssetGroupHeight, assetBoardCardHeight, assetBoardCardHeights, assetBoardCardIsLocked, assetBoardFixedColumnBounds, assetBoardMinimumColumnWidth, assetBoardSafeColumnWidths, assetBoardToFlowEdges, assetBoardToFlowNodes, resolveAssetProductionTarget } from './App';
import type { AssetBoard, LibraryAsset, StoryShot } from './types';

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
    expect(assetBoardCardHeight({ node_type: 'asset', config: { asset_prompt: '', asset_artifact_count: 0 } })).toBe(assetBoardCardHeights.asset);
  });

  it('uses one fixed budget for each card variant and the tallest member of an asset group', () => {
    expect(assetBoardCardHeight({ node_type: 'handoff', config: { prompt_card: true } })).toBe(assetBoardCardHeights.prompt);
    expect(assetBoardCardHeight({ node_type: 'handoff', config: { prompt_card: true, artifact_url: '/candidate.png' } })).toBe(assetBoardCardHeights.promptWithMedia);
    expect(assetBoardCardHeight({ node_type: 'artifact', config: {} })).toBe(assetBoardCardHeights.artifact);
    expect(assetBoardAssetGroupHeight([assetBoardCardHeights.asset], [assetBoardCardHeights.prompt], 16)).toBe(assetBoardCardHeights.prompt);
    expect(assetBoardAssetGroupHeight([assetBoardCardHeights.asset], [assetBoardCardHeights.promptWithMedia, assetBoardCardHeights.artifact], 16)).toBe(926);
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

  it('keeps uploaded candidate metadata on the Prompt card', () => {
    const board = {
      metadata: {},
      nodes: [
        { id: 'asset:ENV01', node_type: 'asset', asset_id: 'ENV01', label: 'ENV01', status: 'partial', config: {} },
        {
          id: 'handoff:ENV01',
          node_type: 'handoff',
          asset_id: 'ENV01',
          label: '资产 Prompt · ENV01',
          status: 'prompt_draft_ready',
          config: {
            prompt_card: true,
            prompt: '未来都市平台',
            artifact_id: 'ART_ENV01',
            artifact_url: '/api/project-files/PRJ/artifacts/intake/env01.png',
            artifact_status: 'generated_pending_qa',
          },
        },
      ],
      edges: [],
    } as unknown as AssetBoard;
    const asset = { id: 'ENV01', name: 'ENV01', assetClass: 'environment', readiness: {} } as unknown as LibraryAsset;
    const promptCard = assetBoardToFlowNodes(board, [asset], 'all', true, [], { layoutMode: 'adaptive' }).find((node) => node.data.node_type === 'handoff');
    expect(promptCard?.data.config.artifact_id).toBe('ART_ENV01');
    expect(promptCard?.data.config.artifact_url).toBe('/api/project-files/PRJ/artifacts/intake/env01.png');
  });

  it('keeps S02 fusion inputs on the S02 row when source assets also appear in other shots', () => {
    const board = {
      metadata: {},
      nodes: [
        { id: 'shot:S02', node_type: 'shot', shot_id: 'S02', label: 'S02', status: 'ready', config: {} },
        { id: 'shot:S03', node_type: 'shot', shot_id: 'S03', label: 'S03', status: 'ready', config: {} },
        { id: 'asset:ENV01', node_type: 'asset', asset_id: 'ENV01', label: 'ENV01', status: 'ready', config: {} },
        { id: 'asset:P01', node_type: 'asset', asset_id: 'P01', label: 'P01', status: 'ready', config: {} },
        { id: 'asset:P02', node_type: 'asset', asset_id: 'P02', label: 'P02', status: 'ready', config: {} },
        { id: 'handoff:ENV01', node_type: 'handoff', asset_id: 'ENV01', label: '资产 Prompt · ENV01', status: 'prompt_draft_ready', config: { prompt_card: true, asset_class: 'scene' } },
        { id: 'handoff:P01', node_type: 'handoff', asset_id: 'P01', label: '资产 Prompt · P01', status: 'prompt_draft_ready', config: { prompt_card: true, asset_class: 'character' } },
        { id: 'handoff:P02', node_type: 'handoff', asset_id: 'P02', label: '资产 Prompt · P02', status: 'prompt_draft_ready', config: { prompt_card: true, asset_class: 'character' } },
        { id: 'asset:FUSION_S02', node_type: 'asset', asset_id: 'FUSION_S02', label: 'S02 镜头融合', status: 'planned', config: { asset_class: 'fusion' } },
        { id: 'handoff:FUSION_S02', node_type: 'handoff', asset_id: 'FUSION_S02', label: '资产 Prompt · S02 镜头融合', status: 'production_draft', config: { prompt_card: true, asset_class: 'fusion', fusion_slot: true } },
      ],
      edges: [
        { id: 'shot:S02:ENV01', source: 'shot:S02', target: 'asset:ENV01', relation: 'shot_dependency' },
        { id: 'shot:S02:P01', source: 'shot:S02', target: 'asset:P01', relation: 'shot_dependency' },
        { id: 'shot:S02:P02', source: 'shot:S02', target: 'asset:P02', relation: 'shot_dependency' },
        { id: 'shot:S02:FUSION', source: 'shot:S02', target: 'asset:FUSION_S02', relation: 'shot_dependency' },
        { id: 'shot:S03:P01', source: 'shot:S03', target: 'asset:P01', relation: 'shot_dependency' },
        { id: 'candidate:ENV01', source: 'asset:ENV01', target: 'handoff:ENV01', relation: 'candidate' },
        { id: 'candidate:P01', source: 'asset:P01', target: 'handoff:P01', relation: 'candidate' },
        { id: 'candidate:P02', source: 'asset:P02', target: 'handoff:P02', relation: 'candidate' },
        { id: 'fusion:ENV01:S02', source: 'asset:ENV01', target: 'asset:FUSION_S02', relation: 'fusion_input' },
        { id: 'fusion:P01:S02', source: 'asset:P01', target: 'asset:FUSION_S02', relation: 'fusion_input' },
        { id: 'fusion:P02:S02', source: 'asset:P02', target: 'asset:FUSION_S02', relation: 'fusion_input' },
      ],
    } as unknown as AssetBoard;
    const assets = [
      { id: 'ENV01', name: '平台环境', assetClass: 'scene', prompt: '环境', readiness: {} },
      { id: 'P01', name: '黑甲忍者', assetClass: 'character', prompt: '角色一', readiness: {} },
      { id: 'P02', name: '银白骑士', assetClass: 'character', prompt: '角色二', readiness: {} },
      { id: 'FUSION_S02', name: 'S02 镜头融合', assetClass: 'fusion', fusionSlot: true, fusionSourceAssetIds: ['ENV01', 'P01', 'P02'], promptRelevantShots: ['S02'], readiness: {} },
    ] as unknown as LibraryAsset[];
    const nodes = assetBoardToFlowNodes(board, assets, 'all', true, [
      { id: 'S02', scene: '平台' },
      { id: 'S03', scene: '平台' },
    ] as unknown as StoryShot[], { layoutMode: 'adaptive' });
    const edges = assetBoardToFlowEdges(board, nodes).filter((edge) => edge.data?.relation === 'fusion_input');
    const s02FusionEdges = edges.filter((edge) => edge.target === 'handoff:FUSION_S02');

    expect(s02FusionEdges).toHaveLength(3);
    expect(s02FusionEdges.map((edge) => edge.source).sort()).toEqual(['handoff:ENV01', 'handoff:P01', 'handoff:P02']);
    expect(edges.some((edge) => edge.source.includes(':row:S03') && edge.target === 'handoff:FUSION_S02')).toBe(false);
    const allFlowEdges = assetBoardToFlowEdges(board, nodes);
    expect(allFlowEdges.some((edge) => edge.data?.relation === 'candidate' && edge.source === 'asset:P02' && edge.target === 'handoff:P02')).toBe(false);
  });

  it('centers the default fusion group inside its shot row and keeps it in the fusion column', () => {
    const board = {
      metadata: { layout_mode: 'shot_asset_table_v8', layout_view: 'adaptive' },
      nodes: [
        { id: 'shot:S02', node_type: 'shot', shot_id: 'S02', label: 'S02', status: 'ready', config: {} },
        { id: 'asset:ENV01', node_type: 'asset', asset_id: 'ENV01', label: 'ENV01', status: 'ready', config: {} },
        { id: 'asset:P01', node_type: 'asset', asset_id: 'P01', label: 'P01', status: 'ready', config: {} },
        { id: 'asset:P02', node_type: 'asset', asset_id: 'P02', label: 'P02', status: 'ready', config: {} },
        { id: 'asset:FUSION_S02', node_type: 'asset', asset_id: 'FUSION_S02', label: 'S02 镜头融合', status: 'planned', config: { asset_class: 'fusion' } },
        { id: 'handoff:ENV01', node_type: 'handoff', asset_id: 'ENV01', label: '资产 Prompt · ENV01', status: 'prompt_draft_ready', config: { prompt_card: true, asset_class: 'scene' } },
        { id: 'handoff:P01', node_type: 'handoff', asset_id: 'P01', label: '资产 Prompt · P01', status: 'prompt_draft_ready', config: { prompt_card: true, asset_class: 'character' } },
        { id: 'handoff:P02', node_type: 'handoff', asset_id: 'P02', label: '资产 Prompt · P02', status: 'prompt_draft_ready', config: { prompt_card: true, asset_class: 'character' } },
        { id: 'handoff:FUSION_S02', node_type: 'handoff', asset_id: 'FUSION_S02', label: '资产 Prompt · S02 镜头融合', status: 'production_draft', config: { prompt_card: true, asset_class: 'fusion', fusion_slot: true } },
      ],
      edges: [
        { id: 'shot:S02:ENV01', source: 'shot:S02', target: 'asset:ENV01', relation: 'shot_dependency' },
        { id: 'shot:S02:P01', source: 'shot:S02', target: 'asset:P01', relation: 'shot_dependency' },
        { id: 'shot:S02:P02', source: 'shot:S02', target: 'asset:P02', relation: 'shot_dependency' },
        { id: 'shot:S02:FUSION', source: 'shot:S02', target: 'asset:FUSION_S02', relation: 'shot_dependency' },
      ],
    } as unknown as AssetBoard;
    const assets = [
      { id: 'ENV01', name: '平台环境', assetClass: 'scene', prompt: '环境', readiness: {} },
      { id: 'P01', name: '黑甲忍者', assetClass: 'character', prompt: '角色一', readiness: {} },
      { id: 'P02', name: '银白骑士', assetClass: 'character', prompt: '角色二', readiness: {} },
      { id: 'FUSION_S02', name: 'S02 镜头融合', assetClass: 'fusion', fusionSlot: true, fusionSourceAssetIds: ['ENV01', 'P01', 'P02'], promptRelevantShots: ['S02'], readiness: {} },
    ] as unknown as LibraryAsset[];
    const nodes = assetBoardToFlowNodes(board, assets, 'all', true, [{ id: 'S02', scene: '平台' }] as unknown as StoryShot[], { layoutMode: 'adaptive' });
    const table = nodes.find((node) => node.id === 'asset-grid:table');
    const fusionPrompt = nodes.find((node) => node.id === 'handoff:FUSION_S02');
    const fusionBound = (table?.data.config.grid_column_bounds as Array<{ key: string; x: number; width: number }> | undefined)?.find((bound) => bound.key === 'fusion');
    const row = (table?.data.config.grid_rows as Array<{ key: string; y: number; height: number }> | undefined)?.find((item) => item.key === 'S02');
    expect(fusionPrompt).toBeDefined();
    expect(fusionBound).toBeDefined();
    expect(row).toBeDefined();
    expect(fusionPrompt!.data.config.grid_column_key).toBe('fusion');
    expect(fusionPrompt!.position.x).toBeGreaterThanOrEqual(fusionBound!.x);
    const promptHeight = assetBoardCardHeights.prompt;
    const fusionCenter = fusionPrompt!.position.y + promptHeight / 2;
    const rowCenter = row!.y + row!.height / 2;
    expect(Math.abs(fusionCenter - rowCenter)).toBeLessThanOrEqual(80);
  });

  it('keeps adjacent P12 and P08 asset groups in non-overlapping vertical slots', () => {
    const board = {
      metadata: { layout_mode: 'shot_asset_table_v8', layout_view: 'adaptive', layout_preset: 'standard' },
      nodes: [
        { id: 'shot:S07', node_type: 'shot', shot_id: 'S07', label: 'S07', status: 'ready', config: {} },
        { id: 'asset:P12', node_type: 'asset', asset_id: 'P12', label: 'P12', status: 'partial', config: { asset_class: 'prop' } },
        { id: 'handoff:P12', node_type: 'handoff', asset_id: 'P12', label: '资产 Prompt · P12', status: 'prompt_draft_ready', config: { prompt_card: true, asset_class: 'prop', prompt: 'P12 长 Prompt 与前置资产清单' } },
        { id: 'asset:P08', node_type: 'asset', asset_id: 'P08', label: 'P08', status: 'partial', config: { asset_class: 'prop' } },
        { id: 'handoff:P08', node_type: 'handoff', asset_id: 'P08', label: '资产 Prompt · P08', status: 'prompt_draft_ready', config: { prompt_card: true, asset_class: 'prop', prompt: 'P08 长 Prompt 与前置资产清单', artifact_url: '/candidate-p08.png' } },
      ],
      edges: [
        { id: 'shot:S07:P12', source: 'shot:S07', target: 'asset:P12', relation: 'shot_dependency' },
        { id: 'shot:S07:P08', source: 'shot:S07', target: 'asset:P08', relation: 'shot_dependency' },
      ],
    } as unknown as AssetBoard;
    const assets = [
      { id: 'P12', name: 'P12', assetClass: 'prop', prompt: 'P12 长 Prompt', readiness: {} },
      { id: 'P08', name: 'P08', assetClass: 'prop', prompt: 'P08 长 Prompt', readiness: {} },
    ] as unknown as LibraryAsset[];
    const nodes = assetBoardToFlowNodes(board, assets, 'all', true, [{ id: 'S07', scene: '平台' }] as unknown as StoryShot[], { layoutMode: 'adaptive', gap: 16 });
    const intervals = [...new Set(['P12', 'P08'])].map((assetId) => {
      const groupNodes = nodes.filter((node) => node.data.asset_id === assetId && node.data.config.grid_row_key === 'S07' && ['asset', 'handoff'].includes(node.data.node_type));
      const start = Math.min(...groupNodes.map((node) => node.position.y));
      const end = Math.max(...groupNodes.map((node) => node.position.y + assetBoardCardHeight(node.data)));
      return { assetId, start, end };
    }).sort((left, right) => left.start - right.start);

    expect(intervals).toHaveLength(2);
    expect(intervals[0].assetId).toBe('P12');
    expect(intervals[1].assetId).toBe('P08');
    expect(intervals[1].start).toBeGreaterThanOrEqual(intervals[0].end + 16);
  });

  it('resolves the production workspace target from prompt and media readiness', () => {
    expect(resolveAssetProductionTarget({ hasPrompt: false, hasMedia: false })).toBe('prompt');
    expect(resolveAssetProductionTarget({ hasPrompt: false, hasMedia: true })).toBe('prompt');
    expect(resolveAssetProductionTarget({ hasPrompt: true, hasMedia: false })).toBe('upload');
    expect(resolveAssetProductionTarget({ hasPrompt: true, hasMedia: true })).toBe('prompt');
  });
});
