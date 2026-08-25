import { useEffect } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  type NodeProps,
  type OnNodeDrag,
  type Viewport,
  useReactFlow,
} from '@xyflow/react';
import { assetClassLabels, assetStatusLabels } from './asset-state';
import type { AssetBoardNode, LibraryAsset } from './types';

export type AssetProductionTarget = 'prompt' | 'upload';
export type AssetBoardLayoutMode = 'adaptive' | 'matrix';
export type AssetBoardCollapseTarget = { type: 'shot' | 'asset'; id: string; keepNodeId?: string; scopeKey?: string };
export type AssetBoardColumnWidths = { shots: number; 'asset-flow': number; fusion: number };
export type AssetBoardContextTarget = { nodeId: string; assetId: string; label: string; nodeType: AssetBoardNodeData['node_type']; rowKey: string; x: number; y: number };
export type AssetBoardNodeData = Omit<AssetBoardNode, 'node_type'> & {
  node_type: AssetBoardNode['node_type'] | 'row' | 'table';
  presentationOnly?: boolean;
  sourceNodeId?: string;
  collapsed?: boolean;
  onToggleScope?: (target: AssetBoardCollapseTarget) => void;
  onContextMenu?: (target: AssetBoardContextTarget) => void;
  onApprovePrompt?: (assetId: string) => void;
  onGenerateImage?: (assetId: string) => void;
  onCopyPrompt?: (assetId: string) => void;
  onUploadAsset?: (assetId: string, file: File) => void;
  onApproveAsset?: (assetId: string, artifactId: string) => void;
  onRejectAsset?: (assetId: string, artifactId: string) => void;
  onRegisterAsset?: (assetId: string, artifactId: string) => void;
  onGeneratePrompt?: (assetId: string) => void;
  onColumnResize?: (key: keyof AssetBoardColumnWidths, delta: number) => void;
  onOpenAssetProduction?: (assetId: string, target: AssetProductionTarget, nodeId?: string) => void;
};
export type AssetFlowNode = Node<AssetBoardNodeData, 'asset-board'>;

const defaultAssetBoardColumnWidths: AssetBoardColumnWidths = { shots: 260, 'asset-flow': 640, fusion: 640 };
const assetBoardDefaultCardWidth = 286;
const assetBoardCellPadding = 12;

function assetBoardColumnWidthForKey(widths: AssetBoardColumnWidths, key: string): number {
  if (key === 'shots') return widths.shots;
  if (key === 'fusion') return widths.fusion;
  return widths['asset-flow'];
}

function assetBoardMinimumColumnWidth(key: string, cardWidth: number, gap: number, layoutMode: AssetBoardLayoutMode): number {
  const safeCardWidth = Math.max(220, cardWidth);
  if (key === 'shots') return 220;
  const minimum = layoutMode === 'adaptive' ? safeCardWidth * 2 + gap : safeCardWidth;
  return Math.max(280, minimum + assetBoardCellPadding * 2);
}

function assetBoardSafeColumnWidths(widths: AssetBoardColumnWidths, cardWidth: number, gap: number, layoutMode: AssetBoardLayoutMode): AssetBoardColumnWidths {
  return {
    shots: Math.max(widths.shots, assetBoardMinimumColumnWidth('shots', cardWidth, gap, layoutMode)),
    'asset-flow': Math.max(widths['asset-flow'], assetBoardMinimumColumnWidth('asset-flow', cardWidth, gap, layoutMode)),
    fusion: Math.max(widths.fusion, assetBoardMinimumColumnWidth('fusion', cardWidth, gap, layoutMode)),
  };
}

function assetBoardStatusLabel(status: string): string {
  return assetStatusLabels[status] || status || '待处理';
}

function resolveAssetProductionTarget(input: { hasPrompt: boolean; hasMedia: boolean }): AssetProductionTarget {
  return input.hasPrompt && !input.hasMedia ? 'upload' : 'prompt';
}

