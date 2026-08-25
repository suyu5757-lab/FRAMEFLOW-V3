export type AssetBoardSelectionData = {
  id: string;
  node_type: string;
  sourceNodeId?: string;
  config: Record<string, unknown>;
};

export type AssetBoardSelectionNode = AssetBoardSelectionData & {
  selected?: boolean;
  hidden?: boolean;
};

export type AssetBoardFlowSelectionNode = {
  id: string;
  data: AssetBoardSelectionData;
  selected?: boolean;
  hidden?: boolean;
};

type SelectionInput = AssetBoardSelectionNode | AssetBoardFlowSelectionNode;

export type AssetBoardSelectionKey = string;

const selectableNodeTypes = new Set(['asset', 'handoff', 'artifact']);

function selectionData(node: SelectionInput): AssetBoardSelectionData {
  return 'data' in node ? node.data : node;
}

export function isAssetBoardSelectionNode(node: SelectionInput | Pick<AssetBoardSelectionData, 'node_type'>): boolean {
  return selectableNodeTypes.has(selectionData(node as SelectionInput).node_type);
}

export function assetBoardSelectionKey(node: SelectionInput): AssetBoardSelectionKey | null {
  const data = selectionData(node);
  if (!selectableNodeTypes.has(data.node_type)) return null;
  const sourceNodeId = String(data.sourceNodeId || data.id);
  const rowKey = String(data.config.grid_row_key || 'shared');
  return [sourceNodeId, data.node_type, rowKey].join('::');
}

export function selectedAssetBoardCards<T extends SelectionInput>(nodes: T[]): T[] {
  return nodes.filter((node) => node.selected && !node.hidden && assetBoardSelectionKey(node) !== null);
}

export function singleSelectedAssetBoardCard<T extends SelectionInput>(nodes: T[]): T | undefined {
  const selected = selectedAssetBoardCards(nodes);
  return selected.length === 1 ? selected[0] : undefined;
}

export function applyAssetBoardSelection<T extends SelectionInput>(nodes: T[], selectionKey: AssetBoardSelectionKey | null): T[] {
  return nodes.map((node) => {
    const selected = Boolean(!node.hidden && selectionKey && assetBoardSelectionKey(node) === selectionKey);
    return node.selected === selected ? node : { ...node, selected };
  });
}
