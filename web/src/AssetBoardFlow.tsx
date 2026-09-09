import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, MouseEvent, PointerEvent as ReactPointerEvent } from 'react';
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
  type CoordinateExtent,
  type Viewport,
  useReactFlow,
} from '@xyflow/react';
import { assetClassLabels, assetStatusLabels } from './asset-state';
import { assetBoardSelectionKey } from './asset-board-selection';
import { generationReferenceAssetsFromConfig, mergeGenerationReferenceAssets } from './asset-reference-requirements';
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
  onRemoveArtifact?: (assetId: string, artifactId: string) => void;
  onApproveAsset?: (assetId: string, artifactId: string) => void;
  onRejectAsset?: (assetId: string, artifactId: string) => void;
  onRegisterAsset?: (assetId: string, artifactId: string) => void;
  onGeneratePrompt?: (assetId: string) => void;
  onGenerateFusionPrompt?: (assetId: string, sourceAssetIds: string[], shotId: string) => void;
  onColumnResize?: (key: keyof AssetBoardColumnWidths, delta: number) => void;
  onOpenAssetProduction?: (assetId: string, target: AssetProductionTarget, nodeId?: string) => void;
};
export type AssetFlowNode = Node<AssetBoardNodeData, 'asset-board'>;

const assetBoardViewportPadding = { x: 220, y: 160 };
const assetBoardMinimumContentSize = { width: 720, height: 640 };

const defaultAssetBoardColumnWidths: AssetBoardColumnWidths = { shots: 260, 'asset-flow': 640, fusion: 640 };
const assetBoardDefaultCardWidth = 286;
const assetBoardCellPadding = 12;

function flowNodeWidth(node: AssetFlowNode): number {
  return Math.max(1, Number(node.style?.width) || assetBoardDefaultCardWidth);
}

function flowNodeHeight(node: AssetFlowNode): number {
  const configuredHeight = Number(node.style?.height);
  if (configuredHeight > 0) return configuredHeight;
  if (node.data.node_type === 'table') return assetBoardMinimumContentSize.height;
  if (node.data.node_type === 'handoff') return 500;
  if (node.data.node_type === 'artifact') return 260;
  if (node.data.node_type === 'shot') return 112;
  return 160;
}

/**
 * Keep the viewport and movable candidate cards inside the generated board.
 * React Flow defaults both extents to infinity, which makes a small
 * asset-board dataset easy to lose in an empty canvas. The extra viewport
 * padding preserves a comfortable margin for one-shot navigation without
 * reintroducing an effectively infinite work area.
 */
export function assetBoardFlowExtents(nodes: AssetFlowNode[]): { translateExtent: CoordinateExtent; nodeExtent: CoordinateExtent } {
  const visibleNodes = nodes.filter((node) => !node.hidden);
  const table = visibleNodes.find((node) => node.id === 'asset-grid:table') || nodes.find((node) => node.id === 'asset-grid:table');
  const tableRight = table ? table.position.x + flowNodeWidth(table) : assetBoardMinimumContentSize.width;
  const tableBottom = table ? table.position.y + flowNodeHeight(table) : assetBoardMinimumContentSize.height;
  const contentRight = Math.max(assetBoardMinimumContentSize.width, tableRight, ...visibleNodes.map((node) => node.position.x + flowNodeWidth(node)));
  const contentBottom = Math.max(assetBoardMinimumContentSize.height, tableBottom, ...visibleNodes.map((node) => node.position.y + flowNodeHeight(node)));
  const nodeExtent: CoordinateExtent = [[0, 0], [contentRight, contentBottom]];
  const translateExtent: CoordinateExtent = [
    [-assetBoardViewportPadding.x, -assetBoardViewportPadding.y],
    [contentRight + assetBoardViewportPadding.x, contentBottom + assetBoardViewportPadding.y],
  ];
  return { translateExtent, nodeExtent };
}

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