function AssetBoardCard({ data, selected }: NodeProps<AssetFlowNode>) {
  if (data.node_type === 'table') {
    const rawColumns = Array.isArray(data.config.grid_columns) ? data.config.grid_columns as Array<{ key: string; label: string; english: string; description: string }> : [];
    const layoutMode = String(data.config.layout_mode || 'adaptive') as AssetBoardLayoutMode;
    const fusionColumn = rawColumns.find((column) => column.key === 'fusion') || { key: 'fusion', label: '镜头融合', english: 'SHOT FUSION', description: '连接角色、场景与道具生成融合资产' };
    const columns = layoutMode === 'adaptive' && rawColumns.length ? [rawColumns[0], { key: 'asset-flow', label: '镜头资产流', english: 'SHOT ASSET FLOW', description: '按当前镜头需求自动收拢' }, fusionColumn] : rawColumns;
    const rows = Array.isArray(data.config.grid_rows) ? data.config.grid_rows as Array<{ key: string; y: number; height: number; shotLabel?: string; shotScene?: string; shotDetail?: string; shotStatus?: string }> : [];
    const requestedColumnWidths: AssetBoardColumnWidths = {
      shots: Math.max(220, Number(data.config.shot_column_width) || defaultAssetBoardColumnWidths.shots),
      'asset-flow': Math.max(280, Number(data.config.asset_flow_width) || defaultAssetBoardColumnWidths['asset-flow']),
      fusion: Math.max(280, Number(data.config.fusion_column_width) || defaultAssetBoardColumnWidths.fusion),
    };
    const cardWidth = Math.max(220, Number(data.config.card_width) || assetBoardDefaultCardWidth);
    const columnWidths = assetBoardSafeColumnWidths(requestedColumnWidths, cardWidth, Math.max(8, Number(data.config.layout_gap) || 16), layoutMode);
    const logicalGridTemplate = layoutMode === 'adaptive' && columns.length === 3
      ? `${columnWidths.shots}px ${columnWidths['asset-flow']}px ${columnWidths.fusion}px`
      : columns.map((column) => `${assetBoardColumnWidthForKey(columnWidths, column.key)}px`).join(' ');
    const gridGap = layoutMode === 'adaptive' ? Math.max(8, Number(data.config.layout_gap) || 16) : 0;
    const gridTemplate = `${logicalGridTemplate} minmax(0, 1fr)`;
    const collapsedRows = new Set(Array.isArray(data.config.collapsed_scopes) ? data.config.collapsed_scopes.map((value) => String(value)) : []);
    return <div className="asset-board-table" style={{ '--asset-shot-column': `${columnWidths.shots}px` } as CSSProperties}>
      <div className="asset-board-table-header" style={{ gridTemplateColumns: gridTemplate, columnGap: `${gridGap}px` }}>
        {columns.map((column, index) => <div key={column.key} className="asset-board-table-header-cell">
          <span>{column.english}</span><strong>{column.label}</strong><small>{column.description}</small>
          {index < columns.length - 1 && <button className="asset-board-column-resizer" type="button" aria-label={`调整${column.label}列宽`} onPointerDown={(event) => {
            event.preventDefault(); event.stopPropagation();
            const resizeKey: keyof AssetBoardColumnWidths = column.key === 'shots' ? 'shots' : column.key === 'fusion' ? 'fusion' : 'asset-flow';
            let lastX = event.clientX;
            const move = (moveEvent: PointerEvent) => { const delta = moveEvent.clientX - lastX; lastX = moveEvent.clientX; data.onColumnResize?.(resizeKey, delta); };
            const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
            window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop, { once: true });
          }} />}
        </div>)}
      </div>
      {rows.map((row) => <div key={row.key} className={`asset-board-table-row ${row.key === 'shared' ? 'shared' : ''} ${collapsedRows.has(row.key) ? 'collapsed' : ''}`} style={{ top: row.y, height: row.height, gridTemplateColumns: gridTemplate, columnGap: `${gridGap}px` }} onClick={(event) => { event.stopPropagation(); data.onToggleScope?.({ type: 'shot', id: row.key }); }}>
        <div className="asset-board-table-cell asset-board-table-shot-cell" aria-label={`${row.key} 镜头标题`}>
          <div className="asset-board-table-shot-meta"><span>镜头执行单元</span><i>{collapsedRows.has(row.key) ? '已收起' : assetBoardStatusLabel(String(row.shotStatus || (row.key === 'shared' ? 'partial' : 'ready')))}</i></div>
          <strong>{row.shotLabel || (row.key === 'shared' ? 'SHARED' : row.key)}</strong>
          <b>{row.shotScene || (row.key === 'shared' ? '跨镜头资产' : '未命名场景')}</b>
          <small>{row.shotDetail || '当前镜头所需资产'}</small>
        </div>
        {columns.slice(1).map((column) => <div key={column.key} className="asset-board-table-cell asset-board-table-asset-cell" />)}
      </div>)}
    </div>;
  }
  if (data.node_type === 'row' || data.node_type === 'group') return null;
  const assetClass = String(data.config.asset_class || '');
  const isMedia = data.node_type === 'artifact' && typeof data.config.url === 'string';
  const rowKey = String(data.config.grid_row_key || '');
  const canCollapseAssetScope = data.node_type === 'asset' && Boolean(data.asset_id);
  if (data.node_type === 'shot') return <div className="asset-board-shot-anchor" aria-hidden="true"><Handle type="target" position={Position.Left} /><Handle type="source" position={Position.Right} /></div>;
  const canOpenContextMenu = Boolean(data.asset_id) && ['asset', 'artifact', 'handoff'].includes(data.node_type);
  const promptCard = data.node_type === 'handoff' && Boolean(data.config.prompt_card);
  if (promptCard) {
    const isFusionPrompt = assetClass === 'fusion';
    const fusionPromptSource = String(data.config.fusion_prompt_source || '');
    const fusionPromptState = String(data.config.fusion_prompt_state || 'awaiting_connection');
    const fusionPromptReady = !isFusionPrompt || fusionPromptSource === 'fusion-connection-agent';
    const fusionPromptStale = Boolean(data.config.fusion_prompt_stale) || fusionPromptState === 'stale';
    const promptQa = String(data.config.prompt_qa_decision || 'Pending');
    const generationStatus = String(data.config.generation_status || 'planned');
    const eligible = data.config.image_generation_eligible !== false;
    const relevantShots = Array.isArray(data.config.relevant_shots) ? data.config.relevant_shots.map((item) => String(item)).join('、') : '';
    const artifactId = String(data.config.artifact_id || '');
    const artifactUrl = String(data.config.artifact_url || '');
    const artifactStatus = String(data.config.artifact_status || '');
    const artifactQa = String(data.config.artifact_qa_decision || 'Pending');
    const productionDraft = Boolean(data.config.production_draft);
    const artifactApproved = artifactQa === 'Approved' || ['approved_pending_registration', 'ready', 'active'].includes(artifactStatus);
    const artifactState = artifactApproved ? (artifactStatus === 'approved_pending_registration' ? '图片已审核 · 待登记' : '图片已审核') : '图片待审核';
    return <article className={`asset-board-card asset-board-prompt-card ${selected ? 'selected' : ''}`} data-asset-card-type="handoff" data-asset-id={String(data.asset_id || '')} data-grid-row={rowKey} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); data.onContextMenu?.({ nodeId: data.id, assetId: String(data.asset_id), label: data.label, nodeType: data.node_type, rowKey, x: event.clientX, y: event.clientY }); }}>
      <Handle type="target" position={Position.Left} />
      {artifactUrl ? <div className="asset-board-prompt-media"><img src={artifactUrl} alt={`${data.label} 已上传资产`} /><div><span>已上传资产</span><i>{artifactState}</i></div></div> : productionDraft && <div className="asset-board-prompt-media asset-board-prompt-media-empty"><strong>图片位置</strong><span>可从右侧上传候选图片</span></div>}
      <div className="asset-board-prompt-content">
        <div className="asset-board-card-meta"><span>{isFusionPrompt ? (fusionPromptReady ? '正式融合 Prompt' : '融合规划 / 历史 Prompt') : '资产 Prompt'}</span><i>{fusionPromptStale ? '输入已变化 · 待重新融合' : !fusionPromptReady ? '等待实际资产连线' : artifactId ? artifactState : promptQa === 'Approved' ? 'Prompt 已通过' : promptQa}</i></div>
        <strong>{data.label}</strong>
        <small>{data.asset_id || '资产'} · {String(data.config.target_skill || 'video-asset-regulator')}{relevantShots ? ` · ${relevantShots}` : ''}</small>
        <pre tabIndex={0} aria-label={`${data.label} Prompt`} className={`asset-board-prompt-text ${productionDraft && !String(data.config.prompt || '').trim() ? 'empty' : ''}`}>{String(data.config.prompt || '').trim() || '提示词为空，可点击“编辑 Prompt”手动填写，或使用 AI 编写 Prompt。'}</pre>
        <div className="asset-board-prompt-state"><span>{!fusionPromptReady ? '正式 Prompt：尚未生成' : artifactId ? `图片：${artifactState}` : `图像执行：${generationStatus}`}</span>{fusionPromptStale && <span>请重新确认融合连线</span>}{!eligible && <span>非图像资产</span>}</div>
        <div className="asset-board-prompt-actions">
          {fusionPromptReady && !artifactId && <label className="asset-board-upload-button">上传资产<input type="file" accept="image/png,image/jpeg,image/webp" onClick={(event) => event.stopPropagation()} onChange={(event) => { const file = event.target.files?.[0]; if (file) data.onUploadAsset?.(String(data.asset_id), file); event.currentTarget.value = ''; }} /></label>}
          {productionDraft && !String(data.config.prompt || '').trim() && <button className="asset-board-prompt-primary" onClick={(event) => { event.stopPropagation(); data.onOpenAssetProduction?.(String(data.asset_id), 'prompt', data.id); }}>编辑 Prompt</button>}
          {productionDraft && !String(data.config.prompt || '').trim() && <button onClick={(event) => { event.stopPropagation(); data.onGeneratePrompt?.(String(data.asset_id)); }}>AI 编写 Prompt</button>}
          {fusionPromptReady && !artifactId && String(data.config.prompt || '').trim() && <button onClick={(event) => { event.stopPropagation(); data.onCopyPrompt?.(String(data.asset_id)); }}>复制并打开 ChatGPT</button>}
          {fusionPromptReady && artifactId && !artifactApproved && <button className="asset-board-prompt-primary" onClick={(event) => { event.stopPropagation(); data.onApproveAsset?.(String(data.asset_id), artifactId); }}>审核通过</button>}
          {fusionPromptReady && artifactId && !artifactApproved && <button onClick={(event) => { event.stopPropagation(); data.onRejectAsset?.(String(data.asset_id), artifactId); }}>审核不通过并重写提示词</button>}
          {fusionPromptReady && artifactId && artifactStatus === 'approved_pending_registration' && <button className="asset-board-prompt-primary" onClick={(event) => { event.stopPropagation(); data.onRegisterAsset?.(String(data.asset_id), artifactId); }}>登记为资产</button>}
          {fusionPromptReady && !artifactId && String(data.config.prompt || '').trim() && promptQa !== 'Approved' && <button className="asset-board-prompt-primary" onClick={(event) => { event.stopPropagation(); data.onApprovePrompt?.(String(data.asset_id)); }}>通过 Prompt QA</button>}
          {fusionPromptReady && !artifactId && promptQa === 'Approved' && eligible && generationStatus !== 'generated-pending-qa' && <button className="asset-board-prompt-primary" onClick={(event) => { event.stopPropagation(); data.onGenerateImage?.(String(data.asset_id)); }}>确认并生成</button>}
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </article>;
  }
  const hasPrompt = Boolean(String(data.config.asset_prompt || '').trim());
  const hasMedia = Number(data.config.asset_artifact_count || 0) > 0 || Boolean(data.config.asset_file_url);
  const showProductionShortcuts = data.node_type === 'asset' && Boolean(data.asset_id) && (!hasPrompt || !hasMedia);
  const productionTarget = resolveAssetProductionTarget({ hasPrompt, hasMedia });
  const productionShortcutLabel = !hasPrompt && !hasMedia ? '缺少 Prompt 与候选文件' : !hasPrompt ? '缺少 Prompt' : '待上传候选文件';
  return <article className={`asset-board-card asset-board-${data.node_type} ${selected ? 'selected' : ''} ${canCollapseAssetScope && data.collapsed ? 'collapsed' : ''} ${data.config.archived ? 'archived' : ''}`} data-asset-card-type={data.node_type} data-asset-id={String(data.asset_id || '')} data-grid-row={rowKey} onContextMenu={canOpenContextMenu ? (event) => { event.preventDefault(); event.stopPropagation(); data.onContextMenu?.({ nodeId: data.id, assetId: String(data.asset_id), label: data.label, nodeType: data.node_type, rowKey, x: event.clientX, y: event.clientY }); } : undefined} aria-expanded={canCollapseAssetScope && data.collapsed === true ? false : undefined}>
    <Handle type="target" position={Position.Left} />
    {isMedia && <img className="asset-board-thumb" src={String(data.config.url)} alt="候选素材" />}
    {data.node_type === 'asset' && rowKey && rowKey !== 'shared' && String(data.config.manual_shot_id || '') === rowKey && <b className="asset-board-assignment-corner">加入 {rowKey} 分镜资产组</b>}
    <div className="asset-board-card-meta"><span>{data.node_type === 'handoff' ? '人工桥接' : data.node_type === 'artifact' ? '候选版本' : assetClassLabels[assetClass] || assetClass || '资产'}</span><div className="asset-board-card-meta-actions"><i>{assetBoardStatusLabel(data.status)}</i>{canCollapseAssetScope && <button type="button" className="asset-board-scope-toggle" aria-expanded={!data.collapsed} aria-label={`${data.collapsed ? '展开' : '收起'} ${data.label} 下游内容`} title={`${data.collapsed ? '展开' : '收起'}下游内容`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); const rowScope = String(data.config.grid_row_key || 'shared'); data.onToggleScope?.({ type: 'asset', id: String(data.asset_id), keepNodeId: data.id, scopeKey: `asset:${data.asset_id}:${rowScope}` }); }}>{data.collapsed ? '展开' : '收起'}</button>}</div></div>
    <strong>{data.label}</strong>
    <small>{data.asset_id || data.shot_id || '空间节点'}{data.config.grade ? ` · ${String(data.config.grade)}` : ''}{rowKey && rowKey !== 'shared' ? ` · ${rowKey}` : ''}</small>
    {showProductionShortcuts && <div className="asset-board-production-shortcuts"><span title={productionShortcutLabel}>{productionShortcutLabel}</span><div><button type="button" aria-label={`打开 ${data.label} 的制作操作台`} onClick={(event) => { event.stopPropagation(); data.onOpenAssetProduction?.(String(data.asset_id), productionTarget, data.id); }}>打开制作操作台</button></div></div>}
    <Handle type="source" position={Position.Right} />
  </article>;
}

