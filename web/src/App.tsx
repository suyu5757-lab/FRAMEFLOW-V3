import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Connection, Edge, EdgeChange, Node, NodeChange, Viewport } from '@xyflow/react';
import { studioApi } from './api';
import { AudioStudioView } from './AudioStudioView';
import { EDGE_RELATIONS, autoLayoutNodes, edgeRelationPresentation, wouldCreateExecutionCycle, type EdgeRelation } from './graph-editor';
import type { AgentPlan, AudioStudioDocument, AudioStudioEnvelope, AssetAuditEnvelope, AssetBoard, AssetBoardEdgeRelation, AssetBoardEnvelope, AssetBoardNode, AssetLibraryEnvelope, DashboardEnvelope, DashboardTask, GraphEnvelope, GraphNodeData, HomeStatus, LibraryAsset, ProjectCreateInput, ProjectDashboard, ProjectRecord, ProjectHomeSummary, RenderJob, RunEstimate, SettingsEnvelope, SettingsProvider, SettingsPreset, StoryDiff, StoryDocument, StoryEnvelope, StoryRun, StoryShot, TimelineClip, TimelineDocument, TimelineEnvelope, TimelinePreflight, TimelinePreflightShot, WorkflowGraph, WorkflowManifest, WorkflowRun, WorkflowRunDetail } from './types';
import { dashboardHasActiveWork, progressLabel, stageProgress, statusClass, statusIcon, statusLabel, taskPriorityLabel } from './dashboard-state';
import { assetClassLabels as sharedAssetClassLabels, assetMatchesFilter, assetMatchesScope, assetNextAction, assetProductionStatus, assetStatusBucket, assetStatusFilterLabels, assetStatusLabels as sharedAssetStatusLabels, assetStatusPresentationOrder, filterAssets, parseJsonObject, productionStatusLabels, type AssetLibraryFilter, type AssetLibraryScope, type AssetLibraryStatusFilter, type AssetSort } from './asset-state';
import { applyAssetBoardSelection, assetBoardSelectionKey, selectedAssetBoardCards as getSelectedAssetBoardCards, singleSelectedAssetBoardCard, type AssetBoardSelectionKey } from './asset-board-selection';
import { VirtualAssetList } from './components/VirtualAssetList';

type StudioMode = 'home' | 'story' | 'canvas' | 'timeline' | 'audio' | 'assets' | 'settings';
const LazyAssetBoardFlow = lazy(() => import('./AssetBoardFlow').then(({ AssetBoardFlow }) => ({ default: AssetBoardFlow })));
type FlowNode = Node<GraphNodeData, 'workflow'>;
type AssetBoardCollapseTarget = { type: 'shot' | 'asset'; id: string; keepNodeId?: string; scopeKey?: string };
type AssetBoardContextTarget = { nodeId: string; assetId: string; label: string; nodeType: AssetBoardNodeData['node_type']; rowKey: string; x: number; y: number };
type AssetPlacement = { assetId: string; name: string; mode: 'assign' | 'move' };
type AssetBoardColumnWidths = { shots: number; 'asset-flow': number; fusion: number };
type AssetProductionFocus = { assetId: string; target: AssetProductionTarget } | null;
type AssetAssignmentOverrides = { pending?: AssetPlacement; projectRevision?: number; boardEnvelope?: AssetBoardEnvelope; library?: AssetLibraryEnvelope; storyEnvelope?: StoryEnvelope; nodes?: AssetFlowNode[]; edges?: Edge[] };
type AssetInspectorTab = 'overview' | 'media' | 'prompt' | 'dependencies' | 'audit' | 'history';
type AssetQaType = 'prompt' | 'image' | 'video' | 'audio' | 'reference';
type AssetQaDecision = 'Approved' | 'Needs revision' | 'Rejected' | 'Blocked';
type AssetBoardNodeData = Omit<AssetBoardNode, 'node_type'> & {
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
type AssetFlowNode = Node<AssetBoardNodeData, 'asset-board'>;
type EditorSnapshot = { nodes: FlowNode[]; edges: Edge[] };
type AssetBoardEditorSnapshot = { board: AssetBoard; selectedNodeIds: string[] };

function applyNodeChangesLocal<T extends Node>(changes: NodeChange<T>[], nodes: T[]): T[] {
  let next = [...nodes];
  for (const change of changes) {
    if (change.type === 'add') {
      next.splice(change.index ?? next.length, 0, change.item);
    } else if (change.type === 'remove') {
      next = next.filter((node) => node.id !== change.id);
    } else if (change.type === 'replace') {
      next = next.map((node) => node.id === change.id ? change.item : node);
    } else if (change.type === 'select') {
      next = next.map((node) => node.id === change.id ? { ...node, selected: change.selected } : node);
    } else if (change.type === 'position' && change.position) {
      next = next.map((node) => node.id === change.id ? { ...node, position: change.position, dragging: change.dragging } : node);
    }
  }
  return next;
}

function applyEdgeChangesLocal(changes: EdgeChange[], edges: Edge[]): Edge[] {
  let next = [...edges];
  for (const change of changes) {
    if (change.type === 'add') {
      next.splice(change.index ?? next.length, 0, change.item);
    } else if (change.type === 'remove') {
      next = next.filter((edge) => edge.id !== change.id);
    } else if (change.type === 'replace') {
      next = next.map((edge) => edge.id === change.id ? change.item : edge);
    } else if (change.type === 'select') {
      next = next.map((edge) => edge.id === change.id ? { ...edge, selected: change.selected } : edge);
    }
  }
  return next;
}

function addEdgeLocal(connection: Partial<Edge> & Pick<Edge, 'source' | 'target'>, edges: Edge[]): Edge[] {
  const duplicate = edges.some((edge) => edge.source === connection.source && edge.target === connection.target && edge.sourceHandle === connection.sourceHandle && edge.targetHandle === connection.targetHandle);
  return duplicate ? edges : [...edges, connection as Edge];
}

const kindLabels: Record<string, string> = {
  story: '文本', asset_regulator: '审计', asset_production: '资产', fusion: '融合',
  shot_director: '导演', audio_production: '声音', video_generation: '生成', delivery: '交付',
};

const assetClassLabels: Record<string, string> = sharedAssetClassLabels;
const assetStatusLabels: Record<string, string> = sharedAssetStatusLabels;
const assistantSkillLabels: Record<string, string> = {
  'video-script-storyboard': '故事与分镜',
  'video-asset-regulator': '资产总控',
  'video-character-design-director': '角色设计',
  'video-scene-design-director': '场景设计',
  'video-prop-design-director': '道具设计',
  'video-fusion-production-director': '融合生产',
  'video-shot-director': '镜头导演',
  'voice-controller': '声音控制',
  'voice-performance-director': '人物声音导演',
  'music-sound-designer': '音乐与声音设计',
  'seedance-shot-packager': 'Seedance 打包',
  'final-render': '最终交付',
};
const fallbackAssistantSkills: WorkflowManifest[] = Object.keys(assistantSkillLabels).map((skill_id) => ({
  skill_id,
  skill_version: skill_id === 'seedance-shot-packager' ? '2.5.0' : '1.0.0',
  approval_policy: skill_id === 'seedance-shot-packager' || skill_id === 'voice-controller' ? 'paid_confirmation' : 'supervised',
  instructions: '使用稳定 ID，所有更改创建新版本，不覆盖已批准产物。',
  next_routes: [],
  deterministic_gates: ['required_assets_ready', 'shots_ready'],
}));
const shortcutGroups = [
  {
    title: '全局操作',
    rows: [
      ['Ctrl / ⌘ + K', '打开命令面板'],
      ['Ctrl / ⌘ + S', '保存当前页面'],
      ['Ctrl / ⌘ + Shift + A', '打开 AI 创作助手'],
      ['?', '查看全部快捷键'],
      ['Esc', '关闭当前浮层'],
    ],
  },
  {
    title: '工作区导航',
    rows: [
      ['Alt + 1', '项目总览'],
      ['Alt + 2', '故事与分镜'],
      ['Alt + 3', '资产生产工作区'],
      ['Alt + 4', '后期时间线'],
      ['Alt + 5', '统一资产库'],
      ['Alt + 6', '设置与 Provider'],
    ],
  },
  {
    title: '画布编辑',
    rows: [
      ['Ctrl / ⌘ + Z', '撤销上一步编辑'],
      ['Ctrl / ⌘ + Shift + Z', '重做上一步编辑'],
      ['Ctrl / ⌘ + C / X / V', '复制、剪切、粘贴节点'],
      ['Ctrl / ⌘ + F', '打开镜头索引'],
    ],
  },
] as const;
type CommandAction = { id: string; label: string; description: string; shortcut?: string; disabled?: boolean; onSelect: () => void };
const assetGridColumns = [
  { key: 'shots', label: '镜头编排', english: 'SHOT PLAN', description: '分镜与画面意图' },
  { key: 'character', label: '角色设计', english: 'CHARACTER DESIGN', description: '人物身份与表演锚点' },
  { key: 'scene', label: '场景环境', english: 'ENVIRONMENT DESIGN', description: '空间、光线与时空' },
  { key: 'prop', label: '道具物件', english: 'PROP & OBJECT', description: '关键道具与物证' },
  { key: 'fusion', label: '镜头融合', english: 'SHOT FUSION', description: '角色、场景与道具合成' },
  { key: 'other', label: '声音及其他', english: 'SOUND & OTHER', description: '声音、音乐及补充资源' },
] as const;
type AssetGridPreset = 'compact' | 'standard' | 'spacious';
type AssetBoardLayoutMode = 'adaptive' | 'matrix';
export type AssetProductionTarget = 'prompt' | 'upload';
const assetGridPresets: Record<AssetGridPreset, { columnWidth: number; rowHeight: number; label: string }> = {
  compact: { columnWidth: 260, rowHeight: 152, label: '紧凑' },
  standard: { columnWidth: 310, rowHeight: 182, label: '标准' },
  spacious: { columnWidth: 370, rowHeight: 220, label: '舒展' },
};

const defaultAssetBoardColumnWidths: AssetBoardColumnWidths = { shots: 260, 'asset-flow': 640, fusion: 640 };
const assetBoardFrameScale = 1.5;
const assetBoardCellPadding = 12;
const assetBoardDefaultCardWidth = 286;

function assetBoardColumnWidthsFromMetadata(metadata: Record<string, unknown>, legacyWidth?: number): AssetBoardColumnWidths {
  const stored = metadata.layout_column_widths && typeof metadata.layout_column_widths === 'object' ? metadata.layout_column_widths as Record<string, unknown> : {};
  const legacy = Math.max(220, Number(legacyWidth || metadata.layout_column_width) || 310);
  return {
    shots: Math.max(220, Number(stored.shots) || defaultAssetBoardColumnWidths.shots),
    'asset-flow': Math.max(280, Number(stored['asset-flow']) || legacy * 2 + 16),
    fusion: Math.max(280, Number(stored.fusion) || legacy * 2 + 16),
  };
}

function assetBoardColumnWidthForKey(widths: AssetBoardColumnWidths, key: string): number {
  if (key === 'shots') return widths.shots;
  if (key === 'fusion') return widths.fusion;
  return widths['asset-flow'];
}

export function assetBoardMinimumColumnWidth(key: string, cardWidth: number, gap: number, layoutMode: AssetBoardLayoutMode): number {
  const safeCardWidth = Math.max(220, cardWidth);
  if (key === 'shots') return 220;
  const minimum = layoutMode === 'adaptive' ? safeCardWidth * 2 + gap : safeCardWidth;
  return Math.max(280, minimum + assetBoardCellPadding * 2);
}

export function assetBoardSafeColumnWidths(widths: AssetBoardColumnWidths, cardWidth: number, gap: number, layoutMode: AssetBoardLayoutMode): AssetBoardColumnWidths {
  return {
    shots: Math.max(widths.shots, assetBoardMinimumColumnWidth('shots', cardWidth, gap, layoutMode)),
    'asset-flow': Math.max(widths['asset-flow'], assetBoardMinimumColumnWidth('asset-flow', cardWidth, gap, layoutMode)),
    fusion: Math.max(widths.fusion, assetBoardMinimumColumnWidth('fusion', cardWidth, gap, layoutMode)),
  };
}

export function assetBoardCardIsLocked(node: { node_type: string; config?: Record<string, any> }): boolean {
  return node.node_type === 'asset' || (node.node_type === 'handoff' && Boolean(node.config?.prompt_card));
}

export function assetBoardCardHeight(node: { node_type: string; config: Record<string, any> }): number {
  const hasPrompt = Boolean(String(node.config.asset_prompt || node.config.prompt || '').trim());
  const hasMedia = Number(node.config.asset_artifact_count || 0) > 0 || Boolean(node.config.asset_file_url || node.config.artifact_url);
  if (node.node_type === 'asset' && (!hasPrompt || !hasMedia)) return 150;
  return node.node_type === 'artifact' ? 226 : node.node_type === 'handoff' && Boolean(node.config.prompt_card) ? (node.config.artifact_url || node.config.production_draft ? 570 : 350) : node.node_type === 'shot' ? 112 : 106;
}

export function resolveAssetProductionTarget(input: { hasPrompt: boolean; hasMedia: boolean }): AssetProductionTarget {
  return input.hasPrompt && !input.hasMedia ? 'upload' : 'prompt';
}

type AssetBoardColumnBound = { key: string; x: number; y: number; width: number; height: number };

function assetBoardColumnDefinitions(layoutMode: AssetBoardLayoutMode): Array<{ key: string }> {
  return layoutMode === 'adaptive'
    ? [{ key: 'shots' }, { key: 'asset-flow' }, { key: 'fusion' }]
    : assetGridColumns.map((column) => ({ key: column.key }));
}

export function assetBoardFixedColumnBounds(layoutMode: AssetBoardLayoutMode, widths: AssetBoardColumnWidths, gap: number, tableHeight: number, cardWidth = assetBoardDefaultCardWidth): AssetBoardColumnBound[] {
  const safeWidths = assetBoardSafeColumnWidths(widths, cardWidth, gap, layoutMode);
  const columns = assetBoardColumnDefinitions(layoutMode);
  let x = 24;
  return columns.map((column, index) => {
    const bound = { key: column.key, x, y: 96, width: assetBoardColumnWidthForKey(safeWidths, column.key), height: Math.max(120, tableHeight - 96) };
    x += bound.width;
    if (layoutMode === 'adaptive' && index < columns.length - 1) x += gap;
    return bound;
  });
}

function assetBoardInnerTableWidth(layoutMode: AssetBoardLayoutMode, widths: AssetBoardColumnWidths, gap: number, cardWidth = assetBoardDefaultCardWidth): number {
  const bounds = assetBoardFixedColumnBounds(layoutMode, widths, gap, 216, cardWidth);
  const right = bounds.length ? bounds[bounds.length - 1].x + bounds[bounds.length - 1].width : 24;
  return right + 24;
}

function assetBoardFixedTableWidth(layoutMode: AssetBoardLayoutMode, widths: AssetBoardColumnWidths, gap: number, cardWidth = assetBoardDefaultCardWidth): number {
  return Math.round(assetBoardInnerTableWidth(layoutMode, widths, gap, cardWidth) * assetBoardFrameScale);
}

function assetBoardCardWidthForNodes(nodes: AssetFlowNode[], fallback = assetBoardDefaultCardWidth): number {
  return nodes.reduce((width, node) => {
    if (node.data.presentationOnly || node.data.node_type === 'shot' || node.data.node_type === 'table' || node.data.node_type === 'row') return width;
    return Math.max(width, Number(node.style?.width) || fallback);
  }, Math.max(220, fallback));
}

function assetBoardNodeColumnKey(node: AssetFlowNode, layoutMode: AssetBoardLayoutMode, columns: Array<{ key: string }>): string {
  if (layoutMode === 'adaptive') return node.data.node_type === 'shot' ? 'shots' : String(node.data.config.grid_column_key || '') === 'fusion' ? 'fusion' : 'asset-flow';
  const rawKey = String(node.data.config.grid_column_key || 'other');
  return columns.some((column) => column.key === rawKey) ? rawKey : 'other';
}

function clampAssetBoardFlowNodes(nodes: AssetFlowNode[], layoutMode: AssetBoardLayoutMode, widths: AssetBoardColumnWidths, gap: number, cardWidth = assetBoardCardWidthForNodes(nodes)): AssetFlowNode[] {
  const table = nodes.find((node) => node.id === 'asset-grid:table');
  const tableHeight = Math.max(180, Number(table?.style?.height) || 900);
  const columns = assetBoardColumnDefinitions(layoutMode);
  const bounds = assetBoardFixedColumnBounds(layoutMode, widths, gap, tableHeight, cardWidth);
  const boundByKey = new Map(bounds.map((bound) => [bound.key, bound]));
  return nodes.map((node) => {
    if (node.data.presentationOnly || ['table', 'row', 'shot'].includes(String(node.data.node_type))) return node;
    const bound = boundByKey.get(assetBoardNodeColumnKey(node, layoutMode, columns));
    if (!bound) return node;
    const rawCardWidth = Math.max(1, Number(node.style?.width) || cardWidth);
    const boundedCardWidth = Math.min(rawCardWidth, Math.max(1, bound.width - assetBoardCellPadding * 2));
    const cardHeight = assetBoardCardHeight(node.data);
    const minX = bound.x + assetBoardCellPadding;
    const minY = bound.y + 8;
    const maxX = bound.x + bound.width - assetBoardCellPadding - boundedCardWidth;
    const maxY = Math.max(minY, bound.y + bound.height - cardHeight - 8);
    const position = { x: Math.min(maxX, Math.max(minX, node.position.x)), y: Math.min(maxY, Math.max(minY, node.position.y)) };
    const widthChanged = boundedCardWidth !== rawCardWidth;
    if (!widthChanged && position.x === node.position.x && position.y === node.position.y) return node;
    return { ...node, position, style: widthChanged ? { ...node.style, width: boundedCardWidth } : node.style, data: { ...node.data, position, config: assetBoardCardIsLocked(node.data) ? node.data.config : { ...node.data.config, position_source: 'manual' } } };
  });
}

function assetBoardWithFixedFrame(nodes: AssetFlowNode[], layoutMode: AssetBoardLayoutMode, widths: AssetBoardColumnWidths, gap: number): AssetFlowNode[] {
  const table = nodes.find((node) => node.id === 'asset-grid:table');
  if (!table) return nodes;
  const cardWidth = assetBoardCardWidthForNodes(nodes, Number(table.data.config.card_width) || assetBoardDefaultCardWidth);
  const safeWidths = assetBoardSafeColumnWidths(widths, cardWidth, gap, layoutMode);
  const tableY = Number(table.position?.y) || 0;
  const tableHeight = Math.max(180, Number(table.style?.height) || 900);
  const nextTable = {
    ...table,
    position: { x: 0, y: 0 },
    style: { ...table.style, width: assetBoardFixedTableWidth(layoutMode, safeWidths, gap, cardWidth), height: tableHeight },
    data: {
      ...table.data,
      position: { x: 0, y: 0 },
      config: {
        ...table.data.config,
        shot_column_width: safeWidths.shots,
        asset_flow_width: safeWidths['asset-flow'],
        fusion_column_width: safeWidths.fusion,
        card_width: cardWidth,
        layout_gap: gap,
        grid_rows: Array.isArray(table.data.config.grid_rows) ? (table.data.config.grid_rows as Array<Record<string, unknown>>).map((row) => ({ ...row, y: Number(row.y || 0) + tableY })) : table.data.config.grid_rows,
        grid_column_bounds: assetBoardFixedColumnBounds(layoutMode, safeWidths, gap, tableHeight, cardWidth),
      },
    },
  };
  return clampAssetBoardFlowNodes(nodes.map((node) => node.id === table.id ? nextTable : node), layoutMode, safeWidths, gap, cardWidth);
}

function assetBoardStatusLabel(status: string): string { return assetStatusLabels[status] || status || '待处理'; }

function shotIdsFromValue(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return [];
  const normalized = text.replace(/[—–－]/g, '-');
  const expanded: string[] = [];
  normalized.replace(/SH(\d{1,3})\s*-\s*(?:SH)?(\d{1,3})/gi, (_match, start, end) => {
    const from = Number(start); const to = Number(end);
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from && to - from <= 80) {
      for (let index = from; index <= to; index += 1) expanded.push(`SH${String(index).padStart(3, '0')}`);
    }
    return _match;
  });
  normalized.replace(/SH\d{1,3}/gi, (match) => { expanded.push(match.toUpperCase().replace(/SH(\d+)$/, (_m, digits) => `SH${String(Number(digits)).padStart(3, '0')}`)); return match; });
  return [...new Set(expanded)];
}

const dialogFocusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useDialogFocus(open: boolean) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!open) return undefined;
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const initial = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus], [autofocus], ' + dialogFocusableSelector);
      initial?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
      triggerRef.current = null;
    };
  }, [open]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (!open || event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(dialogFocusableSelector)).filter((element) => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    if (!focusable.length) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && (currentIndex <= 0 || currentIndex === -1)) {
      event.preventDefault();
      focusable[focusable.length - 1].focus();
    } else if (!event.shiftKey && (currentIndex === focusable.length - 1 || currentIndex === -1)) {
      event.preventDefault();
      focusable[0].focus();
    }
  }, [open]);

  return { dialogRef, onKeyDown };
}

export function assetShotRows(board: AssetBoard, assets: LibraryAsset[], storyShots: StoryShot[]): Map<string, string[]> {
  const shotIds = board.nodes.filter((node) => node.node_type === 'shot' && node.shot_id).map((node) => String(node.shot_id));
  const knownShots = new Set([...shotIds, ...storyShots.map((shot) => shot.id)]);
  const rows = new Map<string, Set<string>>();
  assets.forEach((asset) => rows.set(asset.id, new Set()));
  const add = (assetId: unknown, shotId: unknown) => {
    const id = String(assetId || ''); const shot = String(shotId || '').toUpperCase();
    if (rows.has(id) && knownShots.has(shot)) rows.get(id)?.add(shot);
  };
  for (const edge of board.edges) {
    if (edge.relation !== 'shot_dependency') continue;
    const source = board.nodes.find((node) => node.id === edge.source);
    const target = board.nodes.find((node) => node.id === edge.target);
    if (source?.shot_id && target?.asset_id) add(target.asset_id, source.shot_id);
    if (target?.shot_id && source?.asset_id) add(source.asset_id, target.shot_id);
  }
  for (const shot of storyShots) {
    const shotRaw = JSON.stringify(shot);
    for (const asset of assets) if (shotRaw.includes(asset.id)) add(asset.id, shot.id);
    const requirements = (shot as Record<string, unknown>).assetRequirements;
    for (const requirement of Array.isArray(requirements) ? requirements : []) {
      const raw = typeof requirement === 'string' ? requirement : JSON.stringify(requirement);
      if (!raw) continue;
      for (const asset of assets) if (raw.includes(asset.id)) add(asset.id, shot.id);
    }
  }
  for (const asset of assets) {
    const ids = shotIdsFromValue(JSON.stringify(asset)).filter((id) => knownShots.has(id));
    ids.forEach((id) => add(asset.id, id));
  }
  return new Map([...rows.entries()].map(([assetId, values]) => [assetId, [...values].sort((a, b) => shotIds.indexOf(a) - shotIds.indexOf(b))]));
}

type AssetBoardToolbarMenu = 'filters' | 'layout' | null;

function AssetBoardToolbar({
  assetCount,
  shotCount,
  relationCount,
  busy,
  boardReady,
  dirty,
  assetPlacement,
  menu,
  onMenuChange,
  onSync,
  onCancelPlacement,
  storyShots,
  filter,
  onFilterChange,
  showShots,
  onShowShotsChange,
  shotId,
  onShotIdChange,
  onlyBlocked,
  onOnlyBlockedChange,
  showCandidates,
  onShowCandidatesChange,
  layoutMode,
  onLayoutModeChange,
  layoutPreset,
  onLayoutPresetChange,
  gap,
  onGapChange,
  onAutoLayout,
  onResetColumns,
}: {
  assetCount: number;
  shotCount: number;
  relationCount: number;
  busy: boolean;
  boardReady: boolean;
  dirty: boolean;
  assetPlacement: AssetPlacement | null;
  menu: AssetBoardToolbarMenu;
  onMenuChange: (menu: AssetBoardToolbarMenu) => void;
  onSync: () => void;
  onCancelPlacement: () => void;
  storyShots: StoryShot[];
  filter: string;
  onFilterChange: (value: string) => void;
  showShots: boolean;
  onShowShotsChange: (value: boolean) => void;
  shotId: string;
  onShotIdChange: (value: string) => void;
  onlyBlocked: boolean;
  onOnlyBlockedChange: (value: boolean) => void;
  showCandidates: boolean;
  onShowCandidatesChange: (value: boolean) => void;
  layoutMode: AssetBoardLayoutMode;
  onLayoutModeChange: (value: AssetBoardLayoutMode) => void;
  layoutPreset: AssetGridPreset;
  onLayoutPresetChange: (value: AssetGridPreset) => void;
  gap: number;
  onGapChange: (value: number) => void;
  onAutoLayout: () => void;
  onResetColumns: () => void;
}) {
  const filterOptions = Object.entries(assetClassLabels).filter(([key]) => ['character', 'scene', 'prop', 'fusion'].includes(key));
  return <div className="canvas-toolbar asset-board-toolbar">
    {assetPlacement && <div className="asset-placement-banner"><strong>正在分配：{assetPlacement.name}</strong><span>请点击目标镜头行，例如 SH006；分配完成后资产会从 SHARED 移入该镜头。</span><button type="button" onClick={onCancelPlacement}>取消</button></div>}
    <div className="asset-board-toolbar-heading"><span>SHOT–ASSET GRID</span><strong>{assetCount} 个资产 · {shotCount} 个镜头 · {relationCount} 条关系</strong><small className="canvas-subline">按镜头组织资产关系、Prompt、候选文件与质量审核</small><small className="canvas-shortcut-hint">Ctrl / ⌘ + Z 撤销 · Ctrl / ⌘ + Shift + Z 或 Y 重做</small></div>
    <div className="canvas-tools">
      <button type="button" onClick={onSync} disabled={busy || !boardReady || dirty} title={dirty ? '请先保存当前画布修改，再同步故事与分镜' : '同步故事与分镜'}>同步故事与分镜</button>
      <div className="asset-board-toolbar-popover">
        <button type="button" className={menu === 'filters' ? 'active' : ''} aria-expanded={menu === 'filters'} onClick={() => onMenuChange(menu === 'filters' ? null : 'filters')}>筛选</button>
        {menu === 'filters' && <div className="asset-board-toolbar-menu" role="dialog" aria-label="资产工作区筛选">
          <div className="asset-board-toolbar-menu-heading"><strong>筛选与显示</strong><small>仅影响当前视图，不会修改项目数据</small></div>
          <label>资产类型<select value={filter} onChange={(event) => onFilterChange(event.target.value)}><option value="all">全部资产</option>{filterOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label>定位镜头<select value={shotId} onChange={(event) => onShotIdChange(event.target.value)}><option value="">全部镜头</option>{storyShots.map((shot) => <option key={shot.id} value={shot.id}>{shot.id} · {shot.scene}</option>)}</select></label>
          <label className="check-row"><input type="checkbox" checked={showShots} onChange={(event) => onShowShotsChange(event.target.checked)} />显示镜头列</label>
          <label className="check-row"><input type="checkbox" checked={onlyBlocked} onChange={(event) => onOnlyBlockedChange(event.target.checked)} />仅显示阻塞</label>
          <label className="check-row"><input type="checkbox" checked={showCandidates} onChange={(event) => onShowCandidatesChange(event.target.checked)} />显示候选</label>
        </div>}
      </div>
      <div className="asset-board-toolbar-popover">
        <button type="button" className={menu === 'layout' ? 'active' : ''} aria-expanded={menu === 'layout'} onClick={() => onMenuChange(menu === 'layout' ? null : 'layout')}>布局</button>
        {menu === 'layout' && <div className="asset-board-toolbar-menu" role="dialog" aria-label="资产工作区布局">
          <div className="asset-board-toolbar-menu-heading"><strong>布局与密度</strong><small>修改后请使用顶部“保存”写入画布</small></div>
          <label>呈现方式<select value={layoutMode} onChange={(event) => onLayoutModeChange(event.target.value as AssetBoardLayoutMode)}><option value="adaptive">自适应资产流</option><option value="matrix">资产类型矩阵</option></select></label>
          <label>网格密度<select value={layoutPreset} onChange={(event) => onLayoutPresetChange(event.target.value as AssetGridPreset)}>{Object.entries(assetGridPresets).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
          <label className="asset-board-range">间距 <input type="range" min="8" max="48" step="4" value={gap} onChange={(event) => onGapChange(Number(event.target.value))} /><output>{gap}px</output></label>
          <div className="asset-board-toolbar-menu-actions"><button type="button" onClick={onAutoLayout} disabled={!boardReady}>重新整理布局</button><button type="button" onClick={onResetColumns} disabled={!boardReady}>恢复默认列宽</button></div>
        </div>}
      </div>
    </div>
  </div>;
}

 export function assetBoardToFlowNodes(board: AssetBoard, assets: LibraryAsset[], filter: string, showShots: boolean, storyShots: StoryShot[] = [], options: { forceGrid?: boolean; preset?: AssetGridPreset; columnWidth?: number; columnWidths?: AssetBoardColumnWidths; gap?: number; layoutMode?: AssetBoardLayoutMode; collapsedScopes?: Record<string, string | true>; onlyBlocked?: boolean; showCandidates?: boolean; shotId?: string; selectedSelectionKey?: AssetBoardSelectionKey | null; onToggleScope?: (target: AssetBoardCollapseTarget) => void; onContextMenu?: (target: AssetBoardContextTarget) => void; onApprovePrompt?: (assetId: string) => void; onGenerateImage?: (assetId: string) => void; onGeneratePrompt?: (assetId: string) => void; onCopyPrompt?: (assetId: string) => void; onUploadAsset?: (assetId: string, file: File) => void; onApproveAsset?: (assetId: string, artifactId: string) => void; onRejectAsset?: (assetId: string, artifactId: string) => void; onRegisterAsset?: (assetId: string, artifactId: string) => void; onColumnResize?: (key: keyof AssetBoardColumnWidths, delta: number) => void; onOpenAssetProduction?: (assetId: string, target: AssetProductionTarget, nodeId?: string) => void } = {}): AssetFlowNode[] {
  const requestedPreset = options.preset || String(board.metadata.layout_preset || 'standard') as AssetGridPreset;
  const preset = assetGridPresets[requestedPreset] || assetGridPresets.standard;
  const layoutMode = options.layoutMode || (String(board.metadata.layout_view) === 'matrix' ? 'matrix' : 'adaptive') as AssetBoardLayoutMode;
  const collapsedScopes = options.collapsedScopes || {};
  const useStoredPositions = !options.forceGrid && board.metadata.layout_mode === 'shot_asset_table_v8' && board.metadata.layout_view === layoutMode;
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const shotRows = assetShotRows(board, assets, storyShots);
  const shotNodes = board.nodes.filter((node) => node.node_type === 'shot' && node.shot_id);
  const shotOrder = storyShots.map((shot) => shot.id).filter((id) => shotNodes.some((node) => node.shot_id === id));
  shotNodes.forEach((node) => { if (node.shot_id && !shotOrder.includes(String(node.shot_id))) shotOrder.push(String(node.shot_id)); });
  const requestedShotId = options.shotId ? String(options.shotId).toUpperCase() : '';
  const rowKeys = [...new Set([...shotOrder, ...([...shotRows.values()].some((value) => value.length === 0) ? ['shared'] : [])])].filter((row) => !requestedShotId || String(row).toUpperCase() === requestedShotId);
  if (!rowKeys.length) rowKeys.push('shared');
  const rowMeta = new Map<string, { scene: string; detail: string; label: string; status: string }>();
  rowMeta.set('shared', { scene: '跨镜头或待分配', detail: '当前镜头所需资产', label: 'SHARED', status: 'partial' });
  for (const shotId of shotOrder) {
    const node = shotNodes.find((item) => item.shot_id === shotId);
    rowMeta.set(shotId, { scene: String(node?.config.scene || '未命名场景'), detail: `${String(node?.config.duration || '—')}s · ${String(node?.config.purpose || '镜头画面意图')}`, label: String(node?.shot_id || shotId), status: String(node?.status || 'ready') });
  }
  const gap = Math.max(8, Number(options.gap) || 16);
  const storedColumnWidths = options.columnWidths || assetBoardColumnWidthsFromMetadata(board.metadata, options.columnWidth || preset.columnWidth);
  const columnWidth = Math.max(220, Number(options.columnWidth) || preset.columnWidth);
  const layoutCardWidth = Math.max(220, Number(board.metadata.layout_card_width) || preset.columnWidth - 24);
  const columnWidths = assetBoardSafeColumnWidths({
    shots: Math.max(220, Number(storedColumnWidths.shots) || defaultAssetBoardColumnWidths.shots),
    'asset-flow': Math.max(280, Number(storedColumnWidths['asset-flow']) || preset.columnWidth * 2 + gap),
    fusion: Math.max(280, Number(storedColumnWidths.fusion) || preset.columnWidth * 2 + gap),
  }, layoutCardWidth, gap, layoutMode);
  const shotColumnWidth = layoutMode === 'adaptive' ? columnWidths.shots : Math.round(Math.max(250, columnWidths.shots));
  const directoryWidth = 0;
  const left = 24;
  const top = 96;
  const boardOriginX = directoryWidth;
  const adaptiveFlowWidth = columnWidths['asset-flow'];
  const layoutColumnBounds = assetBoardFixedColumnBounds(layoutMode, columnWidths, gap, 216, layoutCardWidth);
  const layoutColumnBoundsByKey = new Map(layoutColumnBounds.map((bound) => [bound.key, bound]));
  const columnX = (key: string) => {
    const resolvedKey = layoutMode === 'adaptive' && key !== 'shots' && key !== 'fusion' ? 'asset-flow' : key;
    return layoutColumnBoundsByKey.get(resolvedKey)?.x || boardOriginX + left;
  };
  const columnForNode = (node: AssetBoardNode) => {
    if (node.node_type === 'shot') return 'shots';
    const assetClass = node.asset_id ? String(assetMap.get(node.asset_id)?.assetClass || node.config.asset_class || '') : String(node.config.asset_class || '');
    return ['character', 'scene', 'prop', 'fusion'].includes(assetClass) ? assetClass : 'other';
  };
  const compositeAssetIds = new Set(board.nodes.filter((node) => node.node_type === 'handoff' && Boolean(node.config.prompt_card) && node.asset_id).map((node) => String(node.asset_id)));
  const isCompositeArtifact = (node: AssetBoardNode) => node.node_type === 'artifact' && Boolean(node.asset_id) && compositeAssetIds.has(String(node.asset_id));
  const presentationIdFor = (node: AssetBoardNode, row: string, index: number) => index > 0 ? `${node.id}:row:${row}` : node.id;
  const isCollapsedPresentationNode = (node: AssetBoardNode, row: string, index: number) => {
    if (collapsedScopes[`shot:${row}`] && node.node_type !== 'shot') return true;
    if (!node.asset_id) return false;
    const scope = collapsedScopes[`asset:${node.asset_id}:${row}`];
    if (!scope) return false;
    if (node.node_type === 'asset') return false;
    if (scope === true) return true;
    return String(scope) !== presentationIdFor(node, row, index);
  };
  const stackCounts = new Map<string, number>();
  const adaptiveFlowGroups = new Map<string, Array<{ key: string; column: string; titleCount: number; handoffCount: number; promptCount: number; promptMediaCount: number; artifactCount: number }>>();
  const cardHeightFor = (node: AssetBoardNode) => {
    const linkedAsset = node.asset_id ? assetMap.get(node.asset_id) : undefined;
    return assetBoardCardHeight({
      node_type: node.node_type,
      config: {
        ...node.config,
        asset_prompt: linkedAsset?.prompt || '',
        asset_artifact_count: linkedAsset?.artifact_count || linkedAsset?.artifacts?.length || 0,
        asset_file_url: linkedAsset?.filePath || linkedAsset?.file_path || linkedAsset?.previewUrl || '',
      },
    });
  };
  for (const node of board.nodes) {
    if (node.node_type === 'group' || node.node_type === 'shot' && !showShots) continue;
    // Legacy boards may still contain the old generic ChatGPT bridge. It is
    // intentionally hidden here; the prompt card is now the single handoff
    // surface and carries the prompt, QA state and ChatGPT action together.
    if (node.node_type === 'handoff' && !node.config.prompt_card) continue;
    if (isCompositeArtifact(node)) continue;
    if (requestedShotId && node.node_type === 'shot' && String(node.shot_id || '').toUpperCase() !== requestedShotId) continue;
    const linkedAsset = node.asset_id ? assetMap.get(node.asset_id) : undefined;
    if (options.onlyBlocked && linkedAsset && linkedAsset.readiness.production_ready && linkedAsset.readiness.status !== 'blocked') continue;
    if (options.showCandidates === false && node.node_type === 'artifact') continue;
    if (node.node_type !== 'shot' && filter !== 'all') {
      const assetClass = node.asset_id ? String(assetMap.get(node.asset_id)?.assetClass || node.config.asset_class || '') : '';
      if (assetClass !== filter) continue;
    }
    const candidateRows = node.node_type === 'shot' ? (node.shot_id ? [String(node.shot_id)] : ['shared']) : (shotRows.get(String(node.asset_id || '')) || []).length ? shotRows.get(String(node.asset_id || '')) || [] : ['shared'];
    const rows = requestedShotId ? candidateRows.filter((row) => String(row).toUpperCase() === requestedShotId) : candidateRows;
    rows.forEach((row, index) => {
      if (isCollapsedPresentationNode(node, row, index)) return;
      const key = `${row}:${columnForNode(node)}`;
      const estimatedCardHeight = cardHeightFor(node);
      stackCounts.set(key, (stackCounts.get(key) || 0) + estimatedCardHeight / 118);
      if (layoutMode === 'adaptive' && node.node_type !== 'shot') {
        const assetKey = String(node.asset_id || node.id);
        const groups = adaptiveFlowGroups.get(row) || [];
        const group = groups.find((item) => item.key === assetKey);
        if (group) {
          if (node.node_type === 'artifact') group.artifactCount += 1;
          else if (node.node_type === 'asset') group.titleCount += 1;
          else if (node.node_type === 'handoff' && Boolean(node.config.prompt_card)) { group.promptCount += 1; if (node.config.artifact_url) group.promptMediaCount += 1; }
          else group.handoffCount += 1;
        } else {
          groups.push({ key: assetKey, column: columnForNode(node), titleCount: node.node_type === 'asset' ? 1 : 0, handoffCount: node.node_type === 'handoff' && !node.config.prompt_card ? 1 : 0, promptCount: node.node_type === 'handoff' && Boolean(node.config.prompt_card) ? 1 : 0, promptMediaCount: node.node_type === 'handoff' && Boolean(node.config.prompt_card) && Boolean(node.config.artifact_url) ? 1 : 0, artifactCount: node.node_type === 'artifact' ? 1 : 0 });
        }
        adaptiveFlowGroups.set(row, groups);
      }
    });
  }
  const rowHeights = new Map<string, number>();
  const adaptiveFlowGroupLayout = new Map<string, { top: number; height: number; titleHeight: number; outputHeight: number; fusionStack: boolean }>();
  for (const row of rowKeys) {
    if (collapsedScopes[`shot:${row}`]) {
      rowHeights.set(row, 120);
      continue;
    }
    let height = preset.rowHeight;
    if (layoutMode === 'adaptive') {
      let cursor = gap;
      for (const group of adaptiveFlowGroups.get(row) || []) {
        const titleHeight = group.titleCount ? group.titleCount * 150 + Math.max(0, group.titleCount - 1) * gap : 0;
        const outputCount = group.handoffCount + group.promptCount + group.artifactCount;
          const outputHeight = group.handoffCount * 106 + group.promptCount * 350 + group.promptMediaCount * 220 + group.artifactCount * 226 + Math.max(0, outputCount - 1) * gap;
        const groupHeight = Math.max(106, titleHeight, outputHeight);
        adaptiveFlowGroupLayout.set(`${row}:${group.key}`, { top: cursor, height: groupHeight, titleHeight, outputHeight, fusionStack: false });
        cursor += groupHeight + gap;
      }
      height = Math.max(height, cursor + gap);
    } else {
      for (const column of assetGridColumns) height = Math.max(height, 34 + gap + Math.ceil(stackCounts.get(`${row}:${column.key}`) || 0) * (118 + gap));
    }
    rowHeights.set(row, height);
  }
  const rowY = new Map<string, number>();
  let cursorY = top;
  for (const row of rowKeys) { rowY.set(row, cursorY); cursorY += rowHeights.get(row) || preset.rowHeight; }
  const boardHeight = cursorY + 30;
  const rowsByCell = new Map<string, number>();
  const adaptiveFlowStackOffsets = new Map<string, number>();
  const positionFor = (node: AssetBoardNode, row: string, index = 0) => {
    const column = columnForNode(node); const rowTop = rowY.get(row) || top;
    if (isCollapsedPresentationNode(node, row, index)) return node.position || { x: columnX(column) + 12, y: rowTop + gap };
    const adaptiveRole = node.node_type === 'asset' ? 'title' : 'output';
    const assetKey = String(node.asset_id || node.id);
    const cellKey = layoutMode === 'adaptive' && node.node_type !== 'shot' ? `${row}:flow:${assetKey}:${adaptiveRole}` : `${row}:${column}`;
    const ordinal = rowsByCell.get(cellKey) || 0; rowsByCell.set(cellKey, ordinal + 1);
    const nodeHeight = cardHeightFor(node);
    const adaptiveGroup = layoutMode === 'adaptive' && node.node_type !== 'shot' ? adaptiveFlowGroupLayout.get(`${row}:${assetKey}`) : undefined;
    const groupTop = rowTop + (adaptiveGroup?.top || gap);
    // Keep the primary card and its output cards on the same horizontal
    // baseline. Centering the shorter card against a tall Prompt/media card
    // made one logical asset look like it had been split into two rows.
    const titleOffset = 0;
    const outputOffset = 0;
    const adaptiveStackKey = `${row}:flow:${assetKey}:${adaptiveRole}`;
    const adaptiveStackOffset = adaptiveFlowStackOffsets.get(adaptiveStackKey) || 0;
    if (layoutMode === 'adaptive' && node.node_type !== 'shot') adaptiveFlowStackOffsets.set(adaptiveStackKey, adaptiveStackOffset + nodeHeight + gap);
    const flowColumnX = columnX('asset-flow');
    const fusionColumnX = columnX('fusion');
    const isFusionColumn = layoutMode === 'adaptive' && column === 'fusion';
    const outputColumnX = isFusionColumn ? fusionColumnX : flowColumnX;
    const outputColumnWidth = isFusionColumn ? columnWidths.fusion : adaptiveFlowWidth;
    const fallback = node.node_type === 'shot'
      ? { x: columnX(column) + shotColumnWidth - 10, y: rowTop + 54 }
      : layoutMode === 'adaptive' && isFusionColumn
        ? { x: outputColumnX + (adaptiveRole === 'output' ? outputColumnWidth - layoutCardWidth - assetBoardCellPadding * 2 : assetBoardCellPadding), y: groupTop + (adaptiveRole === 'output' ? outputOffset : titleOffset) + adaptiveStackOffset }
          : layoutMode === 'adaptive' && adaptiveRole === 'output'
          ? { x: flowColumnX + adaptiveFlowWidth - layoutCardWidth - assetBoardCellPadding * 2, y: groupTop + outputOffset + adaptiveStackOffset }
          : layoutMode === 'adaptive'
            ? { x: flowColumnX + assetBoardCellPadding, y: groupTop + titleOffset + adaptiveStackOffset }
      : { x: columnX(column) + 12, y: rowTop + gap + ordinal * (nodeHeight + gap) };
    return useStoredPositions && !assetBoardCardIsLocked(node) && node.node_type !== 'shot' && index === 0 && node.config.position_source === 'manual' && node.position ? node.position : fallback;
  };
  const nodeWidthFor = (node: AssetBoardNode) => {
    if (columnForNode(node) === 'shots') return 1;
    // Column resizing changes the container frame only. Card dimensions stay
    // stable so Prompt/media cards do not jump or resize while the divider is
    // being dragged.
    return layoutCardWidth;
  };
  const presentation: AssetFlowNode[] = [];
  presentation.push({ id: 'asset-grid:table', type: 'asset-board', position: { x: boardOriginX, y: 0 }, draggable: false, selectable: false, className: 'asset-board-table-node', style: { width: assetBoardFixedTableWidth(layoutMode, columnWidths, gap, layoutCardWidth), height: boardHeight, zIndex: -3 }, data: { id: 'asset-grid:table', node_type: 'table', label: '镜头资产矩阵', position: { x: boardOriginX, y: 0 }, config: { grid_columns: layoutMode === 'adaptive' ? [assetGridColumns[0], { key: 'asset-flow', label: '镜头资产流', english: 'SHOT ASSET FLOW', description: '按当前镜头需求自动收拢' }, assetGridColumns.find((column) => column.key === 'fusion') || { key: 'fusion', label: '镜头融合', english: 'SHOT FUSION', description: '连接角色、场景与道具生成融合资产' }].filter(Boolean) : assetGridColumns, layout_mode: layoutMode, layout_gap: gap, collapsed_scopes: rowKeys.filter((row) => Boolean(collapsedScopes[`shot:${row}`])), grid_rows: rowKeys.map((row) => { const meta = rowMeta.get(row) || rowMeta.get('shared')!; return { key: row, y: rowY.get(row) || top, height: rowHeights.get(row) || preset.rowHeight, shotLabel: meta.label, shotScene: meta.scene, shotDetail: meta.detail, shotStatus: meta.status }; }), shot_column_width: columnWidths.shots, asset_flow_width: columnWidths['asset-flow'], fusion_column_width: columnWidths.fusion, card_width: layoutCardWidth }, status: 'idle', presentationOnly: true, onToggleScope: options.onToggleScope, onContextMenu: options.onContextMenu, onApprovePrompt: options.onApprovePrompt, onGenerateImage: options.onGenerateImage, onGeneratePrompt: options.onGeneratePrompt, onCopyPrompt: options.onCopyPrompt, onColumnResize: options.onColumnResize } });
  const visibleByNode = (node: AssetBoardNode): boolean => {
    if (Boolean(node.config.archived)) return false;
    if (node.node_type === 'shot') return showShots;
    const linkedAsset = node.asset_id ? assetMap.get(node.asset_id) : undefined;
    if (options.onlyBlocked && linkedAsset && linkedAsset.readiness.production_ready && linkedAsset.readiness.status !== 'blocked') return false;
    if (options.showCandidates === false && node.node_type === 'artifact') return false;
    if (filter === 'all') return true;
    const assetId = node.asset_id;
    const assetClass = assetId ? String(assetMap.get(assetId)?.assetClass || node.config.asset_class || '') : String(node.config.category || '');
    return assetClass === filter;
  };
  for (const node of board.nodes) {
    if (node.node_type === 'group') continue;
    if (node.node_type === 'handoff' && !node.config.prompt_card) continue;
    if (isCompositeArtifact(node)) continue;
    if (requestedShotId && node.node_type === 'shot' && String(node.shot_id || '').toUpperCase() !== requestedShotId) continue;
    const candidateRows = node.node_type === 'shot' ? (node.shot_id ? [String(node.shot_id)] : ['shared']) : (shotRows.get(String(node.asset_id || '')) || []).length ? shotRows.get(String(node.asset_id || '')) || [] : ['shared'];
    const rows = requestedShotId ? candidateRows.filter((row) => String(row).toUpperCase() === requestedShotId) : candidateRows;
    rows.forEach((row, index) => {
      const position = positionFor(node, row, index);
      const presentationOnly = index > 0;
      const id = presentationOnly ? `${node.id}:row:${row}` : node.id;
      const assetScope = node.asset_id ? collapsedScopes[`asset:${node.asset_id}:${row}`] : undefined;
      const shotCollapsed = Boolean(collapsedScopes[`shot:${row}`]);
      const keepNodeId = assetScope && assetScope !== true ? String(assetScope) : '';
      const hiddenByShot = shotCollapsed && node.node_type !== 'shot';
      const hiddenByAsset = Boolean(assetScope) && node.node_type !== 'asset' && (assetScope === true || keepNodeId !== id);
      const linkedAsset = node.asset_id ? assetMap.get(node.asset_id) : undefined;
      const data: AssetBoardNodeData = { ...node, id, position, presentationOnly, sourceNodeId: presentationOnly ? node.id : undefined, collapsed: Boolean(assetScope), onToggleScope: options.onToggleScope, onContextMenu: options.onContextMenu, onApprovePrompt: options.onApprovePrompt, onGenerateImage: options.onGenerateImage, onGeneratePrompt: options.onGeneratePrompt, onCopyPrompt: options.onCopyPrompt, onUploadAsset: options.onUploadAsset, onApproveAsset: options.onApproveAsset, onRejectAsset: options.onRejectAsset, onRegisterAsset: options.onRegisterAsset, onColumnResize: options.onColumnResize, onOpenAssetProduction: options.onOpenAssetProduction, config: { ...node.config, asset_prompt: linkedAsset?.prompt || '', asset_artifact_count: linkedAsset?.artifact_count || linkedAsset?.artifacts?.length || 0, asset_file_url: linkedAsset?.filePath || linkedAsset?.file_path || linkedAsset?.previewUrl || '', production_draft: Boolean((linkedAsset?.assetMetadata as Record<string, any> | undefined)?.production_draft?.active || (linkedAsset?.assetMetadata as Record<string, any> | undefined)?.metadata?.production_draft?.active || node.config.production_draft), fusion_prompt_source: linkedAsset?.fusionPromptSource, fusion_prompt_state: linkedAsset?.fusionPromptState, fusion_prompt_stale: Boolean(linkedAsset?.fusionPromptStale), fusion_prompt_stale_reason: linkedAsset?.fusionPromptStaleReason || null, fusion_plan: linkedAsset?.fusionPlan || node.config.fusion_plan || {}, grid_row_key: row, grid_column_key: columnForNode(node), shot_scope: rows } };
      presentation.push({ id, type: 'asset-board', position, selected: Boolean(options.selectedSelectionKey && assetBoardSelectionKey(data) === options.selectedSelectionKey), hidden: !visibleByNode(node) || hiddenByShot || hiddenByAsset, draggable: !assetBoardCardIsLocked(node) && node.node_type !== 'shot', selectable: node.node_type !== 'shot', style: { width: nodeWidthFor(node), zIndex: node.node_type === 'artifact' ? 2 : 3, opacity: node.node_type === 'shot' ? 0 : 1, pointerEvents: node.node_type === 'shot' ? 'none' : 'auto' }, data });
    });
  }

  // The table is a presentation-only background. Its frame is intentionally
  // fixed by the configured column widths and the generated board height.
  // Card positions are clamped to this frame; content never expands it.
  const columnBounds = assetBoardFixedColumnBounds(layoutMode, columnWidths, gap, boardHeight, layoutCardWidth);
  const tableNode = presentation[0];
  if (tableNode) {
    tableNode.position = { x: boardOriginX, y: 0 };
    tableNode.style = { ...tableNode.style, width: assetBoardFixedTableWidth(layoutMode, columnWidths, gap, layoutCardWidth), height: boardHeight };
    tableNode.data = {
      ...tableNode.data,
      position: { x: boardOriginX, y: 0 },
      config: {
        ...tableNode.data.config,
        grid_column_bounds: columnBounds,
      },
    };
  }
  return clampAssetBoardFlowNodes(presentation, layoutMode, columnWidths, gap, layoutCardWidth);
}

function assetBoardToFlowEdges(board: AssetBoard, nodes: AssetFlowNode[]): Edge[] {
  const visible = new Map(nodes.map((node) => [node.id, !node.hidden]));
  const candidates = (id: string) => nodes.filter((node) => node.id === id || node.data.sourceNodeId === id);
  const rowKey = (node: AssetFlowNode) => String(node.data.config.grid_row_key || '');
  const colors: Record<AssetBoardEdgeRelation, string> = { shot_dependency: '#a8d9c9', reference: '#7db6ff', fusion_input: '#d7ff4b', candidate: '#ffca66' };
  const result: Edge[] = [];
  for (const edge of board.edges) {
    if (edge.relation === 'shot_dependency') continue;
    const sources = candidates(edge.source); const targets = candidates(edge.target);
    const pairs: Array<[AssetFlowNode, AssetFlowNode]> = [];
    for (const source of sources) {
      const sameRow = targets.filter((target) => rowKey(source) && rowKey(source) === rowKey(target));
      const target = sameRow[0] || targets[0];
      if (target) pairs.push([source, target]);
    }
    const uniquePairs = pairs.length ? pairs : (sources[0] && targets[0] ? [[sources[0], targets[0]] as [AssetFlowNode, AssetFlowNode]] : []);
    uniquePairs.forEach(([source, target], index) => result.push({ id: `${edge.id}:${rowKey(source) || index}`, source: source.id, target: target.id, hidden: !visible.get(source.id) || !visible.get(target.id), type: edge.relation === 'shot_dependency' ? 'smoothstep' : 'bezier', animated: edge.relation === 'candidate', style: { stroke: colors[edge.relation], strokeDasharray: edge.relation === 'reference' ? '5 5' : undefined, opacity: .72 }, data: { relation: edge.relation } }));
  }
  return result;
}

function assetBoardFromFlow(board: AssetBoard, nodes: AssetFlowNode[], edges: Edge[]): AssetBoard {
  const flowEdgeFor = (edgeId: string) => edges.some((edge) => edge.id === edgeId || edge.id.startsWith(`${edgeId}:`));
  // shot_dependency is a semantic relation, not a visual edge. Keep it even
  // when its presentation edge is intentionally omitted from React Flow.
  const persistedEdges = board.edges.filter((edge) => edge.relation === 'shot_dependency' || flowEdgeFor(edge.id));
  const newEdges = edges.filter((edge) => !board.edges.some((candidate) => edge.id === candidate.id || edge.id.startsWith(`${candidate.id}:`))).map((edge) => {
    const sourceNode = nodes.find((node) => node.id === edge.source);
    const targetNode = nodes.find((node) => node.id === edge.target);
    if (!sourceNode || !targetNode || sourceNode.data.node_type === 'row' || targetNode.data.node_type === 'row' || sourceNode.data.node_type === 'table' || targetNode.data.node_type === 'table') return null;
    return { id: edge.id, source: sourceNode.data.sourceNodeId || sourceNode.id, target: targetNode.data.sourceNodeId || targetNode.id, relation: (edge.data?.relation as AssetBoardEdgeRelation) || 'reference' };
  }).filter((edge): edge is { id: string; source: string; target: string; relation: AssetBoardEdgeRelation } => Boolean(edge));
  return {
    ...board,
    metadata: { ...board.metadata, layout_mode: 'shot_asset_table_v8', layout_preset: board.metadata.layout_preset || 'standard' },
    nodes: nodes.filter((node) => !node.data.presentationOnly && node.data.node_type !== 'row').map((node) => {
      const { onToggleScope, onContextMenu, onApprovePrompt, onGenerateImage, onGeneratePrompt, onCopyPrompt, onColumnResize, onOpenAssetProduction, collapsed, presentationOnly, sourceNodeId, ...persistedData } = node.data;
      void onToggleScope; void onContextMenu; void onApprovePrompt; void onGenerateImage; void onGeneratePrompt; void onCopyPrompt; void onColumnResize; void onOpenAssetProduction; void collapsed; void presentationOnly; void sourceNodeId;
      const config = assetBoardCardIsLocked(node.data)
        ? Object.fromEntries(Object.entries(persistedData.config || {}).filter(([key]) => key !== 'position_source'))
        : persistedData.config;
      return { ...persistedData, config, node_type: node.data.node_type as AssetBoardNode['node_type'], position: { x: node.position.x, y: node.position.y } };
    }),
    edges: [...persistedEdges, ...newEdges].filter((edge, index, all) => all.findIndex((candidate) => candidate.source === edge.source && candidate.target === edge.target && candidate.relation === edge.relation) === index),
  };
}

function parseObjectText(value: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) { throw new Error(`JSON 格式无效：${error instanceof Error ? error.message : '无法解析'}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON 必须是对象，不能是数组或空值。');
  return parsed as Record<string, unknown>;
}

function composeAssetPrompt(asset: LibraryAsset, story: StoryEnvelope | null, prompt: string): string {
  const metadata = asset.assetMetadata || {};
  const spec = asset.assetSpec || metadata.asset_spec || {};
  const anchors = asset.identityAnchors || metadata.identity_anchors || {};
  const deps = (asset.dependencies || []).map((item) => `${item.shot_id || '未指定镜头'} · ${item.role || '依赖'}`).join('；');
  const storyGoal = story?.story.spec.creative_goal || '';
  return [
    `FRAMEFLOW 视觉资产生产 · ${assetClassLabels[asset.assetClass] || asset.assetClass}`,
    `资产名称：${asset.name || asset.id}`,
    `资产 ID：${asset.id}`,
    storyGoal ? `项目创意目标：${storyGoal}` : '',
    deps ? `镜头依赖：${deps}` : '',
    `身份/结构锚点：${JSON.stringify(anchors, null, 2)}`,
    `生产规格：${JSON.stringify(spec, null, 2)}`,
    asset.mustPreserve?.length ? `必须保留：${asset.mustPreserve.join('、')}` : '',
    asset.mustAvoid?.length ? `必须避免：${asset.mustAvoid.join('、')}` : '',
    `生成要求：${prompt.trim()}`,
    '请生成可用于 AI 视频制作的高一致性视觉资产。不要添加文字水印，不要改变资产的身份、结构、材质和比例。',
  ].filter(Boolean).join('\n\n');
}

function composeFusionPrompt(asset: LibraryAsset, sources: LibraryAsset[], story: StoryEnvelope | null): string {
  const metadata = asset.assetMetadata || {};
  const spec = asset.assetSpec || metadata.asset_spec || {};
  const sourceBlocks = sources.map((source) => {
    const sourceMetadata = source.assetMetadata || {};
    return [
      `输入资产：${source.name || source.id}（${assetClassLabels[source.assetClass] || source.assetClass} · ${source.id}）`,
      source.prompt ? `原始 Prompt：${source.prompt}` : '',
      `生产规格：${JSON.stringify(source.assetSpec || sourceMetadata.asset_spec || {}, null, 2)}`,
      `身份/结构锚点：${JSON.stringify(source.identityAnchors || sourceMetadata.identity_anchors || {}, null, 2)}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  return [
    'FRAMEFLOW 镜头融合资产生产',
    `融合目标：${asset.name || asset.id}（${asset.id}）`,
    story?.story.spec.creative_goal ? `项目创意目标：${story.story.spec.creative_goal}` : '',
    `融合目标原始规格：${JSON.stringify(spec, null, 2)}`,
    asset.mustPreserve?.length ? `融合目标必须保留：${asset.mustPreserve.join('、')}` : '',
    asset.mustAvoid?.length ? `融合目标必须避免：${asset.mustAvoid.join('、')}` : '',
    sourceBlocks ? `连接输入资产：\n${sourceBlocks}` : '连接输入资产：尚未连接角色、场景或道具资产。',
    '融合要求：保持每个输入资产的身份、空间结构、材质和关键识别特征；将它们组织到同一镜头构图中，明确人物与环境的空间关系、尺度、动作、遮挡、光线、天气、镜头焦段和视觉风格；不得凭空替换或削弱输入资产的核心特征。',
    '输出要求：生成可直接用于视觉资产生成的中文 Prompt，画面连续性优先，避免文字乱码、肢体错误、重复人物和不合理透视。',
  ].filter(Boolean).join('\n\n');
}

function AssetProductionPanel({ asset, story, fusionSources, busy, projectRevision, assetBoardDirty, promptDraft, selectedCardType, onSave, onHandoff, onImport, onStartQa, onApprove, onRegister, onApprovePromptCard, onGenerateImageCard, onGeneratePrompt, onGenerateFusionPrompt, onManualProductionApproval }: { asset?: LibraryAsset; story: StoryEnvelope | null; fusionSources: LibraryAsset[]; busy: boolean; projectRevision?: number; assetBoardDirty: boolean; promptDraft?: string; selectedCardType?: 'asset' | 'handoff' | 'artifact'; onSave: (assetId: string, body: Record<string, unknown>) => void; onHandoff: (asset: LibraryAsset, prompt: string) => void; onImport: (asset: LibraryAsset, file: File) => void; onStartQa: (artifactId: string, qaType?: AssetQaType) => void; onApprove: (artifactId: string) => void; onRegister: (artifactId: string) => void; onApprovePromptCard: (assetId: string) => void; onGenerateImageCard: (assetId: string) => void; onGeneratePrompt?: (assetId: string) => void; onGenerateFusionPrompt: (assetId: string, sourceAssetIds: string[], shotId: string) => void; onManualProductionApproval?: (assetId: string, approved: boolean, reason: string, artifactId: string) => void }) {
  const [prompt, setPrompt] = useState('');
  const [assetSpec, setAssetSpec] = useState('{}');
  const [anchors, setAnchors] = useState('{}');
  const [mustPreserve, setMustPreserve] = useState('');
  const [mustAvoid, setMustAvoid] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [manualApprovalReason, setManualApprovalReason] = useState('');
  useEffect(() => {
    if (!asset) return;
     setPrompt(promptDraft !== undefined ? promptDraft : String(asset.prompt || ''));
    setAssetSpec(JSON.stringify(asset.assetSpec || asset.assetMetadata?.asset_spec || {}, null, 2));
    setAnchors(JSON.stringify(asset.identityAnchors || asset.assetMetadata?.identity_anchors || {}, null, 2));
    setMustPreserve((asset.mustPreserve || asset.assetMetadata?.must_preserve || []).join('\n'));
    setMustAvoid((asset.mustAvoid || asset.assetMetadata?.must_avoid || []).join('\n'));
  }, [asset?.id, promptDraft]);
  if (!asset) return <section className="asset-production-empty"><span>ASSET PRODUCTION</span><h2>选择一个资产开始制作</h2><p>从画布中选择角色、场景、道具或融合节点。这里会生成 Prompt、管理参考图和候选版本。</p></section>;
  const shotLabels = (asset.dependencies || []).map((item) => item.shot_id).filter(Boolean).join('、');
  const artifacts = Array.isArray(asset.artifacts) ? asset.artifacts as any[] : [];
  const currentArtifact = artifacts.find((item) => item.id === asset.artifactId || item.artifact_id === asset.artifactId) || artifacts.find((item) => ['active', 'approved', 'registered', 'current'].includes(String(item.status || '').toLowerCase())) || artifacts[0];
  const currentFileUrl = String(asset.filePath || asset.file_path || asset.previewUrl || currentArtifact?.url || currentArtifact?.file_path || '');
  const currentArtifactId = String(asset.artifactId || asset.artifact_id || currentArtifact?.id || '');
  const currentFileId = currentArtifactId || '当前登记文件';
  const manualApprovalActive = Boolean(asset.readiness.manual_approval_active);
  const isFusion = asset.assetClass === 'fusion';
  const fusionPromptReady = !isFusion || asset.fusionPromptSource === 'fusion-connection-agent';
  const fusionShotId = String(asset.fusionPlan?.shot_id || asset.promptRelevantShots?.[0] || String(asset.id).match(/SH\d+/i)?.[0] || '').toUpperCase();
  const fusionSourceIds = fusionSources.map((source) => source.id);
  const fusionBlockedSources = fusionSources.filter((source) => source.readiness?.production_ready !== true && source.production_ready !== true);
  const fusionCanGenerate = isFusion && fusionSources.length >= 2 && fusionBlockedSources.length === 0 && Boolean(fusionShotId);
  const save = () => {
    try {
      const parsedSpec = parseObjectText(assetSpec);
      const parsedAnchors = parseObjectText(anchors);
      setJsonError('');
      onSave(asset.id, { expected_revision: projectRevision, asset_class: asset.assetClass, prompt: isFusion && !fusionPromptReady ? String(asset.prompt || '') : prompt, asset_spec: parsedSpec, identity_anchors: parsedAnchors, must_preserve: mustPreserve.split('\n').map((item) => item.trim()).filter(Boolean), must_avoid: mustAvoid.split('\n').map((item) => item.trim()).filter(Boolean), source: asset.source || 'chatgpt-web', authorization_status: asset.authorizationStatus || 'pending', fusion_source_asset_ids: isFusion ? fusionSourceIds : undefined });
    } catch (error) { setJsonError((error as Error).message); }
  };
  const selectionContextLabel = selectedCardType === 'handoff' ? 'Prompt / 图片卡' : selectedCardType === 'artifact' ? '候选版本卡' : '资产卡';
  return <section className="asset-production-panel">
    <header><span>{selectionContextLabel} · {assetClassLabels[asset.assetClass] || asset.assetClass} · {asset.id}</span><h2>{asset.name || asset.id}</h2><p>{assetBoardStatusLabel(asset.readiness.status)} · 等级 {asset.grade || 'B'}{shotLabels ? ` · 镜头 ${shotLabels}` : ''}{isFusion && asset.fusionPromptStale ? ' · 融合输入已变化' : ''}</p>{asset.prompt && (!isFusion || fusionPromptReady) && <div className="asset-prompt-gate"><span>Prompt QA：{String(asset.promptQaDecision || 'Pending')} · 图像：{String(asset.generationStatus || 'planned')}</span><div>{asset.promptQaDecision !== 'Approved' && <button onClick={() => onApprovePromptCard(asset.id)} disabled={busy}>通过 Prompt QA</button>}{asset.promptQaDecision === 'Approved' && asset.imageGenerationEligible !== false && asset.generationStatus !== 'generated-pending-qa' && <button className="asset-prompt-gate-primary" onClick={() => onGenerateImageCard(asset.id)} disabled={busy}>确认并生成图像</button>}</div></div>}{asset.readiness.registered_ready && !asset.readiness.production_ready && <div className="manual-production-gate"><strong>已登记资产可人工确认</strong><small>仅豁免 Prompt / Prompt QA，当前登记文件、图片 QA、授权与融合门仍然有效。</small><textarea value={manualApprovalReason} onChange={(event) => setManualApprovalReason(event.target.value)} placeholder="填写人工审核原因" rows={2} /><button onClick={() => onManualProductionApproval?.(asset.id, true, manualApprovalReason.trim(), currentFileId)} disabled={busy || !manualApprovalReason.trim() || !currentArtifactId || !onManualProductionApproval}>人工通过可入镜</button></div>}{manualApprovalActive && <div className="manual-production-active"><span>当前登记文件已人工通过可入镜</span><button onClick={() => onManualProductionApproval?.(asset.id, false, '撤销人工通过', currentFileId)} disabled={busy || !onManualProductionApproval}>撤销人工通过</button></div>}</header>
     <div className="asset-production-actions"><button onClick={save} disabled={busy}>保存 Prompt / 规格</button>{!isFusion && <button className="asset-ai-prompt-button" onClick={() => onGeneratePrompt?.(asset.id)} disabled={busy || !onGeneratePrompt}>AI 编写 Prompt</button>}<button className="asset-chatgpt-button" onClick={() => onHandoff(asset, prompt)} disabled={busy || !prompt.trim() || (isFusion && !fusionPromptReady)}>{isFusion && !fusionPromptReady ? '历史融合 Prompt 不可执行' : '复制 Prompt 并打开 ChatGPT'}</button></div>
    {isFusion && <section className="fusion-inputs-panel"><div><span>FUSION WORKFLOW</span><h3>{fusionPromptReady ? '正式融合 Prompt' : '等待实际资产连线'}</h3><p>{String(asset.fusionPlan?.shot_intent || '先完成剧本与分镜对应的资产连接，再生成正式融合场景 Prompt。')}</p></div><div className="fusion-plan-summary"><span>目标镜头：{fusionShotId || '未绑定'}</span><span>规划状态：{fusionPromptReady ? (asset.fusionPromptStale ? '输入已变化 · 待重新融合' : '已生成正式 Prompt') : 'awaiting_connection'}</span></div><div className="fusion-input-list">{fusionSources.length ? fusionSources.map((source) => <span key={source.id} className={source.readiness?.production_ready === true || source.production_ready === true ? 'ready' : 'blocked'}>{assetClassLabels[source.assetClass] || source.assetClass} · {source.name || source.id}{source.readiness?.production_ready === true || source.production_ready === true ? ' · 已就绪' : ` · ${source.readiness?.next_action || '未就绪'}`}</span>) : <small>尚未连接基础资产，请在画布中把角色、场景或道具节点连到此融合卡。</small>}</div>{assetBoardDirty && <p className="fusion-connection-warning">当前画布连线尚未保存；点击生成时会先保存当前连接。</p>}{fusionBlockedSources.length > 0 && <p className="fusion-connection-warning">存在未达到 production_ready 的输入资产：{fusionBlockedSources.map((source) => source.name || source.id).join('、')}</p>}{!fusionShotId && <p className="fusion-connection-warning">该融合资产尚未绑定有效镜头。</p>}<div className="fusion-input-actions"><button className="fusion-compose-button" onClick={() => setPrompt(composeFusionPrompt(asset, fusionSources, story))} disabled={busy || fusionSources.length < 2}>预览融合输入</button><button className="fusion-compose-button fusion-ai-button" onClick={() => onGenerateFusionPrompt(asset.id, fusionSourceIds, fusionShotId)} disabled={busy || !fusionCanGenerate}>确认连接并生成融合 Prompt（AI）</button></div></section>}
    <label>Prompt<textarea data-asset-production-prompt value={prompt} readOnly={isFusion} onChange={(event) => setPrompt(event.target.value)} placeholder="描述这个资产的身份、结构、材质、镜头用途和视觉要求…" /></label>
    {jsonError && <p className="asset-form-error" role="alert">{jsonError}</p>}
    <label>资产生产规格 JSON<textarea className={jsonError ? 'invalid' : ''} value={assetSpec} onChange={(event) => { setAssetSpec(event.target.value); setJsonError(''); }} spellCheck={false} /></label>
    <label>身份/结构锚点 JSON<textarea className={jsonError ? 'invalid' : ''} value={anchors} onChange={(event) => { setAnchors(event.target.value); setJsonError(''); }} spellCheck={false} /></label>
    <div className="asset-production-two-col"><label>必须保留<textarea value={mustPreserve} onChange={(event) => setMustPreserve(event.target.value)} placeholder="每行一条" /></label><label>必须避免<textarea value={mustAvoid} onChange={(event) => setMustAvoid(event.target.value)} placeholder="每行一条" /></label></div>
    <div className="asset-drop-zone" data-asset-production-upload onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) onImport(asset, file); }}><strong>拖入候选图片、视频或声音</strong><span>服务端会按媒体类型进入图片 QA、视频 QA、声音 QA 或参考审核，不会覆盖当前版本。</span><label className="asset-file-button">选择候选媒体<input type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/wav,audio/mpeg,audio/mp4,audio/x-m4a" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(asset, file); event.currentTarget.value = ''; }} /></label></div>
    <section className="asset-current-file"><h3>当前选中文件</h3>{currentFileUrl ? <div className="asset-current-file-card"><div><strong>{currentFileId}</strong><span>{currentArtifact?.source_type || currentArtifact?.source || '当前登记文件'} · {assetBoardStatusLabel(String(currentArtifact?.status || asset.readiness.status || 'ready'))}</span></div><a href={currentFileUrl} target="_blank" rel="noreferrer">预览文件</a></div> : <p>当前资产尚无登记文件。候选文件不会在这里批量展开。</p>}{currentArtifact && <div className="asset-current-file-actions">{['generated_pending_qa', 'reference_pending_review', 'audit_blocked'].includes(String(currentArtifact.status)) && <button onClick={() => onStartQa(String(currentArtifact.id), String(currentArtifact.metadata?.qa_type || (String(currentArtifact.mime_type || '').startsWith('video/') ? 'video' : asset.workflow?.kind === 'reference' ? 'reference' : 'image')) as AssetQaType)} disabled={busy}>开始媒体 QA</button>}{currentArtifact.status === 'qa_in_progress' && <button onClick={() => onApprove(String(currentArtifact.id))} disabled={busy}>打开 QA / 审核</button>}{currentArtifact.status === 'approved_pending_registration' && <button onClick={() => onRegister(String(currentArtifact.id))} disabled={busy}>登记当前文件</button>}{currentArtifact.status === 'reference' && <span className="asset-reference-chip">已通过参考审核 · 不可入镜</span>}</div>}</section>
  </section>;
}

function AgentPanel({ project, graph, selectedNodeIds, plan, busy, onCreate, onApply, onReject }: { project?: ProjectRecord; graph: GraphEnvelope | null; selectedNodeIds: string[]; plan: AgentPlan | null; busy: boolean; onCreate: (message: string) => void; onApply: () => void; onReject: () => void }) {
  const [message, setMessage] = useState('');
  const preview = plan?.preview || {};
  const addedNodes = Array.isArray((preview.added as Record<string, any> | undefined)?.nodes) ? (preview.added as Record<string, any>).nodes : [];
  const modifiedNodes = Array.isArray((preview.modified as Record<string, any> | undefined)?.nodes) ? (preview.modified as Record<string, any>).nodes : [];
  const candidates = Array.isArray(preview.candidates) ? preview.candidates : [];
  return <section className="agent-panel">
    <div className="agent-panel-heading"><div><span>SUPERVISED AGENT</span><h3>Agent 计划编排</h3></div><b>{selectedNodeIds.length ? `已选 ${selectedNodeIds.length} 个节点` : '未选择节点'}</b></div>
    <p className="muted">Agent 只提交结构化补丁。先预览新增、修改、保留和潜在费用，再由你决定是否应用；不会直接执行媒体调用。</p>
    <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="例如：为选中节点增加角色连续性检查，并草拟一版脚本候选。" disabled={busy} />
    <button className="agent-primary" onClick={() => { const value = message.trim(); if (value) onCreate(value); }} disabled={busy || !project || !graph || !message.trim()}>生成结构化计划</button>
    {plan && <div className="agent-plan-review">
      <div className="agent-plan-status"><strong>{plan.status === 'awaiting_review' ? '待审阅' : plan.status}</strong><span>{plan.reply || '已生成结构化补丁'}</span></div>
      <dl><div><dt>新增节点</dt><dd>{addedNodes.length}</dd></div><div><dt>修改节点</dt><dd>{modifiedNodes.length}</dd></div><div><dt>潜在费用</dt><dd>{String(preview.potential_cost ?? 0)} {String(preview.currency || 'USD')}</dd></div><div><dt>需确认</dt><dd>{preview.requires_confirmation ? '是' : '否'}</dd></div></dl>
      {candidates.length > 0 && <p className="agent-candidate-note">将创建 {candidates.length} 个候选版本，应用后仍不会覆盖当前 active 内容。</p>}
      <details><summary>查看补丁预览</summary><pre>{JSON.stringify(preview, null, 2)}</pre></details>
      <div className="agent-actions"><button onClick={onReject} disabled={busy}>拒绝</button><button className="agent-primary" onClick={onApply} disabled={busy || plan.status !== 'awaiting_review'}>应用补丁</button></div>
    </div>}
  </section>;
}

type AssistantChatMessage = { id: string; role: 'user' | 'assistant' | 'system'; content: string };

function assistantModeLabel(mode: StudioMode): string {
  return ({ home: '项目总览', story: '故事与分镜', canvas: '资产生产工作区', timeline: '后期时间线', audio: '声音工作区', assets: '统一资产库', settings: '设置与 Provider' })[mode];
}

function assistantPolicyLabel(policy?: string): string {
  return ({ text_auto: '文本可自动处理', deterministic_gate: '门禁校验', media_qa: '媒体 QA', paid_confirmation: '付费需确认', final_confirmation: '交付需确认', supervised: '监督式修改' }[policy || ''] || policy || '监督式修改');
}

function AssistantDrawer({ open, project, mode, graph, story, assetLibrary, audioStudio, timeline, selectedNodeIds, selectedEdgeIds, dirty, storyDirty, assetBoardDirty, audioDirty, timelineDirty, plan, busy, skills, selectedSkillId, onSkillChange, onCreate, onApply, onReject, onClose, onNavigate }: {
  open: boolean;
  project?: ProjectRecord;
  mode: StudioMode;
  graph: GraphEnvelope | null;
  story: StoryEnvelope | null;
  assetLibrary: AssetLibraryEnvelope | null;
  audioStudio: AudioStudioEnvelope | null;
  timeline: TimelineEnvelope | null;
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  dirty: boolean;
  storyDirty: boolean;
  assetBoardDirty: boolean;
  audioDirty: boolean;
  timelineDirty: boolean;
  plan: AgentPlan | null;
  busy: boolean;
  skills: WorkflowManifest[];
  selectedSkillId: string;
  onSkillChange: (skillId: string) => void;
  onCreate: (message: string, skillId: string) => Promise<boolean>;
  onApply: () => void;
  onReject: () => void;
  onClose: () => void;
  onNavigate: (mode: StudioMode) => void;
}) {
  const dialogFocus = useDialogFocus(open);
  const [message, setMessage] = useState('');
  const [contextOpen, setContextOpen] = useState(false);
  const [messages, setMessages] = useState<AssistantChatMessage[]>([]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastPlanSignature = useRef('');
  const projectKey = project?.document.id || 'no-project';
  const availableSkills = skills.length ? skills : fallbackAssistantSkills;
  const selectedSkill = availableSkills.find((item) => item.skill_id === selectedSkillId) || availableSkills[0];
  const preview = plan?.preview || {};
  const addedNodes = Array.isArray((preview.added as Record<string, any> | undefined)?.nodes) ? (preview.added as Record<string, any>).nodes : [];
  const modifiedNodes = Array.isArray((preview.modified as Record<string, any> | undefined)?.nodes) ? (preview.modified as Record<string, any>).nodes : [];
  const deletedNodes = Array.isArray((preview.deleted as Record<string, any> | undefined)?.nodes) ? (preview.deleted as Record<string, any>).nodes : [];
  const candidates = Array.isArray(preview.candidates) ? preview.candidates : [];
  const quickPrompts = [
    { label: '检查当前流程', value: '扫描整个创作流程，告诉我当前最重要的阻塞项，并提出可以直接应用到工作台的修改。' },
    { label: '完善当前阶段', value: `根据${assistantSkillLabels[selectedSkillId] || '当前 Skill'}的规则，完善当前阶段内容，保留现有稳定 ID。` },
    { label: '做一次连续性检查', value: '检查故事、资产、镜头和时间线之间的连续性，列出问题并生成可审阅的修复计划。' },
  ];

  useEffect(() => {
    lastPlanSignature.current = '';
    setMessages([{ id: `welcome:${projectKey}`, role: 'assistant', content: project ? `我已读取「${project.document.name}」的项目上下文。可以从当前阶段、全流程门禁或具体镜头开始。` : '请选择一个项目后，我会读取完整创作上下文。' }]);
  }, [projectKey]);

  useEffect(() => {
    if (!plan) return;
    const signature = `${plan.id}:${plan.status}:${plan.reply || ''}`;
    if (signature === lastPlanSignature.current) return;
    lastPlanSignature.current = signature;
    const content = plan.status === 'awaiting_review'
      ? `${plan.reply || '已生成一份结构化修改计划。'}\n\n计划已放入下方审阅区，确认后才会写入工作台。`
      : plan.status === 'applied'
        ? '修改计划已应用。工作流图已刷新，候选版本仍保留为独立版本。'
        : plan.status === 'rejected'
          ? '这份修改计划已拒绝，当前项目内容没有改变。'
          : `Agent 状态：${plan.status}`;
    setMessages((current) => [...current, { id: `plan:${signature}`, role: plan.status === 'awaiting_review' ? 'assistant' : 'system', content }]);
  }, [plan?.id, plan?.status, plan?.reply]);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 120);
  }, [open]);

  const submit = async (raw: string) => {
    const value = raw.trim();
    if (!value || busy || !project) return;
    setMessages((current) => [...current, { id: `user:${Date.now()}`, role: 'user', content: value }]);
    setMessage('');
    const ok = await onCreate(value, selectedSkill?.skill_id || selectedSkillId);
    if (!ok) setMessages((current) => [...current, { id: `error:${Date.now()}`, role: 'system', content: '这次请求没有生成计划，请检查 Provider 配置或右上角状态提示。' }]);
  };

  return <>
    {open && <button className="assistant-backdrop" aria-label="关闭创作助手" onClick={onClose} />}
    <aside ref={dialogFocus.dialogRef} onKeyDown={dialogFocus.onKeyDown} className={`assistant-drawer ${open ? 'open' : ''}`} aria-label="FRAMEFLOW AI 创作助手" aria-hidden={!open} inert={!open}>
      <header className="assistant-drawer-header">
        <div className="assistant-drawer-topline"><span>FRAMEFLOW AI · SUPERVISED</span><b><i />已连接</b></div>
        <div className="assistant-drawer-title"><div><h2>创作助手</h2><p>读懂整个制作链，帮你把想法转成可审阅的工作台修改。</p></div><button className="assistant-close" onClick={onClose} aria-label="关闭创作助手">×</button></div>
      </header>

      <div className="assistant-drawer-scroll">
        <section className="assistant-skill-card">
          <div className="assistant-card-label"><span>当前工作 Skill</span><b>{assistantPolicyLabel(selectedSkill?.approval_policy)}</b></div>
          <select id="assistant-skill" name="assistant-skill" value={selectedSkill?.skill_id || selectedSkillId} onChange={(event) => onSkillChange(event.target.value)} disabled={busy} aria-label="选择当前工作 Skill">
            {availableSkills.map((skill) => <option key={skill.skill_id} value={skill.skill_id}>{assistantSkillLabels[skill.skill_id] || skill.skill_id} · v{skill.skill_version}</option>)}
          </select>
          <small>{selectedSkill?.instructions || '使用稳定 ID，所有更改创建新版本，不覆盖已批准产物。'}</small>
        </section>

        <section className="assistant-context-card">
          <div className="assistant-card-label"><span>已读取工作上下文</span><button onClick={() => setContextOpen((value) => !value)}>{contextOpen ? '收起' : '查看范围'}</button></div>
          <div className="assistant-context-project"><span className="assistant-project-dot" /><div><strong>{project?.document.name || '尚未选择项目'}</strong><small>{assistantModeLabel(mode)} · 项目 v{project?.revision || 0}</small></div><b>{project ? 'LIVE' : '—'}</b></div>
          <div className="assistant-context-chips"><span>流程图 v{graph?.revision || 0}</span><span>故事 v{story?.revision || 0}</span><span>资产 {assetLibrary?.summary.total || 0}</span><span>声音 v{audioStudio?.revision || 0}</span><span>时间线 v{timeline?.revision || 0}</span>{selectedNodeIds.length > 0 && <span>选中 {selectedNodeIds.length} 节点</span>}</div>
          {contextOpen && <div className="assistant-context-detail"><p>读取：项目规格、故事与分镜、统一资产库、声音资产工坊、资产画布、后期时间线、工作流图和版本号。</p><p>当前选区：{selectedNodeIds.length ? `${selectedNodeIds.length} 个工作流节点` : '未选择工作流节点'}{selectedEdgeIds.length ? ` · ${selectedEdgeIds.length} 条连接` : ''}。</p><p>未保存状态：{[dirty && '流程图', storyDirty && '故事', assetBoardDirty && '资产画布', audioDirty && '声音', timelineDirty && '时间线'].filter(Boolean).join('、') || '无'}。</p></div>}
        </section>

        <section className="assistant-quick-prompts"><div className="assistant-card-label"><span>快速开始</span><small>点击即可发送</small></div><div>{quickPrompts.map((item) => <button key={item.label} onClick={() => { void submit(item.value); }} disabled={busy || !project}>{item.label}<span>→</span></button>)}</div></section>

        <section className="assistant-chat" aria-live="polite">
          {messages.map((item) => <article className={`assistant-chat-message ${item.role}`} key={item.id}><div className="assistant-chat-avatar">{item.role === 'user' ? '你' : item.role === 'system' ? '!' : 'F'}</div><div><span>{item.role === 'user' ? '你' : item.role === 'system' ? '系统状态' : 'FRAMEFLOW AI'}</span><p>{item.content}</p></div></article>)}
          {busy && <div className="assistant-thinking"><i /><span>正在读取上下文并生成结构化计划…</span></div>}
        </section>

        {plan && <section className="assistant-plan-card"><div className="assistant-plan-heading"><div><span>PLAN REVIEW</span><strong>待审阅的修改计划</strong></div><b className={plan.status}>{plan.status === 'awaiting_review' ? '待确认' : plan.status}</b></div><div className="assistant-plan-stats"><div><strong>{addedNodes.length}</strong><span>新增节点</span></div><div><strong>{modifiedNodes.length}</strong><span>修改节点</span></div><div><strong>{deletedNodes.length}</strong><span>删除节点</span></div><div><strong>{candidates.length}</strong><span>候选版本</span></div></div><div className="assistant-plan-cost"><span>潜在费用</span><strong>{String(preview.potential_cost ?? 0)} {String(preview.currency || 'USD')}</strong><em>{preview.requires_confirmation ? '需要单独确认' : '当前无需付费确认'}</em></div><details><summary>查看结构化补丁</summary><pre>{JSON.stringify({ added: preview.added, modified: preview.modified, candidates: preview.candidates, approval_gates: preview.approval_gates }, null, 2)}</pre></details>{plan.status === 'awaiting_review' && <div className="assistant-plan-actions"><button onClick={onReject} disabled={busy}>拒绝计划</button><button className="assistant-apply" onClick={onApply} disabled={busy}>应用到工作台</button></div>}</section>}
      </div>

      <footer className="assistant-composer"><div className="assistant-composer-hint"><span>向 {assistantSkillLabels[selectedSkill?.skill_id || selectedSkillId] || '当前 Skill'} 提问</span><small>Enter 发送 · Shift + Enter 换行</small></div><div className="assistant-composer-box"><textarea ref={inputRef} id="assistant-message" name="assistant-message" aria-label="向当前工作 Skill 提问" data-dialog-initial-focus value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(message); } }} placeholder={project ? '描述你想怎么修改当前内容…' : '先选择一个项目'} disabled={busy || !project} rows={3} /><button onClick={() => { void submit(message); }} disabled={busy || !project || !message.trim()} aria-label="发送消息">↑</button></div><button className="assistant-open-workspace" onClick={() => { onNavigate(mode); onClose(); }}>返回当前工作区 <span>↗</span></button></footer>
    </aside>
  </>;
}

function CommandPalette({ open, query, actions, onQueryChange, onClose }: { open: boolean; query: string; actions: CommandAction[]; onQueryChange: (value: string) => void; onClose: () => void }) {
  const dialogFocus = useDialogFocus(open);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const filteredActions = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return actions;
    return actions.filter((action) => `${action.label} ${action.description}`.toLowerCase().includes(value));
  }, [actions, query]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (activeIndex >= filteredActions.length) setActiveIndex(0);
  }, [activeIndex, filteredActions.length]);

  if (!open) return null;
  const run = (action?: CommandAction) => {
    if (!action || action.disabled) return;
    action.onSelect();
    onClose();
  };

  return <div className="keyboard-overlay command-palette-overlay">
    <button type="button" className="keyboard-overlay-backdrop" onClick={onClose} aria-label="关闭命令面板" />
    <section ref={dialogFocus.dialogRef} onKeyDown={dialogFocus.onKeyDown} className="command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title">
      <header className="command-palette-heading"><div><span>COMMAND LAYER</span><h2 id="command-palette-title">跳转到工作台功能</h2></div><button type="button" className="keyboard-close" onClick={onClose} aria-label="关闭命令面板">Esc</button></header>
      <label className="command-palette-search"><span>⌕</span><input ref={inputRef} id="command-palette-search" name="command-palette-search" data-dialog-initial-focus value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((value) => filteredActions.length ? (value + 1) % filteredActions.length : 0); } else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((value) => filteredActions.length ? (value - 1 + filteredActions.length) % filteredActions.length : 0); } else if (event.key === 'Enter') { event.preventDefault(); run(filteredActions[activeIndex]); } else if (event.key === 'Escape') { event.preventDefault(); onClose(); } }} placeholder="搜索操作，例如：故事、保存、助手…" aria-label="搜索工作台操作" /></label>
      <div className="command-palette-list" role="listbox" aria-label="可用工作台操作">
        {filteredActions.length ? filteredActions.map((action, index) => <button type="button" role="option" aria-selected={index === activeIndex} className={`command-palette-item ${index === activeIndex ? 'active' : ''}`} key={action.id} disabled={action.disabled} onMouseEnter={() => setActiveIndex(index)} onClick={() => run(action)}><span className="command-palette-icon">{action.id === 'help' ? '?' : action.id === 'save' ? '↓' : action.id === 'assistant' ? '✦' : '→'}</span><span><strong>{action.label}</strong><small>{action.description}</small></span>{action.shortcut && <kbd>{action.shortcut}</kbd>}</button>) : <p className="command-palette-empty">没有匹配的操作</p>}
      </div>
      <footer className="command-palette-footer"><span>↑ ↓ 选择</span><span><kbd>Enter</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span></footer>
    </section>
  </div>;
}

function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogFocus = useDialogFocus(open);
  if (!open) return null;
  return <div className="keyboard-overlay shortcut-help-overlay">
    <button type="button" className="keyboard-overlay-backdrop" onClick={onClose} aria-label="关闭快捷键帮助" />
    <section ref={dialogFocus.dialogRef} onKeyDown={dialogFocus.onKeyDown} className="shortcut-help" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title">
      <header className="shortcut-help-heading"><div><span>KEYBOARD LAYER</span><h2 id="shortcut-help-title">工作台快捷键</h2><p>Windows 使用 Ctrl，Mac 使用 ⌘。输入框内的文字编辑快捷键保留给系统。</p></div><button type="button" className="keyboard-close" onClick={onClose} aria-label="关闭快捷键帮助">Esc</button></header>
      <div className="shortcut-help-grid">{shortcutGroups.map((group) => <section key={group.title}><h3>{group.title}</h3><div>{group.rows.map(([keys, label]) => <p key={label}><span>{label}</span><kbd>{keys}</kbd></p>)}</div></section>)}</div>
      <footer className="shortcut-help-footer"><span>也可以按 <kbd>Ctrl / ⌘ + K</kbd> 打开命令面板</span><button type="button" onClick={onClose}>完成</button></footer>
    </section>
  </div>;
}


function toFlowNodes(graph: WorkflowGraph): FlowNode[] {
  const collapsedGroups = new Set(graph.nodes.filter((node) => node.kind === 'group' && node.config.collapsed === true).map((node) => node.id));
  const hiddenByGroup = (node: typeof graph.nodes[number]): boolean => {
    let groupId = typeof node.config.group_id === 'string' ? node.config.group_id : undefined;
    const seen = new Set<string>();
    while (groupId && !seen.has(groupId)) {
      if (collapsedGroups.has(groupId)) return true;
      seen.add(groupId);
      const parent = graph.nodes.find((candidate) => candidate.id === groupId);
      groupId = parent && typeof parent.config.group_id === 'string' ? parent.config.group_id : undefined;
    }
    return false;
  };
  const orderedNodes = [...graph.nodes.filter((node) => node.kind === 'group'), ...graph.nodes.filter((node) => node.kind !== 'group')];
  return orderedNodes.map((node) => ({
    id: node.id,
    type: 'workflow',
    position: node.position,
    parentId: typeof node.config.group_id === 'string' ? node.config.group_id : undefined,
    hidden: hiddenByGroup(node),
    style: node.kind === 'group' ? { width: Number(node.config.width) || 460, height: Number(node.config.height) || 280 } : undefined,
    draggable: !node.locked,
    data: {
      label: node.label,
      kind: node.kind,
      config: node.config,
      status: node.status,
      inputs: node.inputs,
      outputs: node.outputs,
      version: node.version,
      locked: node.locked,
    },
  }));
}

function toFlowEdges(graph: WorkflowGraph): Edge[] {
  return graph.edges.map((edge) => edgeWithRelation({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    data: { relation: edge.relation },
  }, edge.relation));
}

function edgeWithRelation(edge: Edge, relation: EdgeRelation): Edge {
  const presentation = edgeRelationPresentation(relation);
  return {
    ...edge,
    type: presentation.type,
    animated: presentation.animated,
    markerEnd: presentation.animated ? { type: 'arrowclosed' } : undefined,
    style: presentation.dashed ? { strokeDasharray: '5 5', opacity: 0.55 } : undefined,
    data: { ...(edge.data || {}), relation },
  };
}

function cloneEditorSnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as EditorSnapshot;
}

function cloneAssetBoardSnapshot(snapshot: AssetBoardEditorSnapshot): AssetBoardEditorSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as AssetBoardEditorSnapshot;
}

function editorSnapshot(nodes: FlowNode[], edges: Edge[]): EditorSnapshot {
  return cloneEditorSnapshot({ nodes, edges });
}

function fromFlow(graph: WorkflowGraph, nodes: FlowNode[], edges: Edge[]): WorkflowGraph {
  return {
    ...graph,
    nodes: nodes.map((node) => ({
      ...(node.parentId ? { config: { ...node.data.config, group_id: node.parentId } } : { config: Object.fromEntries(Object.entries(node.data.config).filter(([key]) => key !== 'group_id')) }),
      id: node.id,
      kind: node.data.kind,
      label: node.data.label,
      position: node.position,
      inputs: node.data.inputs,
      outputs: node.data.outputs,
      status: node.data.status,
      version: node.data.version,
      locked: node.data.locked,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      source_port: null,
      target_port: null,
      relation: (edge.data?.relation as 'execution' | 'reference' | 'lineage' | 'annotation') || 'execution',
    })),
  };
}

function HomeStatusBadge({ status }: { status: HomeStatus | string }) {
  return <span className={`home-status ${statusClass(status)}`}><i aria-hidden="true">{statusIcon(status)}</i>{statusLabel(status)}</span>;
}

function MetricCard({ label, value, detail, tone }: { label: string; value: string | number; detail: string; tone: 'content' | 'process' | 'asset' | 'execution' }) {
  return <article className={`home-metric metric-${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function ProjectHomeCard({ item, current, onSelect }: { item: ProjectHomeSummary; current: boolean; onSelect: () => void }) {
  return <button className={`home-project-card ${current ? 'current' : ''}`} onClick={onSelect} aria-pressed={current}>
    <div className="home-project-card-head"><strong>{item.name}</strong><HomeStatusBadge status={item.status} /></div>
    <div className="home-project-progress"><span><b style={{ width: `${item.progress.percent}%` }} /></span><em>{item.progress.percent}%</em></div>
    <div className="home-project-card-meta"><span>{item.current_stage_label || '尚未开始'}</span><span>{item.blocker_count ? `⛔ ${item.blocker_count}` : '无阻塞'}</span><span>{item.review_count ? `待审核 ${item.review_count}` : '审核清零'}</span></div>
    <small>{item.next_task?.title || '暂无待处理任务'}</small>
  </button>;
}

function HomeTaskRow({ task, primary, onOpen }: { task: DashboardTask; primary?: boolean; onOpen: () => void }) {
  return <button className={`home-task-row ${primary ? 'primary' : ''}`} onClick={onOpen}>
    <span className="home-task-index">{primary ? '→' : '•'}</span>
    <span className="home-task-copy"><strong>{task.title}</strong><small>{task.reason}</small></span>
    <span className="home-task-side"><em>{taskPriorityLabel(task.priority)}</em><b>进入 →</b></span>
  </button>;
}

function ProcessDetail({ stages, onOpen }: { stages: ProjectDashboard['stages']; onOpen: (stage: ProjectDashboard['stages'][number]) => void }) {
  return <details className="home-process-detail">
    <summary><span><small>PROFESSIONAL PIPELINE</small><strong>查看完整制作流程</strong></span><em>8 个阶段 · 状态实时推导</em></summary>
    <div className="home-stage-list">{stages.map((stage) => <button className={`home-stage-row ${statusClass(stage.status)}`} key={stage.id} onClick={() => onOpen(stage)}>
      <span className="home-stage-order">{String(stage.order).padStart(2, '0')}</span>
      <span className="home-stage-copy"><strong>{stage.label}</strong><small>{stage.reason}</small></span>
      <span className="home-stage-count">{stageProgress(stage)}</span>
      <HomeStatusBadge status={stage.status} />
      <b>进入 →</b>
    </button>)}</div>
  </details>;
}

function HomeView({ dashboard, error, currentProjectId, busy, onSelectProject, onOpenTask, onOpenStage, onRefresh }: {
  dashboard: DashboardEnvelope | null;
  error?: string;
  currentProjectId: string;
  busy: boolean;
  onSelectProject: (id: string) => void;
  onOpenTask: (task: DashboardTask) => void;
  onOpenStage: (stage: ProjectDashboard['stages'][number]) => void;
  onRefresh: () => void;
}) {
  const selected = dashboard?.selected_project || null;
  const metrics = selected?.metrics;
  if (error) return <section className="home-error"><span className="eyebrow">PROJECT COMMAND CENTER</span><h2>状态暂不可用</h2><p>{error}</p><button onClick={onRefresh} disabled={busy}>重试读取状态</button></section>;
  if (!dashboard) return <section className="home-loading"><span className="eyebrow">PROJECT COMMAND CENTER</span><h2>正在读取项目状态…</h2><p>首页会从故事、资产、运行和交付记录推导当前进度。</p></section>;
  return <section className="home-view">
    <header className="home-heading"><div><span className="eyebrow">PROJECT COMMAND CENTER</span><h1>项目首页</h1><p>先处理最重要的一步，再回到完整流程检查全局状态。</p></div><button className="home-refresh" onClick={onRefresh} disabled={busy}>↻ 刷新状态</button></header>
    <section className="home-project-strip"><div className="home-section-heading"><div><small>ALL PROJECTS</small><h2>我的项目</h2></div><span>{dashboard.projects.length} 个项目</span></div><div className="home-project-grid">{dashboard.projects.map((item) => <ProjectHomeCard key={item.project_id} item={item} current={item.project_id === currentProjectId} onSelect={() => onSelectProject(item.project_id)} />)}</div></section>
    {selected ? <>
      <section className="home-hero"><div className="home-hero-copy"><div className="home-project-title-line"><HomeStatusBadge status={selected.project.status} /><span>当前项目</span></div><h2>{selected.project.name}</h2><p>{selected.project.next_task?.reason || '当前项目的制作状态已同步。'}</p><div className="home-hero-specs"><span>{selected.project.ratio || '画幅未定'}</span><span>{selected.project.duration ? `${selected.project.duration}s` : '时长未定'}</span><span>{selected.project.generator || '模型未定'}</span><span>{selected.project.current_stage_label || '未开始'}</span></div></div><div className="home-hero-progress"><strong>{selected.project.progress.percent}<small>%</small></strong><span>生产进度</span><div><b style={{ width: `${selected.project.progress.percent}%` }} /></div></div></section>
      <section className="home-primary-grid"><div className="home-primary-action"><div className="home-section-heading"><div><small>PRIMARY NEXT STEP</small><h2>现在该做什么</h2></div><span>系统按阻塞和审批优先级排序</span></div>{selected.primary_next_task ? <HomeTaskRow task={selected.primary_next_task} primary onOpen={() => onOpenTask(selected.primary_next_task as DashboardTask)} /> : <div className="home-all-done"><strong>项目已完成</strong><span>所有阶段都已通过，可以进入交付复盘。</span></div>}</div><div className="home-activity"><div className="home-section-heading"><div><small>RECENT ACTIVITY</small><h2>最近活动</h2></div></div><div className="home-activity-list">{selected.recent_activity.length ? selected.recent_activity.slice(0, 4).map((activity) => <div className="home-activity-row" key={activity.id}><HomeStatusBadge status={activity.status} /><span>{activity.label}</span><small>{activity.created_at ? new Date(activity.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '刚刚'}</small></div>) : <p className="home-empty-inline">暂无运行记录。</p>}</div></div></section>
      <section className="home-metrics-grid"><MetricCard label="内容状态" value={`${metrics?.content.shot_count || 0} 镜头`} detail={`脚本 ${metrics?.content.script_length || 0} 字 · 完整 ${metrics?.content.complete_shots || 0}/${metrics?.content.shot_count || 0}`} tone="content" /><MetricCard label="流程状态" value={progressLabel(selected.project.progress)} detail={`${selected.project.current_stage_label || '没有进行中的阶段'} · 阻塞 ${selected.project.blocker_count}`} tone="process" /><MetricCard label="资产状态" value={`${metrics?.assets.ready || 0}/${metrics?.assets.total || 0} 就绪`} detail={`待审核 ${metrics?.assets.awaiting_review || 0} · 必需缺口 ${metrics?.assets.missing_required || 0}`} tone="asset" /><MetricCard label="执行状态" value={String(metrics?.execution.run_status || '暂无运行')} detail={`排队 ${metrics?.execution.queued || 0} · 运行 ${metrics?.execution.running || 0} · 待确认 ${metrics?.execution.awaiting_confirmation || 0}`} tone="execution" /></section>
      <section className="home-task-panel"><div className="home-section-heading"><div><small>UP NEXT</small><h2>后续任务</h2></div><span>按优先级排列 · 最多显示 6 项</span></div><div className="home-task-list">{selected.task_queue.length ? selected.task_queue.map((task) => <HomeTaskRow key={task.id} task={task} onOpen={() => onOpenTask(task)} />) : <p className="home-empty-inline">暂无其他任务。</p>}</div></section>
      <ProcessDetail stages={selected.stages} onOpen={onOpenStage} />
    </> : <div className="home-empty-state"><h2>请选择一个项目</h2><p>项目状态和下一步任务会显示在这里。</p></div>}
  </section>;
}

function TimelineView({ envelope, preflight, story, assetLibrary, renderJob, busy, onChange, onSave, onAssemble, onPreview, onRender }: { envelope: TimelineEnvelope | null; preflight: TimelinePreflight | null; story: StoryEnvelope | null; assetLibrary: AssetLibraryEnvelope | null; renderJob: RenderJob | null; busy: boolean; onChange: (document: TimelineDocument) => void; onSave: () => void; onAssemble: () => void; onPreview: () => void; onRender: () => void }) {
  const timeline = envelope?.document;
  const [selectedShotId, setSelectedShotId] = useState('');
  const [selectedClipId, setSelectedClipId] = useState('');
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [snapFrames, setSnapFrames] = useState<number>(() => { try { return Number(window.localStorage.getItem('frameflow.timeline.snap') || 10); } catch { return 10; } });
  const [zoom, setZoom] = useState<number>(() => { try { return Number(window.localStorage.getItem('frameflow.timeline.zoom') || 1); } catch { return 1; } });
  useEffect(() => { try { window.localStorage.setItem('frameflow.timeline.snap', String(snapFrames)); window.localStorage.setItem('frameflow.timeline.zoom', String(zoom)); } catch { /* local preference only */ } }, [snapFrames, zoom]);
  if (!timeline) return <div className="empty-state">正在读取时间线…</div>;

  const fallbackShots: TimelinePreflightShot[] = (story?.story.shots || []).map((shot, index) => ({ shot_id: shot.id, scene_id: String(shot.scene || ''), order: index + 1, duration: Number(shot.duration || 0), status: String(shot.status || 'ready'), clip_ids: [], artifact_ids: [], blockers: [], purpose: shot.purpose, camera: shot.camera, action: shot.action }));
  const shotRows: TimelinePreflightShot[] = preflight?.shots || fallbackShots;
  const shotById = new Map(shotRows.map((shot) => [shot.shot_id, shot]));
  const selectedShot = shotById.get(selectedShotId) || shotRows[0];
  const selectedClip = timeline.tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip }))).find(({ clip }) => clip.id === selectedClipId);
  const selectedShotClip = selectedShot ? timeline.tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip }))).find(({ clip }) => String(clip.metadata?.shot_id || '') === selectedShot.shot_id) : undefined;
  const activeClip = selectedClip || selectedShotClip;
  const timelineWidth = Math.max(900, Math.round(timeline.duration * 18 * zoom));
  const previewUrl = typeof renderJob?.result?.preview_url === 'string' ? renderJob.result.preview_url : '';
  const artifactUrl = (artifactId: string | null | undefined) => assetLibrary?.assets.flatMap((asset) => asset.artifacts || []).find((artifact) => String(artifact.id || artifact.artifact_id) === String(artifactId))?.url || '';
  const snap = (value: number) => { if (!snapFrames) return Math.max(0, value); const unit = snapFrames / timeline.fps; return Math.max(0, Math.round(value / unit) * unit); };
  const updateTimeline = (nextTracks: TimelineDocument['tracks']) => onChange({ ...timeline, tracks: nextTracks });
  const updateClip = (trackId: string, clipId: string, patch: Partial<TimelineClip>) => updateTimeline(timeline.tracks.map((track) => track.id === trackId ? { ...track, clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip) } : track));
  const removeClip = (trackId: string, clipId: string) => { if (selectedClipId === clipId) setSelectedClipId(''); updateTimeline(timeline.tracks.map((track) => track.id === trackId ? { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) } : track)); };
  const splitClip = (trackId: string, clip: TimelineClip) => {
    if (clip.duration < 0.2) return;
    const half = Math.round((clip.duration / 2) * timeline.fps) / timeline.fps;
    const second: TimelineClip = { ...clip, id: `${clip.id}:b`, start: Math.round((clip.start + half) * timeline.fps) / timeline.fps, duration: Math.max(0.1, Math.round((clip.duration - half) * timeline.fps) / timeline.fps), source_in: Math.round((clip.source_in + half * clip.speed) * timeline.fps) / timeline.fps };
    updateTimeline(timeline.tracks.map((track) => track.id === trackId ? { ...track, clips: [...track.clips.map((item) => item.id === clip.id ? { ...item, duration: half } : item), second] } : track));
  };
  const dropClip = (trackId: string, event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const targetTrack = timeline.tracks.find((track) => track.id === trackId);
    const rect = event.currentTarget.getBoundingClientRect();
    const raw = Math.max(0, Math.min(timeline.duration, ((event.clientX - rect.left) / Math.max(1, rect.width)) * timeline.duration));
    const shotPayload = event.dataTransfer.getData('application/frameflow-shot');
    if (shotPayload) {
      if (!targetTrack || !['video', 'overlay'].includes(targetTrack.kind) || targetTrack.locked) return;
      const [shotId, artifactId, durationValue] = shotPayload.split('|');
      if (!shotId || !artifactId) return;
      const duration = Math.max(0.033, Math.min(timeline.duration, Number(durationValue) || 1));
      const start = Math.min(snap(raw), Math.max(0, timeline.duration - duration));
      if (timeline.tracks.some((track) => track.clips.some((clip) => String(clip.metadata?.shot_id || '') === shotId))) return;
      const sourceShot = story?.story.shots.find((shot) => shot.id === shotId);
      const assetIds = Array.isArray(sourceShot?.assetRequirements) ? sourceShot.assetRequirements.map((item) => String((item as Record<string, unknown>).assetId || (item as Record<string, unknown>).asset_id || '')).filter(Boolean) : [];
      const next: TimelineClip = { id: `clip:${shotId}`, artifact_id: artifactId, start, duration, source_in: 0, speed: 1, volume: 1, fade_in: 0, fade_out: 0, metadata: { shot_id: shotId, scene_id: shotById.get(shotId)?.scene_id || null, source_role: 'approved_shot', asset_ids: assetIds, readiness: 'production', artifact_qa_decision: 'Approved' } };
      updateTimeline(timeline.tracks.map((track) => track.id === trackId ? { ...track, clips: [...track.clips, next] } : track));
      setSelectedShotId(shotId); setSelectedClipId(next.id);
      return;
    }
    const payload = event.dataTransfer.getData('application/frameflow-clip');
    if (!payload || targetTrack?.locked) return;
    const [sourceTrackId, clipId] = payload.split('|');
    const sourceTrack = timeline.tracks.find((track) => track.id === sourceTrackId);
    const clip = sourceTrack?.clips.find((item) => item.id === clipId);
    if (!clip) return;
    const start = Math.min(snap(raw), Math.max(0, timeline.duration - clip.duration));
    updateTimeline(timeline.tracks.map((track) => track.id === sourceTrackId ? { ...track, clips: track.clips.filter((item) => item.id !== clipId) } : track).map((track) => track.id === trackId ? { ...track, clips: [...track.clips.filter((item) => item.id !== clipId), { ...clip, start }] } : track));
  };
  const toggleTrack = (trackId: string, field: 'muted' | 'locked') => updateTimeline(timeline.tracks.map((track) => track.id === trackId ? { ...track, [field]: !track[field] } : track));
  const addCaption = () => {
    const track = timeline.tracks.find((item) => item.kind === 'captions') || timeline.tracks[timeline.tracks.length - 1];
    if (!track || track.locked) return;
    const start = activeClip?.clip.start || 0;
    const next: TimelineClip = { id: `caption-${Date.now()}`, start, duration: Math.min(3, timeline.duration - start), source_in: 0, speed: 1, volume: 1, fade_in: 0, fade_out: 0, metadata: { text: '双击编辑字幕', shot_id: selectedShot?.shot_id || null } };
    updateTimeline(timeline.tracks.map((item) => item.id === track.id ? { ...item, clips: [...item.clips, next] } : item));
    setSelectedClipId(next.id);
  };
  const statusLabel = (status: string) => ({ ready: '可入镜', approved: '已批准', partial: '部分就绪', blocked: '阻塞', missing: '缺失' }[status] || status);
  const groupedShots = shotRows.reduce<Record<string, typeof shotRows>>((groups, shot) => { const key = shot.scene_id || '未分场'; (groups[key] ||= []).push(shot); return groups; }, {});
  const inspectorShot = selectedShot ? story?.story.shots.find((shot) => shot.id === selectedShot.shot_id) : undefined;
  const selectedCaption = activeClip?.track.kind === 'captions' ? String(activeClip.clip.metadata?.text || '') : '';
  const renderBlocked = Boolean(preflight && !preflight.summary.delivery_ready);
  return (
    <section className="timeline-view timeline-v2">
      <header className="timeline-v2-header">
        <div className="timeline-v2-title"><span>DELIVERY CONTROL ROOM · v{envelope?.revision || 0}</span><h1>最终整合与交付</h1><p>{timeline.width}×{timeline.height} · {timeline.fps} FPS · {timeline.duration}s {preflight ? (preflight.summary.delivery_ready ? '· 可交付' : `· ${preflight.summary.error_count} 个交付阻塞`) : ''}</p></div>
        <div className="timeline-v2-actions"><button onClick={onAssemble} disabled={busy}>同步生产结果</button><button onClick={addCaption} disabled={busy}>添加字幕</button><button onClick={onPreview} disabled={busy || !timeline.tracks.some((track) => track.kind === 'video' && track.clips.length)}>生成预览</button><button onClick={onSave} disabled={busy}>{envelope && '保存时间线'}</button><button className="run-button" onClick={() => { setDeliveryOpen(true); if (!renderBlocked) void onRender(); }} disabled={busy || renderBlocked}>创建交付包</button></div>
      </header>
      <div className="timeline-status-grid"><div><small>镜头整合</small><strong>{preflight?.summary.shot_placed || 0}<em>/{preflight?.summary.shot_total || shotRows.length}</em></strong><span>{preflight?.summary.shot_ready || 0} 个镜头可入镜</span></div><div><small>资产生产</small><strong>{preflight?.asset_summary?.production_ready || assetLibrary?.summary.production_ready || 0}<em>/{preflight?.asset_summary?.total || assetLibrary?.summary.total || 0}</em></strong><span>production-ready</span></div><div><small>音频片段</small><strong>{preflight?.summary.audio_ready || 0}</strong><span>{preflight?.summary.audio_ready ? '已登记可用' : '对白/配乐待生产'}</span></div><div className={renderBlocked ? 'blocked' : 'ready'}><small>交付预检</small><strong>{renderBlocked ? preflight?.summary.error_count || '—' : 'OK'}</strong><span>{renderBlocked ? '解决阻塞后可导出' : '主片 / Clean / SRT'}</span></div></div>
      <div className="timeline-control-strip"><span>工作视角 <b>镜头优先 · 多轨补充</b></span><label>吸附 <select value={snapFrames} onChange={(event) => setSnapFrames(Number(event.target.value))}><option value="10">10 帧</option><option value="1">逐帧</option><option value="0">关闭</option></select></label><label>缩放 <input type="range" min="0.6" max="2.4" step="0.1" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label><button onClick={() => setDeliveryOpen((value) => !value)}>{deliveryOpen ? '关闭交付检查' : '打开交付检查'}</button></div>
      <div className="timeline-v2-layout">
        <aside className="timeline-shot-panel" aria-label="Shot sequence"><div className="timeline-panel-heading"><div><small>SHOT SEQUENCE</small><h2>镜头序列</h2></div><span>{shotRows.length} 镜头</span></div><div className="timeline-shot-list">{Object.entries(groupedShots).map(([sceneId, rows]) => <section key={sceneId} className="timeline-scene-group"><div className="timeline-scene-heading"><b>{sceneId}</b><span>{rows.length} shots</span></div>{rows.map((shot) => <button className={`timeline-shot-row ${selectedShot?.shot_id === shot.shot_id ? 'active' : ''} ${shot.blockers.length ? 'blocked' : ''}`} key={shot.shot_id} draggable={Boolean(shot.artifact_ids[0])} onDragStart={(event) => event.dataTransfer.setData('application/frameflow-shot', `${shot.shot_id}|${shot.artifact_ids[0] || ''}|${shot.duration}`)} onClick={() => { setSelectedShotId(shot.shot_id); setSelectedClipId(shot.clip_ids[0] || ''); }}><span className="timeline-shot-number">{String(shot.order).padStart(2, '0')}</span><span className="timeline-shot-copy"><strong>{shot.shot_id}</strong><small>{shot.purpose || '未填写镜头目的'}</small></span><span className={`timeline-shot-status ${shot.blockers.length ? 'blocked' : shot.status}`}>{shot.blockers.length ? '阻塞' : statusLabel(shot.status)}</span></button>)}</section>)}</div></aside>
        <div className="timeline-editor-main">
          <section className="timeline-preview-panel"><div className="timeline-preview-screen">{previewUrl ? <video src={previewUrl} controls preload="metadata" /> : activeClip && artifactUrl(activeClip.clip.artifact_id) ? <video src={artifactUrl(activeClip.clip.artifact_id)} controls preload="metadata" /> : <div className="timeline-preview-empty"><span>FRAMEFLOW PREVIEW</span><strong>{activeClip ? '当前片段尚无可播放 artifact' : '从镜头序列选择一个镜头'}</strong><small>{activeClip ? '完成视频生成、QA 和登记后，这里会显示单镜头预览。' : '整片预览会在生成预览后显示。'}</small></div>}</div><div className="timeline-preview-meta"><div><small>{selectedShot?.scene_id || '未选择场景'} · {selectedShot?.shot_id || '未选择镜头'}</small><strong>{selectedShot?.purpose || '选择镜头查看生产结果和预览'}</strong></div><span>{previewUrl ? '整片代理预览' : activeClip ? '当前片段' : '等待选择'}</span></div></section>
          <section className="timeline-track-editor"><div className="timeline-ruler-row"><div className="timeline-track-spacer">时间线</div><div className="timeline-ruler-scroll" tabIndex={0} aria-label="时间线刻度滚动区"><div className="timeline-ruler" style={{ minWidth: timelineWidth }}>{Array.from({ length: Math.max(9, Math.ceil(timeline.duration / 10) + 1) }, (_, index) => <span key={index} style={{ left: `${Math.min(100, index * 10 / timeline.duration * 100)}%` }}>{Math.min(timeline.duration, index * 10).toFixed(0)}s</span>)}</div></div></div><div className="timeline-track-list">{timeline.tracks.map((track) => <div className={`timeline-track-row ${track.muted ? 'muted' : ''}`} key={track.id}><div className="timeline-track-label"><strong>{track.name}</strong><small>{track.kind}</small><div><button aria-label={`${track.name}静音`} onClick={() => toggleTrack(track.id, 'muted')}>{track.muted ? '静音' : '音量'}</button><button aria-label={`${track.name}锁定`} onClick={() => toggleTrack(track.id, 'locked')}>{track.locked ? '解锁' : '锁定'}</button></div></div><div className="timeline-lane-scroll"><div className={`timeline-lane timeline-lane-${track.kind}`} style={{ minWidth: timelineWidth }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropClip(track.id, event)}>{track.clips.length ? track.clips.map((clip) => { const left = `${Math.max(0, Math.min(100, clip.start / timeline.duration * 100))}%`; const width = `${Math.max(2.2, Math.min(100 - Number(left.replace('%', '')), clip.duration / timeline.duration * 100))}%`; const captionText = typeof clip.metadata?.text === 'string' ? clip.metadata.text : clip.metadata?.shot_id || clip.artifact_id || clip.id; const shotId = String(clip.metadata?.shot_id || ''); return <article className={`timeline-clip timeline-clip-v2 ${selectedClipId === clip.id ? 'selected' : ''} ${shotId && shotById.get(shotId)?.blockers.length ? 'clip-blocked' : ''}`} draggable={!busy && !track.locked} onClick={(event) => { event.stopPropagation(); setSelectedClipId(clip.id); if (shotId) setSelectedShotId(shotId); }} onDragStart={(event) => event.dataTransfer.setData('application/frameflow-clip', `${track.id}|${clip.id}`)} style={{ left, width }} key={clip.id} title={String(captionText)}><b>{String(captionText)}</b><small>{clip.start.toFixed(1)}s · {clip.duration.toFixed(1)}s</small></article>; }) : <span className="timeline-lane-empty">{track.kind === 'video' ? '同步批准镜头后，主视频会出现在这里' : '等待生产结果或手动添加片段'}</span>}</div></div></div>)}</div></section>
          <div className="timeline-bottom-hint"><span>拖动片段调整顺序，默认按 {snapFrames ? `${snapFrames} 帧` : '自由'} 吸附。</span><span>{preflight?.summary.warning_count || 0} 个警告 · 所有保存生成新的 revision</span></div>
        </div>
        <aside className="timeline-inspector"><div className="timeline-panel-heading"><div><small>INSPECTOR</small><h2>{activeClip ? '片段检查器' : '镜头检查器'}</h2></div><span>{activeClip?.track.kind || selectedShot?.shot_id || '—'}</span></div>{activeClip ? <div className="timeline-inspector-fields"><div className="timeline-inspector-source"><small>当前来源</small><strong>{String(activeClip.clip.metadata?.shot_id || activeClip.clip.artifact_id || activeClip.clip.id)}</strong><span>{activeClip.track.name}</span></div><label>起始<input type="number" min="0" step="0.033" value={activeClip.clip.start} onChange={(event) => updateClip(activeClip.track.id, activeClip.clip.id, { start: Math.max(0, Math.min(timeline.duration - activeClip.clip.duration, Number(event.target.value) || 0)) })} /></label><label>时长<input type="number" min="0.033" step="0.033" value={activeClip.clip.duration} onChange={(event) => updateClip(activeClip.track.id, activeClip.clip.id, { duration: Math.max(0.033, Math.min(timeline.duration - activeClip.clip.start, Number(event.target.value) || 0.033)) })} /></label><label>源内点<input type="number" min="0" step="0.033" value={activeClip.clip.source_in} onChange={(event) => updateClip(activeClip.track.id, activeClip.clip.id, { source_in: Math.max(0, Number(event.target.value) || 0) })} /></label><label>速度<input type="number" min="0.1" max="16" step="0.1" value={activeClip.clip.speed} onChange={(event) => updateClip(activeClip.track.id, activeClip.clip.id, { speed: Math.max(0.1, Number(event.target.value) || 1) })} /></label>{activeClip.track.kind !== 'captions' && <label>音量<input type="number" min="0" max="4" step="0.1" value={activeClip.clip.volume} onChange={(event) => updateClip(activeClip.track.id, activeClip.clip.id, { volume: Math.max(0, Number(event.target.value) || 0) })} /></label>}{activeClip.track.kind === 'captions' && <label>字幕文本<textarea value={selectedCaption} onChange={(event) => updateClip(activeClip.track.id, activeClip.clip.id, { metadata: { ...activeClip.clip.metadata, text: event.target.value } })} /></label>}<label>转场<select value={activeClip.clip.transition || ''} onChange={(event) => updateClip(activeClip.track.id, activeClip.clip.id, { transition: event.target.value || null })}><option value="">直切</option><option value="dissolve">叠化</option><option value="fade">淡入淡出</option></select></label><div className="timeline-inspector-actions"><button onClick={() => splitClip(activeClip.track.id, activeClip.clip)} disabled={busy || activeClip.track.locked}>分割</button><button className="danger" onClick={() => removeClip(activeClip.track.id, activeClip.clip.id)} disabled={busy || activeClip.track.locked}>删除</button></div></div> : selectedShot ? <div className="timeline-shot-inspector"><div className="timeline-inspector-source"><small>{selectedShot.scene_id} · {selectedShot.shot_id}</small><strong>{selectedShot.purpose || '镜头目的未填写'}</strong><span>{selectedShot.duration}s · {selectedShot.camera || '机位未填写'}</span></div><p>{selectedShot.action || '动作描述未填写。'}</p><div className="timeline-inspector-checks"><span className={selectedShot.blockers.length ? 'blocked' : 'ready'}>视频：{selectedShot.blockers.length ? '待解决' : '可入镜'}</span><span>资产：{selectedShot.artifact_ids.length ? `${selectedShot.artifact_ids.length} 个 artifact` : '待关联'}</span><span>对白：{String((inspectorShot as Record<string, any> | undefined)?.dialogue || '未配置')}</span></div>{selectedShot.blockers.length ? <div className="timeline-blocker-list">{selectedShot.blockers.map((blocker) => <div key={`${blocker.code}-${blocker.source}`}><b>{blocker.code}</b><span>{blocker.message}</span></div>)}</div> : <div className="timeline-inspector-ok">该镜头已通过当前时间线预检，可以进入整合。</div>}</div> : <div className="timeline-inspector-empty">选择一个镜头或片段查看详情。</div>}</aside>
      </div>
      {deliveryOpen && <section className="timeline-delivery-panel"><div><small>DELIVERY PREFLIGHT</small><h2>交付检查</h2><p>{renderBlocked ? '当前仍有阻塞，解决后才能创建正式交付包。' : '时间线已通过交付预检，可以创建多版本交付包。'}</p></div><div className="timeline-delivery-checks"><span className={preflight?.deliverables.master_burn_in === 'ready' ? 'ready' : 'blocked'}>主片烧录字幕 · {preflight?.deliverables.master_burn_in || '检查中'}</span><span className={preflight?.deliverables.clean === 'ready' ? 'ready' : 'blocked'}>Clean 无字幕 · {preflight?.deliverables.clean || '检查中'}</span><span className="ready">SRT 字幕文件 · {preflight?.deliverables.srt || 'ready'}</span></div><div className="timeline-delivery-actions"><button onClick={onPreview} disabled={busy}>生成 540p 代理预览</button><button className="run-button" onClick={onRender} disabled={busy || renderBlocked}>创建交付作业</button></div></section>}
    </section>
  );
}

function AssetLibraryView({ library, focusAssetId, busy, onRefresh, onSave, onFusionGate, onReview }: {
  library: AssetLibraryEnvelope | null;
  focusAssetId?: string;
  busy: boolean;
  onRefresh: () => void;
  onSave: (assetId: string, body: Record<string, unknown>) => void;
  onFusionGate: (assetId: string) => void;
  onReview: (assetId: string, comparisonId: string, candidateArtifactId: string) => void;
}) {
  const assets = library?.assets || [];
  const [selectedId, setSelectedId] = useState('');
  const selected = assets.find((asset) => asset.id === selectedId) || assets[0];
  const [draft, setDraft] = useState({
    assetClass: '', grade: 'B', usageRoles: '', identityAnchors: '{}', assetSpec: '{}', source: '', license: '', authorizationStatus: '', prompt: '', references: '', dependencies: '', fusionSources: '', protectedRegions: '',
  });
  useEffect(() => {
    if (!selected) return;
    const metadata = selected.assetMetadata || {};
    setSelectedId(selected.id);
    setDraft({
      assetClass: selected.assetClass || '', grade: selected.grade || 'B', usageRoles: Array.isArray(metadata.usage_roles || selected.usageRoles) ? (metadata.usage_roles || selected.usageRoles).join(', ') : '',
      identityAnchors: JSON.stringify(metadata.identity_anchors || selected.identityAnchors || {}, null, 2), assetSpec: JSON.stringify(metadata.asset_spec || selected.assetSpec || {}, null, 2), source: String(metadata.source || selected.source || ''), license: String(metadata.license || selected.license || ''), authorizationStatus: String(metadata.authorization_status || selected.authorizationStatus || ''), prompt: String(selected.prompt || ''),
      references: (selected.references || []).map((item) => `${item.reference_id}|${item.role}|${item.source || 'project'}|${item.notes || ''}`).join('\n'), dependencies: (selected.dependencies || []).map((item) => `${item.dependency_asset_id}|${item.shot_id || ''}|${item.role || ''}`).join('\n'), fusionSources: Array.isArray(selected.fusionSourceAssetIds) ? selected.fusionSourceAssetIds.join(', ') : '', protectedRegions: Array.isArray(selected.protectedRegions) ? selected.protectedRegions.join(', ') : '',
    });
  }, [selected?.id]);
  useEffect(() => {
    if (focusAssetId && assets.some((asset) => asset.id === focusAssetId)) setSelectedId(focusAssetId);
  }, [focusAssetId, library?.project_id]);
  if (!library) return <div className="empty-state">正在读取统一资产库…</div>;
  if (!assets.length) return <section className="asset-library"><header className="section-heading"><div><span>UNIFIED ASSET LIBRARY</span><h2>统一资产库</h2></div><button onClick={onRefresh}>刷新</button></header><div className="empty-state">当前项目还没有逻辑资产。</div></section>;
  const parseJson = (value: string) => { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; } };
  const save = () => onSave(selected.id, {
    asset_class: draft.assetClass, grade: draft.grade, usage_roles: draft.usageRoles.split(',').map((item) => item.trim()).filter(Boolean), identity_anchors: parseJson(draft.identityAnchors), asset_spec: parseJson(draft.assetSpec), prompt: draft.prompt, source: draft.source, license: draft.license, authorization_status: draft.authorizationStatus, protected_regions: draft.protectedRegions.split(',').map((item) => item.trim()).filter(Boolean), fusion_source_asset_ids: draft.fusionSources.split(',').map((item) => item.trim()).filter(Boolean), references: draft.references.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => { const [reference_id, role, source = 'project', notes = ''] = line.split('|'); return { reference_id, role, source, notes }; }), shot_dependencies: draft.dependencies.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => { const [dependency_asset_id, shot_id = '', role = ''] = line.split('|'); return { dependency_asset_id, shot_id: shot_id || null, role, relation: 'requires', required: true }; }), });
  return (
    <section className="asset-library">
      <header className="section-heading"><div><span>UNIFIED ASSET LIBRARY</span><h2>统一资产与素材融合</h2></div><div className="story-heading-actions"><p>{library.summary.ready}/{library.summary.total} 已登记 · {library.summary.missing_required_a} 个 A 级待处理</p><button onClick={onRefresh} disabled={busy}>刷新</button><button onClick={save} disabled={busy}>保存资产规格</button></div></header>
      <div className="asset-summary"><span>资产 {library.summary.total}</span><span className="ready">就绪 {library.summary.ready}</span><span className="blocked">阻塞 {library.summary.blocked}</span><span>融合节点 {assets.filter((asset) => asset.assetClass === 'fusion').length}</span></div>
      <div className="asset-library-layout">
        <aside className="asset-list">{assets.map((asset) => <button key={asset.id} className={asset.id === selected.id ? 'asset-list-item active' : 'asset-list-item'} onClick={() => setSelectedId(asset.id)}><b>{asset.id}</b><span>{asset.name || asset.id}</span><i className={asset.readiness.status}>{asset.readiness.status}</i><small>{asset.assetClass} · {asset.grade || 'B'}</small></button>)}</aside>
        <div className="asset-detail">
          <div className="asset-detail-heading"><div><span>{selected.assetClass.toUpperCase()}</span><h3>{selected.id} · {selected.name || '未命名资产'}</h3></div><b className={`readiness-badge ${selected.readiness.status}`}>{selected.readiness.status}</b></div>
          <div className="asset-form-grid"><label>资产类别<input value={draft.assetClass} onChange={(event) => setDraft({ ...draft, assetClass: event.target.value })} /></label><label>等级<select value={draft.grade} onChange={(event) => setDraft({ ...draft, grade: event.target.value })}><option>A+</option><option>A</option><option>B</option><option>C</option><option>optional</option><option>Reject</option></select></label><label>用途角色<input value={draft.usageRoles} onChange={(event) => setDraft({ ...draft, usageRoles: event.target.value })} placeholder="identity, continuity" /></label><label>来源<input value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value })} /></label><label>许可证/授权<input value={draft.license} onChange={(event) => setDraft({ ...draft, license: event.target.value })} /></label><label>授权状态<input value={draft.authorizationStatus} onChange={(event) => setDraft({ ...draft, authorizationStatus: event.target.value })} placeholder="cleared / pending" /></label></div>
          <label className="asset-wide-field">身份锚点 JSON<textarea value={draft.identityAnchors} onChange={(event) => setDraft({ ...draft, identityAnchors: event.target.value })} /></label><label className="asset-wide-field">资产生产规格 JSON（场景空间/时间/天气/机位，道具形状/材质/比例/文字，产品保护区域等）<textarea value={draft.assetSpec} onChange={(event) => setDraft({ ...draft, assetSpec: event.target.value })} /></label><label className="asset-wide-field">Prompt<textarea value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} /></label>
          <label className="asset-wide-field">引用角色（每行：引用 ID | identity/outfit/action/composition/scene_structure/style/lighting/product_structure | 来源 | 备注）<textarea value={draft.references} onChange={(event) => setDraft({ ...draft, references: event.target.value })} /></label><label className="asset-wide-field">镜头依赖（每行：资产 ID | 镜头 ID | 依赖角色）<textarea value={draft.dependencies} onChange={(event) => setDraft({ ...draft, dependencies: event.target.value })} /></label>
          {selected.assetClass === 'fusion' && <div className="fusion-gate-card"><div><strong>Fusion Production Gate</strong><p>{selected.fusionGate?.message || '尚未检查融合基础资产。'}</p>{selected.fusionGate?.missing_sources?.length ? <small>缺失基础资产：{selected.fusionGate.missing_sources.map((item) => String(item.asset_id)).join(', ')}</small> : null}</div><button onClick={() => onFusionGate(selected.id)} disabled={busy}>检查融合门</button></div>}
          <div className="asset-history"><h4>版本与候选对比</h4>{selected.versions?.length ? <div className="version-row"><span>当前版本 AV · {selected.versions.find((item: Record<string, unknown>) => item.is_active)?.version || '—'}</span><small>{selected.versions.length} 个历史版本保留</small></div> : <p className="muted">尚无登记版本；计划状态不会解锁融合。</p>}{selected.comparisons?.map((comparison) => <details key={comparison.id}><summary>{comparison.comparison_group} · {comparison.strategy} · {comparison.candidates.length} 候选</summary>{comparison.candidates.map((candidate) => <div className="candidate-line" key={candidate.artifact_id}><span>{candidate.artifact_id} · {candidate.score ?? '未评分'} · {candidate.comment || '无批注'}</span><button onClick={() => onReview(selected.id, comparison.id, candidate.artifact_id)} disabled={busy || candidate.decision === 'Approved'}>{candidate.decision === 'Approved' ? '已批准' : '批准候选'}</button></div>)}</details>)}</div>
        </div>
      </div>
    </section>
  );
}

function AssetLibraryViewV3({ library, focusAssetId, busy, scope = 'all', filter = 'all', search = '', sort = 'priority', audit, onScopeChange, onFilterChange, onSearchChange, onSortChange, onRefresh, onSave, onFusionGate, onReview, onCreateAsset, onOpenImport, onRefreshAudit, onManualProductionApproval, onDeleteAsset, onStartQa, onSubmitQa, onRegisterArtifact }: {
  library: AssetLibraryEnvelope | null;
  focusAssetId?: string;
  busy: boolean;
  scope?: AssetLibraryScope;
  filter?: AssetLibraryFilter;
  search?: string;
  sort?: AssetSort;
  audit?: { counts: Record<string, number>; total: number } | null;
  onScopeChange?: (value: AssetLibraryScope) => void;
  onFilterChange?: (value: AssetLibraryFilter) => void;
  onSearchChange?: (value: string) => void;
  onSortChange?: (value: AssetSort) => void;
  onRefresh: () => void;
  onSave: (assetId: string, body: Record<string, unknown>) => void;
  onFusionGate: (assetId: string) => void;
  onReview: (assetId: string, comparisonId: string, candidateArtifactId: string) => void;
  onCreateAsset?: () => void;
  onOpenImport?: () => void;
  onRefreshAudit?: () => void;
  onManualProductionApproval?: (assetId: string, approved: boolean, reason: string, artifactId: string) => void;
  onDeleteAsset?: (assetId: string, label: string) => void;
  onStartQa?: (artifactId: string, qaType: AssetQaType) => void | Promise<void>;
  onSubmitQa?: (artifactId: string, qaType: AssetQaType, decision: AssetQaDecision, report: string, checklist?: Record<string, boolean>) => void | Promise<void>;
  onRegisterArtifact?: (artifactId: string, replaceActive: boolean) => void | Promise<void>;
}) {
  const assets = library?.assets || [];
  const auditAssetIds = new Set((audit as AssetAuditEnvelope | null)?.items?.map((item) => String(item.asset?.id || '')) || []);
  const scopedAssets = assets.filter((asset) => assetMatchesScope(asset, scope));
  const visibleAssets = library ? filterAssets(library, filter, search, sort, scope, auditAssetIds) : [];
  const bucketCounts = scopedAssets.reduce<Record<string, number>>((counts, asset) => { const bucket = assetStatusBucket(asset, auditAssetIds); counts[bucket] = (counts[bucket] || 0) + 1; return counts; }, {});
  const [selectedId, setSelectedId] = useState('');
  const [formError, setFormError] = useState('');
  const [inspectorTab, setInspectorTab] = useState<AssetInspectorTab>('overview');
  const [manualReviewOpen, setManualReviewOpen] = useState(false);
  const [manualReviewReason, setManualReviewReason] = useState('');
  const [qaArtifact, setQaArtifact] = useState<Record<string, any> | null>(null);
  const [qaDecision, setQaDecision] = useState<AssetQaDecision>('Approved');
  const [qaReport, setQaReport] = useState('');
  const [qaChecks, setQaChecks] = useState<Record<string, boolean>>({});
  const [registerArtifact, setRegisterArtifact] = useState<Record<string, any> | null>(null);
  const [replaceActive, setReplaceActive] = useState(false);
  const selected = visibleAssets.find((asset) => asset.id === selectedId) || visibleAssets[0] || assets.find((asset) => asset.id === selectedId) || assets[0];
  const [draft, setDraft] = useState({ assetClass: '', grade: 'B', usageRoles: '', identityAnchors: '{}', assetSpec: '{}', source: '', license: '', authorizationStatus: '', prompt: '', references: '', dependencies: '', fusionSources: '', protectedRegions: '' });
  useEffect(() => { if (focusAssetId && assets.some((asset) => asset.id === focusAssetId)) setSelectedId(focusAssetId); }, [focusAssetId, library?.project_id]);
  useEffect(() => {
    if (!selectedId || !visibleAssets.length || visibleAssets.some((asset) => asset.id === selectedId)) return;
    setSelectedId(visibleAssets[0].id);
  }, [scope, filter, search, sort, library?.project_id, visibleAssets.length]);
  useEffect(() => {
    setInspectorTab('overview');
    setManualReviewOpen(false);
    setManualReviewReason('');
    setQaArtifact(null);
    setRegisterArtifact(null);
    setReplaceActive(false);
  }, [selected?.id]);
  useEffect(() => {
    const tablist = document.querySelector<HTMLElement>('.asset-inspector-tabs');
    if (!tablist) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
      const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
      if (currentIndex < 0 || !tabs.length) return;
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (currentIndex + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + tabs.length) % tabs.length;
      event.preventDefault();
      tabs[nextIndex].focus();
      tabs[nextIndex].click();
    };
    tablist.addEventListener('keydown', onKeyDown);
    return () => tablist.removeEventListener('keydown', onKeyDown);
  }, [selected?.id, inspectorTab]);
  useEffect(() => {
    if (!selected) return;
    const metadata = selected.assetMetadata || {};
    setSelectedId((current) => current || selected.id);
    setDraft({
      assetClass: selected.assetClass || '', grade: selected.grade || 'B',
      usageRoles: Array.isArray(metadata.usage_roles || selected.usageRoles) ? (metadata.usage_roles || selected.usageRoles).join(', ') : '',
      identityAnchors: JSON.stringify(metadata.identity_anchors || selected.identityAnchors || {}, null, 2),
      assetSpec: JSON.stringify(metadata.asset_spec || selected.assetSpec || {}, null, 2),
      source: String(metadata.source || selected.source || ''), license: String(metadata.license || selected.license || ''),
      authorizationStatus: String(metadata.authorization_status || selected.authorizationStatus || ''), prompt: String(selected.prompt || ''),
      references: (selected.references || []).map((item) => `${item.reference_id}|${item.role}|${item.source || 'project'}|${item.notes || ''}`).join('\n'),
      dependencies: (selected.dependencies || []).map((item) => `${item.dependency_asset_id}|${item.shot_id || ''}|${item.role || ''}`).join('\n'),
      fusionSources: Array.isArray(selected.fusionSourceAssetIds) ? selected.fusionSourceAssetIds.join(', ') : '',
      protectedRegions: Array.isArray(selected.protectedRegions) ? selected.protectedRegions.join(', ') : '',
    });
    setFormError('');
  }, [selected?.id]);
  useEffect(() => {
    if (!focusAssetId || selected?.id !== focusAssetId) return;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('.studio-content')?.scrollTo({ top: 0, behavior: 'auto' });
      document.querySelector<HTMLElement>(`[data-asset-list-id="${CSS.escape(focusAssetId)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      const detail = document.querySelector<HTMLElement>('.asset-detail-v3');
      detail?.scrollTo({ top: 0, behavior: 'auto' });
      document.querySelector<HTMLElement>('.asset-detail-heading')?.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusAssetId, selected?.id]);
  if (!library) return <div className="empty-state">正在读取统一资产库…</div>;
  const update = (patch: Partial<typeof draft>) => setDraft((current) => ({ ...current, ...patch }));
  const save = () => {
    const anchors = parseJsonObject(draft.identityAnchors, '身份锚点');
    if (anchors.error) { setFormError(anchors.error); return; }
    const spec = parseJsonObject(draft.assetSpec, '资产生产规格');
    if (spec.error) { setFormError(spec.error); return; }
    setFormError('');
    onSave(selected.id, {
      asset_class: draft.assetClass, grade: draft.grade,
      usage_roles: draft.usageRoles.split(',').map((item) => item.trim()).filter(Boolean), identity_anchors: anchors.value, asset_spec: spec.value,
      prompt: draft.prompt, source: draft.source, license: draft.license, authorization_status: draft.authorizationStatus,
      protected_regions: draft.protectedRegions.split(',').map((item) => item.trim()).filter(Boolean), fusion_source_asset_ids: draft.fusionSources.split(',').map((item) => item.trim()).filter(Boolean),
      references: draft.references.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => { const [reference_id, role, source = 'project', notes = ''] = line.split('|'); return { reference_id, role, source, notes }; }),
      shot_dependencies: draft.dependencies.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => { const [dependency_asset_id, shot_id = '', role = ''] = line.split('|'); return { dependency_asset_id, shot_id: shot_id || null, role, relation: 'requires', required: true }; }),
    });
  };
  const readiness = selected?.readiness;
  const currentArtifact = selected?.artifacts?.find((artifact: Record<string, any>) => artifact.id === selected.artifactId) || selected?.artifacts?.find((artifact: Record<string, any>) => artifact.collection === 'qualified') || selected?.artifacts?.[0];
  const promptVersions = Array.isArray(selected?.promptVersions) ? selected.promptVersions : [];
  const productionReadyCount = visibleAssets.filter((asset) => asset.readiness.production_ready).length;
   const hasActiveFilters = scope !== 'all' || Boolean(search.trim()) || filter !== 'all' || sort !== 'priority';
  const clearAssetFilters = () => {
    onScopeChange?.('all');
    onSearchChange?.('');
    onFilterChange?.('all');
    onSortChange?.('priority');
  };
  const selectedWorkflow = selected?.workflow;
  const formatProductionBlocker = (item: string) => {
    const normalized = item.replace(/^registered:/, '');
    if (productionStatusLabels[normalized]) return productionStatusLabels[normalized];
    if (normalized === 'project_file') return '缺少项目文件';
    if (normalized === 'generated_image_qa') return '待图片 QA';
    if (normalized === 'asset_registration') return '待登记资产版本';
    return normalized;
  };
  const readinessReason = !readiness?.production_ready
    ? selectedWorkflow?.kind === 'reference'
      ? '仅参考素材，不可进入正式时间线'
      : (readiness?.production_missing || []).map(formatProductionBlocker).filter(Boolean).slice(0, 3).join(' · ')
        || (readiness?.status === 'blocked' ? 'QA 或文件门禁已阻塞' : readiness?.registered_ready ? '已登记，仍需完成入镜门禁' : '尚未登记资产版本')
    : '';
  const openQa = (artifact: Record<string, any>) => {
    const qaType = String(artifact.metadata?.qa_type || selectedWorkflow?.qa_type || (String(artifact.mime_type || '').startsWith('video/') ? 'video' : 'image')) as AssetQaType;
    setQaArtifact({ ...artifact, __qaType: qaType });
    setQaDecision('Approved');
    setQaReport('');
    setQaChecks({});
  };
  const artifactActionLabel = (artifact: Record<string, any>) => {
    const state = String(artifact.status || '');
    const qaType = String(artifact.metadata?.qa_type || (String(artifact.mime_type || '').startsWith('video/') ? 'video' : selectedWorkflow?.qa_type || 'image'));
    if (state === 'approved_pending_registration') return '登记为资产版本';
    if (state === 'qa_in_progress') return '打开 QA 审核';
    if (state === 'reference') return '仅参考 · 不可入镜';
    if (['generated_pending_qa', 'reference_pending_review', 'audit_blocked', 'revision_required'].includes(state)) return qaType === 'reference' ? '开始参考审核' : `开始${qaType === 'video' ? '视频' : qaType === 'audio' ? '声音' : '图片'} QA`;
    return '查看状态';
  };
  const qaChecklist = [
    ['file_playable', '文件可播放'], ['duration_target', '时长符合镜头目标'], ['technical_format', '分辨率 / FPS / 编码正确'],
    ['first_last_frame', '首帧与尾帧完整'], ['content_match', '内容符合镜头描述'], ['continuity', '角色 / 场景 / 融合连续'],
    ['visual_artifacts', '无闪烁、变形、跳帧或水印'], ['av_sync', '有声音时声画同步'], ['lineage_complete', '来源、生成 ID、项目归属完整'],
  ] as const;
  const qaChecklistReady = qaChecklist.every(([key]) => qaChecks[key] === true);
  return <section className="asset-library asset-library-v3">
    <header className="section-heading"><div><span>UNIFIED ASSET LIBRARY · V3</span><h2>统一资产与素材融合</h2><p className="asset-subtitle">库视图与资产生产工作区共享登记、候选、QA、版本和镜头依赖。</p></div><div className="story-heading-actions"><p>{scopedAssets.length} 项资产 · {bucketCounts.registered || 0} 已登记 · {bucketCounts.production || 0} 可入镜</p><button onClick={onCreateAsset} disabled={busy}>＋ 新建逻辑资产</button><button onClick={onRefresh} disabled={busy}>刷新</button><button onClick={onOpenImport} disabled={busy}>导入候选</button><button onClick={save} disabled={busy || !selected}>保存规格</button></div></header>
    {library.storage_integrity?.ok === false && <div className="asset-integrity-warning" role="status"><strong>项目文件一致性需要处理</strong><span>{library.storage_integrity.orphan_directories?.length ? `发现孤立目录：${library.storage_integrity.orphan_directories.join('、')}。` : ''}{library.storage_integrity.missing_project_records?.length ? `缺少项目目录：${library.storage_integrity.missing_project_records.join('、')}。` : ''}孤立目录不会自动作为有效生产素材，请通过项目导入重新绑定并重新计算哈希。</span></div>}
    <div className="asset-summary" aria-label="资产状态筛选">
      {assetStatusPresentationOrder.map((status) => {
        const count = status === 'all' ? scopedAssets.length : bucketCounts[status] || 0;
        const className = status === 'registered' ? 'ready' : status === 'production' ? 'production-ready' : status === 'blocked' ? 'blocked' : '';
        return <button key={status} type="button" className={`${className} ${filter === status ? 'active' : ''}`.trim()} aria-pressed={filter === status} onClick={() => onFilterChange?.(status)}>{assetStatusFilterLabels[status]} {count}</button>;
      })}
    </div>
    <div className="asset-library-toolbar" role="search" aria-label="资产库筛选工具">
      <div className="asset-library-toolbar-top">
        <div className="asset-toolbar-intro"><span className="asset-toolbar-eyebrow">FILTER &amp; SORT</span><strong>快速定位资产</strong><small>按资产、镜头或生产状态缩小当前工作集</small></div>
        <div className="asset-filter-result" aria-live="polite"><b>{visibleAssets.length}</b><span>当前结果</span><i>·</i><b className="production">{productionReadyCount}</b><span>可入镜</span></div>
      </div>
      <div className="asset-library-controls">
        <label className="asset-search"><span>搜索资产 / 镜头</span><div className="asset-search-control"><span className="asset-search-icon" aria-hidden="true">⌕</span><input id="asset-search" name="asset-search" value={search} onChange={(event) => onSearchChange?.(event.target.value)} placeholder="ID、名称、用途、SH006…" aria-label="搜索资产或镜头" />{search && <button type="button" className="asset-search-clear" onClick={() => onSearchChange?.('')} aria-label="清除搜索">×</button>}</div></label>
        <label><span>资产范围</span><span className="asset-select-control"><select id="asset-scope" name="asset-scope" value={scope} onChange={(event) => onScopeChange?.(event.target.value as AssetLibraryScope)} aria-label="资产分类范围"><option value="all">统一资产库</option><option value="character">人物与角色</option><option value="scene-prop">场景与道具</option><option value="fusion">融合与候选</option></select></span></label>
        <label><span>状态筛选</span><span className="asset-select-control"><select id="asset-status-filter" name="asset-status-filter" value={filter} onChange={(event) => onFilterChange?.(event.target.value as AssetLibraryStatusFilter)} aria-label="资产状态筛选">{assetStatusPresentationOrder.map((status) => <option key={status} value={status}>{status === 'all' ? '全部状态' : assetStatusFilterLabels[status]}</option>)}</select></span></label>
        <label><span>排序</span><span className="asset-select-control"><select id="asset-sort" name="asset-sort" value={sort} onChange={(event) => onSortChange?.(event.target.value as AssetSort)} aria-label="资产排序"><option value="priority">阻塞优先</option><option value="grade">等级</option><option value="updated">更新时间</option><option value="id">资产 ID</option></select></span></label>
        <div className="asset-library-toolbar-actions">{hasActiveFilters && <button type="button" className="asset-filter-clear" onClick={clearAssetFilters}>清除筛选</button>}</div>
      </div>
    </div>
    <div className="asset-library-layout asset-library-layout-v3">
      <VirtualAssetList assets={visibleAssets} selectedId={selected?.id} auditAssetIds={auditAssetIds} onSelect={setSelectedId} />
       {selected ? <div className="asset-detail asset-detail-v3">
          <div className={`asset-detail-heading ${focusAssetId && selected.id === focusAssetId ? 'asset-detail-heading-focus' : ''}`}>
            <div>
              <span>{assetClassLabels[selected.assetClass] || selected.assetClass}</span>
              <h3>{selected.id} · {selected.name || '未命名资产'}</h3>
              <p>{selected.assetRole || '未定义用途'} · {selected.required ? '项目必需' : '可选资产'}</p>
            </div>
            <div className="asset-detail-actions">
              <div className="asset-status-stack">
                <b className={`readiness-badge ${readiness?.registered_ready ? 'ready' : 'pending'}`}>{readiness?.registered_ready ? '已登记' : '待登记'}</b>
                <b className={`readiness-badge ${readiness?.production_ready ? 'production' : readiness?.status === 'blocked' ? 'blocked' : 'pending'}`}>{readiness?.production_ready ? '可入镜' : readiness?.status === 'blocked' ? '已阻塞' : '不可入镜'}</b>
                {!readiness?.production_ready && <small className="asset-status-reason" title={readinessReason}>原因：{readinessReason}</small>}
                {readiness?.manual_approval_active ? <button type="button" className="manual-review-button active" onClick={() => setManualReviewOpen(true)}>撤销人工通过</button> : readiness?.registered_ready && !readiness?.production_ready && <button type="button" className="manual-review-button" disabled={!(currentArtifact?.id || selected.artifactId) || busy} onClick={() => setManualReviewOpen(true)}>人工审核可入镜</button>}
              </div>
              <button type="button" className="asset-delete-button" onClick={() => onDeleteAsset?.(selected.id, selected.name || selected.id)} disabled={busy || !onDeleteAsset} title="删除逻辑资产、画布节点和关联关系；已上传文件保留">删除资产</button>
              {manualReviewOpen && <div className="manual-review-panel" role="dialog" aria-modal="false" aria-label="人工审核可入镜">
                <div>
                  <span className="asset-toolbar-eyebrow">HUMAN REVIEW GATE</span>
                  <h4>{readiness?.manual_approval_active ? '撤销人工通过' : '人工审核可入镜'}</h4>
                  <p>{readiness?.manual_approval_active ? '撤销后资产会恢复到 Prompt / Prompt QA 门禁。' : '该资产已完成文件、图片 QA 和登记；本操作只豁免 Prompt / Prompt QA，不会绕过授权、融合门或基础登记。确认后若其他门禁已满足，状态会自动刷新为“可入镜”。'}</p>
                  {!readiness?.manual_approval_active && <>
                    <ul>{(readiness?.production_missing || []).map((item) => <li key={item}>{formatProductionBlocker(item)}</li>)}</ul>
                    <label>人工审核原因<textarea value={manualReviewReason} onChange={(event) => setManualReviewReason(event.target.value)} placeholder="例如：当前登记图像已由导演人工确认，可直接用于该镜头。" rows={3} /></label>
                  </>}
                  <small>当前绑定文件：{String(currentArtifact?.id || selected.artifactId || '未找到登记文件')}</small>
                </div>
                <div className="manual-review-actions">
                  <button type="button" className="ghost" onClick={() => { setManualReviewOpen(false); setInspectorTab('audit'); }}>查看 QA / 审计</button>
                  {readiness?.manual_approval_active ? <button type="button" className="danger-button" onClick={() => { onManualProductionApproval?.(selected.id, false, '撤销人工通过', String(currentArtifact?.id || selected.artifactId || '')); setManualReviewOpen(false); }} disabled={busy || !onManualProductionApproval}>撤销人工通过</button> : <button type="button" className="primary" onClick={() => { onManualProductionApproval?.(selected.id, true, manualReviewReason.trim(), String(currentArtifact?.id || selected.artifactId || '')); setManualReviewOpen(false); }} disabled={busy || !manualReviewReason.trim() || !(currentArtifact?.id || selected.artifactId) || !onManualProductionApproval}>确认人工通过</button>}
                </div>
              </div>}
            </div>
          </div>
        <div className="asset-next-action"><div><strong>下一步：{selectedWorkflow?.next_action?.label || assetNextAction(selected)}</strong><span>{readiness?.production_missing?.map((item) => productionStatusLabels[item] || item).join(' · ') || '当前资产满足入镜门禁。'}</span></div>{selectedWorkflow?.next_action?.code === 'register_artifact' && selectedWorkflow.artifact_id && <button type="button" className="asset-primary-action" onClick={() => { const artifact = (selected.artifacts || []).find((item: Record<string, any>) => item.id === selectedWorkflow.artifact_id); if (artifact) { setRegisterArtifact(artifact); setReplaceActive(false); } }} disabled={busy}>登记为资产版本</button>}{selectedWorkflow?.next_action?.code?.startsWith('start_') && selectedWorkflow.artifact_id && <button type="button" className="asset-primary-action" onClick={() => { const artifact = (selected.artifacts || []).find((item: Record<string, any>) => item.id === selectedWorkflow.artifact_id); if (artifact) openQa(artifact); }} disabled={busy}>开始审核</button>}{selectedWorkflow?.kind === 'reference' && <span className="asset-reference-notice">仅供参考，不可进入正式时间线</span>}</div>
          <div className="asset-inspector-tabs" role="tablist" aria-label="资产详情标签"><button type="button" role="tab" id="asset-tab-overview" tabIndex={inspectorTab === 'overview' ? 0 : -1} className={inspectorTab === 'overview' ? 'active' : ''} aria-selected={inspectorTab === 'overview'} onClick={() => setInspectorTab('overview')}>概览</button><button type="button" role="tab" id="asset-tab-media" tabIndex={inspectorTab === 'media' ? 0 : -1} className={inspectorTab === 'media' ? 'active' : ''} aria-selected={inspectorTab === 'media'} onClick={() => setInspectorTab('media')}>媒体与候选</button><button type="button" role="tab" id="asset-tab-prompt" tabIndex={inspectorTab === 'prompt' ? 0 : -1} className={inspectorTab === 'prompt' ? 'active' : ''} aria-selected={inspectorTab === 'prompt'} onClick={() => setInspectorTab('prompt')}>Prompt / 规格</button><button type="button" role="tab" id="asset-tab-dependencies" tabIndex={inspectorTab === 'dependencies' ? 0 : -1} className={inspectorTab === 'dependencies' ? 'active' : ''} aria-selected={inspectorTab === 'dependencies'} onClick={() => setInspectorTab('dependencies')}>依赖与镜头</button><button type="button" role="tab" id="asset-tab-audit" tabIndex={inspectorTab === 'audit' ? 0 : -1} className={inspectorTab === 'audit' ? 'active' : ''} aria-selected={inspectorTab === 'audit'} onClick={() => setInspectorTab('audit')}>QA / 审计</button><button type="button" role="tab" id="asset-tab-history" tabIndex={inspectorTab === 'history' ? 0 : -1} className={inspectorTab === 'history' ? 'active' : ''} aria-selected={inspectorTab === 'history'} onClick={() => setInspectorTab('history')}>版本历史</button></div>
         {(inspectorTab === 'overview' || inspectorTab === 'media') && <section className="asset-media-section"><div className="asset-section-heading"><h4>媒体与候选</h4><small>{selected.artifact_count ?? selected.artifacts?.length ?? 0} 个文件 · 当前登记 {currentArtifact?.id || '—'}</small></div><div className="asset-media-grid">{currentArtifact?.url && String(currentArtifact.mime_type || '').startsWith('image/') ? <img src={currentArtifact.url} alt={`${selected.name || selected.id} 当前登记素材`} /> : currentArtifact?.url && String(currentArtifact.mime_type || '').startsWith('video/') ? <video src={currentArtifact.url} controls preload="metadata" /> : <div className="asset-media-fallback">{currentArtifact ? `${currentArtifact.mime_type || '媒体'} · ${currentArtifact.id}` : '尚无当前登记媒体'}</div>}<div className="asset-candidate-list">{(selected.artifacts || []).slice(0, 8).map((artifact: Record<string, any>) => <div className="asset-candidate-row" key={artifact.id}><div><span>{artifact.id} · {artifact.role || '候选'} · {artifact.qa_decision || 'Pending'}</span><small>{artifact.mime_type || '未知媒体'} · {artifact.collection || artifact.status || 'intake'}</small></div><div className="asset-candidate-row-actions">{artifact.status === 'approved_pending_registration' && <button type="button" onClick={() => { setRegisterArtifact(artifact); setReplaceActive(false); }} disabled={busy}>登记</button>}{['generated_pending_qa', 'reference_pending_review', 'audit_blocked', 'revision_required'].includes(String(artifact.status || '')) && <button type="button" onClick={() => openQa(artifact)} disabled={busy}>{artifactActionLabel(artifact)}</button>}{artifact.status === 'qa_in_progress' && <button type="button" onClick={() => openQa(artifact)} disabled={busy}>打开 QA</button>}{artifact.status === 'reference' && <span className="asset-reference-chip">仅参考</span>}<button type="button" className="ghost" onClick={() => artifact.url && window.open(String(artifact.url), '_blank', 'noopener,noreferrer')} disabled={!artifact.url}>查看文件</button></div></div>)}</div></div></section>}
         {(inspectorTab === 'overview' || inspectorTab === 'prompt') && <div className="asset-prompt-panel"><div className="asset-form-grid"><label>资产类别<select id="asset-edit-class" name="asset-edit-class" value={draft.assetClass} onChange={(event) => update({ assetClass: event.target.value })}>{Object.entries(assetClassLabels).filter(([key]) => key !== 'unknown').map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>等级<select id="asset-edit-grade" name="asset-edit-grade" value={draft.grade} onChange={(event) => update({ grade: event.target.value })}><option>A+</option><option>A</option><option>B</option><option>C</option><option>optional</option><option>Reject</option></select></label><label>用途角色<input id="asset-edit-usage" name="asset-edit-usage" value={draft.usageRoles} onChange={(event) => update({ usageRoles: event.target.value })} placeholder="identity, continuity" /></label><label>来源<input id="asset-edit-source" name="asset-edit-source" value={draft.source} onChange={(event) => update({ source: event.target.value })} /></label><label>许可证/授权<input id="asset-edit-license" name="asset-edit-license" value={draft.license} onChange={(event) => update({ license: event.target.value })} /></label><label>授权状态<input id="asset-edit-authorization" name="asset-edit-authorization" value={draft.authorizationStatus} onChange={(event) => update({ authorizationStatus: event.target.value })} placeholder="cleared / pending" /></label></div>
         <label className="asset-wide-field"><span>{selected.assetClass === 'character' ? '身份锚点 / 脸部 / 发型 / 服装 JSON' : selected.assetClass === 'scene' ? '空间布局 / 时间 / 天气 / 光线 / 机位 JSON' : selected.assetClass === 'prop' ? '结构 / 材质 / 尺度 / 文字 / 保护区 JSON' : selected.assetClass === 'fusion' ? '输入资产 / 空间关系 / 遮挡 / 连续性 JSON' : '身份锚点 JSON'}</span><textarea id="asset-edit-identity-anchors" name="asset-edit-identity-anchors" className={formError?.startsWith('身份锚点') ? 'invalid' : ''} value={draft.identityAnchors} onChange={(event) => update({ identityAnchors: event.target.value })} /></label><label className="asset-wide-field">资产生产规格 JSON<textarea id="asset-edit-spec" name="asset-edit-spec" className={formError?.startsWith('资产生产规格') ? 'invalid' : ''} value={draft.assetSpec} onChange={(event) => update({ assetSpec: event.target.value })} /></label><label className="asset-wide-field">Prompt <small>编辑已批准 Prompt 会创建新版本并重置 Prompt QA。</small><textarea id="asset-edit-prompt" name="asset-edit-prompt" value={draft.prompt} onChange={(event) => update({ prompt: event.target.value })} /></label></div>}
         {(inspectorTab === 'overview' || inspectorTab === 'dependencies') && <div className="asset-dependencies-panel"><label className="asset-wide-field">引用角色（每行：引用 ID | identity/outfit/action/composition/scene_structure/style/lighting/product_structure | 来源 | 备注）<textarea id="asset-edit-references" name="asset-edit-references" value={draft.references} onChange={(event) => update({ references: event.target.value })} /></label><label className="asset-wide-field">镜头依赖（每行：资产 ID | 镜头 ID | 依赖角色）<textarea id="asset-edit-dependencies" name="asset-edit-dependencies" value={draft.dependencies} onChange={(event) => update({ dependencies: event.target.value })} /></label></div>}
         {formError && (inspectorTab === 'overview' || inspectorTab === 'prompt') && <p className="asset-form-error" role="alert">{formError}</p>}
         {(inspectorTab === 'overview' || inspectorTab === 'audit') && selected.assetClass === 'fusion' && <div className="fusion-gate-card"><div><strong>融合生产门</strong><p>{selected.fusionGate?.message || '尚未检查融合基础资产。'}</p>{selected.fusionGate?.missing_sources?.length ? <small>缺失基础资产：{selected.fusionGate.missing_sources.map((item) => String(item.asset_id)).join(', ')}</small> : null}</div><button onClick={() => onFusionGate(selected.id)} disabled={busy}>检查融合门</button></div>}
         {(inspectorTab === 'overview' || inspectorTab === 'audit') && <section className="asset-audit-inline"><div className="asset-section-heading"><h4>QA 与审计</h4><button onClick={onRefreshAudit} disabled={busy}>刷新队列</button></div><div className="asset-audit-pills"><span>待图片 QA {audit?.counts?.['待图片 QA'] ?? 0}</span><span>待视频 QA {audit?.counts?.['待视频 QA'] ?? 0}</span><span>待参考审核 {audit?.counts?.['待参考审核'] ?? 0}</span><span>待登记 {audit?.counts?.['待登记'] ?? 0}</span><span>需修订 {audit?.counts?.['需要修订'] ?? 0}</span><span>拒绝 {audit?.counts?.['拒绝/重建 Prompt'] ?? 0}</span></div><p>QA Owner：{selected.qaOwner || selected.workflow?.qa_owner || ({ character: '角色设计导演', scene: '场景设计导演', prop: '道具设计导演', fusion: '融合生产导演', video: '镜头导演' } as Record<string, string>)[selected.assetClass] || '资产总控'} · {readiness?.qa_kind === 'video' ? '视频 QA' : readiness?.qa_kind === 'reference' ? '参考审核' : '图片 QA'}：{readiness?.qa_decision || '待处理'} · 已登记 ≠ 可入镜</p></section>}
          {(inspectorTab === 'overview' || inspectorTab === 'history') && <div className="asset-history"><h4>版本与 Prompt 历史</h4><div className="version-row"><span>当前登记版本 · {selected.versions?.find((item: Record<string, unknown>) => item.is_active)?.version || '—'}</span><small>{selected.versions?.length || 0} 个资产版本保留 · {promptVersions.length} 个 Prompt 版本</small></div>{promptVersions.slice(0, 5).map((version: Record<string, any>) => <div className="version-row" key={version.id}><span>Prompt v{version.version} · {version.status}</span><small>{version.id}</small></div>)}{selected.comparisons?.map((comparison) => <details key={comparison.id}><summary>{comparison.comparison_group} · {comparison.strategy} · {comparison.candidates.length} 候选</summary>{comparison.candidates.map((candidate) => <div className="candidate-line" key={candidate.artifact_id}><span>{candidate.artifact_id} · {candidate.score ?? '未评分'} · {candidate.comment || '无批注'}</span><button onClick={() => onReview(selected.id, comparison.id, candidate.artifact_id)} disabled={busy || candidate.decision === 'Approved'}>{candidate.decision === 'Approved' ? '已批准' : '批准候选'}</button></div>)}</details>)}</div>}
        {qaArtifact && <div className="asset-qa-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setQaArtifact(null); }}><section className="asset-qa-modal" role="dialog" aria-modal="true" aria-labelledby="asset-qa-title"><header><div><span>MEDIA QA · {qaArtifact.__qaType === 'reference' ? 'REFERENCE REVIEW' : String(qaArtifact.__qaType || 'image').toUpperCase()}</span><h3 id="asset-qa-title">审核候选文件</h3><p>{qaArtifact.id} · {qaArtifact.mime_type || '未知媒体'} · {selected.id}</p></div><button type="button" className="close-button" onClick={() => setQaArtifact(null)} aria-label="关闭 QA 审核">×</button></header><div className="asset-qa-body">{qaArtifact.url && String(qaArtifact.mime_type || '').startsWith('video/') ? <video className="asset-qa-preview" src={qaArtifact.url} controls preload="metadata" /> : qaArtifact.url ? <img className="asset-qa-preview" src={qaArtifact.url} alt="候选审核预览" /> : <div className="asset-media-fallback">没有可预览文件</div>}<div className="asset-qa-form"><p className="asset-qa-hint">审核必须记录结论与依据；Prompt QA 与媒体 QA 分开，不会互相替代。</p>{qaArtifact.__qaType === 'video' && <fieldset className="asset-qa-checklist-form"><legend>视频 QA 检查清单（Approved 必须全部确认）</legend>{qaChecklist.map(([key, label]) => <label key={key}><input type="checkbox" checked={Boolean(qaChecks[key])} onChange={(event) => setQaChecks((current) => ({ ...current, [key]: event.target.checked }))} />{label}</label>)}</fieldset>}<label>审核决策<select value={qaDecision} onChange={(event) => setQaDecision(event.target.value as AssetQaDecision)}><option value="Approved">Approved · 通过</option><option value="Needs revision">Needs revision · 需修订</option><option value="Rejected">Rejected · 拒绝</option><option value="Blocked">Blocked · 阻塞</option></select></label><label>审核依据 / 观察问题<textarea value={qaReport} onChange={(event) => setQaReport(event.target.value)} placeholder="记录可播放性、时长/FPS、画面连续性、闪烁/变形、水印、声画同步或参考用途等检查结果。" rows={7} /></label><div className="asset-qa-checklist"><span>目标：{qaArtifact.__qaType === 'video' ? '正式镜头视频 QA' : qaArtifact.__qaType === 'reference' ? '分镜参考审核' : '媒体 QA'}</span><span>QA Owner：{selected.workflow?.qa_owner || selected.qaOwner || '资产总控'}</span><span>{qaArtifact.metadata?.source || qaArtifact.source || '来源已登记'} · SHA-256 {qaArtifact.sha256 ? String(qaArtifact.sha256).slice(0, 12) + '…' : '待校验'}</span></div></div></div><footer><button type="button" onClick={() => setQaArtifact(null)}>取消</button><button type="button" className="asset-primary-action" onClick={() => { if (!qaReport.trim() && qaDecision !== 'Blocked') return; void Promise.resolve(onSubmitQa?.(String(qaArtifact.id), String(qaArtifact.__qaType || 'image') as AssetQaType, qaDecision, qaReport.trim(), qaChecks)).then(() => setQaArtifact(null)); }} disabled={busy || !onSubmitQa || (!qaReport.trim() && qaDecision !== 'Blocked') || (qaArtifact.__qaType === 'video' && qaDecision === 'Approved' && !qaChecklistReady)}>提交审核结论</button></footer></section></div>}
        {registerArtifact && <div className="asset-qa-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setRegisterArtifact(null); }}><section className="asset-qa-modal asset-register-modal" role="dialog" aria-modal="true" aria-labelledby="asset-register-title"><header><div><span>REGISTER ARTIFACT VERSION</span><h3 id="asset-register-title">登记为资产版本</h3><p>{registerArtifact.id} · {registerArtifact.mime_type || '未知媒体'} · QA {registerArtifact.qa_decision || 'Approved'}</p></div><button type="button" className="close-button" onClick={() => setRegisterArtifact(null)} aria-label="关闭登记确认">×</button></header><div className="asset-register-summary"><div><b>目标资产</b><span>{selected.id} · {selected.name || '未命名资产'}</span></div><div><b>文件摘要</b><span>{registerArtifact.filename || registerArtifact.original_name || '候选文件'} · {registerArtifact.sha256 ? String(registerArtifact.sha256).slice(0, 18) + '…' : 'SHA-256 待校验'}</span></div><div><b>审核信息</b><span>{registerArtifact.qa_decision || 'Approved'} · {registerArtifact.qa_owner || selected.workflow?.qa_owner || '—'}</span></div><div><b>版本策略</b><span>{selected.versions?.some((item: Record<string, any>) => item.is_active) ? '已有 active 版本，默认登记为 candidate' : '没有 active 版本，将登记为 active'}</span></div><label className="check-row"><input type="checkbox" checked={replaceActive} onChange={(event) => setReplaceActive(event.target.checked)} />明确替换当前 active 版本</label><p className="asset-qa-hint">已登记 ≠ 可入镜。登记后仍需满足授权、Prompt、融合和镜头依赖门禁。</p></div><footer><button type="button" onClick={() => setRegisterArtifact(null)}>取消</button><button type="button" className="asset-primary-action" onClick={() => { void Promise.resolve(onRegisterArtifact?.(String(registerArtifact.id), replaceActive)).then(() => setRegisterArtifact(null)); }} disabled={busy || !onRegisterArtifact}>确认登记</button></footer></section></div>}
      </div> : <div className="empty-state">当前筛选没有可检查的资产。</div>}
    </div>
  </section>;
}

function AssetImportDrawer({ library, busy, onClose, onImport }: { library: AssetLibraryEnvelope; busy: boolean; onClose: () => void; onImport: (items: Array<{ file: File; assetId: string; role: string }>) => Promise<void> }) {
  const dialogFocus = useDialogFocus(true);
  const [items, setItems] = useState<Array<{ file: File; assetId: string; role: string }>>([]);
  const addFiles = (files: FileList | File[]) => setItems((current) => [...current, ...Array.from(files).map((file) => ({ file, assetId: library.assets[0]?.id || '', role: 'candidate' }))]);
  return <div className="project-manager-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogFocus.dialogRef} onKeyDown={dialogFocus.onKeyDown} className="project-manager asset-import-drawer" role="dialog" aria-modal="true" aria-labelledby="asset-import-title">
      <header className="project-manager-heading"><div><span>ASSET INTAKE QUEUE</span><h2 id="asset-import-title">导入候选素材</h2><p>文件只进入候选队列；服务端按 MIME 和文件名分类为图片、视频、声音或参考素材，不会覆盖当前批准版本。</p></div><button className="close-button" onClick={onClose} aria-label="关闭导入抽屉">×</button></header>
      <label className="asset-import-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}><strong>拖放多个文件到这里</strong><span>支持 PNG / JPEG / WebP、MP4 / WebM / MOV、WAV / MP3 / M4A。</span><input id="asset-intake-files" name="asset-intake-files" aria-label="选择候选素材文件" type="file" multiple accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/wav,audio/mpeg,audio/mp4,audio/x-m4a" onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.currentTarget.value = ''; }} /></label>
      <div className="asset-import-queue">{items.map((item, index) => { const extension = item.file.name.toLowerCase().split('.').pop() || ''; const inferredType = item.file.type || ({ mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[extension] || ''; const supported = /^(image\/(png|jpeg|webp)|video\/(mp4|webm|quicktime)|audio\/(wav|mpeg|mp4|x-m4a))$/.test(inferredType); return <div className="asset-import-row" key={`${item.file.name}-${index}`}><div><strong>{item.file.name}</strong><small>{Math.ceil(item.file.size / 1024)} KB · {inferredType || '未知类型'}{!supported ? ' · 类型不受支持' : ''}</small></div><select id={`asset-intake-asset-${index}`} name={`asset-intake-asset-${index}`} aria-label={`候选文件 ${index + 1} 目标资产`} value={item.assetId} onChange={(event) => setItems((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, assetId: event.target.value } : candidate))}>{library.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.id} · {asset.name || asset.id}</option>)}</select><input id={`asset-intake-role-${index}`} name={`asset-intake-role-${index}`} aria-label={`候选文件 ${index + 1} 资产角色`} value={item.role} onChange={(event) => setItems((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, role: event.target.value } : candidate))} placeholder="资产角色" /><button type="button" onClick={() => setItems((current) => current.filter((_, candidateIndex) => candidateIndex !== index))}>移除</button></div>; })}{!items.length && <p className="muted">队列为空，请选择或拖入文件。</p>}</div>
      <footer className="project-manager-footer"><span>{items.length} 个文件 · 上传后进入待 QA</span><div className="project-manager-footer-actions"><button onClick={onClose} disabled={busy}>取消</button><button className="project-create-submit" onClick={() => void onImport(items)} disabled={busy || !items.length || items.some((item) => !item.assetId)}>开始导入</button></div></footer>
    </section>
  </div>;
}

function AssetCreateModal({ draft, shots, busy, onChange, onClose, onSubmit }: { draft: { name: string; assetClass: string; assetRole: string; grade: string; required: boolean; shotId: string }; shots: StoryShot[]; busy: boolean; onChange: (patch: Partial<{ name: string; assetClass: string; assetRole: string; grade: string; required: boolean; shotId: string }>) => void; onClose: () => void; onSubmit: () => void }) {
  const dialogFocus = useDialogFocus(true);
  return <div className="project-manager-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogFocus.dialogRef} onKeyDown={dialogFocus.onKeyDown} className="project-manager asset-create-modal" role="dialog" aria-modal="true" aria-labelledby="asset-create-title">
      <header className="project-manager-heading"><div><span>NEW ASSET</span><h2 id="asset-create-title">新增逻辑资产</h2><p>创建空白资产后，在资产生产工作区中连接依赖、生成 Prompt 并进入候选与 QA 流程。</p></div><button className="close-button" onClick={onClose} aria-label="关闭新增资产">×</button></header>
      <div className="project-create-grid">
        <label className="project-create-wide">资产名称 <em>*</em><input id="asset-create-name" name="asset-create-name" autoFocus value={draft.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="例如：陈继业 · 祠堂雨夜融合" maxLength={160} /></label>
        <label>资产类型<select id="asset-create-class" name="asset-create-class" value={draft.assetClass} onChange={(event) => onChange({ assetClass: event.target.value })}>{['character', 'scene', 'prop', 'fusion', 'product', 'style', 'video', 'audio', 'music', 'sfx'].map((item) => <option key={item} value={item}>{assetClassLabels[item] || item}</option>)}</select></label>
        <label>资产角色<input id="asset-create-role" name="asset-create-role" value={draft.assetRole} onChange={(event) => onChange({ assetRole: event.target.value })} placeholder="identity / environment / fusion" /></label>
        <label>制作等级<select id="asset-create-grade" name="asset-create-grade" value={draft.grade} onChange={(event) => onChange({ grade: event.target.value })}><option>A+</option><option>A</option><option>B</option><option>C</option><option>optional</option><option>Reject</option></select></label>
        <label className="project-create-wide">添加到哪个分镜<select id="asset-create-shot" name="asset-create-shot" value={draft.shotId} onChange={(event) => onChange({ shotId: event.target.value })}><option value="">暂不归属（稍后在画布分配）</option>{shots.map((shot) => <option key={shot.id} value={shot.id}>{shot.id} · {shot.scene} · {shot.purpose}</option>)}</select></label>
        <label className="check-row project-create-wide"><input id="asset-create-required" name="asset-create-required" type="checkbox" checked={draft.required} onChange={(event) => onChange({ required: event.target.checked })} />加入当前项目必需资产清单</label>
      </div>
      <footer className="project-manager-footer"><span>{draft.assetClass === 'fusion' ? '创建后可连接角色、场景或道具资产' : '创建后状态为待制作'}</span><div className="project-manager-footer-actions"><button onClick={onClose} disabled={busy}>取消</button><button className="project-create-submit" onClick={onSubmit} disabled={busy || !draft.name.trim()}>创建资产</button></div></footer>
    </section>
  </div>;
}

function AssetContextMenu({ menu, shots, busy, onClose, onDelete, onMove, onCopy }: { menu: { x: number; y: number; target: AssetBoardContextTarget }; shots: StoryShot[]; busy: boolean; onClose: () => void; onDelete: () => void; onMove: (shotId: string) => void; onCopy: () => void }) {
  const currentShot = String(menu.target.rowKey || '').toUpperCase();
  const left = Math.min(menu.x, Math.max(12, window.innerWidth - 292));
  const top = Math.min(menu.y, Math.max(12, window.innerHeight - 360));
  return <div className="asset-context-menu" style={{ left, top }} role="menu" onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
    <header><div><span>ASSET ACTIONS</span><strong>{menu.target.label}</strong><small>{menu.target.assetId} · {menu.target.nodeType === 'artifact' ? '候选版本' : menu.target.nodeType === 'handoff' ? '人工桥接' : '逻辑资产'}</small></div><button onClick={onClose} aria-label="关闭资产菜单">×</button></header>
    <button className="asset-context-command danger" onClick={onDelete} disabled={busy}>删除逻辑资产及画布内容</button>
    <div className="asset-context-section"><span>移动到目标分镜</span>{shots.length ? shots.map((shot) => { const shotId = String(shot.id).toUpperCase(); return <button key={shot.id} className="asset-context-shot" onClick={() => onMove(shotId)} disabled={busy || shotId === currentShot}><b>{shotId}</b><small>{shot.scene} · {shot.purpose}</small>{shotId === currentShot && <i>当前位置</i>}</button>; }) : <p>当前项目还没有分镜。</p>}</div>
    <button className="asset-context-command" onClick={onCopy} disabled={busy}>复制资产及相关内容</button>
  </div>;
}

type ProjectCreateDraft = Omit<ProjectCreateInput, 'duration'> & { duration: string };
const emptyProjectDraft = (): ProjectCreateDraft => ({ name: '', brief: '', ratio: '16:9', duration: '30', generator: 'seedance2.0' });

function ProjectManager({ projects, archivedProjects, currentId, busy, onClose, onSwitch, onMove, onDelete, onArchive, onRestore, onCreate }: {
  projects: ProjectRecord[];
  archivedProjects: ProjectRecord[];
  currentId: string;
  busy: boolean;
  onClose: () => void;
  onSwitch: (projectId: string) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onDelete: (project: ProjectRecord) => void;
  onArchive: (project: ProjectRecord) => void;
  onRestore: (project: ProjectRecord) => void;
  onCreate: (input: ProjectCreateInput) => Promise<boolean>;
}) {
  const dialogFocus = useDialogFocus(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState(emptyProjectDraft);
  const [createError, setCreateError] = useState('');
  const submitCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = draft.name.trim();
    const duration = Number(draft.duration);
    if (!name) { setCreateError('请填写项目名称。'); return; }
    if (!Number.isInteger(duration) || duration < 1 || duration > 3600) { setCreateError('时长请输入 1—3600 秒的整数。'); return; }
    setCreateError('');
    const created = await onCreate({ name, brief: draft.brief.trim(), ratio: draft.ratio, duration, generator: draft.generator.trim() || 'seedance2.0' });
    if (created) { setCreateOpen(false); setDraft(emptyProjectDraft()); }
  };
  return <div className="project-manager-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogFocus.dialogRef} onKeyDown={dialogFocus.onKeyDown} className="project-manager" role="dialog" aria-modal="true" aria-labelledby="project-manager-title">
      <header className="project-manager-heading"><div><span>PROJECT MANAGEMENT</span><h2 id="project-manager-title">项目管理</h2><p>切换、排序和管理项目。制作状态由首页根据真实数据实时推导。</p></div><button className="close-button" onClick={onClose} aria-label="关闭项目管理">×</button></header>
      <div className="project-manager-list">
        {projects.map((item, index) => {
          const current = item.document.id === currentId;
          return <article className={`project-manager-row ${current ? 'current' : ''}`} key={item.document.id}>
            <div className="project-manager-info"><div className="project-manager-name"><strong>{item.document.name}</strong>{current && <span className="project-current-badge">当前项目</span>}</div><small>{item.document.ratio || '—'} · {item.document.duration || 0}s · 修订版 v{item.revision}</small></div>
            <div className="project-manager-actions">
              <button onClick={() => onMove(index, -1)} disabled={busy || index === 0} title="上移项目">↑</button>
              <button onClick={() => onMove(index, 1)} disabled={busy || index === projects.length - 1} title="下移项目">↓</button>
              <button onClick={() => onArchive(item)} disabled={busy || projects.length <= 1}>归档</button>
              <button className="danger-button" onClick={() => onDelete(item)} disabled={busy || projects.length <= 1}>删除</button>
              <button className="project-switch-button" onClick={() => onSwitch(item.document.id)} disabled={busy || current}>{current ? '当前项目' : '切换到此项目'}</button>
            </div>
          </article>;
        })}
        {!projects.length && <p className="muted">暂无项目。</p>}
        {archivedProjects.length > 0 && <section className="archived-projects" aria-label="已归档项目"><h3>已归档项目</h3>{archivedProjects.map((item) => <article className="project-manager-row archived" key={item.document.id}><div className="project-manager-info"><div className="project-manager-name"><strong>{item.document.name}</strong><span className="project-status archived">已归档</span></div><small>{item.document.ratio || '—'} · {item.document.duration || 0}s · 修订版 v{item.revision}</small></div><div className="project-manager-actions"><button onClick={() => onRestore(item)} disabled={busy}>恢复</button><button className="danger-button" onClick={() => onDelete(item)} disabled={busy}>删除</button></div></article>)}</section>}
      </div>
      {createOpen && <form className="project-create-form" onSubmit={submitCreate}>
        <div className="project-create-heading"><div><span>NEW PROJECT</span><h3>新建项目</h3><p>创建一个空白项目，从创意目标和剧本开始编辑。</p></div><button type="button" className="close-button" onClick={() => setCreateOpen(false)} aria-label="关闭新建项目表单">×</button></div>
        <div className="project-create-grid">
          <label>项目名称 <em>*</em><input id="project-create-name" name="project-create-name" autoFocus value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如：我的新短片" maxLength={100} /></label>
          <label>画面比例<select id="project-create-ratio" name="project-create-ratio" value={draft.ratio} onChange={(event) => setDraft((current) => ({ ...current, ratio: event.target.value }))}><option value="16:9">16:9 横屏</option><option value="9:16">9:16 竖屏</option><option value="1:1">1:1 方形</option></select></label>
          <label>目标时长（秒）<input id="project-create-duration" name="project-create-duration" type="number" min="1" max="3600" step="1" value={draft.duration} onChange={(event) => setDraft((current) => ({ ...current, duration: event.target.value }))} /></label>
<label>生成模型<input id="project-create-generator" name="project-create-generator" value={draft.generator} onChange={(event) => setDraft((current) => ({ ...current, generator: event.target.value }))} placeholder="seedance2.0" /></label>
          <label className="project-create-wide">创意简介（可选）<textarea id="project-create-brief" name="project-create-brief" value={draft.brief} onChange={(event) => setDraft((current) => ({ ...current, brief: event.target.value }))} placeholder="先写下这个项目想表达的内容……" rows={3} maxLength={2000} /></label>
        </div>
        {createError && <p className="project-create-error" role="alert">{createError}</p>}
        <div className="project-create-actions"><button type="button" onClick={() => setCreateOpen(false)} disabled={busy}>取消</button><button type="submit" className="project-create-submit" disabled={busy}>创建并开始编辑</button></div>
      </form>}
      <footer className="project-manager-footer"><span>共 {projects.length} 个活动项目 · {archivedProjects.length} 个已归档</span><div className="project-manager-footer-actions"><button className="project-create-trigger" onClick={() => { setCreateOpen((current) => !current); setCreateError(''); }} disabled={busy}>{createOpen ? '收起新建' : '＋ 新建项目'}</button><button onClick={onClose}>完成</button></div></footer>
    </section>
  </div>;
}

function StoryView({ story, storyRun, storyDiff, dirty, busy, onChange, onSave, onGenerate, onAccept, onRollback, onOpenAssetBoard, onGenerateAssetPrompts }: { story: StoryEnvelope | null; storyRun: StoryRun | null; storyDiff: StoryDiff | null; dirty: boolean; busy: boolean; onChange: (story: StoryDocument) => void; onSave: () => void; onGenerate: () => void; onAccept: (scope?: 'all' | 'script_only' | 'shots_only', shotIds?: string[]) => void; onRollback: (versionId: string, scope: 'script' | 'shots') => void; onOpenAssetBoard: () => void; onGenerateAssetPrompts: () => void }) {
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const creativeGoalRef = useRef<HTMLTextAreaElement | null>(null);
  const resizeCreativeGoal = () => {
    const textarea = creativeGoalRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  };
  useEffect(() => { if (story) resizeCreativeGoal(); }, [story?.story.spec.creative_goal]);
  if (!story) return <div className="empty-state">正在读取故事与分镜…</div>;
  const proposedScript = typeof storyRun?.storyboard_output?.proposedScript === 'string' ? storyRun.storyboard_output.proposedScript : '';
  const proposedShots = Array.isArray(storyRun?.storyboard_output?.shots) ? storyRun.storyboard_output.shots.filter((item): item is StoryShot => typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).id === 'string') : [];
  const reviewReady = storyRun?.status === 'storyboard_review_required';
  // The asset-prompt endpoint is the workflow step that extracts missing
  // assets from the accepted storyboard and creates their Prompt cards. An
  // asset_gap is therefore expected at this point and must not disable this
  // action. Other story structure errors still block Prompt generation.
  const promptGenerationBlockingIssues = story.checks.issues.filter((issue) => issue.severity === 'error' && issue.code !== 'asset_gap');
  const assetGapIssueCount = story.checks.issues.filter((issue) => issue.code === 'asset_gap').length;
  const promptGenerationBlocked = busy || !story.story.shots.length || promptGenerationBlockingIssues.length > 0;
  const promptGenerationTitle = !story.story.shots.length
    ? '请先完成至少一个镜头'
    : promptGenerationBlockingIssues.length > 0
      ? `请先修复故事与分镜的阻塞问题：${promptGenerationBlockingIssues[0].message}`
      : story.checks.issues.some((issue) => issue.code === 'asset_gap')
        ? '镜头资产尚未登记，将由本流程自动提取并创建 Prompt 卡'
        : '按 video-asset-regulator 审计并生成资产 Prompt 卡';
  const updateSpec = (key: keyof StoryDocument['spec'], value: string | number) => onChange({ ...story.story, spec: { ...story.story.spec, [key]: value } });
  const updateShot = (shotId: string, key: keyof StoryShot, value: string | number) => onChange({ ...story.story, shots: story.story.shots.map((shot) => shot.id === shotId ? { ...shot, [key]: value } : shot) });
  const stableId = (prefix: 'SH' | 'SC') => `${prefix}M-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const addScene = () => onChange({ ...story.story, scenes: [...story.story.scenes, { id: stableId('SC'), name: '新场景', description: '' }] });
  const updateScene = (sceneId: string, key: string, value: string) => onChange({ ...story.story, scenes: story.story.scenes.map((scene) => String(scene.id || '') === sceneId ? { ...scene, [key]: value } : scene) });
  const removeScene = (sceneId: string) => onChange({ ...story.story, scenes: story.story.scenes.filter((scene) => String(scene.id || '') !== sceneId) });
  const addShot = () => {
    const scene = String(story.story.scenes[0]?.id || story.story.scenes[0]?.name || 'SCENE');
    onChange({ ...story.story, shots: [...story.story.shots, { id: stableId('SH'), scene, duration: 3, purpose: '', size: '中景', camera: '固定', action: '' }] });
  };
  const removeShot = (shotId: string) => onChange({ ...story.story, shots: story.story.shots.filter((shot) => shot.id !== shotId) });
  const moveShot = (shotId: string, direction: -1 | 1) => {
    const shots = [...story.story.shots]; const index = shots.findIndex((shot) => shot.id === shotId); const target = index + direction;
    if (index < 0 || target < 0 || target >= shots.length) return;
    [shots[index], shots[target]] = [shots[target], shots[index]]; onChange({ ...story.story, shots });
  };
  const duplicateShot = (shotId: string) => {
    const index = story.story.shots.findIndex((shot) => shot.id === shotId); if (index < 0) return;
    const shots = [...story.story.shots]; shots.splice(index + 1, 0, { ...shots[index], id: stableId('SH'), purpose: `${shots[index].purpose || '镜头'}（副本）` }); onChange({ ...story.story, shots });
  };
  const splitShot = (shotId: string) => {
    const index = story.story.shots.findIndex((shot) => shot.id === shotId); if (index < 0) return;
    const shots = [...story.story.shots]; const source = shots[index]; const half = Math.max(.1, Number((source.duration / 2).toFixed(2)));
    shots[index] = { ...source, duration: half }; shots.splice(index + 1, 0, { ...source, id: stableId('SH'), duration: Math.max(.1, Number((source.duration - half).toFixed(2))), purpose: `${source.purpose || '镜头'}（拆分）` }); onChange({ ...story.story, shots });
  };
  const linesToItems = (value: string, prefix: string) => value.split('\n').map((line) => line.trim()).filter(Boolean).map((label, index) => ({ id: `${prefix}${String(index + 1).padStart(2, '0')}`, label }));
  return (
    <section className="story-view">
      <header className="section-heading"><div><span>STORY & SHOT DESIGN</span><h2>故事与分镜</h2></div><div className="story-heading-actions"><p className="story-heading-status">{promptGenerationBlockingIssues.length} 个故事阻塞问题 · {story.checks.warnings} 个提醒{assetGapIssueCount ? ` · ${assetGapIssueCount} 个资产待提取` : ''}{storyRun ? ` · ${storyRun.active_step}` : ''}</p>{storyRun && ['storyboard_review_required', 'regulator_review_required'].includes(storyRun.status) && <button onClick={() => onAccept('all')} disabled={busy}>接受下一层</button>}<button className="asset-prompt-button" onClick={onGenerateAssetPrompts} disabled={promptGenerationBlocked} title={promptGenerationTitle}>资产 Prompt 生成</button><button className="asset-entry-button" onClick={onOpenAssetBoard} disabled={busy || !story.story.shots.length}>进入资产生产</button><button onClick={onSave} disabled={!dirty || busy}>保存故事剧本</button></div></header>
      <div className="story-spec-grid">
        <label>创意目标 / 补充想法<textarea id="story-creative-goal" name="story-creative-goal" ref={creativeGoalRef} value={story.story.spec.creative_goal} onChange={(event) => updateSpec('creative_goal', event.target.value)} onInput={resizeCreativeGoal} /></label>
        <label>平台<input id="story-platform" name="story-platform" value={story.story.spec.platform} onChange={(event) => updateSpec('platform', event.target.value)} /></label>
        <label>目标时长<input id="story-duration" name="story-duration" type="number" min="1" value={story.story.spec.duration} onChange={(event) => updateSpec('duration', Number(event.target.value) || 1)} /></label>
        <label>画幅<input id="story-ratio" name="story-ratio" value={story.story.spec.ratio} onChange={(event) => updateSpec('ratio', event.target.value)} /></label>
        <label>语言<input id="story-language" name="story-language" value={story.story.spec.language} onChange={(event) => updateSpec('language', event.target.value)} /></label>
        <label>结构 / 节拍<textarea id="story-beats" name="story-beats" value={story.story.spec.beats.map((item) => String(item.label || item.text || '')).join('\n')} placeholder="每行一个节拍，例如：建立目标\n冲突升级\n反转与收束" onChange={(event) => onChange({ ...story.story, spec: { ...story.story.spec, structure: linesToItems(event.target.value, 'S'), beats: linesToItems(event.target.value, 'B') } })} /></label>
      </div>
      <div className="story-section-title"><div><span>SCENE LIST</span><h3>场景</h3></div><div className="story-section-actions"><small>{story.story.scenes.length} 个场景</small><button type="button" onClick={addScene} disabled={busy}>＋ 新增场景</button></div></div>
      <div className="manual-scene-list">{story.story.scenes.map((scene, index) => { const sceneId = String(scene.id || `SCENE-${index + 1}`); return <article className="manual-scene-row" key={sceneId}><b>{sceneId}</b><label>场景名称<input id={`scene-${sceneId}-name`} name={`scene-${sceneId}-name`} value={String(scene.name || '')} onChange={(event) => updateScene(sceneId, 'name', event.target.value)} /></label><label>空间/说明<input id={`scene-${sceneId}-description`} name={`scene-${sceneId}-description`} value={String(scene.description || '')} onChange={(event) => updateScene(sceneId, 'description', event.target.value)} /></label><button type="button" onClick={() => removeScene(sceneId)} disabled={busy}>删除场景</button></article>; })}{!story.story.scenes.length && <div className="empty-state compact">暂无场景。可直接手工新增，不需要 Provider。</div>}</div>
      <section className="script-workflow" aria-label="脚本优化流程">
        <div className="script-stage source-script-stage">
          <div className="script-stage-heading"><div><span>STEP 01 · SOURCE</span><h3>初始想法 / 现有剧本</h3></div><small>输入你的想法、剧情梗概或已有剧本，AI 会以此作为唯一优化来源。</small></div>
          <textarea id="story-source-script" name="story-source-script" aria-label="初始想法或现有剧本" value={story.story.script} onChange={(event) => onChange({ ...story.story, script: event.target.value })} placeholder="在这里输入初始想法、剧情梗概或现有剧本……" />
          <div className="script-stage-action"><button className="script-optimize-button" onClick={onGenerate} disabled={busy || !story.story.script.trim()}>✦ AI 整合并优化为拍摄剧本</button><span>{busy ? '正在生成候选…' : '点击后会保留原稿，并生成下方可审阅的拍摄剧本候选。'}</span></div>
        </div>
        <div className="script-stage optimized-script-stage">
          <div className="script-stage-heading"><div><span>STEP 02 · AI OUTPUT</span><h3>AI 优化后的拍摄剧本</h3></div><small>{proposedScript ? '候选版本已生成，可在下方审阅并接受。' : '完成上方输入并点击按钮后，AI 优化结果会显示在这里。'}</small></div>
          <textarea id="story-optimized-script" name="story-optimized-script" aria-label="AI 优化后的拍摄剧本" value={proposedScript} readOnly placeholder="AI 优化后的、适合拍摄执行的剧本将显示在这里……" />
        </div>
      </section>
      <div className="story-section-title"><div><span>SHOT TABLE</span><h3>镜头表</h3></div><div className="story-section-actions"><small>{story.story.shots.length} 个镜头 · {story.checks.metrics.total_duration}s</small><button type="button" onClick={addShot} disabled={busy}>＋ 新增镜头</button><button onClick={onSave} disabled={!dirty || busy}>保存镜头表</button></div></div>
      <div className="shot-table">{story.story.shots.length ? story.story.shots.map((shot, index) => <article className="shot-row" key={shot.id}><div className="shot-id"><b>{shot.id}</b><small>{shot.scene}</small></div><label>时长<input id={`shot-${shot.id}-duration`} name={`shot-${shot.id}-duration`} type="number" min="0.1" step="0.1" value={shot.duration} onChange={(event) => updateShot(shot.id, 'duration', Number(event.target.value) || 0.1)} /></label><label>景别<input id={`shot-${shot.id}-size`} name={`shot-${shot.id}-size`} value={shot.size} onChange={(event) => updateShot(shot.id, 'size', event.target.value)} /></label><label>机位/运镜<input id={`shot-${shot.id}-camera`} name={`shot-${shot.id}-camera`} value={shot.camera} onChange={(event) => updateShot(shot.id, 'camera', event.target.value)} /></label><label>动作/表演<input id={`shot-${shot.id}-action`} name={`shot-${shot.id}-action`} value={shot.action} onChange={(event) => updateShot(shot.id, 'action', event.target.value)} /></label><label>叙事目的<input id={`shot-${shot.id}-purpose`} name={`shot-${shot.id}-purpose`} value={shot.purpose} onChange={(event) => updateShot(shot.id, 'purpose', event.target.value)} /></label><div className="shot-row-actions"><button type="button" aria-label={`上移 ${shot.id}`} onClick={() => moveShot(shot.id, -1)} disabled={busy || index === 0}>↑</button><button type="button" aria-label={`下移 ${shot.id}`} onClick={() => moveShot(shot.id, 1)} disabled={busy || index === story.story.shots.length - 1}>↓</button><button type="button" onClick={() => duplicateShot(shot.id)} disabled={busy}>复制</button><button type="button" onClick={() => splitShot(shot.id)} disabled={busy}>拆分</button><button type="button" onClick={() => removeShot(shot.id)} disabled={busy}>删除</button></div></article>) : <div className="empty-state">暂无镜头。点击“新增镜头”即可手工建立生产链，不需要 Provider。</div>}</div>
      {reviewReady && <section className="candidate-review"><div className="story-section-title"><div><span>CANDIDATE REVIEW</span><h3>候选差异审阅</h3></div><small>候选不会覆盖当前版本</small></div><details open><summary>候选剧本</summary><pre>{proposedScript || '候选未提供剧本改动'}</pre></details><div className="candidate-shots"><strong>候选镜头（选择后局部接受）</strong>{proposedShots.map((candidate) => <label key={candidate.id}><input type="checkbox" checked={selectedCandidateIds.includes(candidate.id)} onChange={(event) => setSelectedCandidateIds((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))} />{candidate.id} · {candidate.purpose || candidate.action || '未命名镜头'}</label>)}</div><div className="candidate-actions"><button onClick={() => onAccept('script_only')}>仅接受剧本</button><button onClick={() => onAccept('shots_only', selectedCandidateIds)} disabled={!selectedCandidateIds.length}>接受选中镜头</button><button onClick={() => onAccept('all')}>接受全部候选</button></div></section>}
      {storyDiff && <section className="story-diff"><div className="story-section-title"><div><span>VERSION DIFF</span><h3>最近版本差异</h3></div><small>{storyDiff.shot_diff.added.length} 新增 · {storyDiff.shot_diff.changed.length} 修改 · {storyDiff.shot_diff.removed.length} 移除</small></div><pre>{storyDiff.script_diff.filter((item) => item.type !== 'same').map((item) => `${item.type === 'add' ? '+' : '-'} ${item.text}`).join('\n') || '剧本文本无变化'}</pre></section>}
      <div className="story-checks"><h3>自动检查</h3>{story.checks.issues.length ? story.checks.issues.slice(0, 12).map((issue, index) => <div className={`check-item ${issue.severity}`} key={`${issue.code}-${issue.shot_id || index}`}><b>{issue.severity === 'error' ? '阻塞' : '提醒'}</b><span>{issue.message}{issue.shot_id ? ` · ${issue.shot_id}` : ''}</span></div>) : <p>当前结构化故事通过基础检查。</p>}</div>
      <div className="version-history"><div className="story-section-title"><div><span>VERSION HISTORY</span><h3>版本与回退</h3></div><small>回退会创建新版本，不覆盖历史</small></div>{story.story.script_versions.filter((version) => version.status !== 'active').slice(-5).map((version) => <div className="version-row" key={String(version.id)}><span>{String(version.id)} · {String(version.source || 'unknown')}</span><button onClick={() => onRollback(String(version.id), 'script')} disabled={busy}>回退剧本</button></div>)}{story.story.storyboard_versions.filter((version) => version.status !== 'active').slice(-5).map((version) => <div className="version-row" key={String(version.id)}><span>{String(version.id)} · 分镜</span><button onClick={() => onRollback(String(version.id), 'shots')} disabled={busy}>回退分镜</button></div>)}</div>
    </section>
  );
}

const settingsCapabilityLabels: Record<string, string> = {
  orchestrator: '编排 Agent', vision: '视觉理解', image: '图片生成', image_edit: '图片编辑', video: '视频生成',
  tts: '语音 / TTS', music: '音乐', sfx: '音效', lip_sync: '口型同步', upscale: '放大 / 修复', upload: '媒体上传',
};
const settingsProviderLabels: Record<string, string> = {
  openai: 'OpenAI', openai_compatible: 'OpenAI-compatible', jimeng_cli: '即梦官方 CLI', opencode: 'OpenCode Agent', comfyui: 'ComfyUI 本地',
};
const settingsProviderTypes = ['openai', 'openai_compatible', 'jimeng_cli', 'opencode', 'comfyui'];
const settingsEnvForType: Record<string, string> = { openai: 'OPENAI_API_KEY', openai_compatible: 'DEEPSEEK_API_KEY', opencode: 'OPENCODE_SERVER_PASSWORD', comfyui: 'COMFYUI_API_KEY' };
const settingsProviderCapabilities: Record<string, string[]> = {
  openai: ['orchestrator', 'vision', 'image', 'image_edit', 'tts'],
  openai_compatible: ['orchestrator'],
  opencode: ['orchestrator'],
  jimeng_cli: ['video'],
  comfyui: ['image', 'image_edit', 'video', 'music', 'sfx', 'lip_sync', 'upscale', 'upload'],
};
const JIMENG_VIDEO_MODELS = [
  { id: 'seedance2.0fast', description: '文生/图生/首尾帧 · 4–15 秒 · 720p' },
  { id: 'seedance2.0', description: '文生/图生/首尾帧 · 4–15 秒 · 720p' },
  { id: 'seedance2.0_vip', description: 'VIP · 4–15 秒 · 720p/1080p/4K' },
  { id: 'seedance2.0fast_vip', description: 'VIP · 4–15 秒 · 720p/1080p/4K' },
  { id: 'seedance2.0mini', description: '文生/图生/首尾帧 · 4–15 秒 · 720p' },
  { id: 'seedance2.5', description: 'VIP · 4–30 秒 · 480p/720p/1080p' },
  { id: 'seedance1.5pro', description: '图生/首尾帧 · 5–12 秒 · 720p' },
  { id: 'seedance1.0fast', description: '仅图生 · 5–10 秒 · 720p' },
];
type OpenCodeGoModel = { id: string; name: string; focus: string; note: string; quota?: string };

// OpenCode Go 官方模型组合（来源：https://opencode.ai/zh/go，2026-08-20）。
// focus/note 是 FRAMEFLOW 面向视频制作的调度建议，不是模型原生媒体能力声明。
const OPEN_CODE_GO_MODELS: OpenCodeGoModel[] = [
  { id: 'grok-4.5', name: 'Grok 4.5', focus: '创意发散 / 反转剧情', note: '适合快速提出大胆的故事概念、角色冲突和短视频反转。', quota: '120' },
  { id: 'glm-5.3', name: 'GLM-5.3', focus: '复杂编排 / 分镜规划', note: '适合把创意拆解为结构化流程、场景和镜头任务。', quota: '220' },
  { id: 'glm-5.2', name: 'GLM-5.2', focus: '脚本结构 / 镜头导演', note: '适合严谨整理长脚本、镜头表和制作约束。', quota: '880' },
  { id: 'glm-5.1', name: 'GLM-5.1', focus: '日常编排 / Prompt 改写', note: '适合稳定完成常规脚本迭代和提示词整理。', quota: '880' },
  { id: 'gpt-5.6-luna', name: 'GPT 5.6 Luna', focus: '视觉概念 / 图片生成提示词', note: '适合视觉创意、画面描述、风格拆解和图像生成 Prompt。', quota: '2,050' },
  { id: 'kimi-k3', name: 'Kimi K3', focus: '长脚本 / 世界观连续性', note: '适合维护角色、场景、道具和多场戏之间的长上下文一致性。', quota: '110' },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', focus: '工作流自动化 / 技术配置', note: '适合编写工作台辅助脚本、结构化配置和流程工具。', quota: '1,350' },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', focus: '资产圣经 / 连续性检查', note: '适合整理角色与场景资料，并检查跨镜头信息一致。', quota: '1,150' },
  { id: 'mimo-v2.5-pro', name: 'MiMo-V2.5-Pro', focus: '视觉分析 / 高质量 Prompt', note: '适合分析参考图、提炼视觉语言和精修画面提示词。', quota: '3,250' },
  { id: 'mimo-v2.5', name: 'MiMo-V2.5', focus: '批量 Prompt / 快速草稿', note: '适合高频生成镜头变体、资产标签和日常创作草稿。', quota: '30,100' },
  { id: 'qwen3.8-max', name: 'Qwen3.8 Max', focus: '复杂制作方案 / 质量把关', note: '适合拆解复杂制作目标、约束和交付检查项。', quota: '160' },
  { id: 'qwen3.7-max', name: 'Qwen3.7 Max', focus: '分镜设计 / 场景调度', note: '适合把脚本转换为镜头节奏、空间关系和调度方案。', quota: '340' },
  { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', focus: '脚本迭代 / 镜头变体', note: '适合日常脚本改写、镜头扩写和多版本比较。', quota: '4,300' },
  { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', focus: '批量内容 / 资产描述', note: '适合批量生成资产说明、镜头摘要和提示词变体。', quota: '3,300' },
  { id: 'minimax-m3', name: 'MiniMax M3', focus: '对白 / 旁白 / 情绪表达', note: '适合角色对白、旁白、情绪节奏和声音脚本。', quota: '3,200' },
  { id: 'minimax-m2.7', name: 'MiniMax M2.7', focus: '对白变体 / 短文案', note: '适合快速生成多组对白、标题和社交媒体短文案。', quota: '3,400' },
  { id: 'muse-spark-1.2-contributor', name: 'Muse Spark 1.2 Contributor', focus: '高频草稿 / 资产标注', note: '适合高吞吐的镜头摘要、标签和 Prompt 初稿；受官方地区限制。', quota: '45,300' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', focus: '逻辑编排 / 连续性 QA', note: '适合找出剧本、镜头、资产规格之间的逻辑冲突。', quota: '1,050' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', focus: '快速 QA / 批量改写', note: '适合快速检查大量镜头和提示词，并给出轻量修订建议。', quota: '7,600' },
  { id: 'hy3', name: 'Hy3', focus: '快速创意 / Prompt 变体', note: '适合批量探索画面方向、镜头动作和短提示词变体。', quota: '4,300' },
];

type SettingsDraft = { providerType: string; displayName: string; baseUrl: string; capabilities: string[]; enabled: boolean; modelConfig: string; serverUsername: string; agent: string; preferredModel: string; thinkingStrength: string; cliExecutable: string };

function SettingsView({ settings, busy, onRefresh, onSaveProvider, onAddPreset, onDeleteProvider, onWriteCredential, onImportCredential, onClearCredential, onProbe, onBind, onAutoMatch }: {
  settings: SettingsEnvelope | null;
  busy: boolean;
  onRefresh: () => void;
  onSaveProvider: (providerId: string | null, body: Record<string, unknown>) => Promise<boolean>;
  onAddPreset: (presetId: string) => void;
  onDeleteProvider: (providerId: string) => void;
  onWriteCredential: (providerId: string, value: string) => void;
  onImportCredential: (providerId: string, environmentVariable: string) => void;
  onClearCredential: (providerId: string) => void;
  onProbe: (providerId: string) => Promise<boolean>;
  onBind: (capability: string, providerId: string, model: string | null) => void;
  onAutoMatch: () => void;
}) {
  const providers = settings?.providers || [];
  const [selectedId, setSelectedId] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [secret, setSecret] = useState('');
  const [environmentVariable, setEnvironmentVariable] = useState('OPENAI_API_KEY');
  const [draft, setDraft] = useState<SettingsDraft>({ providerType: 'openai', displayName: '', baseUrl: 'https://api.openai.com/v1', capabilities: ['orchestrator'], enabled: true, modelConfig: '{}', serverUsername: 'opencode', agent: 'build', preferredModel: '', thinkingStrength: 'max', cliExecutable: 'dreamina' });
  const [bindingDraft, setBindingDraft] = useState<Record<string, { providerId: string; model: string }>>({});
  const [saveFeedback, setSaveFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [probePendingId, setProbePendingId] = useState<string | null>(null);
  useEffect(() => {
    const select = document.querySelector<HTMLSelectElement>('.settings-credential-actions > select');
    if (select) {
      select.id = 'settings-credential-environment';
      select.name = 'settings-credential-environment';
      select.setAttribute('aria-label', '要导入的环境变量');
    }
  }, [selectedId, isCreating]);
  const selected = providers.find((provider) => provider.id === selectedId);
  const supportedCapabilities = settingsProviderCapabilities[draft.providerType] || Object.keys(settingsCapabilityLabels);
  const unsupportedSelectedCapabilities = draft.capabilities.filter((capability) => !supportedCapabilities.includes(capability));
  const normalizeGoModelId = (value: string) => value.toLowerCase().split('/').pop()?.replace(/-free$/, '') || '';
  const goModelOptions = selected?.provider_type === 'opencode'
    ? OPEN_CODE_GO_MODELS.map((model) => {
      const detectedId = selected.models.find((candidate) => normalizeGoModelId(candidate) === model.id && !candidate.toLowerCase().endsWith('-free'));
      return { id: detectedId || `opencode/${model.id}`, label: `${model.name} · ${model.focus}${model.quota ? ` · 5h ${model.quota} 次` : ''}`, focus: model.focus, note: model.note, quota: model.quota };
    })
    : [];
  const currentModelIsInGoOptions = goModelOptions.some((model) => model.id === draft.preferredModel);
  const currentModelFallback = selected?.provider_type === 'opencode' && draft.preferredModel && !currentModelIsInGoOptions
    ? [{ id: draft.preferredModel, label: `当前配置 · ${draft.preferredModel}`, focus: '当前配置', note: '该模型不在当前官方 Go 目录中，请重新探测并选择 Go 模型。' }]
    : [];
  const opencodeModelOptions = [...goModelOptions, ...currentModelFallback];
  const selectedGoModel = OPEN_CODE_GO_MODELS.find((model) => normalizeGoModelId(draft.preferredModel) === model.id);
  const probe = selected?.last_probe || null;
  const probeModels = Array.isArray(probe?.models) ? probe.models : [];
  const probeCapabilities = Array.isArray(probe?.capabilities) ? probe.capabilities : [];
  const probePending = Boolean(selected && probePendingId === selected.id);
  const probeStatus = probePending ? '正在检测' : probe?.ok === true ? '连接正常' : probe?.ok === false ? '连接失败' : '尚未检测';
  const probeStatusClass = probePending ? 'checking' : probe?.ok === true ? 'success' : probe?.ok === false ? 'error' : 'pending';

  useEffect(() => {
    if (isCreating) return;
    if (!providers.length) { setSelectedId(''); return; }
    if (!providers.some((provider) => provider.id === selectedId)) setSelectedId(providers[0].id);
  }, [providers, selectedId, isCreating]);

  useEffect(() => {
    if (!selected) return;
    const config = selected.model_config || {};
    setDraft({ providerType: selected.provider_type, displayName: selected.display_name, baseUrl: selected.base_url, capabilities: [...selected.capabilities], enabled: selected.enabled, modelConfig: JSON.stringify(config, null, 2), serverUsername: String(config.server_username || 'opencode'), agent: String(config.agent || 'build'), preferredModel: String(config.model_version || config.orchestrator_model || config.preferred_model || ''), thinkingStrength: String(config.thinking_strength || config.reasoning_effort || 'max'), cliExecutable: String(config.executable || 'dreamina') });
    setSecret('');
    setEnvironmentVariable(settingsEnvForType[selected.provider_type] || 'OPENAI_API_KEY');
  }, [selected?.id]);

  useEffect(() => {
    const next: Record<string, { providerId: string; model: string }> = {};
    (settings?.bindings || []).forEach((binding) => { next[binding.capability] = { providerId: binding.provider_profile_id, model: binding.model || '' }; });
    setBindingDraft(next);
  }, [settings?.bindings]);

  const selectProvider = (provider: SettingsProvider) => { setIsCreating(false); setSelectedId(provider.id); setSaveFeedback(null); };
  const startCreate = () => { setIsCreating(true); setSelectedId(''); setSecret(''); setSaveFeedback(null); setDraft({ providerType: 'openai', displayName: '新 Provider', baseUrl: 'https://api.openai.com/v1', capabilities: ['orchestrator'], enabled: true, modelConfig: '{}', serverUsername: 'opencode', agent: 'build', preferredModel: '', thinkingStrength: 'max', cliExecutable: 'dreamina' }); };
  const toggleCapability = (capability: string) => {
    if (!supportedCapabilities.includes(capability)) return;
    setDraft((current) => ({ ...current, capabilities: current.capabilities.includes(capability) ? current.capabilities.filter((item) => item !== capability) : [...current.capabilities, capability] }));
  };
  const parseConfig = () => { try { const value = JSON.parse(draft.modelConfig); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return null; } };
  const saveProvider = async () => {
    const config = parseConfig();
    if (!config) { setSaveFeedback({ kind: 'error', text: '扩展配置 JSON 无法解析，请修正后再保存。' }); return; }
    if (draft.providerType === 'opencode') {
      delete config.orchestrator_model;
      Object.assign(config, { server_username: draft.serverUsername, agent: draft.agent, thinking_strength: draft.thinkingStrength || 'auto', ...(draft.preferredModel ? { orchestrator_model: draft.preferredModel } : {}) });
    }
    if (draft.providerType === 'jimeng_cli') Object.assign(config, { executable: draft.cliExecutable.trim() || 'dreamina', model_version: draft.preferredModel || 'seedance2.0fast', models: JIMENG_VIDEO_MODELS.map((model) => model.id) });
    const body: Record<string, unknown> = { display_name: draft.displayName.trim(), base_url: draft.providerType === 'jimeng_cli' ? 'cli://dreamina' : draft.baseUrl.trim(), capabilities: draft.capabilities.filter((capability) => supportedCapabilities.includes(capability)), enabled: draft.enabled, model_config: config };
    if (isCreating) body.provider_type = draft.providerType;
    const saved = await onSaveProvider(isCreating ? null : selectedId, body);
    setSaveFeedback(saved ? { kind: 'success', text: '保存成功 · Provider 配置已写入' } : { kind: 'error', text: '保存失败 · 请查看顶部提示' });
  };
  const selectedBinding = (capability: string) => bindingDraft[capability] || { providerId: '', model: '' };
  const updateBindingDraft = (capability: string, patch: Partial<{ providerId: string; model: string }>) => setBindingDraft((current) => ({ ...current, [capability]: { ...selectedBinding(capability), ...patch } }));

  if (!settings) return <div className="empty-state">正在读取 V3 设置控制面…</div>;
  return <section className="settings-view">
    <header className="settings-heading"><div><span>V3 CONTROL PLANE</span><h2>设置与 Provider 控制面</h2><p>管理模型接入、系统凭据、能力路由和本地运行环境。所有配置均属于 V3，不兼容旧版接口。</p></div><button onClick={onRefresh} disabled={busy}>重新检测全部状态</button></header>
    <div className="settings-health-grid">
      <article className="settings-health-card"><small>运行时</small><strong>{settings.system.runtime.toUpperCase()}</strong><span>FrameFlow {settings.system.version} · Schema {settings.system.schema_version}</span></article>
      <article className={`settings-health-card ${settings.system.keyring.available ? 'ok' : 'danger'}`}><small>系统凭据库</small><strong>{settings.system.keyring.available ? '可用' : '不可用'}</strong><span>{settings.system.keyring.backend || '未发现可用后端'}</span></article>
      <article className={`settings-health-card ${settings.system.media.ffmpeg && settings.system.media.ffprobe ? 'ok' : 'warn'}`}><small>媒体工具链</small><strong>{settings.system.media.ffmpeg && settings.system.media.ffprobe ? 'FFmpeg 就绪' : '需要补齐'}</strong><span>ffmpeg / ffprobe · {Math.round(settings.system.disk_free_bytes / 1024 / 1024 / 1024)} GB 可用</span></article>
      <article className={`settings-health-card ${settings.system.openai.credential_configured ? 'ok' : 'warn'}`}><small>OpenAI</small><strong>{settings.system.openai.credential_configured ? '已配置' : '未配置'}</strong><span>{settings.system.provider_count} 个 Provider 配置</span></article>
    </div>
    <div className="settings-layout">
      <aside className="settings-provider-column"><div className="settings-column-heading"><div><small>PROVIDERS</small><h3>接入目录</h3></div><button onClick={startCreate}>＋ 新配置</button></div>
        {providers.map((provider) => <button key={provider.id} className={`settings-provider-item ${!isCreating && provider.id === selectedId ? 'active' : ''}`} onClick={() => selectProvider(provider)}><span className="settings-provider-status">{provider.enabled ? '●' : '○'}</span><span><b>{provider.display_name}</b><small>{settingsProviderLabels[provider.provider_type] || provider.provider_type}</small></span><i className={provider.healthy === true ? 'ok' : provider.healthy === false ? 'danger' : ''}>{provider.credential_configured ? '已接入' : provider.provider_type === 'comfyui' || provider.provider_type === 'opencode' || provider.provider_type === 'jimeng_cli' ? '待连接' : '缺凭据'}</i></button>)}
        <div className="settings-presets"><small>快速接入预设</small>{settings.presets.map((preset: SettingsPreset) => <button key={preset.preset_id} onClick={() => onAddPreset(preset.preset_id)} disabled={busy}><b>{preset.display_name}</b><span>{settingsProviderLabels[preset.provider_type] || preset.provider_type} · 添加独立配置</span></button>)}</div>
      </aside>
        <div className="settings-editor">
          <div className="settings-editor-heading"><div><small>{isCreating ? 'NEW PROVIDER' : 'PROVIDER PROFILE'}</small><h3>{isCreating ? '创建新的 V3 Provider' : selected?.display_name || '选择 Provider'}</h3></div>{selected && <div className="settings-editor-actions"><button onClick={async () => { setProbePendingId(selected.id); try { await onProbe(selected.id); } finally { setProbePendingId(null); } }} disabled={busy}>连接探测</button>{!['openai-default', 'jimeng-default', 'opencode-default'].includes(selected.id) && <button className="danger-button" onClick={() => onDeleteProvider(selected.id)} disabled={busy}>删除配置</button>}</div>}</div>
         {selected && <section className={`settings-connection-result ${probeStatusClass}`} role="status" aria-live="polite"><div className="settings-connection-heading"><small>CONNECTION STATUS</small><strong>{probeStatus}</strong><span>{probe?.error ? String(probe.error) : probePending ? '正在验证接入点、认证与可用模型，请稍候…' : probe?.ok === true ? 'Provider 已响应，下面的数据来自最近一次探测。' : '点击右上角“连接探测”获取实时状态。'}</span></div><dl><div><dt>延迟</dt><dd>{probe?.latency_ms != null ? `${Number(probe.latency_ms)} ms` : '—'}</dd></div><div><dt>可用模型</dt><dd>{probeModels.length ? `${probeModels.length} 个` : '—'}</dd></div><div><dt>声明能力</dt><dd>{probeCapabilities.length ? probeCapabilities.map((capability) => settingsCapabilityLabels[String(capability)] || String(capability)).join('、') : '—'}</dd></div><div><dt>最近检测</dt><dd>{probe?.checked_at ? new Date(Number(probe.checked_at) * 1000).toLocaleString('zh-CN') : '—'}</dd></div>{probe?.server_version != null && <div><dt>Server 版本</dt><dd>{String(probe.server_version)}</dd></div>}</dl></section>}
          <div className="settings-form-grid"><label>显示名称<input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label><label>Provider 类型<select value={draft.providerType} disabled={!isCreating} onChange={(event) => setDraft({ ...draft, providerType: event.target.value, capabilities: [] })}>{settingsProviderTypes.map((type) => <option key={type} value={type}>{settingsProviderLabels[type]}</option>)}</select></label>{draft.providerType === 'jimeng_cli' ? <label className="settings-wide">CLI 可执行文件（只填写程序路径）<input value={draft.cliExecutable} onChange={(event) => setDraft({ ...draft, cliExecutable: event.target.value })} placeholder="dreamina 或 dreamina.exe 的完整路径" /><small className="settings-field-help">不要把 curl 安装命令填在这里；安装命令请在终端执行，成功后这里保持为 dreamina。</small></label> : <label className="settings-wide">Base URL<input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://… 或本机 http://127.0.0.1…" /></label>}</div>
         <div className="settings-capability-picker"><span>声明能力</span>{Object.entries(settingsCapabilityLabels).map(([capability, label]) => { const supported = supportedCapabilities.includes(capability); return <label className={supported ? '' : 'unsupported'} key={capability}><input type="checkbox" checked={draft.capabilities.includes(capability)} disabled={!supported} onChange={() => toggleCapability(capability)} />{label}{!supported && <small>不支持</small>}</label>; })}{unsupportedSelectedCapabilities.length > 0 && <p className="settings-capability-help">当前配置中存在不受此 Provider 适配器支持的能力，保存时会自动忽略这些选项。</p>}<p className="settings-capability-explain">{draft.providerType === 'opencode' ? '这里表示 Provider 适配器可以承担的能力，不是单个 Go 模型的媒体生成能力。OpenCode Go 负责文本编排；图片、视频、声音等任务会按能力绑定交给其他 Provider。' : '这里表示当前 Provider 适配器可以承担的能力；具体模型仍以连接探测和能力绑定为准。'}</p></div>
         <label className="settings-toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用此 Provider（停用后不可被能力路由选择）</label>
         {draft.providerType === 'opencode' && <div className="settings-agent-form"><div className="settings-subheading"><small>OPENCODE AGENT</small><h4>Agent 接入参数</h4></div><div className="settings-form-grid"><label>Server 用户名<input value={draft.serverUsername} onChange={(event) => setDraft({ ...draft, serverUsername: event.target.value })} /></label><label>Agent<input value={draft.agent} onChange={(event) => setDraft({ ...draft, agent: event.target.value })} /></label><label>思考强度<select value={draft.thinkingStrength} onChange={(event) => setDraft({ ...draft, thinkingStrength: event.target.value })}><option value="auto">自动（跟随模型）</option><option value="low">低 · 快速响应</option><option value="medium">中 · 平衡</option><option value="high">高 · 深度规划</option><option value="max">最大 · 复杂创作 / QA</option></select></label><label className="settings-wide">主力模型<select value={draft.preferredModel} onChange={(event) => setDraft({ ...draft, preferredModel: event.target.value })} disabled={!opencodeModelOptions.length}><option value="">{opencodeModelOptions.length ? '请选择主力模型' : '请先连接探测模型'}</option>{opencodeModelOptions.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label></div>{selectedGoModel && <div className="settings-go-model-card"><div className="settings-go-model-heading"><span>FRAMEFLOW 调度建议</span><strong>{selectedGoModel.name}</strong></div><div className="settings-go-model-focus"><small>更偏向视频制作</small><b>{selectedGoModel.focus}</b></div><p>{selectedGoModel.note}</p>{selectedGoModel.quota && <small className="settings-go-model-quota">官方典型额度：每 5 小时约 {selectedGoModel.quota} 次请求</small>}</div>}{draft.preferredModel && !selectedGoModel && <div className="settings-go-model-card settings-go-model-card-warning"><div className="settings-go-model-heading"><span>当前配置</span><strong>{draft.preferredModel}</strong></div><p>该模型不在当前 OpenCode Go 官方目录中。重新探测后可切换到上方 Go 模型组合。</p></div>}<p className="settings-help">模型列表来自 OpenCode Go 官方组合；“思考强度”会作为 OpenCode 的 variant 参数发送。“更偏向视频制作”是 FRAMEFLOW 的调度建议，不代表模型原生支持图片或视频生成。保存后会写入 OpenCode 的编排模型配置，并自动同步“编排 Agent”能力绑定。</p></div>}
          {draft.providerType === 'jimeng_cli' && <div className="settings-agent-form"><div className="settings-subheading"><small>DREAMINA CLI</small><h4>即梦视频模型</h4></div><label className="settings-wide">默认模型<select className="settings-jimeng-model-select" value={draft.preferredModel || 'seedance2.0fast'} onChange={(event) => setDraft({ ...draft, preferredModel: event.target.value })}>{JIMENG_VIDEO_MODELS.map((model) => <option key={model.id} value={model.id}>{model.id} · {model.description}</option>)}</select></label><p className="settings-help">模型列表已按当前 dreamina CLI 帮助同步；VIP、图生/首尾帧专用模型会在不匹配的生成模式下被后端拦截。安装命令请在终端执行，不要填入上方路径。登录命令：dreamina login --headless。</p></div>}
          <label className="settings-json-field">扩展配置 JSON<textarea value={draft.modelConfig} onChange={(event) => setDraft({ ...draft, modelConfig: event.target.value })} spellCheck={false} /></label>
         <div className="settings-save-row"><button className="settings-primary" onClick={saveProvider} disabled={busy || !draft.displayName.trim() || !draft.baseUrl.trim()}>{isCreating ? '创建 Provider' : '保存 Provider 配置'}</button>{saveFeedback && <span className={`settings-save-feedback ${saveFeedback.kind}`} role="status">{saveFeedback.text}</span>}</div>
        {!isCreating && selected && (selected.provider_type === 'jimeng_cli' ? <section className="settings-credential-card"><div className="settings-subheading"><small>LOCAL CLI LOGIN</small><h4>即梦本机登录态</h4><p>{selected.credential_configured ? 'CLI 已检测到本机登录态。' : '不填写 API Key；请先安装官方 CLI，并运行 dreamina login 或 dreamina login --headless。'}</p></div><small className="settings-security-note">登录态由官方 dreamina CLI 自己管理，FrameFlow 不读取、不保存 Cookie 或 token。</small></section> : <section className="settings-credential-card"><div className="settings-subheading"><small>CREDENTIALS</small><h4>系统凭据库</h4><p>{selected.credential_configured ? `当前状态：已配置 ${selected.credential_mask || '••••••••'}` : selected.provider_type === 'opencode' || selected.provider_type === 'comfyui' ? '当前 Provider 可以不配置密钥，连接由本地服务决定。' : '当前状态：未配置 API Key'}</p></div><div className="settings-credential-actions"><input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="输入后仅写入系统凭据库，不会保存到网页" autoComplete="off"/><button onClick={() => { onWriteCredential(selected.id, secret); setSecret(''); }} disabled={busy || !secret}>写入凭据库</button><select value={environmentVariable} onChange={(event) => setEnvironmentVariable(event.target.value)}><option>{settingsEnvForType[selected.provider_type] || 'OPENAI_API_KEY'}</option><option>OPENAI_API_KEY</option><option>DEEPSEEK_API_KEY</option><option>OPENCODE_SERVER_PASSWORD</option><option>COMFYUI_API_KEY</option></select><button onClick={() => onImportCredential(selected.id, environmentVariable)} disabled={busy}>导入环境变量</button><button className="danger-button" onClick={() => onClearCredential(selected.id)} disabled={busy}>清除系统凭据</button></div><small className="settings-security-note">API Key 不回显、不进入项目 JSON、运行快照、日志、前端 localStorage 或 Provider 探测结果。</small></section>)}
       </div>
       <aside className="settings-routing" aria-label="Capability routing"><div className="settings-column-heading"><div><small>CAPABILITY ROUTING</small><h3>能力绑定</h3></div><button onClick={onAutoMatch} disabled={busy}>补齐自动推荐</button></div><p className="settings-help">{settings.routing_policy || '先按 Provider 能力和状态自动匹配，再允许手动调整。'} 每项能力只保存一个默认 Provider + model；手动调整后点击“保存绑定”即可用于调试。</p>{settings.capabilities.map((capability) => { const binding = selectedBinding(capability); const candidates = providers.filter((provider) => provider.enabled && provider.contract?.capabilities.includes(capability)); const provider = providers.find((item) => item.id === binding.providerId); const models = provider?.models || []; return <div className="settings-binding-row" key={capability}><label>{settingsCapabilityLabels[capability] || capability}<select value={binding.providerId} onChange={(event) => updateBindingDraft(capability, { providerId: event.target.value, model: '' })}><option value="">未绑定</option>{candidates.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label><label>模型<select value={binding.model} onChange={(event) => updateBindingDraft(capability, { model: event.target.value })}><option value="">Provider 默认</option>{(models.length ? models : capability === 'orchestrator' ? settings.orchestrator_models.models.map((item) => item.id) : []).map((model) => <option key={model} value={model}>{model}</option>)}</select></label><button onClick={() => onBind(capability, binding.providerId, binding.model || null)} disabled={busy || !binding.providerId}>保存绑定</button></div>; })}</aside>
    </div>
    <section className="settings-security-panel"><div><small>SECURITY BOUNDARY</small><h3>安全与费用规则</h3></div><ul><li>付费媒体调用必须通过 V3 审批门，设置页不会直接触发生成。</li><li>密钥只进入系统凭据库；清除操作只清除系统存储，不修改环境变量。</li><li>Provider 探测只展示脱敏状态、延迟、能力和模型目录。</li><li>新结果保留为独立版本；设置变更不会覆盖项目、资产或时间线内容。</li></ul></section>
  </section>;
}

const terminalRunStatuses = new Set(['succeeded', 'failed', 'canceled']);

function runStatusLabel(status: string): string {
  return {
    awaiting_confirmation: '等待确认',
    queued: '排队中',
    running: '运行中',
    paused: '已暂停',
    succeeded: '已完成',
    failed: '失败',
    canceled: '已取消',
  }[status] || status;
}

function Studio() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [archivedProjects, setArchivedProjects] = useState<ProjectRecord[]>([]);
  const [projectId, setProjectId] = useState('');
  const [dashboard, setDashboard] = useState<DashboardEnvelope | null>(null);
  const [dashboardError, setDashboardError] = useState('');
  const [graphEnvelope, setGraphEnvelope] = useState<GraphEnvelope | null>(null);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [mode, setMode] = useState<StudioMode>('home');
  const [timelineEnvelope, setTimelineEnvelope] = useState<TimelineEnvelope | null>(null);
  const [timelinePreflight, setTimelinePreflight] = useState<TimelinePreflight | null>(null);
  const [timelineDirty, setTimelineDirty] = useState(false);
  const [renderJob, setRenderJob] = useState<RenderJob | null>(null);
  const [story, setStory] = useState<StoryEnvelope | null>(null);
  const [assetLibrary, setAssetLibrary] = useState<AssetLibraryEnvelope | null>(null);
  const [audioStudio, setAudioStudio] = useState<AudioStudioEnvelope | null>(null);
  const [audioDirty, setAudioDirty] = useState(false);
  const [assetAudit, setAssetAudit] = useState<AssetAuditEnvelope | null>(null);
  const [assetLibraryFilter, setAssetLibraryFilter] = useState<AssetLibraryStatusFilter>('all');
  const [assetLibraryScope, setAssetLibraryScope] = useState<AssetLibraryScope>('all');
  const [assetLibrarySearch, setAssetLibrarySearch] = useState('');
  const [assetLibrarySort, setAssetLibrarySort] = useState<AssetSort>('priority');
  const [assetBoardEnvelope, setAssetBoardEnvelope] = useState<AssetBoardEnvelope | null>(null);
  const [assetBoardNodes, setAssetBoardNodes] = useState<AssetFlowNode[]>([]);
  const [assetBoardEdges, setAssetBoardEdges] = useState<Edge[]>([]);
  const [assetBoardSelectedKey, setAssetBoardSelectedKey] = useState<AssetBoardSelectionKey | null>(null);
  const [assetBoardDirty, setAssetBoardDirty] = useState(false);
  const [assetBoardFilter, setAssetBoardFilter] = useState('all');
  const [assetBoardShowShots, setAssetBoardShowShots] = useState(true);
  const [assetBoardOnlyBlocked, setAssetBoardOnlyBlocked] = useState(false);
  const [assetBoardShowCandidates, setAssetBoardShowCandidates] = useState(true);
  const [assetBoardShotId, setAssetBoardShotId] = useState('');
  const [assetBoardToolbarOpen, setAssetBoardToolbarOpen] = useState<AssetBoardToolbarMenu>(null);
  const [assetBoardLayoutPreset, setAssetBoardLayoutPreset] = useState<AssetGridPreset>('standard');
  const [assetBoardLayoutMode, setAssetBoardLayoutMode] = useState<AssetBoardLayoutMode>('adaptive');
  const [assetBoardColumnWidth, setAssetBoardColumnWidth] = useState(310);
  const [assetBoardColumnWidths, setAssetBoardColumnWidths] = useState<AssetBoardColumnWidths>(defaultAssetBoardColumnWidths);
  const assetBoardEnvelopeRef = useRef<AssetBoardEnvelope | null>(null);
  const assetBoardNodesRef = useRef<AssetFlowNode[]>([]);
  const assetBoardSelectedKeyRef = useRef<AssetBoardSelectionKey | null>(null);
    const refreshAssetBoardRef = useRef<((preserveLayout?: boolean, libraryOverride?: AssetLibraryEnvelope, selectedAssetId?: string | null) => Promise<AssetBoardEnvelope | null>) | null>(null);
  const assetBoardColumnWidthsRef = useRef<AssetBoardColumnWidths>(defaultAssetBoardColumnWidths);
  assetBoardEnvelopeRef.current = assetBoardEnvelope;
  assetBoardNodesRef.current = assetBoardNodes;
  assetBoardSelectedKeyRef.current = assetBoardSelectedKey;
  assetBoardColumnWidthsRef.current = assetBoardColumnWidths;
  const [assetBoardGap, setAssetBoardGap] = useState(16);
  const [assetBoardCollapsedScopes, setAssetBoardCollapsedScopes] = useState<Record<string, string | true>>({});
  const [assetBoardLocator, setAssetBoardLocator] = useState('');
  const [assetBoardIndexOpen, setAssetBoardIndexOpen] = useState(false);
  const [assetBoardIndexPosition, setAssetBoardIndexPosition] = useState({ x: 11, y: 100 });
  const [assetBoardDirectoryQuery, setAssetBoardDirectoryQuery] = useState('');
  const [focusAssetId, setFocusAssetId] = useState('');
  const [assetProductionFocus, setAssetProductionFocus] = useState<AssetProductionFocus>(null);
  const [assetPromptDraft, setAssetPromptDraft] = useState<{ assetId: string; prompt: string } | null>(null);
  const [settings, setSettings] = useState<SettingsEnvelope | null>(null);
  const [storyRun, setStoryRun] = useState<StoryRun | null>(null);
  const [storyDiff, setStoryDiff] = useState<StoryDiff | null>(null);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('V3 工作台已连接');
  const [storyDirty, setStoryDirty] = useState(false);
  const [newEdgeRelation, setNewEdgeRelation] = useState<EdgeRelation>('execution');
  const [agentPlan, setAgentPlan] = useState<AgentPlan | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [assistantSkillId, setAssistantSkillId] = useState('video-script-storyboard');
  const [workflowManifests, setWorkflowManifests] = useState<WorkflowManifest[]>([]);
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [paidConfirmation, setPaidConfirmation] = useState<{ estimate: RunEstimate; graphRevision: number; nodeIds: string[] } | null>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; message: string; confirmLabel: string; danger?: boolean; resolve: (value: boolean) => void } | null>(null);
  const requestConfirmation = useCallback((title: string, message: string, confirmLabel = '确认', danger = false) => new Promise<boolean>((resolve) => setConfirmation({ title, message, confirmLabel, danger, resolve })), []);
  const closeConfirmation = useCallback((accepted: boolean) => { confirmation?.resolve(accepted); setConfirmation(null); }, [confirmation]);
  const [assetCreateOpen, setAssetCreateOpen] = useState(false);
  const [assetImportOpen, setAssetImportOpen] = useState(false);
  const [assetCreateDraft, setAssetCreateDraft] = useState({ name: '', assetClass: 'character', assetRole: 'identity', grade: 'B', required: true, shotId: '' });
  const [assetPlacement, setAssetPlacement] = useState<AssetPlacement | null>(null);
  const [assetContextMenu, setAssetContextMenu] = useState<{ x: number; y: number; target: AssetBoardContextTarget } | null>(null);
  const editorHistory = useRef<{ past: EditorSnapshot[]; future: EditorSnapshot[] }>({ past: [], future: [] });
  const dragSnapshot = useRef<EditorSnapshot | null>(null);
  const assetClipboard = useRef<AssetFlowNode[]>([]);
  const workflowClipboard = useRef<FlowNode[]>([]);
  const assetBoardHistory = useRef<{ past: AssetBoardEditorSnapshot[]; future: AssetBoardEditorSnapshot[] }>({ past: [], future: [] });
  const assetBoardDragSnapshot = useRef<AssetBoardEditorSnapshot | null>(null);
  const assetBoardIndexDrag = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const assetBoardIndexClickSuppressed = useRef(false);
  const generateAssetPromptRef = useRef<(assetId: string) => void>(() => undefined);
  const projectLoadSequence = useRef(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const clearAssetBoardHistory = useCallback(() => {
    assetBoardHistory.current = { past: [], future: [] };
    assetBoardDragSnapshot.current = null;
  }, []);

  const project = projects.find((item) => item.document.id === projectId);
  const currentPageDirty = mode === 'story' ? storyDirty : mode === 'timeline' ? timelineDirty : mode === 'canvas' ? assetBoardDirty : mode === 'audio' ? audioDirty : dirty;
  const selectedNodeIds = useMemo(() => nodes.filter((node) => node.selected).map((node) => node.id), [nodes]);
  const selectedEdgeIds = useMemo(() => edges.filter((edge) => edge.selected).map((edge) => edge.id), [edges]);
  const selectedEdge = useMemo(() => selectedEdgeIds.length === 1 ? edges.find((edge) => edge.id === selectedEdgeIds[0]) : undefined, [edges, selectedEdgeIds]);
  const selectedNode = useMemo(() => nodes.find((node) => node.selected), [nodes]);
  const selectedAssetBoardCards = useMemo(() => getSelectedAssetBoardCards(assetBoardNodes), [assetBoardNodes]);
  const selectedAssetBoardNode = useMemo(() => singleSelectedAssetBoardCard(assetBoardNodes), [assetBoardNodes]);
  const selectedProductionAsset = useMemo(() => {
    const assetId = selectedAssetBoardNode?.data.asset_id;
    return assetId ? assetLibrary?.assets.find((asset) => asset.id === assetId) : undefined;
  }, [assetBoardNodes, assetLibrary?.assets, selectedAssetBoardNode]);
  const setAssetBoardSelection = useCallback((selectionKey: AssetBoardSelectionKey | null) => {
    assetBoardSelectedKeyRef.current = selectionKey;
    setAssetBoardSelectedKey((current) => current === selectionKey ? current : selectionKey);
  }, []);
  const onAssetBoardNodeClick = useCallback((event: React.MouseEvent, node: AssetFlowNode) => {
    if (!['asset', 'handoff', 'artifact'].includes(String(node.data.node_type))) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, input, textarea, select, label, a')) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey) return;
    const selectionKey = assetBoardSelectionKey(node);
    if (!selectionKey) return;
    setAssetBoardNodes((current) => applyAssetBoardSelection(current, selectionKey));
    setAssetBoardSelection(selectionKey);
  }, [setAssetBoardSelection]);
  useEffect(() => {
    const selected = getSelectedAssetBoardCards(assetBoardNodes);
    if (selected.length === 1) {
      setAssetBoardSelection(assetBoardSelectionKey(selected[0]));
      return;
    }
    if (selected.length > 1) {
      setAssetBoardSelection(null);
      return;
    }
    const selectionKey = assetBoardSelectedKeyRef.current;
    if (!selectionKey) return;
    const restored = applyAssetBoardSelection(assetBoardNodes, selectionKey);
    if (restored.some((node, index) => node.selected !== assetBoardNodes[index]?.selected)) {
      setAssetBoardNodes(restored);
      return;
    }
    setAssetBoardSelection(null);
  }, [assetBoardNodes, setAssetBoardSelection]);
  const generatePromptFromBoard = useCallback((assetId: string) => { generateAssetPromptRef.current(assetId); }, []);
  useEffect(() => {
    if (!assetProductionFocus || selectedProductionAsset?.id !== assetProductionFocus.assetId) return;
    const frame = window.requestAnimationFrame(() => {
      const selector = assetProductionFocus.target === 'prompt' ? '[data-asset-production-prompt]' : '[data-asset-production-upload]';
      const target = document.querySelector<HTMLElement>(selector);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (assetProductionFocus.target === 'prompt' && target instanceof HTMLTextAreaElement) target.focus();
      setAssetProductionFocus(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [assetProductionFocus, selectedProductionAsset?.id]);
  const assistantContext = useMemo(() => ({
    active_view: mode,
    selected_node_ids: selectedNodeIds,
    selected_edge_ids: selectedEdgeIds,
    selected_asset_id: selectedProductionAsset?.id || null,
    revisions: {
      project: project?.revision || null,
      graph: graphEnvelope?.revision || null,
      story: story?.revision || null,
      asset_library: project?.revision || null,
      asset_board: assetBoardEnvelope?.revision || null,
      timeline: timelineEnvelope?.revision || null,
    },
    pending_changes: { graph: dirty, story: storyDirty, asset_board: assetBoardDirty, timeline: timelineDirty },
    project_document: project?.document || null,
    story_document: story?.story || null,
    asset_library: assetLibrary || null,
    asset_board: assetBoardEnvelope?.board || null,
    timeline_document: timelineEnvelope?.document || null,
    workflow_graph: graphEnvelope?.graph || null,
    video_skill_chain: workflowManifests,
  }), [assetBoardDirty, assetBoardEnvelope?.board, assetBoardEnvelope?.revision, assetLibrary, dirty, graphEnvelope?.graph, graphEnvelope?.revision, mode, project?.document, project?.revision, selectedEdgeIds, selectedNodeIds, selectedProductionAsset?.id, story?.revision, story?.story, storyDirty, timelineDirty, timelineEnvelope?.document, timelineEnvelope?.revision, workflowManifests]);
  const selectedFusionSources = useMemo(() => {
    if (!selectedProductionAsset || selectedProductionAsset.assetClass !== 'fusion') return [];
    // The asset board is the source of truth for the current connection set.
    // Persisted fusionSourceAssetIds remain lineage metadata, not an
    // implicit replacement for a user's current canvas connections.
    const sourceIds = new Set<string>();
    const flowNodesById = new Map(assetBoardNodes.map((node) => [node.id, node]));
    const assetClassFor = (node?: AssetFlowNode) => node?.data.asset_id ? String(assetLibrary?.assets.find((asset) => asset.id === node.data.asset_id)?.assetClass || node.data.config.asset_class || '') : '';
    for (const edge of assetBoardEdges) {
      const source = flowNodesById.get(edge.source);
      const target = flowNodesById.get(edge.target);
      const relation = String(edge.data?.relation || '');
      const targetIsFusion = target?.data.node_type === 'asset' && target.data.asset_id === selectedProductionAsset.id && assetClassFor(target) === 'fusion';
      if (targetIsFusion && source?.data.asset_id && assetClassFor(source) !== 'fusion' && relation === 'fusion_input') sourceIds.add(String(source.data.asset_id));
      const sourceIsFusion = source?.data.node_type === 'asset' && source.data.asset_id === selectedProductionAsset.id && assetClassFor(source) === 'fusion';
      if (sourceIsFusion && target?.data.asset_id && assetClassFor(target) !== 'fusion' && relation === 'fusion_input') sourceIds.add(String(target.data.asset_id));
    }
    const board = assetBoardEnvelope?.board;
    if (board) {
      const nodesById = new Map(board.nodes.map((node) => [node.id, node]));
      const boardAssetClassFor = (node?: AssetBoardNode) => node?.asset_id ? String(assetLibrary?.assets.find((asset) => asset.id === node.asset_id)?.assetClass || node.config.asset_class || '') : '';
      for (const edge of board.edges.filter((candidate) => candidate.relation === 'fusion_input')) {
        const source = nodesById.get(edge.source);
        const target = nodesById.get(edge.target);
        if (target?.node_type === 'asset' && target.asset_id === selectedProductionAsset.id && boardAssetClassFor(target) === 'fusion' && source?.asset_id && boardAssetClassFor(source) !== 'fusion' && edge.relation === 'fusion_input') sourceIds.add(String(source.asset_id));
        if (source?.node_type === 'asset' && source.asset_id === selectedProductionAsset.id && boardAssetClassFor(source) === 'fusion' && target?.asset_id && boardAssetClassFor(target) !== 'fusion' && edge.relation === 'fusion_input') sourceIds.add(String(target.asset_id));
      }
    }
    return (assetLibrary?.assets || []).filter((asset) => sourceIds.has(asset.id));
  }, [assetBoardEdges, assetBoardEnvelope?.board, assetBoardNodes, assetLibrary?.assets, selectedProductionAsset?.assetClass, selectedProductionAsset?.id]);

  const openAssetContextMenu = (target: AssetBoardContextTarget) => {
    setAssetContextMenu({ x: target.x, y: target.y, target });
  };

  const copyAssetPromptCard = async (assetId: string) => {
    const asset = assetLibrary?.assets.find((item) => item.id === assetId);
    if (!asset?.prompt) { setNotice('当前资产没有可复制的 Prompt。'); return; }
    const fullPrompt = composeAssetPrompt(asset, story, asset.prompt);
    try {
      await navigator.clipboard.writeText(fullPrompt);
      const opened = window.open('https://chatgpt.com/', '_blank', 'noopener,noreferrer');
      setNotice(opened
        ? `「${asset.name || asset.id}」Prompt 已复制，ChatGPT 已打开；生成后请把图片导回该资产卡`
        : `「${asset.name || asset.id}」Prompt 已复制；浏览器阻止了新标签页，请手动打开 ChatGPT`);
    } catch {
      setNotice('浏览器未授权剪贴板，请在右侧资产面板手动复制。');
    }
  };

  const refreshPromptBoard = async (library: AssetLibraryEnvelope) => {
    if (!projectId) return;
    const board = await studioApi.assetBoard(projectId);
      const boardNodes = assetBoardToFlowNodes(board.board, library.assets, assetBoardFilter, assetBoardShowShots, story?.story.shots || [], { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
    setAssetBoardEnvelope(board); setAssetBoardNodes(boardNodes); setAssetBoardEdges(assetBoardToFlowEdges(board.board, boardNodes)); setAssetBoardDirty(false);
  };

  const approveAssetPromptCard = async (assetId: string) => {
    if (!projectId) return;
    const asset = assetLibrary?.assets.find((item) => item.id === assetId);
    const promptVersion = String(asset?.promptVersion || '');
    if (!promptVersion) { setNotice('当前 Prompt 卡缺少版本号，无法进入 QA。'); return; }
    if (!(await requestConfirmation('确认 Prompt QA', `确认通过「${asset?.name || assetId}」的 Prompt QA？通过后仍需再次确认，才会调用图像生成。`, '通过 QA'))) return;
    setBusy(true);
    try {
      await studioApi.approveAssetPrompt(projectId, promptVersion);
      const [library, projectEnvelope] = await Promise.all([studioApi.assetLibrary(projectId), studioApi.projects()]);
      setAssetLibrary(library); setProjects(projectEnvelope.projects); await refreshPromptBoard(library); setNotice(`Prompt QA 已通过 · ${asset?.name || assetId} · 等待用户确认图像生成`);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };

  const generateAssetImageCard = async (assetId: string) => {
    if (!projectId) return;
    const asset = assetLibrary?.assets.find((item) => item.id === assetId);
    if (!asset?.prompt || asset.promptQaDecision !== 'Approved') { setNotice('请先通过当前资产的 Prompt QA。'); return; }
    const confirmed = await requestConfirmation('确认图像生成', `将使用 Codex Image 生成「${asset.name || assetId}」并产生费用。生成结果会进入待图片 QA，不会直接登记为就绪资产。是否确认？`, '确认生成', true);
    if (!confirmed) { setNotice('已取消图像生成，仍保留 Prompt 卡。'); return; }
    setBusy(true);
    try {
      const result = await studioApi.generateAssetImage(projectId, assetId, { prompt: asset.prompt, prompt_version: asset.promptVersion, size: '1024x1024', quality: 'medium', confirmed: true });
      const [library, projectEnvelope] = await Promise.all([studioApi.assetLibrary(projectId), studioApi.projects()]);
      setAssetLibrary(library); setProjects(projectEnvelope.projects); await refreshPromptBoard(library); setNotice(`图像候选已生成 · ${String(result.artifact?.id || result.artifact_id || 'artifact')} · 待图片 QA 与资产登记`);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!assetContextMenu) return;
    const close = (event: PointerEvent) => {
      const element = event.target as HTMLElement | null;
      if (!element?.closest('.asset-context-menu')) setAssetContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setAssetContextMenu(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', closeOnEscape); };
  }, [assetContextMenu]);

  async function assignAssetToShot(shotId: string, overrides: AssetAssignmentOverrides = {}) {
    const currentBoardEnvelope = overrides.boardEnvelope || assetBoardEnvelope;
    const currentStory = overrides.storyEnvelope || story;
    const currentLibrary = overrides.library || assetLibrary;
    const pending = overrides.pending || assetPlacement;
    if (!pending || !projectId || !project || !currentStory || !currentBoardEnvelope) return;
    const normalizedShotId = String(shotId).toUpperCase();
    if (normalizedShotId === 'SHARED') {
      setNotice('请点击具体镜头行完成资产归属，SHARED 只是待分配区域');
      return;
    }
    const shotNode = currentBoardEnvelope.board.nodes.find((node) => node.node_type === 'shot' && String(node.shot_id || '').toUpperCase() === normalizedShotId);
    const assetNode = currentBoardEnvelope.board.nodes.find((node) => node.node_type === 'asset' && node.asset_id === pending.assetId);
    const shot = currentStory.story.shots.find((item) => String(item.id).toUpperCase() === normalizedShotId);
    if (!shotNode || !assetNode || !shot) {
      setNotice(`没有找到 ${normalizedShotId} 对应的镜头，请点击镜头执行单元行`);
      return;
    }
    const alreadyAssigned = currentStory.story.shots.some((item) => Array.isArray(item.assetRequirements) && item.assetRequirements.some((requirement: any) => String(requirement?.assetId || '') === pending.assetId && String(item.id).toUpperCase() === normalizedShotId));
    if (alreadyAssigned && pending.mode === 'assign') {
      setAssetPlacement(null);
      setNotice(`${pending.name} 已经属于 ${normalizedShotId}`);
      return;
    }
    setBusy(true);
    try {
      const libraryAsset = currentLibrary?.assets.find((asset) => asset.id === pending.assetId);
      const assigned = await studioApi.assignAsset(projectId, { expected_project_revision: overrides.projectRevision ?? project.revision, expected_board_revision: currentBoardEnvelope.revision, asset_id: pending.assetId, shot_id: normalizedShotId, mode: pending.mode, role: `${assetClassLabels[String(libraryAsset?.assetClass || assetNode.config.asset_class || 'unknown')] || '资产'}镜头依赖`, required: true, required_readiness: 'production' });
      const synced = assigned.asset_board;
      const boardNodes = assetBoardToFlowNodes(synced.board, assigned.library.assets, assetBoardFilter, assetBoardShowShots, assigned.story.shots, { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
      setStory({ ...currentStory, story: assigned.story, revision: assigned.project_revision });
      setStoryDirty(false);
      setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: assigned.project_revision } : item));
      setAssetLibrary(assigned.library);
      setAssetBoardEnvelope(synced);
      setAssetBoardNodes(boardNodes);
      setAssetBoardEdges(assetBoardToFlowEdges(synced.board, boardNodes));
      setAssetBoardDirty(false);
      setAssetPlacement(null);
      setNotice(`${pending.name} 已${pending.mode === 'move' ? '移动并' : '分配到'} ${normalizedShotId}，已加入 ${normalizedShotId} 分镜资产组`);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function toggleAssetBoardScope(target: AssetBoardCollapseTarget) {
    if (assetPlacement && target.type === 'shot') {
      void assignAssetToShot(target.id);
      return;
    }
    const key = target.scopeKey || `${target.type}:${target.id}`;
    setAssetBoardCollapsedScopes((current) => {
      if (current[key]) {
        const next = { ...current };
        delete next[key];
        setNotice(target.type === 'shot' ? `${target.id} 已展开` : '资产内容已展开');
        return next;
      }
      const next: Record<string, string | true> = { ...current, [key]: target.keepNodeId ? target.keepNodeId : true };
      setNotice(target.type === 'shot' ? `${target.id} 已收起关联资产` : '资产下游内容已收起');
      return next;
    });
  }
  const focusAssetBoardTarget = useCallback((target: string) => {
    const normalized = target.trim();
    if (!normalized) return;
    const node = assetBoardNodes.find((candidate) => !candidate.data.presentationOnly && (candidate.id === normalized || candidate.data.shot_id === normalized || candidate.data.asset_id === normalized || String(candidate.data.config.grid_row_key || '') === normalized));
    if (!node) {
      setNotice(`没有找到“${normalized}”对应的画布节点`);
      return;
    }
    setAssetBoardLocator(normalized);
    setNotice(`已定位：${node.data.label}`);
  }, [assetBoardNodes]);
  const clampAssetBoardIndexPosition = useCallback((x: number, y: number) => {
    const canvas = document.querySelector('.asset-board-wrap');
    const rect = canvas?.getBoundingClientRect();
    const maxX = Math.max(8, (rect?.width || window.innerWidth) - 52);
    const maxY = Math.max(58, (rect?.height || window.innerHeight) - 64);
    return { x: Math.min(maxX, Math.max(8, x)), y: Math.min(maxY, Math.max(58, y)) };
  }, []);
  const updateAssetBoardIndexPosition = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const origin = assetBoardIndexPosition;
    assetBoardIndexDrag.current = { startX: event.clientX, startY: event.clientY, originX: origin.x, originY: origin.y, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const drag = assetBoardIndexDrag.current;
      if (!drag) return;
      const dx = moveEvent.clientX - drag.startX;
      const dy = moveEvent.clientY - drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
      const next = clampAssetBoardIndexPosition(drag.originX + dx, drag.originY + dy);
      setAssetBoardIndexPosition(next);
      if (assetBoardEnvelope) {
        setAssetBoardEnvelope((current) => current ? { ...current, board: { ...current.board, metadata: { ...current.board.metadata, layout_directory_position: next } } } : current);
        setAssetBoardDirty(true);
      }
    };
    const stop = () => {
      const drag = assetBoardIndexDrag.current;
      assetBoardIndexClickSuppressed.current = Boolean(drag?.moved);
      assetBoardIndexDrag.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  }, [assetBoardEnvelope, assetBoardIndexPosition, clampAssetBoardIndexPosition]);
  const openAssetProductionShortcut = useCallback((assetId: string, target: 'prompt' | 'upload', nodeId?: string) => {
    const currentEnvelope = assetBoardEnvelopeRef.current;
    const currentNodes = assetBoardNodesRef.current;
    if (!projectId || !currentEnvelope) {
      setNotice('资产画布尚未加载完成，请稍后再试。');
      return;
    }
    const root = currentNodes.find((node) => node.id === nodeId && node.data.node_type === 'asset' && String(node.data.asset_id || '') === assetId)
      || currentNodes.find((node) => !node.data.presentationOnly && node.data.node_type === 'asset' && String(node.data.asset_id || '') === assetId);
    const rootRow = String(root?.data.config.grid_row_key || 'shared');
    const existingDraft = currentNodes.find((node) => !node.data.presentationOnly && node.data.node_type === 'handoff' && String(node.data.asset_id || '') === assetId && String(node.data.config.grid_row_key || 'shared') === rootRow && Boolean(node.data.config.prompt_card));
    const draftId = existingDraft?.id || `handoff:${assetId}:production-draft`;
    const draftPosition = existingDraft?.position || (root ? { x: root.position.x + (Number(root.style?.width) || 286) + 16, y: root.position.y } : { x: 320, y: 180 });
    const draftData: AssetBoardNodeData | null = root && !existingDraft ? {
      ...root.data,
      id: draftId,
      node_type: 'handoff',
      label: `资产 Prompt · ${root.data.label}`,
      position: draftPosition,
      config: {
        ...root.data.config,
        prompt_card: true,
        production_draft: true,
        prompt: '',
        artifact_id: '',
        artifact_url: '',
        artifact_status: '',
        prompt_qa_decision: 'Pending',
        generation_status: 'planned',
      },
    } : null;
    setMode('canvas');
    setAssetProductionFocus({ assetId, target });
    setAssetBoardNodes((current) => {
      let hasDraft = false;
      const next = current.map((node) => {
        const isRoot = node.id === root?.id;
        const isDraft = node.id === draftId;
        if (isDraft) {
          hasDraft = true;
          return { ...node, selected: false, data: { ...node.data, config: { ...node.data.config, production_draft: true } } };
        }
        return { ...node, selected: isRoot };
      });
      if (!hasDraft && draftData) {
        next.push({ id: draftId, type: 'asset-board', position: draftPosition, selected: false, draggable: false, selectable: true, style: { width: Number(root?.style?.width) || 286, zIndex: 3, opacity: 1, pointerEvents: 'auto' }, data: draftData });
      }
      return assetBoardWithFixedFrame(next, assetBoardLayoutMode, assetBoardColumnWidthsRef.current, assetBoardGap);
    });
    setAssetBoardSelection(root ? assetBoardSelectionKey(root.data) : null);
    if (root) {
      setAssetBoardEdges((current) => current.some((edge) => edge.source === root.id && edge.target === draftId) ? current : [...current, { id: `asset-edge:${root.id}:${draftId}:reference`, source: root.id, target: draftId, type: 'bezier', style: { stroke: '#7db6ff', strokeDasharray: '5 5', opacity: .72 }, data: { relation: 'reference' } }]);
    }
    const draftMetadata = { active: true, focus: target, updated_at: new Date().toISOString() };
    setBusy(true);
    studioApi.updateAssetMetadata(projectId, assetId, { ...(project?.revision ? { expected_revision: project.revision } : {}), metadata: { production_draft: draftMetadata } }).then(({ revision }) => {
      setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision } : item));
      return studioApi.assetLibrary(projectId);
    }).then((library) => {
      setAssetLibrary(library);
      const refresh = refreshAssetBoardRef.current;
      setNotice(target === 'prompt' ? '已创建生产草稿，右侧 Prompt 编辑区已定位' : '已创建生产草稿，右侧候选上传区已定位');
      return refresh ? refresh(true, library, assetId) : null;
    }).catch((error: Error) => {
      setNotice(`生产草稿保存失败：${error.message}`);
      if (!existingDraft && draftData) {
        setAssetBoardNodes((current) => current.filter((node) => node.id !== draftId));
        setAssetBoardEdges((current) => current.filter((edge) => edge.target !== draftId));
      }
    }).finally(() => setBusy(false));
  }, [assetBoardGap, assetBoardLayoutMode, projectId, project?.revision, setAssetBoardSelection]);
  const applyFixedAssetBoardFrame = useCallback((nodes: AssetFlowNode[], widths: AssetBoardColumnWidths = assetBoardColumnWidthsRef.current) => {
    return assetBoardWithFixedFrame(nodes, assetBoardLayoutMode, widths, assetBoardGap);
  }, [assetBoardGap, assetBoardLayoutMode]);
  const resizeAssetBoardColumn = useCallback((key: keyof AssetBoardColumnWidths, delta: number) => {
    const currentEnvelope = assetBoardEnvelopeRef.current;
    const currentNodes = assetBoardNodesRef.current;
    if (!currentEnvelope || !currentNodes.length) return;
    const current = assetBoardColumnWidthsRef.current;
    const stableCardWidth = assetBoardCardWidthForNodes(currentNodes);
    const minimumColumnWidths: AssetBoardColumnWidths = {
      shots: assetBoardMinimumColumnWidth('shots', stableCardWidth, assetBoardGap, assetBoardLayoutMode),
      'asset-flow': assetBoardMinimumColumnWidth('asset-flow', stableCardWidth, assetBoardGap, assetBoardLayoutMode),
      fusion: assetBoardMinimumColumnWidth('fusion', stableCardWidth, assetBoardGap, assetBoardLayoutMode),
    };
    const limits: Record<keyof AssetBoardColumnWidths, [number, number]> = { shots: [minimumColumnWidths.shots, 520], 'asset-flow': [minimumColumnWidths['asset-flow'], 1100], fusion: [minimumColumnWidths.fusion, 1100] };
    const nextWidths = { ...current, [key]: Math.min(limits[key][1], Math.max(limits[key][0], current[key] + delta)) };
    if (nextWidths[key] === current[key]) return;
    const safeNextWidths = assetBoardSafeColumnWidths(nextWidths, stableCardWidth, assetBoardGap, assetBoardLayoutMode);
    const board: AssetBoard = { ...currentEnvelope.board, metadata: { ...currentEnvelope.board.metadata, layout_column_widths: safeNextWidths, layout_column_width: Math.max(220, Math.round((safeNextWidths['asset-flow'] - assetBoardGap) / 2)) } };
    const nextNodes = currentNodes.map((node) => {
      if (node.id === 'asset-grid:table') {
        return { ...node, style: { ...node.style, width: assetBoardFixedTableWidth(assetBoardLayoutMode, safeNextWidths, assetBoardGap, stableCardWidth) }, data: { ...node.data, config: { ...node.data.config, shot_column_width: safeNextWidths.shots, asset_flow_width: safeNextWidths['asset-flow'], fusion_column_width: safeNextWidths.fusion, card_width: stableCardWidth } } };
      }
      if (node.data.presentationOnly) return node;
      return assetBoardCardIsLocked(node.data) ? node : { ...node, data: { ...node.data, config: { ...node.data.config, position_source: 'manual' } } };
    });
    setAssetBoardColumnWidths(safeNextWidths);
    setAssetBoardColumnWidth(Math.max(220, Math.round((safeNextWidths['asset-flow'] - assetBoardGap) / 2)));
    setAssetBoardEnvelope((currentEnvelope) => currentEnvelope ? { ...currentEnvelope, board } : currentEnvelope);
    setAssetBoardNodes(applyFixedAssetBoardFrame(nextNodes, safeNextWidths));
    setAssetBoardDirty(true);
  }, [applyFixedAssetBoardFrame, assetBoardLayoutMode]);
  useLayoutEffect(() => {
    setAssetBoardNodes((current) => {
      let changed = false;
       const next = current.map((node) => {
         if ((node.id !== 'asset-grid:table' && node.data.onOpenAssetProduction === openAssetProductionShortcut && node.data.onGeneratePrompt === generatePromptFromBoard) || (node.id === 'asset-grid:table' && node.data.onColumnResize === resizeAssetBoardColumn && node.data.onOpenAssetProduction === openAssetProductionShortcut && node.data.onGeneratePrompt === generatePromptFromBoard)) return node;
         changed = true;
         return { ...node, data: { ...node.data, onColumnResize: resizeAssetBoardColumn, onOpenAssetProduction: openAssetProductionShortcut, onGeneratePrompt: generatePromptFromBoard } };
       });
      return changed ? next : current;
    });
  }, [generatePromptFromBoard, openAssetProductionShortcut, resizeAssetBoardColumn]);
  const assetBoardLocatorOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: Array<{ value: string; label: string; group: 'shot' | 'asset' }> = [];
    for (const node of assetBoardNodes) {
      if (node.data.presentationOnly) continue;
      const value = node.data.node_type === 'shot' ? String(node.data.shot_id || '') : String(node.data.asset_id || '');
      if (!value || seen.has(value)) continue;
      seen.add(value);
      options.push({ value, label: node.data.node_type === 'shot' ? `${value} · ${String(node.data.config.scene || node.data.label)}` : `${String(node.data.label || value)} · ${value}`, group: node.data.node_type === 'shot' ? 'shot' : 'asset' });
    }
    return options;
  }, [assetBoardNodes]);
  const assetBoardShotDirectory = useMemo(() => {
    const query = assetBoardDirectoryQuery.trim().toLowerCase();
    return assetBoardLocatorOptions.filter((item) => item.group === 'shot' && (!query || item.value.toLowerCase().includes(query) || item.label.toLowerCase().includes(query)));
  }, [assetBoardDirectoryQuery, assetBoardLocatorOptions]);
  const historyState = useMemo(() => ({
    canUndo: editorHistory.current.past.length > 0,
    canRedo: editorHistory.current.future.length > 0,
  }), [historyRevision]);

  useEffect(() => {
    studioApi.projects().then(({ projects: items }) => {
      const normalized = items.map((item) => ({ ...item, document: { ...item.document, productionStatus: item.document.productionStatus || 'in_progress' } }));
      setProjects(normalized);
      if (normalized.length) setProjectId(normalized[0].document.id);
    }).catch((error: Error) => setNotice(error.message));
     studioApi.dashboard().then((value) => { setDashboard(value); setDashboardError(''); }).catch((error: Error) => { setDashboardError(error.message); setNotice(error.message); });
    studioApi.settings().then(setSettings).catch((error: Error) => setNotice(error.message));
    studioApi.workflows().then(({ workflows }) => setWorkflowManifests(workflows)).catch(() => setWorkflowManifests(fallbackAssistantSkills));
  }, []);

  useEffect(() => {
    if (!projectManagerOpen) {
      setArchivedProjects([]);
      return;
    }
    studioApi.projects(true).then(({ projects: items }) => setArchivedProjects(items.filter((item) => item.lifecycle_status === 'archived' || item.document.lifecycleStatus === 'archived'))).catch((error: Error) => setNotice(error.message));
  }, [projectManagerOpen]);

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    const sequence = ++projectLoadSequence.current;
    setDashboard(null);
    setDashboardError('');
    setGraphEnvelope(null);
    setTimelineEnvelope(null);
    setTimelinePreflight(null);
    setStory(null);
    setAssetLibrary(null);
    setAudioStudio(null);
    setAudioDirty(false);
    setAssetBoardEnvelope(null);
    setAssetBoardSelection(null);
    setAssetAudit(null);
    setStoryRun(null);
    setRun(null);
    setBusy(true);
    studioApi.loadProjectSnapshot(projectId, controller.signal)
      .then(({ graph: envelope, timeline: timelineEnvelope, timelinePreflight: preflight, story: storyEnvelope, storyRuns, assetLibrary: library, assetBoard, dashboard: dashboardEnvelope, assetAudit, audioStudio: audioEnvelope }) => {
        if (controller.signal.aborted || sequence !== projectLoadSequence.current) return;
        setGraphEnvelope(envelope);
        setNodes(toFlowNodes(envelope.graph));
        setEdges(toFlowEdges(envelope.graph));
        setTimelineEnvelope(timelineEnvelope);
        setTimelinePreflight(preflight);
        setTimelineDirty(false);
        setRenderJob(null);
        setStory(storyEnvelope);
        setAssetLibrary(library);
        setAudioStudio(audioEnvelope);
        setAudioDirty(false);
        setAssetAudit(assetAudit);
        setAssetBoardEnvelope(assetBoard);
        setAssetBoardCollapsedScopes({});
        setAssetBoardLocator('');
        const loadedPreset = (['compact', 'standard', 'spacious'] as AssetGridPreset[]).includes(String(assetBoard.board.metadata.layout_preset) as AssetGridPreset) ? String(assetBoard.board.metadata.layout_preset) as AssetGridPreset : 'standard';
        const loadedColumnWidth = Math.max(220, Number(assetBoard.board.metadata.layout_column_width) || assetGridPresets[loadedPreset].columnWidth);
        const loadedColumnWidths = assetBoardColumnWidthsFromMetadata(assetBoard.board.metadata, loadedColumnWidth);
        const storedIndexPosition = assetBoard.board.metadata.layout_directory_position && typeof assetBoard.board.metadata.layout_directory_position === 'object' ? assetBoard.board.metadata.layout_directory_position as Record<string, unknown> : {};
        const loadedGap = Math.max(8, Number(assetBoard.board.metadata.layout_gap) || 16);
        const loadedLayoutMode: AssetBoardLayoutMode = assetBoard.board.metadata.layout_view === 'matrix' ? 'matrix' : 'adaptive';
        const loadedCardWidth = Math.max(220, Number(assetBoard.board.metadata.layout_card_width) || assetGridPresets[loadedPreset].columnWidth - 24);
        const normalizedColumnWidths = assetBoardSafeColumnWidths(loadedColumnWidths, loadedCardWidth, loadedGap, loadedLayoutMode);
        setAssetBoardLayoutPreset(loadedPreset);
        setAssetBoardLayoutMode(loadedLayoutMode);
        setAssetBoardColumnWidth(loadedColumnWidth);
        setAssetBoardColumnWidths(normalizedColumnWidths);
        setAssetBoardGap(loadedGap);
        setAssetBoardIndexPosition(clampAssetBoardIndexPosition(Number(storedIndexPosition.x) || 11, Number(storedIndexPosition.y) || 100));
      const boardNodes = assetBoardToFlowNodes(assetBoard.board, library.assets, 'all', true, storyEnvelope.story.shots, { preset: loadedPreset, columnWidth: loadedColumnWidth, gap: loadedGap, layoutMode: loadedLayoutMode, collapsedScopes: {}, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
        setAssetBoardNodes(boardNodes);
        setAssetBoardEdges(assetBoardToFlowEdges(assetBoard.board, boardNodes));
        setAssetBoardDirty(false);
         setDashboard(dashboardEnvelope);
         setDashboardError('');
        setStoryRun(storyRuns.runs[0] || null);
        setStoryDiff(null);
        setDirty(false);
         setStoryDirty(false);
         setAgentPlan(null);
         editorHistory.current = { past: [], future: [] };
         clearAssetBoardHistory();
         dragSnapshot.current = null;
        setHistoryRevision((value) => value + 1);
        setNotice(`已加载图版本 ${envelope.revision} · 资产画布 v${assetBoard.revision}`);
      })
      .catch((error: Error) => {
        if (controller.signal.aborted || sequence !== projectLoadSequence.current) return;
        setDashboardError(error.message);
        setNotice(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted && sequence === projectLoadSequence.current) setBusy(false);
      });
    return () => controller.abort();
  }, [clearAssetBoardHistory, projectId]);

  useEffect(() => {
    if (!assetBoardEnvelope) return;
    const selectedIds = new Set(assetBoardNodes.filter((node) => node.selected).map((node) => node.id));
    const boardNodes = assetBoardToFlowNodes(assetBoardEnvelope.board, assetLibrary?.assets || [], assetBoardFilter, assetBoardShowShots, story?.story.shots || [], { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut }).map((node) => selectedIds.has(node.id) ? { ...node, selected: true } : node);
    setAssetBoardNodes(boardNodes);
    setAssetBoardEdges(assetBoardToFlowEdges(assetBoardEnvelope.board, boardNodes));
  }, [assetBoardCollapsedScopes]);

  useEffect(() => {
    if (!renderJob || !['queued', 'running'].includes(renderJob.status)) return;
    const timer = window.setTimeout(() => {
      studioApi.render(renderJob.id).then(setRenderJob).catch((error: Error) => setNotice(error.message));
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [renderJob]);

  const refreshAssetBoard = async (preserveLayout = true, libraryOverride?: AssetLibraryEnvelope, selectedAssetId?: string | null) => {
    if (!projectId) return null;
    const current = assetBoardEnvelope;
    const refreshed = current && preserveLayout
      ? await studioApi.syncAssetBoard(projectId, current.revision, true)
      : await studioApi.assetBoard(projectId);
    const assets = libraryOverride?.assets || assetLibrary?.assets || [];
    const boardNodes = assetBoardToFlowNodes(refreshed.board, assets, assetBoardFilter, assetBoardShowShots, story?.story.shots || [], { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onlyBlocked: assetBoardOnlyBlocked, showCandidates: assetBoardShowCandidates, shotId: assetBoardShotId, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
    const selectedNode = selectedAssetId ? boardNodes.find((node) => !node.data.presentationOnly && node.data.node_type === 'asset' && String(node.data.asset_id || '') === selectedAssetId) : undefined;
    const selectedSelectionKey = selectedNode ? assetBoardSelectionKey(selectedNode.data) : null;
    const nextBoardNodes = selectedSelectionKey ? applyAssetBoardSelection(boardNodes, selectedSelectionKey) : boardNodes;
    setAssetBoardEnvelope(refreshed);
    setAssetBoardNodes(nextBoardNodes);
    setAssetBoardSelection(selectedSelectionKey);
    setAssetBoardEdges(assetBoardToFlowEdges(refreshed.board, nextBoardNodes));
    setAssetBoardDirty(false);
    return refreshed;
  };
  refreshAssetBoardRef.current = refreshAssetBoard;
  const rebuildAssetBoardView = (patch: { filter?: string; showShots?: boolean; onlyBlocked?: boolean; showCandidates?: boolean; shotId?: string } = {}) => {
    if (!assetBoardEnvelope) return;
    const filter = patch.filter ?? assetBoardFilter;
    const showShots = patch.showShots ?? assetBoardShowShots;
    const onlyBlocked = patch.onlyBlocked ?? assetBoardOnlyBlocked;
    const showCandidates = patch.showCandidates ?? assetBoardShowCandidates;
    const shotId = patch.shotId ?? assetBoardShotId;
    const nextNodes = assetBoardToFlowNodes(assetBoardEnvelope.board, assetLibrary?.assets || [], filter, showShots, story?.story.shots || [], { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onlyBlocked, showCandidates, shotId, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
    setAssetBoardNodes(nextNodes); setAssetBoardEdges(assetBoardToFlowEdges(assetBoardEnvelope.board, nextNodes));
  };

  const buildAssetBoardFlow = (envelope: AssetBoardEnvelope, library: AssetLibraryEnvelope, shots: StoryShot[]) => {
    const boardNodes = assetBoardToFlowNodes(envelope.board, library.assets, assetBoardFilter, assetBoardShowShots, shots, { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
    return { boardNodes, boardEdges: assetBoardToFlowEdges(envelope.board, boardNodes) };
  };

  const deleteAssetById = async (assetId: string, fallbackLabel: string) => {
    if (!projectId || !project || !assetId) return;
    const source = assetLibrary?.assets.find((asset) => asset.id === assetId);
    const label = source?.name || fallbackLabel || assetId;
    if (!(await requestConfirmation('确认删除逻辑资产', `确认删除逻辑资产「${label}」？其画布卡片、候选和桥接内容会一并移除，已上传的物理文件会保留。`, '删除资产', true))) return;
    setBusy(true);
    try {
      const result = await studioApi.deleteAsset(projectId, assetId, project.revision);
      setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: result.revision } : item));
      setAssetLibrary(result.library);
      void studioApi.assetAudit(projectId).then(setAssetAudit).catch(() => undefined);
      if (result.story) setStory((current) => current ? { ...current, story: result.story } : current);
      const envelope = result.asset_board || await studioApi.assetBoard(projectId);
      const flow = buildAssetBoardFlow(envelope, result.library, result.story?.shots || story?.story.shots || []);
      setAssetBoardEnvelope(envelope);
      setAssetBoardNodes(flow.boardNodes);
      setAssetBoardEdges(flow.boardEdges);
      setAssetBoardDirty(false);
      setAssetPlacement(null);
      setNotice(`已删除资产「${label}」及其画布内容；候选文件已保留`);
      void refreshDashboard(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const deleteAssetFromContext = async () => {
    const menu = assetContextMenu;
    if (!menu) return;
    setAssetContextMenu(null);
    await deleteAssetById(menu.target.assetId, menu.target.label);
  };

  const moveAssetFromContext = (shotId: string) => {
    const menu = assetContextMenu;
    if (!menu) return;
    setAssetContextMenu(null);
    const source = assetLibrary?.assets.find((asset) => asset.id === menu.target.assetId);
    void assignAssetToShot(shotId, { pending: { assetId: menu.target.assetId, name: source?.name || menu.target.label, mode: 'move' } });
  };

  const copyAssetFromContext = async () => {
    const menu = assetContextMenu;
    if (!menu || !projectId || !project) return;
    setAssetContextMenu(null);
    const source = assetLibrary?.assets.find((asset) => asset.id === menu.target.assetId);
    if (!source) { setNotice('未找到要复制的逻辑资产'); return; }
    setBusy(true);
    try {
      const copied = await studioApi.duplicateAsset(projectId, source.id, { expected_revision: project.revision, name: `${source.name || source.id} · 副本` });
      setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: copied.revision } : item));
      setAssetLibrary(copied.library);
      const refreshed = await refreshAssetBoard(true, copied.library);
      const copiedId = String(copied.asset.id || '');
      const copiedName = String(copied.asset.name || `${source.name || source.id} · 副本`);
      const shotId = String(menu.target.rowKey || '').toUpperCase();
      const shot = story?.story.shots.find((item) => String(item.id).toUpperCase() === shotId);
      if (copiedId && refreshed && shot) {
        const flow = buildAssetBoardFlow(refreshed, copied.library, story?.story.shots || []);
        await assignAssetToShot(shotId, { pending: { assetId: copiedId, name: copiedName, mode: 'assign' }, projectRevision: copied.revision, boardEnvelope: refreshed, library: copied.library, nodes: flow.boardNodes, edges: flow.boardEdges });
      } else {
        setNotice(`已复制资产「${copiedName}」及其候选/桥接内容${copiedId ? '，当前位于 SHARED' : ''}`);
      }
      void refreshDashboard(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const refreshAssets = () => {
     if (!projectId) return;
     setBusy(true);
     Promise.all([studioApi.assetLibrary(projectId), studioApi.assetAudit(projectId)]).then(([library, audit]) => { setAssetLibrary(library); setAssetAudit(audit); return refreshAssetBoard(true, library); }).then(() => { void refreshDashboard(false); }).catch((error: Error) => setNotice(error.message)).finally(() => setBusy(false));
  };
  const refreshAssetAudit = () => { const requestedProjectId = projectId; if (!requestedProjectId) return; studioApi.assetAudit(requestedProjectId).then((value) => { if (requestedProjectId === projectId) setAssetAudit(value); }).catch((error: Error) => { if (requestedProjectId === projectId) setNotice(error.message); }); };

  const refreshDashboard = async (showProgress = true) => {
    const requestedProjectId = projectId;
    if (!requestedProjectId) return;
    if (showProgress) setBusy(true);
    try {
       const value = await studioApi.dashboard(requestedProjectId);
       if (requestedProjectId !== projectId) return;
       setDashboard(value);
       setDashboardError('');
     } catch (error) {
       if (requestedProjectId !== projectId) return;
       setDashboardError((error as Error).message);
       setNotice((error as Error).message);
    } finally {
      if (showProgress) setBusy(false);
    }
  };

  const openDashboardTask = async (task: DashboardTask) => {
    const route = task.route as StudioMode;
    if (task.action === 'confirm_generation' && task.targetId) {
      setBusy(true);
      try {
        const approved = await studioApi.approveRun(task.targetId);
        setRun(approved);
        setMode('canvas');
        setNotice('已确认付费视频生成，任务进入排队');
        await refreshDashboard(false);
      } catch (error) {
        setNotice((error as Error).message);
      } finally { setBusy(false); }
      return;
    }
    if (task.action === 'retry_generation' && task.targetId) {
      setBusy(true);
      try {
        const retried = await studioApi.resumeRun(task.targetId);
        setRun(retried);
        setMode('canvas');
        setNotice('失败的视频生成已重新排队');
        await refreshDashboard(false);
      } catch (error) {
        setNotice((error as Error).message);
      } finally { setBusy(false); }
      return;
    }
    if (task.action === 'confirm_delivery' && task.targetId) {
      setBusy(true);
      try {
        setRenderJob(await studioApi.approveRender(task.targetId));
        setMode('timeline');
        setNotice('已确认最终交付，渲染任务开始执行');
        await refreshDashboard(false);
      } catch (error) {
        setNotice((error as Error).message);
      } finally { setBusy(false); }
      return;
    }
    if (task.action === 'retry_delivery') {
      setMode('timeline');
      setNotice('已定位到交付时间线，请确认后重新导出');
      void renderTimeline();
      return;
    }
    if (route === 'assets') {
      // A dashboard task is a deep link. Clear a previous semantic/status
      // filter first, otherwise the target asset can remain hidden while the
      // library opens on a different selection.
      setAssetLibraryFilter('all');
      setAssetLibraryScope('all');
      setAssetLibrarySearch('');
      setFocusAssetId(task.targetId || '');
    }
    setMode(route);
    setNotice(`已定位到：${task.title}`);
  };

  const openDashboardStage = (stage: ProjectDashboard['stages'][number]) => {
    if (stage.route === 'assets') { setFocusAssetId(''); setAssetLibraryFilter('all'); setAssetLibraryScope('all'); }
    setMode(stage.route as StudioMode);
    setNotice(`已进入${stage.label}`);
  };

  useEffect(() => {
    if (mode !== 'home' || !projectId || !dashboard?.selected_project) return;
    const active = dashboardHasActiveWork(dashboard.selected_project);
    if (!active) return;
    const timer = window.setInterval(() => { void refreshDashboard(false); }, 3000);
    return () => window.clearInterval(timer);
  }, [dashboard?.selected_project?.project.status, mode, projectId]);

  useEffect(() => {
    const refreshOnFocus = () => { if (mode === 'home' && projectId) void refreshDashboard(false); };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [mode, projectId]);

  const createProject = async (input: ProjectCreateInput): Promise<boolean> => {
    setBusy(true);
    try {
      const created = await studioApi.createProject(input);
      const next: ProjectRecord = { ...created, document: { ...created.document, productionStatus: created.document.productionStatus || 'in_progress' } };
      setProjects((current) => [...current, next].sort((left, right) => (left.document.sortOrder ?? 10 ** 9) - (right.document.sortOrder ?? 10 ** 9)));
      setProjectId(next.document.id);
      setProjectManagerOpen(false);
      setNotice(`已创建项目「${next.document.name}」，可以从零开始编辑`);
      return true;
    } catch (error) {
      setNotice((error as Error).message);
      return false;
    } finally { setBusy(false); }
  };

  const moveProject = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= projects.length || busy) return;
    const reordered = [...projects];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setProjects(reordered);
    setBusy(true);
    try {
      const saved = await Promise.all(reordered.map((item, sortOrder) => studioApi.updateProjectMetadata(item.document.id, { expected_revision: item.revision, sortOrder })));
      const byId = new Map(saved.map((item) => [item.document.id, item]));
      setProjects((current) => current.map((item) => { const next = byId.get(item.document.id); return next ? { ...item, document: next.document, revision: next.revision, updated_at: next.updated_at } : item; }));
      setNotice('项目顺序已更新');
    } catch (error) {
      setNotice((error as Error).message);
      try {
        const refreshed = await studioApi.projects();
        setProjects(refreshed.projects.map((item) => ({ ...item, document: { ...item.document, productionStatus: item.document.productionStatus || 'in_progress' } })));
      } catch (refreshError) { setNotice((refreshError as Error).message); }
    } finally { setBusy(false); }
  };

  const archiveProject = async (item: ProjectRecord) => {
    if (projects.length <= 1) { setNotice('至少保留一个活动项目，无法归档最后一个项目。'); return; }
    setBusy(true);
    try {
      const result = await studioApi.updateProjectMetadata(item.document.id, { expected_revision: item.revision, lifecycleStatus: 'archived' });
      const remaining = projects.filter((candidate) => candidate.document.id !== item.document.id);
      setProjects(remaining);
      setArchivedProjects((current) => [{ ...item, document: { ...result.document, lifecycleStatus: 'archived' }, revision: result.revision, updated_at: result.updated_at, lifecycle_status: 'archived' }, ...current]);
      if (projectId === item.document.id) setProjectId(remaining[0]?.document.id || '');
      setNotice(`项目「${item.document.name}」已归档`);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };

  const restoreProject = async (item: ProjectRecord) => {
    setBusy(true);
    try {
      const result = await studioApi.updateProjectMetadata(item.document.id, { expected_revision: item.revision, lifecycleStatus: 'active' });
      setArchivedProjects((current) => current.filter((candidate) => candidate.document.id !== item.document.id));
      setProjects((current) => [...current, { ...item, document: { ...result.document, lifecycleStatus: 'active' }, revision: result.revision, updated_at: result.updated_at, lifecycle_status: 'active' }]);
      setNotice(`项目「${item.document.name}」已恢复`);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };

  const deleteProject = async (item: ProjectRecord) => {
    if (item.lifecycle_status !== 'archived' && item.document.lifecycleStatus !== 'archived' && projects.length <= 1) { setNotice('至少保留一个项目，无法删除最后一个项目。'); return; }
    if (!(await requestConfirmation('确认删除项目', `确认删除项目「${item.document.name}」？项目记录会被删除，但素材目录会保留。`, '删除项目', true))) return;
    setBusy(true);
    try {
      const result = await studioApi.deleteProject(item.document.id);
      const remaining = projects.filter((candidate) => candidate.document.id !== item.document.id);
      setProjects(remaining);
      setArchivedProjects((current) => current.filter((candidate) => candidate.document.id !== item.document.id));
      if (projectId === item.document.id) setProjectId(remaining[0]?.document.id || '');
      setNotice(result.project_files_preserved ? '项目已删除，素材目录已保留' : '项目已删除');
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const refreshSettings = async () => {
    setBusy(true);
    try {
      setSettings(await studioApi.settings());
      setNotice('V3 设置状态已重新检测');
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const runSettingsAction = async (action: () => Promise<void>, success: string) => {
    setBusy(true);
    try {
      await action();
      setSettings(await studioApi.settings());
      setNotice(success);
      return true;
    } catch (error) {
      setNotice((error as Error).message);
      return false;
    } finally { setBusy(false); }
  };

  const saveSettingsProvider = (providerId: string | null, body: Record<string, unknown>) => runSettingsAction(async () => {
    if (providerId) await studioApi.updateSettingsProvider(providerId, body);
    else await studioApi.createSettingsProvider(body);
  }, providerId ? 'Provider 配置已保存' : 'V3 Provider 已创建');
  const addSettingsPreset = (presetId: string) => runSettingsAction(async () => { await studioApi.addSettingsProviderPreset(presetId); }, 'Provider 预设已添加');
  const deleteSettingsProvider = async (providerId: string) => {
    if (!(await requestConfirmation('确认删除 Provider', '确认删除这个 V3 Provider 配置？其系统凭据也会被尝试清除，项目内容不会被删除。', '删除 Provider', true))) return;
    runSettingsAction(async () => { await studioApi.deleteSettingsProvider(providerId); }, 'Provider 配置已删除');
  };
  const writeSettingsCredential = (providerId: string, value: string) => runSettingsAction(async () => { await studioApi.writeSettingsCredential(providerId, value); }, '凭据已写入系统凭据库');
  const importSettingsCredential = (providerId: string, environmentVariable: string) => runSettingsAction(async () => { await studioApi.importSettingsCredential(providerId, environmentVariable); }, `已从 ${environmentVariable} 导入凭据`);
  const clearSettingsCredential = (providerId: string) => runSettingsAction(async () => { await studioApi.clearSettingsCredential(providerId); }, '系统凭据已清除');
  const probeSettingsProvider = (providerId: string) => runSettingsAction(async () => { await studioApi.probeSettingsProvider(providerId); }, 'Provider 探测完成，模型目录已更新');
  const bindSettingsCapability = (capability: string, providerId: string, model: string | null) => runSettingsAction(async () => { await studioApi.updateSettingsBinding({ capability, provider_profile_id: providerId, model }); }, `${settingsCapabilityLabels[capability] || capability} 能力绑定已保存`);
  const autoMatchSettingsBindings = () => runSettingsAction(async () => { await studioApi.autoMatchSettingsBindings(); }, '已按 Provider 能力和状态补齐自动推荐');

  const refreshTimelinePreflight = async () => {
    if (!projectId) return;
    try { setTimelinePreflight(await studioApi.timelinePreflight(projectId)); } catch (error) { setNotice((error as Error).message); }
  };

  const saveTimeline = async () => {
    if (!projectId || !timelineEnvelope) return;
    setBusy(true);
    try {
      const saved = await studioApi.saveTimeline(projectId, timelineEnvelope.document, timelineEnvelope.revision);
      setTimelineEnvelope(saved);
      setTimelineDirty(false);
      await refreshTimelinePreflight();
      setNotice(`时间线已保存 · v${saved.revision}`);
      void refreshDashboard(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const captureAssetBoardSnapshot = useCallback((nodes = assetBoardNodes, edges = assetBoardEdges, board = assetBoardEnvelope?.board): AssetBoardEditorSnapshot | null => {
    if (!board) return null;
    return {
      board: assetBoardFromFlow(board, nodes, edges),
      selectedNodeIds: nodes.filter((node) => node.selected).map((node) => node.id),
    };
  }, [assetBoardEdges, assetBoardEnvelope?.board, assetBoardNodes]);

  const rememberAssetBoardEdit = useCallback((before: AssetBoardEditorSnapshot | null, after: AssetBoardEditorSnapshot | null) => {
    if (!before || !after || JSON.stringify(before) === JSON.stringify(after)) return;
    assetBoardHistory.current = {
      past: [...assetBoardHistory.current.past, cloneAssetBoardSnapshot(before)].slice(-50),
      future: [],
    };
  }, []);

  const recordAssetBoardState = useCallback((beforeNodes: AssetFlowNode[], beforeEdges: Edge[], nextNodes: AssetFlowNode[], nextEdges: Edge[], board = assetBoardEnvelope?.board) => {
    rememberAssetBoardEdit(captureAssetBoardSnapshot(beforeNodes, beforeEdges, assetBoardEnvelope?.board), captureAssetBoardSnapshot(nextNodes, nextEdges, board));
  }, [assetBoardEnvelope?.board, captureAssetBoardSnapshot, rememberAssetBoardEdit]);

  const restoreAssetBoardSnapshot = useCallback((snapshot: AssetBoardEditorSnapshot) => {
    if (!assetBoardEnvelope) return;
    const board = cloneAssetBoardSnapshot(snapshot).board;
    const requestedPreset = String(board.metadata.layout_preset || 'standard') as AssetGridPreset;
    const preset = (['compact', 'standard', 'spacious'] as AssetGridPreset[]).includes(requestedPreset) ? requestedPreset : 'standard';
    const layoutMode: AssetBoardLayoutMode = board.metadata.layout_view === 'matrix' ? 'matrix' : 'adaptive';
    const columnWidth = Math.max(220, Number(board.metadata.layout_column_width) || assetGridPresets[preset].columnWidth);
    const gap = Math.max(8, Number(board.metadata.layout_gap) || 16);
    setAssetBoardLayoutPreset(preset);
    setAssetBoardLayoutMode(layoutMode);
    setAssetBoardColumnWidth(columnWidth);
    setAssetBoardGap(gap);
    const selectedIds = new Set(snapshot.selectedNodeIds);
    const nextNodes = assetBoardToFlowNodes(board, assetLibrary?.assets || [], assetBoardFilter, assetBoardShowShots, story?.story.shots || [], { preset, columnWidth, gap, layoutMode, collapsedScopes: assetBoardCollapsedScopes, onlyBlocked: assetBoardOnlyBlocked, showCandidates: assetBoardShowCandidates, shotId: assetBoardShotId, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut }).map((node) => selectedIds.has(node.id) ? { ...node, selected: true } : node);
    const restoredSelected = getSelectedAssetBoardCards(nextNodes);
    setAssetBoardSelection(restoredSelected.length === 1 ? assetBoardSelectionKey(restoredSelected[0]) : null);
    setAssetBoardEnvelope((current) => current ? { ...current, board } : current);
      const framedNodes = applyFixedAssetBoardFrame(nextNodes);
     setAssetBoardNodes(framedNodes);
    setAssetBoardEdges(assetBoardToFlowEdges(board, nextNodes));
    setAssetBoardDirty(true);
  }, [applyFixedAssetBoardFrame, assetBoardCollapsedScopes, assetBoardEnvelope, assetBoardFilter, assetBoardOnlyBlocked, assetBoardShowCandidates, assetBoardShowShots, assetBoardShotId, assetLibrary?.assets, openAssetContextMenu, approveAssetPromptCard, generateAssetImageCard, copyAssetPromptCard, setAssetBoardSelection, story?.story.shots, toggleAssetBoardScope]);

  const undoAssetBoard = useCallback(() => {
    const before = assetBoardHistory.current.past.at(-1);
    if (!before) { setNotice('资产画布没有可撤销的编辑'); return; }
    const current = captureAssetBoardSnapshot();
    if (!current) return;
    assetBoardHistory.current = {
      past: assetBoardHistory.current.past.slice(0, -1),
      future: [current, ...assetBoardHistory.current.future].slice(0, 50),
    };
    restoreAssetBoardSnapshot(before);
    setNotice('已撤销资产画布上一步编辑');
  }, [captureAssetBoardSnapshot, restoreAssetBoardSnapshot]);

  const redoAssetBoard = useCallback(() => {
    const next = assetBoardHistory.current.future[0];
    if (!next) { setNotice('资产画布没有可重做的编辑'); return; }
    const current = captureAssetBoardSnapshot();
    if (!current) return;
    assetBoardHistory.current = {
      past: [...assetBoardHistory.current.past, current].slice(-50),
      future: assetBoardHistory.current.future.slice(1),
    };
    restoreAssetBoardSnapshot(next);
    setNotice('已重做资产画布上一步编辑');
  }, [captureAssetBoardSnapshot, restoreAssetBoardSnapshot]);

  const updateAssetBoardNodes = useCallback((changes: NodeChange<AssetFlowNode>[]) => {
    const meaningfulChanges = changes.filter((change) => change.type !== 'dimensions');
    if (!meaningfulChanges.length) return;
    const currentById = new Map(assetBoardNodes.map((node) => [node.id, node]));
    const acceptedChanges = meaningfulChanges.filter((change) => change.type !== 'position' || !assetBoardCardIsLocked(currentById.get(change.id)?.data || { node_type: '' }));
    const positionChanges = acceptedChanges.filter((change): change is NodeChange<AssetFlowNode> & { type: 'position'; position: { x: number; y: number } } => change.type === 'position' && Boolean(change.position));
    const manuallyMoved = new Set(positionChanges.map((change) => change.id));
    const changed = applyNodeChangesLocal(acceptedChanges, assetBoardNodes);
    const nextNodes = changed.map((node) => {
      const manuallyPositioned = manuallyMoved.has(node.id) && !assetBoardCardIsLocked(node.data);
      return manuallyPositioned
        ? { ...node, data: { ...node.data, config: { ...node.data.config, position_source: 'manual' } } }
        : node;
    });
     const framedNodes = applyFixedAssetBoardFrame(nextNodes);
     setAssetBoardNodes(framedNodes);
     if (acceptedChanges.some((change) => change.type === 'select')) {
       const selected = getSelectedAssetBoardCards(framedNodes);
       setAssetBoardSelection(selected.length === 1 ? assetBoardSelectionKey(selected[0]) : null);
     }
     const structuralChange = acceptedChanges.some((change) => !['select', 'position'].includes(change.type));
     if (structuralChange) recordAssetBoardState(assetBoardNodes, assetBoardEdges, framedNodes, assetBoardEdges);
    if (positionChanges.some((change) => change.dragging === false) && assetBoardDragSnapshot.current) {
      const before = assetBoardDragSnapshot.current;
      assetBoardDragSnapshot.current = null;
       rememberAssetBoardEdit(before, captureAssetBoardSnapshot(framedNodes, assetBoardEdges));
    }
    if (acceptedChanges.some((change) => change.type !== 'select')) setAssetBoardDirty(true);
     }, [applyFixedAssetBoardFrame, assetBoardEdges, assetBoardNodes, captureAssetBoardSnapshot, recordAssetBoardState, rememberAssetBoardEdit, setAssetBoardSelection]);

  const onAssetNodeDragStart = useCallback(() => {
    assetBoardDragSnapshot.current = captureAssetBoardSnapshot();
  }, [captureAssetBoardSnapshot]);

  const onAssetNodeDragStop = useCallback(() => {
    const before = assetBoardDragSnapshot.current;
    assetBoardDragSnapshot.current = null;
    if (before) rememberAssetBoardEdit(before, captureAssetBoardSnapshot());
  }, [captureAssetBoardSnapshot, rememberAssetBoardEdit]);

  const updateAssetBoardEdges = useCallback((changes: EdgeChange[]) => {
    const nextEdges = applyEdgeChangesLocal(changes, assetBoardEdges);
    setAssetBoardEdges(nextEdges);
    if (changes.some((change) => change.type !== 'select')) recordAssetBoardState(assetBoardNodes, assetBoardEdges, assetBoardNodes, nextEdges);
    if (changes.some((change) => change.type !== 'select')) setAssetBoardDirty(true);
  }, [assetBoardEdges, assetBoardNodes, recordAssetBoardState]);

  const connectAssetBoard = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const sourceNode = assetBoardNodes.find((node) => node.id === connection.source);
    const targetNode = assetBoardNodes.find((node) => node.id === connection.target);
    const assetClassFor = (node?: AssetFlowNode) => node?.data.asset_id ? String(assetLibrary?.assets.find((asset) => asset.id === node.data.asset_id)?.assetClass || node.data.config.asset_class || '') : '';
    let source = connection.source;
    let target = connection.target;
    let relation: AssetBoardEdgeRelation = 'reference';
    const sourceCanFeedFusion = ['asset', 'artifact', 'handoff'].includes(String(sourceNode?.data.node_type || ''));
    const targetCanReceiveFusion = ['asset'].includes(String(targetNode?.data.node_type || ''));
    if (targetCanReceiveFusion && assetClassFor(targetNode) === 'fusion' && sourceCanFeedFusion && assetClassFor(sourceNode) !== 'fusion') {
      relation = 'fusion_input';
    } else if (sourceNode?.data.node_type === 'asset' && assetClassFor(sourceNode) === 'fusion' && ['asset', 'artifact', 'handoff'].includes(String(targetNode?.data.node_type || '')) && assetClassFor(targetNode) !== 'fusion') {
      source = connection.target;
      target = connection.source;
      relation = 'fusion_input';
    }
    const nextEdges = addEdgeLocal({
      ...connection,
      source,
      target,
      id: `asset-edge:${source}:${target}:${Date.now()}`,
      type: 'bezier',
      data: { relation },
    }, assetBoardEdges);
    if (nextEdges.length === assetBoardEdges.length) return;
    setAssetBoardEdges(nextEdges);
    recordAssetBoardState(assetBoardNodes, assetBoardEdges, assetBoardNodes, nextEdges);
    setAssetBoardDirty(true);
    if (relation === 'fusion_input') setNotice('已建立融合输入关系；选中融合资产后可生成融合 Prompt');
  }, [assetBoardEdges, assetBoardNodes, assetLibrary?.assets, recordAssetBoardState]);

  const saveAssetBoard = async () => {
    if (!projectId || !assetBoardEnvelope) return null;
    setBusy(true);
    try {
      const board = assetBoardFromFlow({ ...assetBoardEnvelope.board, metadata: { ...assetBoardEnvelope.board.metadata, layout_preset: assetBoardLayoutPreset, layout_view: assetBoardLayoutMode, layout_column_width: assetBoardColumnWidth, layout_column_widths: assetBoardColumnWidths, layout_directory_position: assetBoardIndexPosition, layout_gap: assetBoardGap } }, assetBoardNodes, assetBoardEdges);
      const saved = await studioApi.saveAssetBoard(projectId, board, assetBoardEnvelope.revision);
      const nextNodes = assetBoardToFlowNodes(saved.board, assetLibrary?.assets || [], assetBoardFilter, assetBoardShowShots, story?.story.shots || [], { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
      setAssetBoardEnvelope(saved);
      setAssetBoardNodes(nextNodes);
      setAssetBoardEdges(assetBoardToFlowEdges(saved.board, nextNodes));
      setAssetBoardDirty(false);
      setNotice(`资产画布已保存 · v${saved.revision}`);
      return saved;
    } catch (error) {
      setNotice((error as Error).message);
      return null;
    } finally { setBusy(false); }
  };

  const syncAssetBoard = async (showProgress = true) => {
    if (!projectId || !assetBoardEnvelope) return null;
    if (assetBoardDirty) {
      setNotice('当前资产生产工作区有未保存修改，请先保存后再同步故事与分镜');
      return null;
    }
    if (showProgress) setBusy(true);
    try {
      const synced = await studioApi.syncAssetBoard(projectId, assetBoardEnvelope.revision, true);
      const boardNodes = assetBoardToFlowNodes(synced.board, assetLibrary?.assets || [], assetBoardFilter, assetBoardShowShots, story?.story.shots || [], { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
      setAssetBoardEnvelope(synced);
      setAssetBoardNodes(boardNodes);
      setAssetBoardEdges(assetBoardToFlowEdges(synced.board, boardNodes));
      setAssetBoardDirty(false);
      setNotice(`故事与分镜已同步到资产画布 · ${boardNodes.filter((node) => node.data.node_type === 'shot').length} 个镜头节点`);
      return synced;
    } catch (error) {
      setNotice((error as Error).message);
      return null;
    } finally { if (showProgress) setBusy(false); }
  };

  const openAssetCreate = () => {
    if (!projectId || !project) { setNotice('请先选择一个项目'); return; }
    if (!['canvas', 'assets'].includes(mode)) { setMode('canvas'); setNotice('请在资产生产工作区新增逻辑资产'); return; }
    setAssetCreateDraft({ name: '', assetClass: 'character', assetRole: 'identity', grade: 'B', required: true, shotId: '' });
    setAssetCreateOpen(true);
  };

  const addAssetToBoard = async () => {
    if (!projectId || !project) return;
    const draft = { ...assetCreateDraft };
    const name = draft.name.trim();
    if (!name) { setNotice('请填写资产名称'); return; }
    const assetClass = draft.assetClass;
    setBusy(true);
    try {
      const created = await studioApi.createAsset(projectId, { expected_revision: project.revision, name, asset_class: assetClass, asset_role: draft.assetRole.trim() || assetClass, grade: draft.grade, required: draft.required });
      setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: created.revision } : item));
      setAssetLibrary(created.library);
      const refreshed = assetBoardEnvelope ? await refreshAssetBoard(true, created.library) : await refreshAssetBoard(false, created.library);
      setAssetCreateOpen(false);
      const createdAssetId = String(created.asset.id || '');
      const pending = createdAssetId ? { assetId: createdAssetId, name, mode: 'assign' as const } : null;
      setMode('canvas');
      const selectedShotId = String(draft.shotId || '').toUpperCase();
      const selectedShot = story?.story.shots.find((shot) => String(shot.id).toUpperCase() === selectedShotId);
      if (pending && refreshed && selectedShot) {
        const flow = buildAssetBoardFlow(refreshed, created.library, story?.story.shots || []);
        await assignAssetToShot(selectedShotId, { pending, projectRevision: created.revision, boardEnvelope: refreshed, library: created.library, nodes: flow.boardNodes, edges: flow.boardEdges });
      } else {
        setAssetPlacement(pending);
        setNotice(`已新增${assetClassLabels[assetClass] || assetClass}资产「${name}」；请点击目标镜头行完成归属`);
      }
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const openAssetBoard = async () => {
    if (storyDirty) {
      const saved = await saveStory();
      if (!saved) return;
    }
    setMode('canvas');
    await syncAssetBoard();
  };

  const generateAssetPrompts = async (targetAssetId?: string) => {
    if (!projectId || !story) return;
    setBusy(true);
    try {
      const currentStory = storyDirty ? await saveStory(false) : story;
      if (!currentStory) return;
      const result = await studioApi.generateAssetPrompts(projectId, { expected_revision: currentStory.revision, ...(targetAssetId ? { target_asset_id: targetAssetId } : {}) });
      setStory(result.story); setStoryDirty(false); setAssetLibrary(result.library); setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: result.revision } : item));
      setAssetBoardEnvelope(result.asset_board);
      const flow = buildAssetBoardFlow(result.asset_board, result.library, result.story.story.shots);
      const nextBoardNodes = targetAssetId ? flow.boardNodes.map((node) => ({ ...node, selected: node.data.node_type === 'asset' && String(node.data.asset_id || '') === targetAssetId })) : flow.boardNodes;
      setAssetBoardNodes(nextBoardNodes); setAssetBoardEdges(flow.boardEdges); setAssetBoardDirty(false); setMode('canvas');
      if (targetAssetId) {
        const generated = result.run.promptCards.find((card) => card.id === targetAssetId)?.prompt || '';
        setAssetPromptDraft(generated ? { assetId: targetAssetId, prompt: generated } : null);
        setAssetProductionFocus({ assetId: targetAssetId, target: 'prompt' });
      }
      setNotice(targetAssetId ? '已为当前资产生成 Prompt 草稿 · 请编辑并保存后进入 Prompt QA' : `已生成 ${result.run.promptCards.length} 张资产 Prompt 卡 · 等待 Prompt QA 和用户确认`); void refreshDashboard(false);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };
  generateAssetPromptRef.current = (assetId: string) => { void generateAssetPrompts(assetId); };

  const handoffAssetToChatGPT = async (asset: LibraryAsset, prompt: string) => {
    const fullPrompt = composeAssetPrompt(asset, story, prompt);
    try {
      await navigator.clipboard.writeText(fullPrompt);
    } catch {
      setNotice('浏览器未授权剪贴板，请手动复制右侧 Prompt；ChatGPT 地址仍可手动打开。');
    }
    const opened = window.open('https://chatgpt.com/', '_blank', 'noopener,noreferrer');
    setNotice(opened ? 'Prompt 已复制，ChatGPT 已打开；请生成并下载图片后拖回当前资产。' : 'Prompt 已复制；浏览器阻止了新标签页，请手动打开 https://chatgpt.com/。');
  };

  const importAssetCandidate = async (asset: LibraryAsset, file: File) => {
    if (!projectId) return;
    const mediaType = file.type || ({ mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[file.name.toLowerCase().split('.').pop() || ''] || '';
    if (!/^(image\/(png|jpeg|webp)|video\/(mp4|webm|quicktime)|audio\/(wav|mpeg|mp4|x-m4a))$/.test(mediaType)) {
      setNotice('仅支持 PNG/JPEG/WebP 图片、MP4/WebM/MOV 视频和 WAV/MP3/M4A 音频。');
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('logical_asset_id', asset.id);
      form.append('asset_class', asset.assetClass);
      form.append('asset_role', asset.assetRole || asset.assetMetadata?.asset_role || asset.name || asset.assetClass);
      form.append('source_type', 'chatgpt-web');
      form.append('prompt_version', String(asset.promptVersion || asset.assetMetadata?.prompt_version || 'manual-bridge'));
      form.append('relevant_shots_json', JSON.stringify((asset.dependencies || []).map((item) => item.shot_id).filter(Boolean)));
      form.append('authorization_status', asset.authorizationStatus || 'pending');
      const result = await studioApi.intakeAsset(projectId, form);
      const artifact = result.artifact as Record<string, any> | undefined;
      let library = await studioApi.assetLibrary(projectId);
      const draftMetadata = (asset.assetMetadata?.production_draft || (asset.assetMetadata?.metadata as Record<string, any> | undefined)?.production_draft) as Record<string, any> | undefined;
      if (asset.prompt?.trim() && artifact?.id && draftMetadata?.active) {
        const cleared = await studioApi.updateAssetMetadata(projectId, asset.id, { metadata: { production_draft: { ...draftMetadata, active: false, updated_at: new Date().toISOString() } } });
        setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: cleared.revision } : item));
        library = await studioApi.assetLibrary(projectId);
      }
      setAssetLibrary(library);
      await refreshAssetBoard(true, library);
      setNotice(`候选${mediaType.startsWith('video/') ? '视频' : mediaType.startsWith('audio/') ? '声音' : '图片'}已导入 · ${artifact?.id || 'artifact'} · 待 QA，不会覆盖当前版本`);
      void refreshDashboard(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const importAssetBatch = async (items: Array<{ file: File; assetId: string; role: string }>) => {
    if (!projectId || !assetLibrary) return;
    setBusy(true);
    let imported = 0;
    try {
      for (const item of items) {
        const asset = assetLibrary.assets.find((candidate) => candidate.id === item.assetId);
        if (!asset) continue;
        const itemMime = item.file.type || ({ mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[item.file.name.toLowerCase().split('.').pop() || ''] || '';
        if (!/^(image\/(png|jpeg|webp)|video\/(mp4|webm|quicktime)|audio\/(wav|mpeg|mp4|x-m4a))$/.test(itemMime)) throw new Error(`${item.file.name} 不是支持的图片、视频或音频格式。`);
        const form = new FormData();
        form.append('file', item.file, item.file.name); form.append('logical_asset_id', asset.id); form.append('asset_class', asset.assetClass); form.append('asset_role', item.role || asset.assetRole || asset.assetClass); form.append('source_type', 'asset-library-batch'); form.append('prompt_version', String(asset.promptVersion || 'manual-bridge')); form.append('relevant_shots_json', JSON.stringify((asset.dependencies || []).map((dependency) => dependency.shot_id).filter(Boolean))); form.append('authorization_status', asset.authorizationStatus || 'pending');
        await studioApi.intakeAsset(projectId, form); imported += 1;
      }
      const [library, audit] = await Promise.all([studioApi.assetLibrary(projectId), studioApi.assetAudit(projectId)]);
      setAssetLibrary(library); setAssetAudit(audit); await refreshAssetBoard(true, library); setAssetImportOpen(false); setNotice(`已导入 ${imported} 个候选文件 · 全部进入待 QA，当前版本保持不变`); void refreshDashboard(false);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };

  const refreshAssetProduction = async () => {
    if (!projectId) return;
    const [library, projectEnvelope, audit] = await Promise.all([studioApi.assetLibrary(projectId), studioApi.projects(), studioApi.assetAudit(projectId)]);
    setAssetLibrary(library);
    setAssetAudit(audit);
    setProjects(projectEnvelope.projects.map((item) => ({ ...item, document: { ...item.document, productionStatus: item.document.productionStatus || 'in_progress' } })));
    await refreshAssetBoard(true, library);
  };

  const manualProductionApproval = async (assetId: string, approved: boolean, reason: string, artifactId: string) => {
    if (!projectId || !project) return;
    if (approved && !reason.trim()) { setNotice('人工通过必须填写审核原因。'); return; }
    setBusy(true);
    try {
      const result = await studioApi.manualProductionApproval(projectId, assetId, { expected_revision: project.revision, approved, reason, artifact_id: artifactId });
      setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: result.revision } : item));
      await refreshAssetProduction();
      setNotice(approved ? '人工通过已记录：当前登记文件可进入镜头生产' : '人工通过已撤销：资产恢复 Prompt 门禁');
      void refreshDashboard(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const startAssetQa = async (artifactId: string, qaType: AssetQaType = 'image', manualReview = false) => {
    if (!projectId) return;
    setBusy(true);
    try {
      const result = await studioApi.startAssetQa(projectId, artifactId, qaType, manualReview);
      const qaLabel = qaType === 'video' ? '视频' : qaType === 'audio' ? '声音' : qaType === 'reference' ? '参考' : qaType === 'image' ? '图片' : 'Prompt';
      setNotice(`已创建${qaLabel} QA · ${String((result.qa_run as Record<string, any>)?.id || 'QA')}；完成检查后提交审核结论`);
      await refreshAssetProduction();
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };

  const approveAssetCandidate = async (artifactId: string) => {
    if (!projectId) return;
    setBusy(true);
    try {
      const linkedAsset = assetLibrary?.assets.find((asset) => asset.artifacts?.some((artifact: Record<string, any>) => artifact.id === artifactId));
      const linkedArtifact = linkedAsset?.artifacts?.find((artifact: Record<string, any>) => artifact.id === artifactId);
      if (linkedArtifact?.metadata?.is_sensitive && !['cleared', 'approved', 'authorized', '已授权', '已通过'].includes(String(linkedArtifact.metadata.authorization_status || linkedAsset?.authorizationStatus || '').toLowerCase())) throw new Error('敏感素材尚未完成授权，QA 被阻塞；请先确认授权或暂存人工处理。');
      const runs = await studioApi.assetQaRuns(projectId, artifactId);
      let run = runs.qa_runs.find((candidate: Record<string, any>) => ['pending', 'running', 'blocked'].includes(String(candidate.status))) || runs.qa_runs[0];
      if (!run?.id) {
        const inferredQaType = String(linkedArtifact?.metadata?.qa_type || linkedAsset?.workflow?.qa_type || (String(linkedArtifact?.mime_type || '').startsWith('video/') ? 'video' : 'image')) as AssetQaType;
        const started = await studioApi.startAssetQa(projectId, artifactId, inferredQaType, true);
        run = started.qa_run as Record<string, any>;
      }
      if (!run?.id || String(run.status) === 'blocked') throw new Error('该候选无法进入人工图片 QA，请检查资产映射或授权状态。');
      const approvedRoles: Record<string, string[]> = { character: ['identity', 'face', 'hair', 'outfit', 'continuity'], scene: ['layout', 'lighting', 'weather', 'axis', 'continuity'], prop: ['structure', 'material', 'scale', 'text', 'continuity'], fusion: ['inputs', 'occlusion', 'scale', 'lighting', 'continuity'] };
      await studioApi.submitAssetQa(projectId, String(run.id), { decision: 'Approved', report: { manual_review: true, review_source: 'asset-production-board', qa_owner: linkedAsset?.qaOwner || linkedAsset?.assetClass || 'asset-regulator', asset_class: linkedAsset?.assetClass || 'unknown', note: '用户确认候选图片符合当前资产类型的生产规格。' }, approved_roles: approvedRoles[linkedAsset?.assetClass || ''] || ['identity', 'continuity'] });
      setNotice('候选已通过 QA，下一步请登记为资产版本。');
      await refreshAssetProduction();
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };

  const submitAssetQaReview = async (artifactId: string, qaType: AssetQaType, decision: AssetQaDecision, reportNote: string, checklist: Record<string, boolean> = {}) => {
    if (!projectId) return;
    setBusy(true);
    try {
      const runs = await studioApi.assetQaRuns(projectId, artifactId);
      let run = runs.qa_runs.find((candidate: Record<string, any>) => String(candidate.qa_type || '') === qaType && ['pending', 'running'].includes(String(candidate.status))) || runs.qa_runs.find((candidate: Record<string, any>) => String(candidate.qa_type || '') === qaType);
      if (!run?.id) {
        const started = await studioApi.startAssetQa(projectId, artifactId, qaType, true);
        run = started.qa_run as Record<string, any>;
      }
      if (!run?.id || ['blocked', 'failed'].includes(String(run.status))) throw new Error('该候选无法进入当前类型 QA，请先检查媒体类型、项目映射和授权状态。');
      await studioApi.submitAssetQa(projectId, String(run.id), {
        decision,
        report: { manual_review: true, review_source: 'asset-library', qa_type: qaType, reviewer_note: reportNote, ...(qaType === 'video' ? { video_checks: checklist } : {}) },
        observed_issues: reportNote ? [reportNote] : [],
      });
      setNotice(`${qaType === 'reference' ? '参考审核' : '媒体 QA'}已提交：${decision}。${decision === 'Approved' ? (qaType === 'reference' ? '已标记为仅参考，不可入镜。' : '下一步请登记为资产版本。') : ''}`);
      await refreshAssetProduction();
      void refreshDashboard(false);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };

  const registerAssetCandidate = async (artifactId: string, replaceActive = false) => {
    if (!projectId) return;
    setBusy(true);
    try {
      await studioApi.registerAssetArtifact(projectId, artifactId, replaceActive);
      setNotice(replaceActive ? '候选已登记并替换当前 active 版本；历史版本仍保留。' : '候选已登记为资产版本；已有 active 时默认保留当前版本。');
      await refreshAssetProduction();
      void refreshDashboard(false);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };

  const generateFusionPrompt = async (assetId: string, sourceAssetIds: string[], shotId: string) => {
    if (!projectId || !project || !assetBoardEnvelope) return;
    if (!shotId) { setNotice('融合资产尚未绑定有效镜头'); return; }
    if (sourceAssetIds.length < 2) { setNotice('至少需要两项已完成基础资产，并使用 fusion_input 连线连接到融合卡'); return; }
    setBusy(true);
    try {
      let currentBoard = assetBoardEnvelope;
      if (assetBoardDirty) {
        const saved = await saveAssetBoard();
        if (!saved) return;
        currentBoard = saved;
      }
      const result = await studioApi.generateFusionPrompt(projectId, { expected_project_revision: project.revision, expected_board_revision: currentBoard.revision, fusion_asset_id: assetId, shot_id: shotId, source_asset_ids: sourceAssetIds, confirmed: true });
      setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: result.revision } : item));
      setAssetLibrary(result.library);
      setAssetBoardEnvelope(result.asset_board);
      const nextNodes = assetBoardToFlowNodes(result.asset_board.board, result.library.assets, assetBoardFilter, assetBoardShowShots, story?.story.shots || [], { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
      setAssetBoardNodes(nextNodes);
      setAssetBoardEdges(assetBoardToFlowEdges(result.asset_board.board, nextNodes));
      setAssetBoardDirty(false);
      clearAssetBoardHistory();
      setNotice(`融合 Prompt 已生成 · ${assetId} · ${shotId} · 待 Prompt QA`);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };

  const rejectAssetAndRewrite = async (assetId: string, artifactId: string) => {
    if (!projectId) return;
    const asset = assetLibrary?.assets.find((candidate) => candidate.id === assetId);
    const revisedPrompt = window.prompt('请输入重写后的完整 Prompt。历史 Prompt 会保留，新 Prompt 会进入待 QA。', String(asset?.prompt || ''))?.trim();
    if (!revisedPrompt) return;
    setBusy(true);
    try {
      const runs = await studioApi.assetQaRuns(projectId, artifactId);
      let run = runs.qa_runs.find((candidate: Record<string, any>) => ['pending', 'running', 'blocked'].includes(String(candidate.status))) || runs.qa_runs[0];
      if (!run?.id) {
        const started = await studioApi.startAssetQa(projectId, artifactId, 'image', true);
        run = started.qa_run as Record<string, any>;
      }
      if (!run?.id || String(run.status) === 'blocked') throw new Error('该候选无法进入人工图片 QA，请检查资产映射或授权状态。');
      await studioApi.submitAssetQa(projectId, String(run.id), { decision: 'Reject and rebuild prompt', observed_issues: ['人工审核认为当前图片与资产 Prompt 或连续性要求不一致。'], rebuild_required: true, report: { manual_review: true, review_source: 'asset-prompt-card', note: '图片审核不通过，按用户提供的重写内容创建新 Prompt 版本。' } });
      await studioApi.createPromptVersion(projectId, assetId, { prompt: revisedPrompt, source: 'human-review', skill_id: asset?.qaOwner || 'video-asset-regulator', source_qa_run_id: String(run.id), change_reason: '图片审核不通过并重写 Prompt' });
      await refreshAssetProduction();
      setNotice(`「${asset?.name || assetId}」图片已退回，新 Prompt 已创建并等待 QA`);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };

  function uploadAssetFromBoard(assetId: string, file: File) {
    const asset = assetLibrary?.assets.find((candidate) => candidate.id === assetId);
    if (asset) void importAssetCandidate(asset, file);
  }

  function approveAssetFromBoard(_assetId: string, artifactId: string) {
    void approveAssetCandidate(artifactId);
  }

  function rejectAssetFromBoard(assetId: string, artifactId: string) {
    void rejectAssetAndRewrite(assetId, artifactId);
  }

  function registerAssetFromBoard(_assetId: string, artifactId: string) {
    void registerAssetCandidate(artifactId);
  }

  const assembleTimeline = async () => {
    if (!projectId || !timelineEnvelope) return;
    setBusy(true);
    try {
      if (timelineDirty) {
        const saved = await studioApi.saveTimeline(projectId, timelineEnvelope.document, timelineEnvelope.revision);
        setTimelineEnvelope(saved);
        setTimelineDirty(false);
        const assembled = await studioApi.assembleTimeline(projectId, saved.revision);
        setTimelineEnvelope(assembled);
        setTimelinePreflight(await studioApi.timelinePreflight(projectId));
        setNotice(`已同步生产结果 · 新增 ${String(assembled.assembly?.added_clips || 0)} 个片段 · 跳过 ${String((assembled.assembly?.missing as unknown[] | undefined)?.length || 0)} 个缺口`);
      } else {
        const assembled = await studioApi.assembleTimeline(projectId, timelineEnvelope.revision);
        setTimelineEnvelope(assembled);
        setTimelinePreflight(await studioApi.timelinePreflight(projectId));
        setNotice(`已同步生产结果 · 新增 ${String(assembled.assembly?.added_clips || 0)} 个片段 · 跳过 ${String((assembled.assembly?.missing as unknown[] | undefined)?.length || 0)} 个缺口`);
      }
      void refreshDashboard(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const renderTimeline = async () => {
    if (!projectId || !timelineEnvelope) return;
    setBusy(true);
    try {
      let current = timelineEnvelope;
      if (timelineDirty) {
        current = await studioApi.saveTimeline(projectId, timelineEnvelope.document, timelineEnvelope.revision);
        setTimelineEnvelope(current);
        setTimelineDirty(false);
        await refreshTimelinePreflight();
      }
      const estimate = await studioApi.estimateRender(projectId, current.revision);
      const accepted = await requestConfirmation('确认创建交付作业', `将导出 ${estimate.manifest.output?.resolution || `${current.document.width}×${current.document.height}`} · ${current.document.duration}s，输入 ${estimate.estimate.input_count} 个，FFmpeg 本地处理，是否创建交付作业？`, '创建交付作业');
      if (!accepted) { setNotice('已取消导出。'); return; }
      const created = await studioApi.createRender(projectId, current.revision, false);
      setRenderJob(created);
      if (created.status === 'awaiting_confirmation') {
        const approved = await requestConfirmation('确认最终导出', '交付作业已创建。最终导出会生成 MP4、字幕、项目 JSON、资产清单、制作报告和 manifest，是否确认执行？', '确认执行', true);
        if (approved) setRenderJob(await studioApi.approveRender(created.id));
      }
      setNotice(`交付作业 ${created.id} · ${created.status}`);
      void refreshDashboard(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const saveAssetMetadata = (assetId: string, body: Record<string, unknown>) => {
    if (!projectId) return;
    const sourceAsset = assetLibrary?.assets.find((item) => item.id === assetId);
    const promptValue = typeof body.prompt === 'string' ? body.prompt.trim() : String(sourceAsset?.prompt || '').trim();
    const hasImage = Boolean(sourceAsset?.artifactId || sourceAsset?.artifact_id || sourceAsset?.filePath || sourceAsset?.file_path || sourceAsset?.previewUrl || (Array.isArray(sourceAsset?.artifacts) && sourceAsset.artifacts.length));
    const existingMetadata = sourceAsset?.assetMetadata || {};
    const existingDraft = (existingMetadata.production_draft || (existingMetadata.metadata as Record<string, any> | undefined)?.production_draft) as Record<string, any> | undefined;
    const saveBody = promptValue && hasImage && existingDraft?.active
      ? { ...body, metadata: { ...(body.metadata as Record<string, unknown> | undefined), production_draft: { ...existingDraft, active: false, updated_at: new Date().toISOString() } } }
      : body;
    setBusy(true);
    studioApi.updateAssetMetadata(projectId, assetId, saveBody).then(({ revision }) => { setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision } : item)); setAssetPromptDraft((current) => current?.assetId === assetId ? null : current); setNotice(`资产规格已保存，项目修订版 ${revision}`); return studioApi.assetLibrary(projectId); }).then((library) => { setAssetLibrary(library); return refreshAssetBoard(false, library); }).then(() => { void refreshDashboard(false); }).catch((error: Error) => setNotice(error.message)).finally(() => setBusy(false));
  };

  const checkFusionGate = (assetId: string) => {
    if (!projectId) return;
    setBusy(true);
    studioApi.fusionGate(projectId, assetId).then((result) => { setNotice(result.status === 'allowed' ? '融合门已通过' : '融合门仍阻塞：请先完成基础资产登记'); return studioApi.assetLibrary(projectId); }).then(setAssetLibrary).then(() => { void refreshDashboard(false); }).catch((error: Error) => setNotice(error.message)).finally(() => setBusy(false));
  };

  const createAgentPlan = async (message: string, skillId = assistantSkillId): Promise<boolean> => {
    if (!project || !graphEnvelope || dirty) {
      setNotice(dirty ? '请先保存当前工作流图，再让 Agent 读取稳定版本。' : '尚未加载项目图。');
      return false;
    }
    setAgentBusy(true);
    try {
      const result = await studioApi.createAgentPlan({
        project_id: project.document.id,
        message,
        selected_node_ids: selectedNodeIds,
        graph_revision: graphEnvelope.revision,
        project_revision: project.revision,
        skill_id: skillId,
        context: assistantContext,
        cost_boundary: { currency: 'USD', confirmation_required: true },
      });
      setAgentPlan(result.plan);
      setNotice(`Agent 计划已生成，等待审阅 · ${result.id}`);
      return true;
    } catch (error) {
      setNotice((error as Error).message);
      return false;
    } finally { setAgentBusy(false); }
  };

  const applyAgentPlan = async () => {
    if (!agentPlan || !project || !graphEnvelope) return;
    setAgentBusy(true);
    try {
      const result = await studioApi.applyAgentPlan(agentPlan.id, { expected_project_revision: project.revision, expected_graph_revision: graphEnvelope.revision, detail: { approved_from: 'v3_canvas' } });
      const refreshed = await studioApi.graph(project.document.id);
      setGraphEnvelope(refreshed);
      setNodes(toFlowNodes(refreshed.graph));
      setEdges(toFlowEdges(refreshed.graph));
      setDirty(false);
      setAgentPlan(result.plan);
      setNotice(`Agent 补丁已应用 · 图版本 v${result.graph_revision} · 候选版本待审阅`);
      void refreshDashboard(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setAgentBusy(false); }
  };

  const rejectAgentPlan = async () => {
    if (!agentPlan) return;
    setAgentBusy(true);
    try {
      const result = await studioApi.rejectAgentPlan(agentPlan.id);
      setAgentPlan(result.plan);
      setNotice('Agent 计划已拒绝，未修改工作流图或项目内容。');
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setAgentBusy(false); }
  };

  const reviewAssetCandidate = (assetId: string, comparisonId: string, candidateArtifactId: string) => {
    if (!projectId) return;
    setBusy(true);
    studioApi.reviewComparison(projectId, assetId, comparisonId, { candidate_artifact_id: candidateArtifactId, decision: 'Approved', score: 100, comment: '在资产库中批准候选', annotations: [] }).then(() => studioApi.assetLibrary(projectId)).then(setAssetLibrary).then(() => { void refreshDashboard(false); }).catch((error: Error) => setNotice(error.message)).finally(() => setBusy(false));
  };

  useEffect(() => {
    if (!projectId || !story) return;
    const versions = story.story.script_versions.filter((version) => typeof version.id === 'string');
    const active = versions.find((version) => version.status === 'active');
    const previous = versions.filter((version) => version.id !== active?.id).at(-1);
    if (!active || !previous) {
      setStoryDiff(null);
      return;
    }
    studioApi.storyDiff(projectId, String(previous.id), String(active.id)).then(setStoryDiff).catch(() => setStoryDiff(null));
  }, [projectId, story?.revision]);

  const saveStory = async (manageBusy = true): Promise<StoryEnvelope | null> => {
    if (!story || !projectId) return null;
    if (manageBusy) setBusy(true);
    try {
      setNotice('正在保存故事与分镜…');
      const saved = await studioApi.saveStory(projectId, story.story, story.revision);
      setStory(saved);
      setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: saved.revision } : item));
      setStoryDirty(false);
      setNotice(`故事与分镜已保存 · v${saved.revision}`);
      void refreshDashboard(false);
      return saved;
    } catch (error) {
      setNotice((error as Error).message);
      return null;
    } finally { if (manageBusy) setBusy(false); }
  };

  const generateStoryCandidate = async () => {
    if (!story || !projectId) return;
    setBusy(true);
    try {
      const currentStory = storyDirty ? await saveStory(false) : story;
      if (!currentStory) return;
      const created = await studioApi.createStoryRun(projectId, { goal: 'full', strength: 'balanced', duration: currentStory.story.spec.duration, ratio: currentStory.story.spec.ratio, generator: project?.document.generator, audience: currentStory.story.spec.audience, platform: currentStory.story.spec.platform, language: currentStory.story.spec.language, brand_requirements: currentStory.story.spec.brand_requirements, must_preserve: currentStory.story.spec.must_preserve, must_avoid: currentStory.story.spec.must_avoid });
      const started = await studioApi.startStoryRun(created.id);
      setStoryRun(started.run);
      setNotice('故事候选已生成，等待逐层接受');
      void refreshDashboard(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const acceptStoryLayer = async (scope: 'all' | 'script_only' | 'shots_only' = 'all', shotIds: string[] = []) => {
    if (!storyRun) return;
    setBusy(true);
    try {
      const result = storyRun.status === 'storyboard_review_required' ? await studioApi.acceptStoryboard(storyRun.id, scope, shotIds) : await studioApi.acceptRegulator(storyRun.id);
      setStoryRun(result.run);
      const refreshed = await studioApi.story(projectId);
      setStory(refreshed);
      setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: refreshed.revision } : item));
      setStoryDirty(false);
      setNotice('已接受当前层，历史版本仍可追溯');
      void refreshDashboard(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const rollbackStory = async (versionId: string, scope: 'script' | 'shots') => {
    if (!story || !projectId) return;
    setBusy(true);
    try {
      const restored = await studioApi.rollbackStory(projectId, versionId, story.revision, scope);
      setStory(restored);
      setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: restored.revision } : item));
      setStoryDiff(null);
      setStoryDirty(false);
      setNotice(`已从 ${versionId} 创建回退版本`);
      void refreshDashboard(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!run?.id || terminalRunStatuses.has(run.status)) return;
    let active = true;
    const refresh = async () => {
      try {
        const detail = await studioApi.runDetail(run.id);
        if (active) setRun(detail as WorkflowRunDetail);
      } catch (error) {
        if (active) setNotice((error as Error).message);
      }
    };
    const timer = window.setInterval(refresh, 800);
    void refresh();
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [run?.id, run?.status]);

  const rememberEdit = useCallback((before: EditorSnapshot) => {
    editorHistory.current = {
      past: [...editorHistory.current.past, cloneEditorSnapshot(before)].slice(-50),
      future: [],
    };
    setHistoryRevision((value) => value + 1);
  }, []);

  const commitEdit = useCallback((before: EditorSnapshot, after: EditorSnapshot) => {
    setNodes(after.nodes);
    setEdges(after.edges);
    setDirty(true);
    rememberEdit(before);
  }, [rememberEdit]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const removedIds = new Set(changes.filter((change) => change.type === 'remove').map((change) => change.id));
    const nextNodes = applyNodeChangesLocal(changes, nodes).map((node) => removedIds.has(node.parentId || '') ? {
      ...node,
      parentId: undefined,
      position: { x: node.position.x + 40, y: node.position.y + 80 },
      data: { ...node.data, config: Object.fromEntries(Object.entries(node.data.config).filter(([key]) => key !== 'group_id')) },
    } : node);
    if (changes.some((change) => change.type === 'remove')) {
      commitEdit(editorSnapshot(nodes, edges), { nodes: nextNodes, edges });
      return;
    }
    setNodes(nextNodes);
  }, [commitEdit, edges, nodes]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const nextEdges = applyEdgeChangesLocal(changes, edges);
    if (changes.some((change) => change.type === 'remove')) {
      commitEdit(editorSnapshot(nodes, edges), { nodes, edges: nextEdges });
      return;
    }
    setEdges(nextEdges);
  }, [commitEdit, edges, nodes]);

  const onNodeDragStart = useCallback(() => {
    dragSnapshot.current = editorSnapshot(nodes, edges);
  }, [edges, nodes]);

  const onNodeDragStop = useCallback(() => {
    const before = dragSnapshot.current;
    dragSnapshot.current = null;
    if (!before) return;
    const after = editorSnapshot(nodes, edges);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      rememberEdit(before);
      setDirty(true);
    }
  }, [edges, nodes, rememberEdit]);

  const onConnect = useCallback((connection: Connection) => {
    const graphEdges = edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      relation: (edge.data?.relation as EdgeRelation) || 'execution',
    }));
    if (newEdgeRelation === 'execution' && wouldCreateExecutionCycle(graphEdges, connection.source || '', connection.target || '')) {
      setNotice('执行连接会形成环，已阻止保存；如需表达循环，请改用参考或注释连接。');
      return;
    }
    const nextEdges = addEdgeLocal(edgeWithRelation({
      ...connection,
      id: `edge:${connection.source}:${connection.target}:${Date.now()}`,
    }, newEdgeRelation), edges);
    if (nextEdges.length !== edges.length) {
      commitEdit(editorSnapshot(nodes, edges), { nodes, edges: nextEdges });
    }
  }, [commitEdit, edges, newEdgeRelation, nodes]);

  const updateSelectedEdgeRelation = useCallback((relation: EdgeRelation) => {
    if (!selectedEdge) return;
    const nextEdges = edges.map((edge) => edge.id === selectedEdge.id ? edgeWithRelation(edge, relation) : edge);
    commitEdit(editorSnapshot(nodes, edges), { nodes, edges: nextEdges });
    setNotice(`已将连接标记为 ${relation}`);
  }, [commitEdit, edges, nodes, selectedEdge]);

  const undo = useCallback(() => {
    const before = editorHistory.current.past.at(-1);
    if (!before) return;
    const current = editorSnapshot(nodes, edges);
    editorHistory.current = {
      past: editorHistory.current.past.slice(0, -1),
      future: [current, ...editorHistory.current.future].slice(0, 50),
    };
    const restored = cloneEditorSnapshot(before);
    setNodes(restored.nodes);
    setEdges(restored.edges);
    setDirty(true);
    setHistoryRevision((value) => value + 1);
    setNotice('已撤销上一步编辑');
  }, [edges, nodes]);

  const redo = useCallback(() => {
    const next = editorHistory.current.future[0];
    if (!next) return;
    const current = editorSnapshot(nodes, edges);
    editorHistory.current = {
      past: [...editorHistory.current.past, current].slice(-50),
      future: editorHistory.current.future.slice(1),
    };
    const restored = cloneEditorSnapshot(next);
    setNodes(restored.nodes);
    setEdges(restored.edges);
    setDirty(true);
    setHistoryRevision((value) => value + 1);
    setNotice('已重做上一步编辑');
  }, [edges, nodes]);

  const duplicateSelectedNodes = useCallback(() => {
    const selected = nodes.filter((node) => node.selected);
    if (!selected.length) return;
    const before = editorSnapshot(nodes, edges);
    const stamp = Date.now();
    const copies = selected.map((node, index) => ({
      ...node,
      id: `${node.id}:copy:${stamp}:${index}`,
      position: { x: node.position.x + 36, y: node.position.y + 36 },
      selected: true,
      data: { ...node.data, config: { ...node.data.config }, inputs: [...node.data.inputs], outputs: [...node.data.outputs] },
    }));
    const nextNodes = [...nodes.map((node) => ({ ...node, selected: false })), ...copies];
    commitEdit(before, { nodes: nextNodes, edges });
    setNotice(`已复制 ${copies.length} 个节点`);
  }, [commitEdit, edges, nodes]);

  const groupSelectedNodes = useCallback(() => {
    const selected = nodes.filter((node) => node.selected && node.data.kind !== 'group');
    if (selected.length < 1) {
      setNotice('请先选择至少一个节点再建立分组');
      return;
    }
    const before = editorSnapshot(nodes, edges);
    const groupId = `group:${Date.now()}`;
    const minX = Math.min(...selected.map((node) => node.position.x));
    const minY = Math.min(...selected.map((node) => node.position.y));
    const maxX = Math.max(...selected.map((node) => node.position.x + 190));
    const maxY = Math.max(...selected.map((node) => node.position.y + 100));
    const group: FlowNode = {
      id: groupId,
      type: 'workflow',
      position: { x: minX - 28, y: minY - 78 },
      style: { width: Math.max(460, maxX - minX + 56), height: Math.max(280, maxY - minY + 108) },
      data: { label: '新分组', kind: 'group', config: { width: Math.max(460, maxX - minX + 56), height: Math.max(280, maxY - minY + 108), collapsed: false }, status: 'idle', inputs: [], outputs: [], version: 1, locked: false },
      selected: true,
    };
    const nextNodes = [
      ...nodes.map((node) => selected.some((item) => item.id === node.id) ? {
        ...node,
        selected: false,
        parentId: groupId,
        position: { x: node.position.x - group.position.x, y: node.position.y - group.position.y },
        data: { ...node.data, config: { ...node.data.config, group_id: groupId } },
      } : { ...node, selected: false }),
      group,
    ];
    commitEdit(before, { nodes: nextNodes, edges });
    setNotice(`已将 ${selected.length} 个节点放入分组`);
  }, [commitEdit, edges, nodes]);

  const ungroupSelectedNodes = useCallback(() => {
    const selectedGroups = nodes.filter((node) => node.selected && node.data.kind === 'group');
    if (!selectedGroups.length) return;
    const before = editorSnapshot(nodes, edges);
    const groupIds = new Set(selectedGroups.map((node) => node.id));
    const nextNodes = nodes.filter((node) => !groupIds.has(node.id)).map((node) => groupIds.has(node.parentId || '') ? {
      ...node,
      parentId: undefined,
      position: { x: node.position.x + (selectedGroups.find((group) => group.id === node.parentId)?.position.x || 0), y: node.position.y + (selectedGroups.find((group) => group.id === node.parentId)?.position.y || 0) },
      selected: false,
      data: { ...node.data, config: Object.fromEntries(Object.entries(node.data.config).filter(([key]) => key !== 'group_id')) },
    } : node);
    commitEdit(before, { nodes: nextNodes, edges });
    setNotice('已解散所选分组，节点保留在画布上');
  }, [commitEdit, edges, nodes]);

  const autoLayout = useCallback(() => {
    const before = editorSnapshot(nodes, edges);
    const graphNodes = nodes.map((node) => ({
      id: node.id,
      kind: node.data.kind,
      label: node.data.label,
      position: node.position,
      config: node.parentId ? { ...node.data.config, group_id: node.parentId } : node.data.config,
      inputs: node.data.inputs,
      outputs: node.data.outputs,
      status: node.data.status,
      version: node.data.version,
      locked: node.data.locked,
    }));
    const layout = autoLayoutNodes(graphNodes, edges.map((edge) => ({ source: edge.source, target: edge.target, relation: (edge.data?.relation as EdgeRelation) || 'execution' })));
    const positions = new Map(layout.map((node) => [node.id, node.position]));
    const nextNodes = nodes.map((node) => ({ ...node, position: positions.get(node.id) || node.position }));
    commitEdit(before, { nodes: nextNodes, edges });
    setNotice('已按执行依赖自动布局');
  }, [commitEdit, edges, nodes]);

  const updateSelectedNode = useCallback((patch: Partial<GraphNodeData>, configPatch: Record<string, unknown> = {}) => {
    if (!selectedNode) return;
    const before = editorSnapshot(nodes, edges);
    const nextNodes = nodes.map((node) => node.id === selectedNode.id ? {
      ...node,
      draggable: patch.locked === undefined ? node.draggable : !patch.locked,
      data: {
        ...node.data,
        ...patch,
        config: { ...node.data.config, ...configPatch },
      },
    } : node);
    commitEdit(before, { nodes: nextNodes, edges });
  }, [commitEdit, edges, nodes, selectedNode]);

  const toggleSelectedGroup = useCallback(() => {
    const selectedGroup = nodes.find((node) => node.selected && node.data.kind === 'group');
    if (!selectedGroup) return;
    updateSelectedNode({}, { collapsed: !selectedGroup.data.config.collapsed });
    setNotice(selectedGroup.data.config.collapsed ? '分组已展开' : '分组已折叠');
  }, [nodes, updateSelectedNode]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select')) return;
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (mode !== 'canvas' && ['c', 'x', 'v'].includes(key)) {
        event.preventDefault();
        if (key === 'v') {
          if (!workflowClipboard.current.length) { setNotice('工作流剪贴板为空'); return; }
          const stamp = Date.now();
          const pasted = workflowClipboard.current.map((source, index) => {
            const id = `${source.id}:copy:${stamp}:${index}`;
            return { ...source, id, position: { x: source.position.x + 44, y: source.position.y + 44 }, selected: true, data: { ...source.data, label: `${source.data.label} 副本`, config: { ...source.data.config } } };
          });
          setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...pasted]);
          setDirty(true);
          setNotice(`已粘贴 ${pasted.length} 个工作流节点`);
          return;
        }
        const selected = nodes.filter((node) => node.selected);
        if (!selected.length) { setNotice('请先选择一个工作流节点'); return; }
        workflowClipboard.current = selected.map((node) => ({ ...node, selected: false, data: { ...node.data, config: { ...node.data.config } } }));
        if (key === 'x') {
          const ids = new Set(selected.map((node) => node.id));
          setNodes((current) => current.filter((node) => !ids.has(node.id)));
          setEdges((current) => current.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target)));
          setDirty(true);
          setNotice(`已剪切 ${selected.length} 个工作流节点`);
        } else setNotice(`已复制 ${selected.length} 个工作流节点，可使用 Ctrl+V 粘贴`);
        return;
      }
      if (mode === 'canvas') return;
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if (key === 'y') {
        event.preventDefault();
        redo();
      } else if (key === 'd') {
        event.preventDefault();
        duplicateSelectedNodes();
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [duplicateSelectedNodes, mode, nodes, redo, undo]);

  useEffect(() => {
    const onAssetShortcut = (event: KeyboardEvent) => {
      if (mode !== 'canvas') return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select')) return;
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === 'f') {
        event.preventDefault();
        setAssetBoardIndexOpen(true);
        window.setTimeout(() => document.getElementById('asset-board-directory-search')?.focus(), 0);
        return;
      }
      if (key === 's') {
        event.preventDefault();
        void saveAssetBoard();
        return;
      }
      if (!['c', 'x', 'v'].includes(key)) return;
      event.preventDefault();
      if (key === 'v') {
        if (!assetClipboard.current.length) { setNotice('资产剪贴板为空'); return; }
        const stamp = Date.now();
        const pasted = assetClipboard.current.map((source, index) => {
          const id = `${source.data.sourceNodeId || source.id}:copy:${stamp}:${index}`;
          const position = { x: source.position.x + 48, y: source.position.y + 48 };
          return { ...source, id, position, selected: true, data: { ...source.data, id, position, selected: true, sourceNodeId: undefined, presentationOnly: false, config: { ...source.data.config, copied_from: source.data.id } } };
        });
        const nextNodes = [...assetBoardNodes.map((node) => ({ ...node, selected: false })), ...pasted];
        setAssetBoardNodes(nextNodes);
        setAssetBoardSelection(pasted.length === 1 ? assetBoardSelectionKey(pasted[0].data) : null);
        recordAssetBoardState(assetBoardNodes, assetBoardEdges, nextNodes, assetBoardEdges);
        setAssetBoardDirty(true);
        setNotice(`已粘贴 ${pasted.length} 个资产节点`);
        return;
      }
      const selected = assetBoardNodes.filter((node) => node.selected && !node.data.presentationOnly && !['table', 'row', 'group'].includes(node.data.node_type));
      if (!selected.length) { setNotice('请先选择一个资产或镜头节点'); return; }
      assetClipboard.current = selected.map((node) => ({ ...node, selected: false, data: { ...node.data, selected: false, config: { ...node.data.config } } }));
      if (key === 'x') {
        const ids = new Set(selected.map((node) => node.id));
        const nextNodes = assetBoardNodes.filter((node) => !ids.has(node.id));
        const nextEdges = assetBoardEdges.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target));
        setAssetBoardNodes(nextNodes);
        setAssetBoardEdges(nextEdges);
        setAssetBoardSelection(null);
        recordAssetBoardState(assetBoardNodes, assetBoardEdges, nextNodes, nextEdges);
        setAssetBoardDirty(true);
        setNotice(`已剪切 ${selected.length} 个节点`);
      } else {
        setNotice(`已复制 ${selected.length} 个节点，可使用 Ctrl+V 粘贴`);
      }
    };
    window.addEventListener('keydown', onAssetShortcut);
    return () => window.removeEventListener('keydown', onAssetShortcut);
  }, [assetBoardEdges, assetBoardNodes, mode, recordAssetBoardState, setAssetBoardSelection]);

  const save = async (): Promise<GraphEnvelope | null> => {
    if (!graphEnvelope || !projectId) return null;
    setBusy(true);
    try {
      const saved = await studioApi.saveGraph(projectId, fromFlow(graphEnvelope.graph, nodes, edges), graphEnvelope.revision);
      setGraphEnvelope(saved);
      setDirty(false);
      setNotice(`工作流图已保存 · v${saved.revision}`);
      void refreshDashboard(false);
      return saved;
    } catch (error) {
      setNotice((error as Error).message);
      return null;
    } finally { setBusy(false); }
  };

  const applyAssetGridLayout = useCallback((preset: AssetGridPreset = assetBoardLayoutPreset, overrides: { columnWidth?: number; gap?: number; layoutMode?: AssetBoardLayoutMode } = {}) => {
    if (!assetBoardEnvelope) return;
    const nextColumnWidth = Math.max(220, Number(overrides.columnWidth) || (preset !== assetBoardLayoutPreset ? assetGridPresets[preset].columnWidth : assetBoardColumnWidth));
    const nextGap = Math.max(8, Number(overrides.gap) || assetBoardGap);
    const nextLayoutMode = overrides.layoutMode || assetBoardLayoutMode;
    const nextColumnWidths: AssetBoardColumnWidths = overrides.columnWidth !== undefined || preset !== assetBoardLayoutPreset
      ? { shots: 260, 'asset-flow': nextColumnWidth * 2 + nextGap, fusion: nextColumnWidth * 2 + nextGap }
      : assetBoardColumnWidths;
    const board: AssetBoard = { ...assetBoardEnvelope.board, metadata: { ...assetBoardEnvelope.board.metadata, layout_mode: 'shot_asset_table_v8', layout_view: nextLayoutMode, layout_preset: preset, layout_column_width: nextColumnWidth, layout_column_widths: nextColumnWidths, layout_gap: nextGap } };
    const nextNodes = assetBoardToFlowNodes(board, assetLibrary?.assets || [], assetBoardFilter, assetBoardShowShots, story?.story.shots || [], { forceGrid: true, preset, columnWidth: nextColumnWidth, columnWidths: nextColumnWidths, gap: nextGap, layoutMode: nextLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
    const nextEdges = assetBoardToFlowEdges(board, nextNodes);
    recordAssetBoardState(assetBoardNodes, assetBoardEdges, nextNodes, nextEdges, board);
    setAssetBoardLayoutPreset(preset);
    setAssetBoardLayoutMode(nextLayoutMode);
    setAssetBoardColumnWidth(nextColumnWidth);
    setAssetBoardColumnWidths(nextColumnWidths);
    setAssetBoardGap(nextGap);
    setAssetBoardEnvelope((current) => current ? { ...current, board } : current);
    setAssetBoardNodes(nextNodes);
    setAssetBoardEdges(nextEdges);
    setAssetBoardDirty(true);
    setNotice(`${nextLayoutMode === 'adaptive' ? '自适应资产流' : '资产类型矩阵'} · 列宽 ${nextColumnWidth}px · 间距 ${nextGap}px`);
  }, [assetBoardCollapsedScopes, assetBoardColumnWidth, assetBoardColumnWidths, assetBoardEdges, assetBoardEnvelope, assetBoardFilter, assetBoardGap, assetBoardLayoutMode, assetBoardLayoutPreset, assetBoardNodes, assetBoardShowShots, assetLibrary?.assets, recordAssetBoardState, story?.story.shots, toggleAssetBoardScope]);

  const autoLayoutAssetBoard = useCallback(() => applyAssetGridLayout(assetBoardLayoutPreset), [applyAssetGridLayout, assetBoardLayoutPreset]);

  const resetAssetBoardColumns = useCallback(() => {
    if (!assetBoardEnvelope) return;
    const widths = defaultAssetBoardColumnWidths;
    setAssetBoardColumnWidths(widths);
    setAssetBoardColumnWidth(310);
    setAssetBoardEnvelope((current) => current ? { ...current, board: { ...current.board, metadata: { ...current.board.metadata, layout_column_widths: widths, layout_column_width: 310 } } } : current);
    setAssetBoardNodes((current) => applyFixedAssetBoardFrame(current, widths).map((node) => node.data.presentationOnly || assetBoardCardIsLocked(node.data) ? node : { ...node, data: { ...node.data, config: { ...node.data.config, position_source: 'manual' } } }));
    setAssetBoardDirty(true);
    setAssetBoardToolbarOpen(null);
    setNotice('已恢复默认列宽；请点击顶部“保存”写入画布');
  }, [applyFixedAssetBoardFrame, assetBoardEnvelope]);

  const updateAssetBoardFilter = (value: string) => {
    setAssetBoardFilter(value);
    rebuildAssetBoardView({ filter: value });
  };

  const previewTimeline = async () => {
    if (!projectId || !timelineEnvelope) return;
    setBusy(true);
    try {
      let current = timelineEnvelope;
      if (timelineDirty) {
        current = await studioApi.saveTimeline(projectId, timelineEnvelope.document, timelineEnvelope.revision);
        setTimelineEnvelope(current);
        setTimelineDirty(false);
        setTimelinePreflight(await studioApi.timelinePreflight(projectId));
      }
      const preview = await studioApi.previewTimeline(projectId, current.revision);
      setRenderJob(preview);
      setNotice(`预览作业 ${preview.id} · ${preview.status}`);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const saveAudioStudio = async (document: AudioStudioDocument): Promise<AudioStudioEnvelope | null> => {
    if (!projectId || !audioStudio) return null;
    setBusy(true);
    try {
      const saved = await studioApi.saveAudioStudio(projectId, document, audioStudio.revision);
      setAudioStudio(saved);
      setAudioDirty(false);
      setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: saved.revision, document: { ...item.document, audio: saved.document } } : item));
      setNotice(`声音工作区已保存 · v${saved.revision}`);
      void refreshDashboard(false);
      return saved;
    } catch (error) {
      setNotice((error as Error).message);
      return null;
    } finally { setBusy(false); }
  };

  const refreshAudioStudio = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const [audioEnvelope, library, audit] = await Promise.all([studioApi.audioStudio(projectId), studioApi.assetLibrary(projectId), studioApi.assetAudit(projectId)]);
      setAudioStudio(audioEnvelope);
      setAssetLibrary(library);
      setAssetAudit(audit);
      setAudioDirty(false);
      setNotice('声音资产与 QA 状态已刷新');
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const createAudioAsset = async (assetClass: 'audio' | 'music' | 'sfx', name: string, role: string): Promise<string | null> => {
    if (!projectId || !project) return null;
    setBusy(true);
    try {
      const result = await studioApi.createAsset(projectId, { expected_revision: project.revision, name, asset_class: assetClass, asset_role: role, grade: 'B', required: false });
      setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: result.revision } : item));
      setAssetLibrary(result.library);
      setAudioStudio((current) => current ? { ...current, revision: result.revision, assets: result.library.assets.filter((asset) => ['audio', 'music', 'sfx'].includes(String(asset.assetClass))) } : current);
      return String(result.asset.id || '');
    } catch (error) {
      setNotice((error as Error).message);
      return null;
    } finally { setBusy(false); }
  };
  const updateAssetBoardShowShots = (value: boolean) => {
    setAssetBoardShowShots(value);
    rebuildAssetBoardView({ showShots: value });
  };
  const updateAssetBoardShotId = (value: string) => {
    setAssetBoardShotId(value);
    rebuildAssetBoardView({ shotId: value });
  };
  const updateAssetBoardOnlyBlocked = (value: boolean) => {
    setAssetBoardOnlyBlocked(value);
    rebuildAssetBoardView({ onlyBlocked: value });
  };
  const updateAssetBoardShowCandidates = (value: boolean) => {
    setAssetBoardShowCandidates(value);
    rebuildAssetBoardView({ showCandidates: value });
  };

  const saveCurrentPage = async () => {
    if (mode === 'story') return saveStory();
    if (mode === 'timeline') return saveTimeline();
    if (mode === 'audio') return audioStudio ? saveAudioStudio(audioStudio.document) : null;
    if (mode === 'canvas') return saveAssetBoard();
    setNotice('当前页面没有待保存的修改');
    return null;
  };

  const enqueueRun = async (graphRevision: number, nodeIds: string[], confirmed: boolean) => {
    if (!projectId) return;
    const created = await studioApi.run(projectId, graphRevision, confirmed, nodeIds);
    setRun(created);
    setNotice(`运行 ${created.id} 已进入 ${created.status}`);
    void refreshDashboard(false);
  };

  const confirmPaidRun = async () => {
    if (!paidConfirmation || !projectId) return;
    const pending = paidConfirmation;
    setPaidConfirmation(null);
    setBusy(true);
    try {
      await enqueueRun(pending.graphRevision, pending.nodeIds, true);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startRun = async () => {
    if (!graphEnvelope || !projectId) return;
    setBusy(true);
    try {
      let current = graphEnvelope;
      if (dirty) {
        const saved = await save();
        if (!saved) return;
        current = saved;
      }
      const { estimate } = await studioApi.estimate(projectId, selectedNodeIds);
      if (estimate.requires_confirmation) {
        setPaidConfirmation({ estimate, graphRevision: current.revision, nodeIds: selectedNodeIds });
        setNotice('请在费用确认窗口中确认后再排队');
        return;
      }
      await enqueueRun(current.revision, selectedNodeIds, false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const controlRun = async (action: 'pause' | 'resume' | 'cancel') => {
    if (!run) return;
    setBusy(true);
    try {
      const detail = action === 'pause' ? await studioApi.pauseRun(run.id) : action === 'resume' ? await studioApi.resumeRun(run.id) : await studioApi.cancelRun(run.id);
      setRun(detail);
      setNotice(`运行已${action === 'pause' ? '暂停' : action === 'resume' ? '恢复' : '取消'}`);
      void refreshDashboard(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const addAgentNode = () => {
    const id = `agent-${Date.now()}`;
    const nextNode: FlowNode = {
      id, type: 'workflow', position: { x: 160 + nodes.length * 24, y: 320 },
      data: { label: 'Agent 编排', kind: 'agent', config: { paid: false }, status: 'idle', inputs: ['context'], outputs: ['patch'], version: 1, locked: false },
    };
    const before = editorSnapshot(nodes, edges);
    commitEdit(before, { nodes: [...nodes, nextNode], edges });
    setNotice('已新增 Agent 节点');
  };

  const openCommandPalette = () => {
    setShortcutHelpOpen(false);
    setCommandQuery('');
    setCommandPaletteOpen(true);
  };
  const closeCommandPalette = () => setCommandPaletteOpen(false);
  const commandActions: CommandAction[] = [
    { id: 'home', label: '打开项目总览', description: '查看当前项目进度、阶段和下一步任务', shortcut: 'Alt 1', onSelect: () => setMode('home') },
    { id: 'story', label: '打开故事与分镜', description: '编辑创意目标、剧本和镜头计划', shortcut: 'Alt 2', onSelect: () => setMode('story') },
    { id: 'canvas', label: '打开资产生产工作区', description: '按镜头管理资产依赖、Prompt、候选和生产关系', shortcut: 'Alt 3', onSelect: () => { void openAssetBoard(); } },
    { id: 'timeline', label: '打开后期时间线', description: '编排片段、音轨和交付输出', shortcut: 'Alt 4', onSelect: () => setMode('timeline') },
    { id: 'audio', label: '打开声音资产工坊', description: '制作人物声音、对白、音乐 Cue、音效和声轨交接', shortcut: 'Alt 7', onSelect: () => setMode('audio') },
    { id: 'assets', label: '打开统一资产库', description: '检索资产、候选版本和 QA 状态', shortcut: 'Alt 5', onSelect: () => { setAssetLibraryFilter('all'); setAssetLibraryScope('all'); setMode('assets'); } },
    { id: 'settings', label: '打开设置与 Provider', description: '管理模型接入、凭据和能力路由', shortcut: 'Alt 6', onSelect: () => setMode('settings') },
    { id: 'save', label: '保存当前页面', description: currentPageDirty ? '写入当前页面的未保存修改' : '当前页面没有待保存的修改', shortcut: 'Ctrl / ⌘ S', disabled: busy, onSelect: () => { void saveCurrentPage(); } },
    { id: 'assistant', label: '打开 AI 创作助手', description: '读取当前项目并生成可审阅的结构化修改', shortcut: 'Ctrl / ⌘ Shift A', onSelect: () => setAssistantOpen(true) },
    { id: 'project', label: '打开项目管理', description: '切换、排序或新建项目', onSelect: () => setProjectManagerOpen(true) },
    { id: 'help', label: '查看快捷键', description: '打开完整的工作台键盘操作说明', shortcut: '?', onSelect: () => setShortcutHelpOpen(true) },
  ];

  useEffect(() => {
    if (!assetBoardToolbarOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.asset-board-toolbar-popover')) setAssetBoardToolbarOpen(null);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [assetBoardToolbarOpen]);

  useEffect(() => {
    const onGlobalShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const editable = target?.matches('input, textarea, select, [contenteditable="true"]');
      const key = event.key.toLowerCase();
      const primary = event.ctrlKey || event.metaKey;

      if (event.key === 'Escape') {
        if (confirmation) { event.preventDefault(); closeConfirmation(false); return; }
        if (paidConfirmation) { event.preventDefault(); setPaidConfirmation(null); return; }
        if (commandPaletteOpen) { event.preventDefault(); setCommandPaletteOpen(false); return; }
        if (shortcutHelpOpen) { event.preventDefault(); setShortcutHelpOpen(false); return; }
        if (assistantOpen) { event.preventDefault(); setAssistantOpen(false); return; }
        if (projectManagerOpen) { event.preventDefault(); setProjectManagerOpen(false); return; }
        if (assetCreateOpen) { event.preventDefault(); setAssetCreateOpen(false); return; }
        if (assetImportOpen) { event.preventDefault(); setAssetImportOpen(false); return; }
        if (assetContextMenu) { event.preventDefault(); setAssetContextMenu(null); return; }
        if (assetBoardIndexOpen) { event.preventDefault(); setAssetBoardIndexOpen(false); return; }
        if (assetBoardToolbarOpen) { event.preventDefault(); setAssetBoardToolbarOpen(null); return; }
      }

      if (mode === 'canvas' && !editable && !primary && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        event.stopPropagation();
        const selected = assetBoardNodes.filter((node) => node.selected && !node.hidden && !['table', 'row', 'group', 'shot'].includes(String(node.data.node_type)));
        const logicalTargets = [...new Map(selected.filter((node) => ['asset', 'handoff'].includes(String(node.data.node_type)) && node.data.asset_id).map((node) => [String(node.data.asset_id), node])).values()];
        if (logicalTargets.length > 1) {
          setNotice('请一次删除一个逻辑资产；Prompt / 图片卡与资产卡会共同删除同一逻辑资产。');
          return;
        }
        if (logicalTargets.length === 1) {
          void deleteAssetById(String(logicalTargets[0].data.asset_id), String(logicalTargets[0].data.label || logicalTargets[0].data.asset_id));
          return;
        }
        const removableCandidates = selected.filter((node) => node.data.node_type === 'artifact' && !node.data.presentationOnly);
        if (removableCandidates.length) {
          const ids = new Set(removableCandidates.map((node) => node.id));
          const nextNodes = assetBoardNodes.filter((node) => !ids.has(node.id));
          const nextEdges = assetBoardEdges.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target));
          setAssetBoardNodes(nextNodes);
          setAssetBoardEdges(nextEdges);
          setAssetBoardSelection(null);
          recordAssetBoardState(assetBoardNodes, assetBoardEdges, nextNodes, nextEdges);
          setAssetBoardDirty(true);
          setNotice(`已移除 ${removableCandidates.length} 个候选版本卡；保存后生效`);
          return;
        }
        setNotice('请先选择资产卡、Prompt / 图片卡或候选版本卡');
        return;
      }

      if (primary && key === 'k') {
        event.preventDefault();
        openCommandPalette();
        return;
      }
      if (primary && key === 's') {
        event.preventDefault();
        void saveCurrentPage();
        return;
      }
      if (primary && event.shiftKey && key === 'a') {
        event.preventDefault();
        setAssistantOpen(true);
        return;
      }
      if (mode === 'canvas' && primary && !editable && (key === 'z' || key === 'y')) {
        event.preventDefault();
        if (key === 'y' || event.shiftKey) redoAssetBoard(); else undoAssetBoard();
        return;
      }
      if (editable) return;
      if (!primary && event.altKey && /^[1-7]$/.test(event.key)) {
        event.preventDefault();
        const modes: Record<string, StudioMode> = { '1': 'home', '2': 'story', '3': 'canvas', '4': 'timeline', '5': 'assets', '6': 'settings', '7': 'audio' };
        setMode(modes[event.key]);
        return;
      }
      if (!primary && (event.key === '?' || event.key === '/')) {
        event.preventDefault();
        setShortcutHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onGlobalShortcut);
    return () => window.removeEventListener('keydown', onGlobalShortcut);
  }, [assetBoardEdges, assetBoardIndexOpen, assetBoardNodes, assetBoardToolbarOpen, assetContextMenu, assetCreateOpen, assetImportOpen, assistantOpen, busy, closeConfirmation, commandPaletteOpen, confirmation, deleteAssetById, mode, paidConfirmation, projectManagerOpen, recordAssetBoardState, redoAssetBoard, saveCurrentPage, setAssetBoardSelection, shortcutHelpOpen, undoAssetBoard]);

  return (
    <div className="studio-shell">
      <aside className="studio-sidebar" aria-label="Primary navigation">
        <div className="brand"><b>F</b><div><strong>FRAMEFLOW</strong><span>AI VIDEO OS · V3</span></div></div>
        <button className="create-button" onClick={() => { if (mode === 'canvas' || mode === 'assets') openAssetCreate(); else void openAssetBoard(); }} disabled={busy || !project}>{mode === 'canvas' ? '＋ 新增资产' : mode === 'assets' ? '＋ 新增逻辑资产' : '进入资产生产'}</button>
        <nav aria-label="Primary workspace navigation">
          <p>工作空间</p>
          <button className={mode === 'home' ? 'active' : ''} aria-current={mode === 'home' ? 'page' : undefined} onClick={() => setMode('home')}>⌂ 首页 / 项目总览</button>
          <button className={mode === 'story' ? 'active' : ''} aria-current={mode === 'story' ? 'page' : undefined} onClick={() => setMode('story')}>▥ 故事与分镜</button>
          <button className={mode === 'canvas' ? 'active' : ''} aria-current={mode === 'canvas' ? 'page' : undefined} onClick={() => setMode('canvas')}>◇ 资产生产工作区</button>
          <button className={mode === 'audio' ? 'active' : ''} aria-current={mode === 'audio' ? 'page' : undefined} onClick={() => setMode('audio')}>♫ 声音资产工坊 <i aria-hidden="true">{audioStudio?.document.dialogues.length || 0}</i></button>
          <button className={mode === 'timeline' ? 'active' : ''} aria-current={mode === 'timeline' ? 'page' : undefined} onClick={() => setMode('timeline')}>≋ 后期时间线</button>
          <p>项目资产</p>
          <button className={mode === 'assets' && assetLibraryScope === 'all' ? 'active' : ''} aria-current={mode === 'assets' && assetLibraryScope === 'all' ? 'page' : undefined} onClick={() => { setAssetLibraryScope('all'); setAssetLibraryFilter('all'); setMode('assets'); }}>统一资产库 <i aria-hidden="true">{assetLibrary?.summary.total || 0}</i></button>
          <button className={mode === 'assets' && assetLibraryScope === 'character' ? 'active' : ''} aria-current={mode === 'assets' && assetLibraryScope === 'character' ? 'page' : undefined} onClick={() => { setAssetLibraryScope('character'); setAssetLibraryFilter('all'); setMode('assets'); }}>人物与角色 <i aria-hidden="true">{assetLibrary?.summary.by_class?.character || 0}</i></button>
          <button className={mode === 'assets' && assetLibraryScope === 'scene-prop' ? 'active' : ''} aria-current={mode === 'assets' && assetLibraryScope === 'scene-prop' ? 'page' : undefined} onClick={() => { setAssetLibraryScope('scene-prop'); setAssetLibraryFilter('all'); setMode('assets'); }}>场景与道具 <i aria-hidden="true">{(assetLibrary?.summary.by_class?.scene || 0) + (assetLibrary?.summary.by_class?.prop || 0)}</i></button>
          <button className={mode === 'assets' && assetLibraryScope === 'fusion' ? 'active' : ''} aria-current={mode === 'assets' && assetLibraryScope === 'fusion' ? 'page' : undefined} onClick={() => { setAssetLibraryScope('fusion'); setAssetLibraryFilter('all'); setMode('assets'); }}>融合与候选 <i aria-hidden="true">{(assetLibrary?.summary.by_class?.fusion || 0) + (assetLibrary?.assets.filter((asset) => Boolean(asset.comparisons?.length)).length || 0)}</i></button>
          <p>系统</p>
          <button className={mode === 'settings' ? 'active' : ''} aria-current={mode === 'settings' ? 'page' : undefined} onClick={() => setMode('settings')}>⚙ 设置与 Provider</button>
        </nav>
        <div className="sidebar-footer"><span>V3 ONLY · 本地优先运行时</span><span>/api/v2 · revision protected</span></div>
      </aside>
      <main className="studio-main">
        <h1 className="a11y-page-title">{({ home: '项目总览', story: '故事与分镜', canvas: '资产生产工作区', timeline: '后期时间线', audio: '声音资产工坊', assets: '统一资产库', settings: '设置与 Provider' } as Record<StudioMode, string>)[mode]}</h1>
        <header className="studio-topbar">
          <div className="topbar-project">
            <strong className="project-title" title={project?.document.name || '尚未选择项目'}>{project?.document.name || '尚未选择项目'}</strong>
            <button type="button" className="project-manager-trigger" onClick={() => setProjectManagerOpen(true)} disabled={busy}>项目管理</button>
            <span className={currentPageDirty ? 'save-state dirty' : 'save-state'} role="status" aria-live="polite" title={currentPageDirty ? `有未保存更改 · ${notice}` : notice}>{currentPageDirty ? `有未保存更改 · ${notice}` : notice}</span>
          </div>
          <div className="top-actions"><button type="button" className={`assistant-launcher ${agentPlan?.status === 'awaiting_review' ? 'has-plan' : ''}`} onClick={() => setAssistantOpen(true)} title="打开 FRAMEFLOW AI 创作助手（Ctrl / ⌘ + Shift + A）"><span>✦</span> AI 助手{agentPlan?.status === 'awaiting_review' && <i>待审阅</i>}</button><button type="button" className="shortcut-launcher" onClick={() => setShortcutHelpOpen(true)} title="查看工作台快捷键（?）"><span>⌨</span> 快捷键 <kbd>?</kbd></button>{mode !== 'home' && <><button type="button" onClick={saveCurrentPage} disabled={!currentPageDirty || busy} title="保存当前页面的修改（Ctrl / ⌘ + S）">保存</button>{mode !== 'canvas' && <button type="button" className="run-button" onClick={startRun} disabled={busy || !graphEnvelope} title="运行专业流程图；故事页的 AI 分镜候选请使用“AI 整合并优化为拍摄剧本”">✦ {selectedNodeIds.length ? `运行所选 ${selectedNodeIds.length} 项` : '启动工作流'}</button>}</>}</div>
        </header>
        <div className="studio-content">
          {busy && <div className="progress-bar" />}
          {mode === 'story' && <StoryView story={story} storyRun={storyRun} storyDiff={storyDiff} dirty={storyDirty} busy={busy} onChange={(next) => { setStory((current) => current ? { ...current, story: next } : current); setStoryDirty(true); }} onSave={saveStory} onGenerate={generateStoryCandidate} onAccept={acceptStoryLayer} onRollback={rollbackStory} onOpenAssetBoard={openAssetBoard} onGenerateAssetPrompts={generateAssetPrompts} />}
          {mode === 'home' && <HomeView dashboard={dashboard} error={dashboardError} currentProjectId={projectId} busy={busy} onSelectProject={(id) => { setProjectId(id); setMode('home'); }} onOpenTask={openDashboardTask} onOpenStage={openDashboardStage} onRefresh={() => { void refreshDashboard(); }} />}
          {mode === 'assets' && <AssetLibraryViewV3 library={assetLibrary} focusAssetId={focusAssetId} busy={busy} scope={assetLibraryScope} filter={assetLibraryFilter} search={assetLibrarySearch} sort={assetLibrarySort} audit={assetAudit} onScopeChange={setAssetLibraryScope} onFilterChange={(value) => setAssetLibraryFilter(value as AssetLibraryStatusFilter)} onSearchChange={setAssetLibrarySearch} onSortChange={setAssetLibrarySort} onRefresh={refreshAssets} onSave={saveAssetMetadata} onFusionGate={checkFusionGate} onReview={reviewAssetCandidate} onCreateAsset={openAssetCreate} onOpenImport={() => setAssetImportOpen(true)} onRefreshAudit={refreshAssetAudit} onManualProductionApproval={manualProductionApproval} onDeleteAsset={(assetId, label) => { void deleteAssetById(assetId, label); }} onStartQa={(artifactId, qaType) => startAssetQa(artifactId, qaType, true)} onSubmitQa={submitAssetQaReview} onRegisterArtifact={registerAssetCandidate} />}
          {mode === 'audio' && <AudioStudioView projectId={projectId} projectName={project?.document.name || '当前项目'} envelope={audioStudio} assetLibrary={assetLibrary} settings={settings} story={story} busy={busy} onSave={saveAudioStudio} onRefresh={refreshAudioStudio} onCreateAsset={createAudioAsset} onNotice={setNotice} onDirtyChange={setAudioDirty} onOpenStory={() => setMode('story')} />}
          {mode === 'timeline' && <TimelineView envelope={timelineEnvelope} preflight={timelinePreflight} story={story} assetLibrary={assetLibrary} renderJob={renderJob} busy={busy} onChange={(document) => { setTimelineEnvelope((current) => current ? { ...current, document } : current); setTimelineDirty(true); }} onSave={saveTimeline} onAssemble={assembleTimeline} onPreview={previewTimeline} onRender={renderTimeline} />}
          {mode === 'settings' && <SettingsView settings={settings} busy={busy} onRefresh={refreshSettings} onSaveProvider={saveSettingsProvider} onAddPreset={addSettingsPreset} onDeleteProvider={deleteSettingsProvider} onWriteCredential={writeSettingsCredential} onImportCredential={importSettingsCredential} onClearCredential={clearSettingsCredential} onProbe={probeSettingsProvider} onBind={bindSettingsCapability} onAutoMatch={autoMatchSettingsBindings} />}
          {mode === 'canvas' && (
            <section className="canvas-wrap asset-board-wrap">
              <aside className={`asset-board-index ${assetBoardIndexOpen ? 'open' : ''} ${assetBoardIndexPosition.x > 520 ? 'dock-left' : ''} ${assetBoardIndexPosition.y > 420 ? 'dock-up' : ''}`} style={{ left: assetBoardIndexPosition.x, top: assetBoardIndexPosition.y }}>
                <button className="asset-board-index-toggle" onPointerDown={updateAssetBoardIndexPosition} onClick={() => { if (assetBoardIndexClickSuppressed.current) { assetBoardIndexClickSuppressed.current = false; return; } setAssetBoardIndexOpen((value) => !value); }} aria-label="打开镜头索引目录" title="拖动定位 · 点击打开镜头目录"><span /><span /><span /></button>
                {assetBoardIndexOpen && <div className="asset-board-index-popover">
                  <header><div><span>SHOT INDEX</span><strong>镜头目录</strong><small>选择镜头后自动定位到画布</small></div><button onClick={() => setAssetBoardIndexOpen(false)} aria-label="关闭目录">×</button></header>
                  <input id="asset-board-directory-search" type="search" value={assetBoardDirectoryQuery} onChange={(event) => setAssetBoardDirectoryQuery(event.target.value)} placeholder="搜索 SH001 或场景名称" />
                  <nav>{assetBoardShotDirectory.length ? assetBoardShotDirectory.map((item) => <button key={item.value} className={assetBoardLocator === item.value ? 'active' : ''} onClick={() => { focusAssetBoardTarget(item.value); setAssetBoardIndexOpen(false); }}><b>{item.value}</b><span>{item.label.replace(`${item.value} · `, '')}</span></button>) : <p>没有匹配的镜头</p>}</nav>
                </div>}
              </aside>
              <AssetBoardToolbar
                assetCount={new Set(assetBoardNodes.filter((node) => !node.hidden && node.data.asset_id).map((node) => node.data.asset_id)).size}
                shotCount={assetBoardNodes.filter((node) => !node.hidden && node.data.node_type === 'shot').length}
                relationCount={assetBoardEdges.filter((edge) => !edge.hidden).length}
                busy={busy}
                boardReady={Boolean(assetBoardEnvelope)}
                dirty={assetBoardDirty}
                assetPlacement={assetPlacement}
                menu={assetBoardToolbarOpen}
                onMenuChange={setAssetBoardToolbarOpen}
                onSync={() => { void syncAssetBoard(); }}
                onCancelPlacement={() => { setAssetPlacement(null); setNotice('已取消资产镜头分配'); }}
                storyShots={story?.story.shots || []}
                filter={assetBoardFilter}
                onFilterChange={updateAssetBoardFilter}
                showShots={assetBoardShowShots}
                onShowShotsChange={updateAssetBoardShowShots}
                shotId={assetBoardShotId}
                onShotIdChange={updateAssetBoardShotId}
                onlyBlocked={assetBoardOnlyBlocked}
                onOnlyBlockedChange={updateAssetBoardOnlyBlocked}
                showCandidates={assetBoardShowCandidates}
                onShowCandidatesChange={updateAssetBoardShowCandidates}
                layoutMode={assetBoardLayoutMode}
                onLayoutModeChange={(value) => applyAssetGridLayout(assetBoardLayoutPreset, { layoutMode: value })}
                layoutPreset={assetBoardLayoutPreset}
                onLayoutPresetChange={(value) => applyAssetGridLayout(value)}
                gap={assetBoardGap}
                onGapChange={(value) => applyAssetGridLayout(assetBoardLayoutPreset, { gap: value })}
                onAutoLayout={autoLayoutAssetBoard}
                onResetColumns={resetAssetBoardColumns}
              />
                <Suspense fallback={<div className="canvas-loading" role="status">正在加载资产画布…</div>}>
                  <LazyAssetBoardFlow
                    nodes={assetBoardNodes}
                    edges={assetBoardEdges}
                    focusTarget={assetBoardLocator}
                    onNodesChange={updateAssetBoardNodes}
                    onEdgesChange={updateAssetBoardEdges}
                    onConnect={connectAssetBoard}
                    onNodeClick={onAssetBoardNodeClick}
                    onNodeDragStart={onAssetNodeDragStart}
                    onNodeDragStop={onAssetNodeDragStop}
                    onMoveEnd={(viewport) => { setAssetBoardEnvelope((current) => current ? { ...current, board: { ...current.board, viewport } } : current); setAssetBoardDirty(true); }}
                    defaultViewport={assetBoardEnvelope?.board.viewport as Viewport | undefined}
                  />
                </Suspense>
            </section>
          )}
        </div>
      </main>
      <aside className="context-panel" aria-label="Project context" tabIndex={0}>
        <header><span>PROJECT CONTEXT</span><h2>{project?.document.name || '尚未选择项目'}</h2><p>{project?.document.brief || '项目上下文、运行和审批状态会显示在这里。'}</p></header>
          {mode === 'canvas' ? selectedAssetBoardCards.length > 1 ? <section className="asset-selection-multi-state"><span>ASSET BOARD SELECTION</span><h3>已选中多个卡片</h3><p>当前选中了 {selectedAssetBoardCards.length} 张卡片。请单独选择一张卡片查看对应的资产、Prompt 或候选版本。</p></section> : <AssetProductionPanel asset={selectedProductionAsset} selectedCardType={selectedAssetBoardNode?.data.node_type === 'asset' || selectedAssetBoardNode?.data.node_type === 'handoff' || selectedAssetBoardNode?.data.node_type === 'artifact' ? selectedAssetBoardNode.data.node_type : undefined} story={story} fusionSources={selectedFusionSources} busy={busy} projectRevision={project?.revision} assetBoardDirty={assetBoardDirty} promptDraft={assetPromptDraft && assetPromptDraft.assetId === selectedProductionAsset?.id ? assetPromptDraft.prompt : undefined} onSave={saveAssetMetadata} onHandoff={handoffAssetToChatGPT} onImport={importAssetCandidate} onStartQa={startAssetQa} onApprove={approveAssetCandidate} onRegister={registerAssetCandidate} onApprovePromptCard={approveAssetPromptCard} onGenerateImageCard={generateAssetImageCard} onGeneratePrompt={generateAssetPrompts} onGenerateFusionPrompt={generateFusionPrompt} onManualProductionApproval={manualProductionApproval} /> : <>
        {selectedNode && <section className="node-inspector"><h3>{selectedNode.data.kind === 'group' ? '分组 Inspector' : '节点 Inspector'}</h3><label>节点名称<input value={selectedNode.data.label} onChange={(event) => updateSelectedNode({ label: event.target.value })} /></label>{selectedNode.data.kind !== 'group' && <><label className="check-row"><input type="checkbox" checked={Boolean(selectedNode.data.config.paid)} onChange={(event) => updateSelectedNode({}, { paid: event.target.checked })} />付费节点</label><label>预计费用<input type="number" min="0" step="0.01" value={String(selectedNode.data.config.estimated_cost ?? '')} onChange={(event) => updateSelectedNode({}, { estimated_cost: event.target.value === '' ? 0 : Number(event.target.value) })} /></label></>}{selectedNode.data.kind === 'group' && <label className="check-row"><input type="checkbox" checked={Boolean(selectedNode.data.config.collapsed)} onChange={(event) => updateSelectedNode({}, { collapsed: event.target.checked })} />折叠组内容</label>}<label className="check-row"><input type="checkbox" checked={selectedNode.data.locked} onChange={(event) => updateSelectedNode({ locked: event.target.checked })} />锁定节点位置</label><small className="inspector-hint">修改会进入图编辑历史，保存时受 revision 冲突保护。</small></section>}
        <section><h3>制作规格</h3><dl><div><dt>画幅</dt><dd>{project?.document.ratio || '—'}</dd></div><div><dt>时长</dt><dd>{project?.document.duration || 0}s</dd></div><div><dt>图版本</dt><dd>v{graphEnvelope?.revision || 0}</dd></div><div><dt>时间线</dt><dd>v{timelineEnvelope?.revision || 0}{timelineDirty ? ' · 未保存' : ''}</dd></div></dl></section>
        {renderJob && <section><h3>交付作业</h3><div className="run-card"><b>{renderJob.status}</b><code>{renderJob.id}</code>{renderJob.result?.delivery && <small>MP4、字幕、项目 JSON、资产清单和 manifest 已生成</small>}{renderJob.error && <small>{String(renderJob.error.message || '渲染失败')}</small>}</div></section>}
        <section><h3>监督式运行</h3>{run ? <div className="run-card"><b>{runStatusLabel(run.status)}</b><code>{run.id}</code><span>{run.estimate.node_count} 节点 · {run.estimate.paid_node_count} 付费</span>{'nodes' in run && <small>{(run as WorkflowRunDetail).nodes.filter((node) => ['succeeded', 'cached'].includes(node.status)).length}/{(run as WorkflowRunDetail).nodes.length} 个节点完成</small>}<div className="run-actions">{['queued', 'running'].includes(run.status) && <button onClick={() => controlRun('pause')} disabled={busy}>暂停</button>}{['paused', 'failed'].includes(run.status) && <button onClick={() => controlRun('resume')} disabled={busy}>恢复</button>}{!['succeeded', 'failed', 'canceled'].includes(run.status) && <button onClick={() => controlRun('cancel')} disabled={busy}>取消</button>}</div></div> : <p className="muted">尚未启动 V3 工作流。可选择节点进行局部运行。</p>}</section>
         <section className="assistant-context-launcher"><div className="assistant-context-launcher-head"><div><span>FRAMEFLOW AI</span><h3>创作助手</h3></div><b>{agentPlan?.status === 'awaiting_review' ? '待审阅' : '在线'}</b></div><p>读取全流程、当前项目和 Video Skill，生成可审阅的结构化修改。</p><button onClick={() => setAssistantOpen(true)}>打开 AI 助手 <span>✦</span></button></section>
        <section><h3>安全门</h3><ul><li>付费生成必须确认</li><li>批准资产不可覆盖</li><li>运行保存不可变快照</li><li>失败只重跑受影响节点</li></ul></section>
        </>}
      </aside>
      <AssistantDrawer open={assistantOpen} project={project} mode={mode} graph={graphEnvelope} story={story} assetLibrary={assetLibrary} audioStudio={audioStudio} timeline={timelineEnvelope} selectedNodeIds={selectedNodeIds} selectedEdgeIds={selectedEdgeIds} dirty={dirty} storyDirty={storyDirty} assetBoardDirty={assetBoardDirty} audioDirty={audioDirty} timelineDirty={timelineDirty} plan={agentPlan} busy={agentBusy || busy} skills={workflowManifests} selectedSkillId={assistantSkillId} onSkillChange={setAssistantSkillId} onCreate={createAgentPlan} onApply={applyAgentPlan} onReject={rejectAgentPlan} onClose={() => setAssistantOpen(false)} onNavigate={setMode} />
      <CommandPalette open={commandPaletteOpen} query={commandQuery} actions={commandActions} onQueryChange={setCommandQuery} onClose={closeCommandPalette} />
      <ShortcutHelp open={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} />
      {assetCreateOpen && <AssetCreateModal draft={assetCreateDraft} shots={story?.story.shots || []} busy={busy} onChange={(patch) => setAssetCreateDraft((current) => ({ ...current, ...patch }))} onClose={() => setAssetCreateOpen(false)} onSubmit={() => { void addAssetToBoard(); }} />}
      {assetImportOpen && assetLibrary && <AssetImportDrawer library={assetLibrary} busy={busy} onClose={() => setAssetImportOpen(false)} onImport={importAssetBatch} />}
      {paidConfirmation && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPaidConfirmation(null); }}>
        <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="paid-confirmation-title">
          <header className="confirm-dialog-heading"><div><span>PAID ACTION GATE</span><h2 id="paid-confirmation-title">确认付费工作流</h2></div><button className="close-button" onClick={() => setPaidConfirmation(null)} aria-label="关闭费用确认">×</button></header>
          <p>本次将排队执行 {paidConfirmation.estimate.node_count} 个节点，其中 {paidConfirmation.estimate.paid_node_count} 个需要付费 Provider。</p>
          <p className="confirm-dialog-cost">预计费用：<strong>{paidConfirmation.estimate.estimated_cost} {paidConfirmation.estimate.currency}</strong></p>
          <ul className="confirm-dialog-list">{paidConfirmation.estimate.paid_nodes.map((node) => <li key={node.node_id}><span>{node.node_id}</span><span>{node.model || '未指定模型'} · {node.estimated_cost} {node.currency || paidConfirmation.estimate.currency}</span></li>)}</ul>
          <p className="muted">影响节点：{(paidConfirmation.estimate.impact_node_ids || paidConfirmation.nodeIds).join('、') || '全流程'}</p>
          <footer className="confirm-dialog-actions"><button onClick={() => { setPaidConfirmation(null); setNotice('已取消：未创建付费任务。'); }}>取消</button><button className="danger-button" onClick={() => void confirmPaidRun()} disabled={busy}>确认排队</button></footer>
        </section>
      </div>}
      {confirmation && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeConfirmation(false); }}>
        <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="generic-confirmation-title">
          <header className="confirm-dialog-heading"><div><span>CONFIRM ACTION</span><h2 id="generic-confirmation-title">{confirmation.title}</h2></div><button className="close-button" onClick={() => closeConfirmation(false)} aria-label="关闭确认窗口">×</button></header>
          <p>{confirmation.message}</p>
          <footer className="confirm-dialog-actions"><button onClick={() => closeConfirmation(false)}>取消</button><button className={confirmation.danger ? 'danger-button' : 'primary-button'} onClick={() => closeConfirmation(true)}>{confirmation.confirmLabel}</button></footer>
        </section>
      </div>}
      {assetContextMenu && <AssetContextMenu menu={assetContextMenu} shots={story?.story.shots || []} busy={busy} onClose={() => setAssetContextMenu(null)} onDelete={() => { void deleteAssetFromContext(); }} onMove={moveAssetFromContext} onCopy={() => { void copyAssetFromContext(); }} />}
      {projectManagerOpen && <ProjectManager projects={projects} archivedProjects={archivedProjects} currentId={projectId} busy={busy} onClose={() => setProjectManagerOpen(false)} onSwitch={(nextId) => { setProjectId(nextId); setProjectManagerOpen(false); }} onMove={moveProject} onDelete={deleteProject} onArchive={archiveProject} onRestore={restoreProject} onCreate={createProject} />}
    </div>
  );
}

export default function App() {
  return <Studio />;
}