function PromptTextScroller({ label, text, empty }: { label: string; text: string; empty: boolean }) {
  const textRef = useRef<HTMLPreElement>(null);
  const scrollbarRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startClientY: number; startScrollTop: number } | null>(null);
  const [active, setActive] = useState(false);
  const [scrollMetrics, setScrollMetrics] = useState({ scrollable: false, thumbHeight: 100, thumbTop: 0 });

  useEffect(() => {
    const element = textRef.current;
    if (!element) return undefined;
    const updateMetrics = () => {
      const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      if (!maxScrollTop) {
        setScrollMetrics({ scrollable: false, thumbHeight: 100, thumbTop: 0 });
        return;
      }
      const thumbHeight = Math.max(18, Math.min(100, (element.clientHeight / element.scrollHeight) * 100));
      const thumbTop = (element.scrollTop / maxScrollTop) * Math.max(0, 100 - thumbHeight);
      setScrollMetrics({ scrollable: true, thumbHeight, thumbTop });
    };
    const handleScroll = () => {
      updateMetrics();
      setActive(true);
    };
    updateMetrics();
    element.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', updateMetrics);
    const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updateMetrics);
    resizeObserver?.observe(element);
    return () => {
      element.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', updateMetrics);
      resizeObserver?.disconnect();
    };
  }, [text]);

  const focusText = () => {
    setActive(true);
    textRef.current?.focus({ preventScroll: true });
  };
  const stopDragging = (event?: ReactPointerEvent<HTMLDivElement>) => {
    if (event && dragRef.current?.pointerId === event.pointerId && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };
  const handleThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    focusText();
    dragRef.current = { pointerId: event.pointerId, startClientY: event.clientY, startScrollTop: textRef.current?.scrollTop || 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleThumbPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const element = textRef.current;
    const scrollbar = scrollbarRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !element || !scrollbar) return;
    const bounds = scrollbar.getBoundingClientRect();
    const thumbHeight = bounds.height * (scrollMetrics.thumbHeight / 100);
    const maxThumbTravel = Math.max(1, bounds.height - thumbHeight);
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const nextScrollTop = drag.startScrollTop + ((event.clientY - drag.startClientY) / maxThumbTravel) * maxScrollTop;
    element.scrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
  };
  const handleScrollbarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    event.stopPropagation();
    const element = textRef.current;
    const scrollbar = scrollbarRef.current;
    if (!element || !scrollbar) return;
    focusText();
    const bounds = scrollbar.getBoundingClientRect();
    const thumbHeight = bounds.height * (scrollMetrics.thumbHeight / 100);
    const maxThumbTravel = Math.max(1, bounds.height - thumbHeight);
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const desiredThumbTop = Math.max(0, Math.min(maxThumbTravel, event.clientY - bounds.top - (thumbHeight / 2)));
    element.scrollTop = (desiredThumbTop / maxThumbTravel) * maxScrollTop;
  };
  const displayText = text || '提示词为空，可点击“编辑 Prompt”手动填写，或使用 AI 编写 Prompt。';

  return <div className={`asset-board-prompt-scroll-shell${active ? ' is-active' : ''}`} onMouseEnter={() => setActive(true)} onMouseLeave={() => { if (!dragRef.current && document.activeElement !== textRef.current) setActive(false); }}>
    <pre ref={textRef} tabIndex={0} aria-label={`${label} Prompt`} className={`asset-board-prompt-text nodrag nopan ${empty ? 'empty' : ''}`} onPointerDown={() => { focusText(); }} onFocus={() => setActive(true)} onBlur={(event) => { if (!event.currentTarget.matches(':hover') && !dragRef.current) setActive(false); }}>{displayText}</pre>
    {scrollMetrics.scrollable && <div ref={scrollbarRef} className="asset-board-prompt-scrollbar" aria-hidden="true" onPointerDown={handleScrollbarPointerDown}>
      <div className="asset-board-prompt-scrollbar-thumb" style={{ height: `${scrollMetrics.thumbHeight}%`, top: `${scrollMetrics.thumbTop}%` }} onPointerDown={handleThumbPointerDown} onPointerMove={handleThumbPointerMove} onPointerUp={stopDragging} onPointerCancel={stopDragging} />
    </div>}
  </div>;
}

