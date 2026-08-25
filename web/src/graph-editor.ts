import type { GraphEdge, GraphNode } from './types';

export type EdgeRelation = GraphEdge['relation'];

export const EDGE_RELATIONS: Array<{ value: EdgeRelation; label: string }> = [
  { value: 'execution', label: '执行' },
  { value: 'reference', label: '参考' },
  { value: 'lineage', label: '血缘' },
  { value: 'annotation', label: '注释' },
];

export function edgeRelationPresentation(relation: EdgeRelation): { type: 'smoothstep' | 'bezier'; animated: boolean; dashed: boolean } {
  const execution = relation === 'execution';
  return {
    type: execution ? 'smoothstep' : 'bezier',
    animated: execution,
    dashed: !execution,
  };
}

export function wouldCreateExecutionCycle(
  edges: Array<Pick<GraphEdge, 'source' | 'target' | 'relation'>>,
  source: string,
  target: string,
): boolean {
  if (source === target) return true;
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.relation !== 'execution') continue;
    next.set(edge.source, [...(next.get(edge.source) || []), edge.target]);
  }
  const queue = [target];
  const visited = new Set<string>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    if (current === source) return true;
    visited.add(current);
    queue.push(...(next.get(current) || []));
  }
  return false;
}

export function autoLayoutNodes(nodes: GraphNode[], edges: Array<Pick<GraphEdge, 'source' | 'target' | 'relation'>>): GraphNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const groups = nodes.filter((node) => node.kind === 'group');
  const groupIds = new Set(groups.map((node) => node.id));
  const topLevel = nodes.filter((node) => !node.config.group_id || groupIds.has(node.id));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.relation !== 'execution' || !nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    const source = groupIds.has(edge.source) ? edge.source : String(nodeById.get(edge.source)?.config.group_id || edge.source);
    const target = groupIds.has(edge.target) ? edge.target : String(nodeById.get(edge.target)?.config.group_id || edge.target);
    if (source === target) continue;
    outgoing.set(source, [...(outgoing.get(source) || []), target]);
    incoming.set(target, [...(incoming.get(target) || []), source]);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const getDepth = (id: string): number => {
    if (depth.has(id)) return depth.get(id) || 0;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const value = Math.max(0, ...(incoming.get(id) || []).map(getDepth).map((item) => item + 1));
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const node of topLevel) getDepth(node.id);
  const byDepth = new Map<number, GraphNode[]>();
  for (const node of topLevel) {
    const column = depth.get(node.id) || 0;
    byDepth.set(column, [...(byDepth.get(column) || []), node]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [column, columnNodes] of [...byDepth.entries()].sort(([a], [b]) => a - b)) {
    columnNodes.sort((a, b) => a.id.localeCompare(b.id));
    columnNodes.forEach((node, row) => positions.set(node.id, { x: column * 280, y: row * 150 }));
  }
  for (const group of groups) {
    const children = nodes.filter((node) => node.config.group_id === group.id).sort((a, b) => a.id.localeCompare(b.id));
    const groupPosition = positions.get(group.id) || group.position;
    positions.set(group.id, groupPosition);
    const width = Number(group.config.width) || 460;
    const columns = Math.max(1, Math.floor((width - 40) / 220));
    children.forEach((child, index) => positions.set(child.id, {
      x: 24 + (index % columns) * 220,
      y: 78 + Math.floor(index / columns) * 130,
    }));
  }
  return nodes.map((node) => ({ ...node, position: positions.get(node.id) || node.position }));
}