export type AssetBoardFlowProps = {
  nodes: AssetFlowNode[];
  edges: Edge[];
  onNodesChange: (changes: NodeChange<AssetFlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onNodeClick: (event: MouseEvent, node: AssetFlowNode) => void;
  onNodeDragStart: OnNodeDrag<AssetFlowNode>;
  onNodeDragStop: OnNodeDrag<AssetFlowNode>;
  onMoveEnd: (viewport: Viewport) => void;
  defaultViewport?: Viewport;
  focusTarget?: string;
};

function AssetBoardFlowInner({ nodes, edges, onNodesChange, onEdgesChange, onConnect, onNodeClick, onNodeDragStart, onNodeDragStop, onMoveEnd, defaultViewport, focusTarget = '' }: AssetBoardFlowProps) {
  const nodeTypes = { 'asset-board': AssetBoardCard };
  const flow = useReactFlow();
  useEffect(() => {
    if (!focusTarget) return;
    const node = nodes.find((candidate) => !candidate.data.presentationOnly && (candidate.id === focusTarget || candidate.data.shot_id === focusTarget || candidate.data.asset_id === focusTarget || String(candidate.data.config.grid_row_key || '') === focusTarget));
    if (!node) return;
    const width = typeof node.style?.width === 'number' ? node.style.width : Number(node.style?.width) || 240;
    const height = node.data.node_type === 'artifact' ? 190 : node.data.node_type === 'shot' ? 120 : 110;
    flow.setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: .86, duration: 460 });
  }, [focusTarget, flow, nodes]);
  return <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={onNodeClick} onNodeDragStart={onNodeDragStart} onNodeDragStop={onNodeDragStop} onMoveEnd={(_, viewport) => onMoveEnd(viewport)} defaultViewport={defaultViewport} fitView minZoom={0.12} maxZoom={1.8} deleteKeyCode={null} selectionOnDrag selectionMode={SelectionMode.Partial} panOnDrag={[1, 2]}>
      <Background color="#343831" gap={22} size={1} />
      <Controls position="bottom-left" />
      <MiniMap position="bottom-right" pannable zoomable nodeColor="#d7ff4b" maskColor="rgba(6,7,6,.72)" />
    </ReactFlow>
}

export function AssetBoardFlow(props: AssetBoardFlowProps) {
  return <ReactFlowProvider><AssetBoardFlowInner {...props} /></ReactFlowProvider>;
}