function AssetBoardCard({ data, selected, id, positionAbsoluteX, positionAbsoluteY, onNodeClick }: NodeProps<AssetFlowNode> & { onNodeClick: AssetBoardFlowProps['onNodeClick'] }) {
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
    const isFusionSlot = isFusionPrompt && Boolean(data.config.fusion_slot);
    const isCharacterPrompt = assetClass === 'character';
    const fusionPromptSource = String(data.config.fusion_prompt_source || '');
    const fusionPromptState = String(data.config.fusion_prompt_state || 'awaiting_connection');
    const fusionPromptReady = !isFusionPrompt || fusionPromptSource === 'fusion-connection-agent';
    const fusionPromptStale = Boolean(data.config.fusion_prompt_stale) || fusionPromptState === 'stale';
    const fusionShotId = String(data.config.fusion_shot_id || (Array.isArray(data.config.relevant_shots) ? data.config.relevant_shots[0] : '') || '').toUpperCase();
    const fusionSourceIds = Array.isArray(data.config.fusion_source_asset_ids) ? data.config.fusion_source_asset_ids.map((item) => String(item)).filter(Boolean) : [];
    const fusionGateAllowed = data.config.fusion_gate_allowed === true;
    const fusionGateReason = String(data.config.fusion_gate_reason || '等待前置基础资产完成 Prompt QA、图片 QA 与登记');
    const fusionSourceStatuses = Array.isArray(data.config.fusion_source_statuses) ? data.config.fusion_source_statuses.filter((item): item is Record<string, any> => Boolean(item && typeof item === 'object')) : [];
    // The board may contain an older persisted reason while the library has
    // already recomputed each source's readiness. Derive a precise display
    // message from those source statuses so a disabled button explains the
    // actionable gate instead of showing only “not ready”.
    const fusionBlockedSourceStatuses = fusionSourceStatuses.filter((item) => item.production_ready !== true);
    const fusionGateDisplayReason = !fusionGateAllowed && fusionSourceIds.length >= 2 && fusionBlockedSourceStatuses.length
      ? `前置资产尚未完成正式入镜门禁：${fusionBlockedSourceStatuses.map((item) => `${String(item.name || item.asset_id || '基础资产')}（${String(item.next_action || '完成正式入镜门禁')}）`).join('；')}`
      : fusionGateReason;
    const fusionNeedsPrompt = isFusionSlot && (!String(data.config.prompt || '').trim() || fusionPromptStale);
    // An existing Fusion Prompt can remain the basis of an uploaded
    // candidate while the user is deciding whether to regenerate it. Image
    // intake/review is a separate path from Prompt freshness; otherwise
    // withdrawing one image would hide the only way to upload its replacement.
    const fusionPromptActionable = fusionPromptReady && (!isFusionPrompt || Boolean(String(data.config.prompt || '').trim()));
    const fusionPromptUsable = fusionPromptReady && (!isFusionPrompt || !fusionPromptStale);
    const promptQa = String(data.config.prompt_qa_decision || 'Pending');
    const generationStatus = String(data.config.generation_status || 'planned');
    const eligible = data.config.image_generation_eligible !== false;
    const relevantShots = Array.isArray(data.config.relevant_shots) ? data.config.relevant_shots.map((item) => String(item)).join('、') : '';
    const artifactId = String(data.config.artifact_id || '');
    const artifactUrl = String(data.config.artifact_url || '');
    const artifactStatus = String(data.config.artifact_status || '');
    const artifactActive = data.config.artifact_active === true;
    const artifactQa = String(data.config.artifact_qa_decision || 'Pending');
    const artifactRemovable = Boolean(artifactId && (artifactActive || !['ready', 'superseded'].includes(artifactStatus)));
    const artifactRemoveLabel = artifactActive ? '撤下当前登记图片' : '移除当前候选图片';
    const productionDraft = Boolean(data.config.production_draft);
    const promptQuality = data.config.prompt_quality as Record<string, any> | undefined;
    const promptCoverage = promptQuality?.coverage as Record<string, any> | undefined;
    const promptCoverageLabel = promptCoverage && Number.isFinite(Number(promptCoverage.passed)) && Number.isFinite(Number(promptCoverage.total)) ? `细节 ${promptCoverage.passed}/${promptCoverage.total}` : '';
    const artifactApproved = artifactQa === 'Approved' || ['approved_pending_registration', 'ready', 'active'].includes(artifactStatus);
    const artifactState = artifactApproved ? (artifactStatus === 'approved_pending_registration' ? '图片已审核 · 待登记' : '图片已审核') : '图片待审核';
    const prerequisiteGateAllowed = data.config.prerequisite_gate_allowed !== false;
    const prerequisiteBlockedDependencies = Array.isArray(data.config.prerequisite_blocked_dependencies) ? data.config.prerequisite_blocked_dependencies.filter((item): item is Record<string, any> => Boolean(item && typeof item === 'object')) : [];
    const prerequisiteItems = Array.isArray(data.config.prerequisite_items) ? data.config.prerequisite_items.filter((item): item is Record<string, any> => Boolean(item && typeof item === 'object')) : prerequisiteBlockedDependencies;
    const prerequisiteIncompleteSummary = prerequisiteItems.filter((item) => item.production_ready !== true).map((item) => String(item.name || item.asset_id || '前置资产')).join('、');
    const generationReferenceAssets = mergeGenerationReferenceAssets(
      generationReferenceAssetsFromConfig(data.config, String(data.asset_id || '')),
      prerequisiteItems,
      String(data.asset_id || ''),
    );
    const canUploadAsset = fusionPromptActionable && !artifactId && prerequisiteGateAllowed;
    const handlePromptFileDrop = (event: DragEvent<HTMLElement>) => {
      if (!canUploadAsset) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      const file = event.dataTransfer.files?.[0];
      if (file) data.onUploadAsset?.(String(data.asset_id), file);
    };
    const handlePromptFileDragOver = (event: DragEvent<HTMLElement>) => {
      if (!canUploadAsset) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
    };
    const selectPromptCard = (event: MouseEvent) => {
      const selectionKey = assetBoardSelectionKey(data);
      if (!selectionKey) return;
      onNodeClick({ target: event.currentTarget, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey } as unknown as MouseEvent, { id, type: 'asset-board', position: { x: positionAbsoluteX, y: positionAbsoluteY }, data } as AssetFlowNode);
    };
    return <article className={`asset-board-card asset-board-prompt-card ${isFusionSlot ? 'fusion-slot-card' : ''} ${selected ? 'selected' : ''}`} data-asset-card-type="handoff" data-asset-id={String(data.asset_id || '')} data-grid-row={rowKey} onClickCapture={selectPromptCard} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); data.onContextMenu?.({ nodeId: data.id, assetId: String(data.asset_id), label: data.label, nodeType: data.node_type, rowKey, x: event.clientX, y: event.clientY }); }}>
      <Handle type="target" position={Position.Left} />
      {artifactUrl ? <div className="asset-board-prompt-media"><div className="asset-board-prompt-media-frame"><img src={artifactUrl} alt={`${data.label} 已上传资产`} />{artifactRemovable && <button type="button" className="asset-board-prompt-media-remove nodrag nopan" aria-label={`${artifactRemoveLabel}：${data.label}`} title={artifactRemoveLabel} onClick={(event) => { event.preventDefault(); event.stopPropagation(); data.onRemoveArtifact?.(String(data.asset_id), artifactId); }}>×</button>}</div><div className="asset-board-prompt-media-meta"><span>{artifactActive ? '当前登记资产' : '已上传候选'}</span><i>{artifactState}</i></div></div> : (productionDraft || (isFusionSlot && !artifactId)) && <div className="asset-board-prompt-media asset-board-prompt-media-empty"><strong>{isFusionSlot ? '融合图片位置' : '图片位置'}</strong><span>{isFusionSlot ? fusionPromptStale ? '已有 Fusion Prompt，可直接上传新的候选图' : 'Fusion Prompt 已就绪，可生成或上传' : '可从右侧上传候选图片'}</span></div>}
      <div className={`asset-board-prompt-content${canUploadAsset ? ' asset-board-prompt-drop-target nodrag nopan' : ''}`} onDragOver={canUploadAsset ? handlePromptFileDragOver : undefined} onDrop={canUploadAsset ? handlePromptFileDrop : undefined}>
        <div className="asset-board-card-meta"><span>{isFusionPrompt ? (fusionPromptUsable ? '正式融合 Prompt' : isFusionSlot ? '镜头融合规划' : '融合规划 / 历史 Prompt') : assetClass === 'audio' ? 'MiniMax Web 声音输入' : '资产 Prompt'}</span><i>{assetClass === 'audio' ? (artifactId ? artifactState : '声音文本 / 字段待确认') : fusionPromptStale ? '输入已变化 · 待重新融合' : isFusionSlot && !fusionGateAllowed ? fusionGateDisplayReason : !fusionPromptReady ? '等待基础资产就绪' : artifactId ? artifactState : promptQa === 'Approved' ? 'Prompt 已通过' : promptQa}</i></div>
        <strong>{data.label}</strong>
        <small>{data.asset_id || '资产'} · {String(data.config.target_skill || 'video-asset-regulator')}{relevantShots ? ` · ${relevantShots}` : ''}{isFusionSlot && fusionSourceIds.length ? ` · 来源 ${fusionSourceIds.join('、')}` : ''}</small>
        <PromptTextScroller label={data.label} text={String(data.config.prompt || '').trim() || (isFusionSlot ? '等待前置基础资产完成 Prompt QA、图片 QA 与登记后生成 Fusion Prompt。' : '')} empty={productionDraft && !String(data.config.prompt || '').trim()} />
        {generationReferenceAssets.length > 0 && <div className={`asset-board-reference-summary ${prerequisiteIncompleteSummary ? 'has-blocked' : 'ready'}`} role="status"><strong>图片生成参考资产</strong><span>参考图：{generationReferenceAssets.map((item) => item.role ? `${item.label}（${item.role}）` : item.label).join('、')}</span><small>{prerequisiteIncompleteSummary ? `未完成：${prerequisiteIncompleteSummary}` : '以上资产可作为当前图片生成参考图；括号内为参考职责'}</small></div>}
        <div className="asset-board-prompt-state"><span>{isFusionSlot && fusionNeedsPrompt ? '融合 Prompt：等待前置资产' : !fusionPromptReady ? '正式 Prompt：尚未生成' : artifactId ? `图片：${artifactState}` : `图像执行：${generationStatus}`}</span>{promptCoverageLabel && <span title="Prompt Contract 细节覆盖度">{promptCoverageLabel}</span>}{isFusionSlot && !fusionGateAllowed && <span title={fusionGateDisplayReason}>{fusionGateDisplayReason}</span>}{fusionPromptStale && <span>请重新生成 Fusion Prompt</span>}{!eligible && <span>非图像资产</span>}</div>
        <div className="asset-board-prompt-actions">
          {canUploadAsset && <label className="asset-board-upload-button nodrag nopan">上传资产<input className="nodrag nopan" type="file" accept="image/png,image/jpeg,image/webp" onClick={(event) => event.stopPropagation()} onChange={(event) => { const file = event.target.files?.[0]; if (file) data.onUploadAsset?.(String(data.asset_id), file); event.currentTarget.value = ''; }} /></label>}
          {productionDraft && !isFusionSlot && !String(data.config.prompt || '').trim() && <button className="asset-board-prompt-primary" onClick={(event) => { event.stopPropagation(); data.onOpenAssetProduction?.(String(data.asset_id), 'prompt', data.id); }}>编辑 Prompt</button>}
          {productionDraft && !isFusionSlot && !String(data.config.prompt || '').trim() && <button onClick={(event) => { event.stopPropagation(); data.onGeneratePrompt?.(String(data.asset_id)); }}>AI 编写 Prompt</button>}
          {isFusionSlot && fusionNeedsPrompt && <button className="asset-board-prompt-primary" disabled={!fusionGateAllowed || !fusionShotId || !fusionSourceIds.length || !data.onGenerateFusionPrompt} title={fusionGateDisplayReason} onClick={(event) => { event.stopPropagation(); data.onGenerateFusionPrompt?.(String(data.asset_id), fusionSourceIds, fusionShotId); }}>{fusionPromptStale ? '重新生成 Fusion Prompt' : '生成 Fusion Prompt'}</button>}
          {assetClass !== 'audio' && fusionPromptUsable && !artifactId && String(data.config.prompt || '').trim() && <button className="asset-board-prompt-rewrite" onClick={(event) => { event.stopPropagation(); data.onRejectAsset?.(String(data.asset_id), ''); }}>重写 Prompt</button>}
          {fusionPromptUsable && !artifactId && String(data.config.prompt || '').trim() && <button onClick={(event) => { event.stopPropagation(); data.onCopyPrompt?.(String(data.asset_id)); }}>{assetClass === 'audio' ? '复制 MiniMax Web 包' : '复制 Prompt'}</button>}
          {fusionPromptActionable && prerequisiteGateAllowed && artifactId && !artifactApproved && <button className="asset-board-prompt-primary" onClick={(event) => { event.stopPropagation(); data.onApproveAsset?.(String(data.asset_id), artifactId); }}>{isFusionPrompt ? '人工审核通过' : '审核通过'}</button>}
          {fusionPromptActionable && artifactId && !artifactApproved && <button onClick={(event) => { event.stopPropagation(); data.onRejectAsset?.(String(data.asset_id), artifactId); }}>审核不通过并重写提示词</button>}
          {fusionPromptActionable && prerequisiteGateAllowed && artifactId && artifactStatus === 'approved_pending_registration' && <button className="asset-board-prompt-primary" onClick={(event) => { event.stopPropagation(); data.onRegisterAsset?.(String(data.asset_id), artifactId); }}>登记为资产</button>}
          {assetClass !== 'audio' && fusionPromptUsable && !artifactId && String(data.config.prompt || '').trim() && promptQa !== 'Approved' && <button className="asset-board-prompt-primary" onClick={(event) => { event.stopPropagation(); data.onApprovePrompt?.(String(data.asset_id)); }}>通过 Prompt QA</button>}
          {fusionPromptUsable && prerequisiteGateAllowed && !artifactId && String(data.config.prompt || '').trim() && promptQa === 'Approved' && eligible && generationStatus !== 'generated-pending-qa' && <button className="asset-board-prompt-primary" onClick={(event) => { event.stopPropagation(); data.onGenerateImage?.(String(data.asset_id)); }}>{isCharacterPrompt ? '确认生成角色结构参考图' : '确认并生成'}</button>}
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </article>;
  }
  const hasPrompt = Boolean(String(data.config.asset_prompt || '').trim());
  const hasMedia = Number(data.config.asset_artifact_count || 0) > 0 || Boolean(data.config.asset_file_url);
  // Fusion assets already expose their production surface as the dedicated
  // Prompt/image card in the SHOT FUSION column. Do not add a second
  // "打开制作操作台" shortcut to the logical fusion card.
  const showProductionShortcuts = data.node_type === 'asset' && assetClass !== 'fusion' && Boolean(data.asset_id) && (!hasPrompt || !hasMedia);
  const productionTarget = resolveAssetProductionTarget({ hasPrompt, hasMedia });
  const productionShortcutLabel = !hasPrompt && !hasMedia ? '缺少 Prompt 与候选文件' : !hasPrompt ? '缺少 Prompt' : '待上传候选文件';
  return <article className={`asset-board-card asset-board-${data.node_type} ${selected ? 'selected' : ''} ${canCollapseAssetScope && data.collapsed ? 'collapsed' : ''} ${data.config.archived ? 'archived' : ''}`} data-asset-card-type={data.node_type} data-asset-id={String(data.asset_id || '')} data-grid-row={rowKey} onContextMenu={canOpenContextMenu ? (event) => { event.preventDefault(); event.stopPropagation(); data.onContextMenu?.({ nodeId: data.id, assetId: String(data.asset_id), label: data.label, nodeType: data.node_type, rowKey, x: event.clientX, y: event.clientY }); } : undefined} aria-expanded={canCollapseAssetScope && data.collapsed === true ? false : undefined}>
    <Handle type="target" position={Position.Left} />
    {isMedia && <img className="asset-board-thumb" src={String(data.config.url)} alt="候选素材" />}
    {data.node_type === 'asset' && rowKey && rowKey !== 'shared' && String(data.config.manual_shot_id || '') === rowKey && <b className="asset-board-assignment-corner">加入 {rowKey} 分镜资产组</b>}
    <div className="asset-board-card-meta"><span>{data.node_type === 'handoff' ? 'Prompt / 图片卡' : data.node_type === 'artifact' ? '候选版本' : assetClassLabels[assetClass] || assetClass || '资产'}</span><div className="asset-board-card-meta-actions"><i>{assetBoardStatusLabel(data.status)}</i>{canCollapseAssetScope && <button type="button" className="asset-board-scope-toggle" aria-expanded={!data.collapsed} aria-label={`${data.collapsed ? '展开' : '收起'} ${data.label} 下游内容`} title={`${data.collapsed ? '展开' : '收起'}下游内容`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); const rowScope = String(data.config.grid_row_key || 'shared'); data.onToggleScope?.({ type: 'asset', id: String(data.asset_id), keepNodeId: data.id, scopeKey: `asset:${data.asset_id}:${rowScope}` }); }}>{data.collapsed ? '展开' : '收起'}</button>}</div></div>
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
  const nodeTypes = useMemo(() => ({ 'asset-board': (props: NodeProps<AssetFlowNode>) => <AssetBoardCard {...props} onNodeClick={onNodeClick} /> }), [onNodeClick]);
  const flowExtents = useMemo(() => assetBoardFlowExtents(nodes), [nodes]);
  const flow = useReactFlow();
  const focusedTargetRef = useRef('');
  useEffect(() => {
    if (!focusTarget) {
      focusedTargetRef.current = '';
      return;
    }
    // Directory focus is a one-shot navigation command. Node/state updates
    // (autosave, uploads, QA, layout changes) must not recenter the viewport
    // around the last directory item and make the canvas feel locked.
    if (focusedTargetRef.current === focusTarget) return;
    const node = nodes.find((candidate) => !candidate.data.presentationOnly && (candidate.id === focusTarget || candidate.data.shot_id === focusTarget || candidate.data.asset_id === focusTarget || String(candidate.data.config.grid_row_key || '') === focusTarget));
    if (!node) return;
    focusedTargetRef.current = focusTarget;
    const width = typeof node.style?.width === 'number' ? node.style.width : Number(node.style?.width) || 240;
    const height = node.data.node_type === 'artifact' ? 190 : node.data.node_type === 'shot' ? 120 : 110;
    flow.setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: .86, duration: 460 });
  }, [focusTarget, flow, nodes]);
  return <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={onNodeClick} onNodeDragStart={onNodeDragStart} onNodeDragStop={onNodeDragStop} onMoveEnd={(event, viewport) => { if (event === null) return; onMoveEnd(viewport); }} defaultViewport={defaultViewport} translateExtent={flowExtents.translateExtent} nodeExtent={flowExtents.nodeExtent} fitView minZoom={0.12} maxZoom={1.8} deleteKeyCode={null} multiSelectionKeyCode={['Control', 'Meta']} selectionOnDrag selectionMode={SelectionMode.Partial} panOnDrag={[1, 2]}>
      <Background color="#343831" gap={22} size={1} />
      <Controls position="bottom-left" />
      <MiniMap position="bottom-right" pannable zoomable nodeColor="#d7ff4b" maskColor="rgba(6,7,6,.72)" />
    </ReactFlow>
}

export function AssetBoardFlow(props: AssetBoardFlowProps) {
  return <ReactFlowProvider><AssetBoardFlowInner {...props} /></ReactFlowProvider>;
}
