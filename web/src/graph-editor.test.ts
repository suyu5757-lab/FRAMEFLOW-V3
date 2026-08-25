import { describe, expect, it } from 'vitest';
import { EDGE_RELATIONS, autoLayoutNodes, edgeRelationPresentation, wouldCreateExecutionCycle } from './graph-editor';

describe('workflow edge relation presentation', () => {
  it('keeps execution edges directional and solid', () => {
    expect(edgeRelationPresentation('execution')).toEqual({ type: 'smoothstep', animated: true, dashed: false });
  });

  it('renders non-execution relations as non-scheduling dashed edges', () => {
    for (const relation of ['reference', 'lineage', 'annotation'] as const) {
      expect(edgeRelationPresentation(relation)).toEqual({ type: 'bezier', animated: false, dashed: true });
    }
  });

  it('exposes all graph relation choices used by the inspector', () => {
    expect(EDGE_RELATIONS.map((relation) => relation.value)).toEqual(['execution', 'reference', 'lineage', 'annotation']);
  });

  it('blocks only cycles made by execution edges', () => {
    const edges = [
      { source: 'story', target: 'assets', relation: 'execution' as const },
      { source: 'assets', target: 'delivery', relation: 'execution' as const },
      { source: 'delivery', target: 'story', relation: 'reference' as const },
    ];
    expect(wouldCreateExecutionCycle(edges, 'delivery', 'story')).toBe(true);
    expect(wouldCreateExecutionCycle(edges, 'delivery', 'assets')).toBe(true);
    expect(wouldCreateExecutionCycle(edges, 'story', 'story')).toBe(true);
    expect(wouldCreateExecutionCycle([{ source: 'delivery', target: 'story', relation: 'reference' as const }], 'story', 'delivery')).toBe(false);
  });

  it('lays out execution ancestors left-to-right and grouped children inside their group', () => {
    const nodes = [
      { id: 'story', kind: 'story', label: '故事', position: { x: 99, y: 99 }, config: {}, inputs: [], outputs: [], status: 'idle', version: 1, locked: false },
      { id: 'group', kind: 'group', label: '组', position: { x: 99, y: 99 }, config: { width: 460 }, inputs: [], outputs: [], status: 'idle', version: 1, locked: false },
      { id: 'assets', kind: 'asset_production', label: '资产', position: { x: 99, y: 99 }, config: { group_id: 'group' }, inputs: [], outputs: [], status: 'idle', version: 1, locked: false },
      { id: 'delivery', kind: 'delivery', label: '交付', position: { x: 99, y: 99 }, config: {}, inputs: [], outputs: [], status: 'idle', version: 1, locked: false },
    ];
    const next = autoLayoutNodes(nodes, [
      { source: 'story', target: 'assets', relation: 'execution' },
      { source: 'assets', target: 'delivery', relation: 'execution' },
    ]);
    expect(next.find((node) => node.id === 'story')?.position.x).toBe(0);
    expect(next.find((node) => node.id === 'delivery')?.position.x).toBeGreaterThan(0);
    expect(next.find((node) => node.id === 'assets')?.position.x).toBe(24);
    expect(next.find((node) => node.id === 'assets')?.position.y).toBe(78);
  });
});
