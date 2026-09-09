import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Connection, Edge, EdgeChange, Node, NodeChange, Viewport } from '@xyflow/react';
import { StudioApiError, studioApi } from './api';
import { AudioStudioView } from './AudioStudioView';
import { AssistantWorkspace } from './AssistantWorkspace';
import { StoryWorkbench } from './StoryWorkbench';
import { EDGE_RELATIONS, autoLayoutNodes, edgeRelationPresentation, wouldCreateExecutionCycle, type EdgeRelation } from './graph-editor';
import type { AgentPlan, AudioStudioDocument, AudioStudioEnvelope, AssetBoard, AssetBoardEdgeRelation, AssetBoardEnvelope, AssetBoardNode, AssetLibraryEnvelope, DashboardEnvelope, DashboardTask, GraphEnvelope, GraphNodeData, HomeStatus, LibraryAsset, MiniMaxRegion, ProjectCreateInput, ProjectDashboard, ProjectRecord, ProjectHomeSummary, RenderJob, RunEstimate, SettingsEnvelope, SettingsProvider, SettingsPreset, StoryChecks, StoryDocument, StoryEnvelope, StoryRun, StoryShot, TimelineClip, TimelineDocument, TimelineEnvelope, TimelinePreflight, TimelinePreflightShot, WorkflowGraph, WorkflowManifest, WorkflowRun, WorkflowRunDetail } from './types';
import { dashboardHasActiveWork, progressLabel, stageProgress, statusClass, statusIcon, statusLabel, taskPriorityLabel } from './dashboard-state';
import { assetClassLabels as sharedAssetClassLabels, assetStatusLabels as sharedAssetStatusLabels } from './asset-state';
import { buildAssetGenerationOrder, type AssetGenerationOrderItem } from './asset-generation-order';
import { generationReferenceAssetsForAsset, mergeGenerationReferenceAssets } from './asset-reference-requirements';
import { applyAssetBoardSelection, assetBoardSelectionKey, selectedAssetBoardCards as getSelectedAssetBoardCards, singleSelectedAssetBoardCard, type AssetBoardSelectionKey } from './asset-board-selection';
import { VirtualAssetList } from './components/VirtualAssetList';
import { PROMPT_CONTRACT_VERSION, PROMPT_WORKFLOW_ID, buildMiniMaxWebPromptPackage, buildNaturalLanguagePrompt, formatMiniMaxWebPromptPackage, normalizePromptPack, renderPromptValue } from './prompt-design';

type StudioMode = 'home' | 'story' | 'canvas' | 'timeline' | 'audio' | 'settings';
type AssetPromptRunState = {
  status: 'idle' | 'preparing' | 'running' | 'success' | 'error';
  message: string;
  startedAt: number | null;
};
type AutoSaveState = 'idle' | 'scheduled' | 'saving' | 'saved' | 'error';
const AUTO_SAVE_DELAY_MS = 900;
const AUTO_SAVE_RETRY_DELAY_MS = 5000;
const LazyAssetBoardFlow = lazy(() => import('./AssetBoardFlow').then(({ AssetBoardFlow }) => ({ default: AssetBoardFlow })));
type FlowNode = Node<GraphNodeData, 'workflow'>;
type AssetBoardCollapseTarget = { type: 'shot' | 'asset'; id: string; keepNodeId?: string; scopeKey?: string };
type AssetBoardContextTarget = { nodeId: string; assetId: string; label: string; nodeType: AssetBoardNodeData['node_type']; rowKey: string; x: number; y: number };
type AssetPlacement = { assetId: string; name: string; mode: 'assign' | 'move' };
type AssetBoardColumnWidths = { shots: number; 'asset-flow': number; fusion: number };
type AssetEditorDraft = { prompt: string; assetSpec: string; anchors: string; mustPreserve: string; mustAvoid: string };
type AssetBoardSyncEnvelope = AssetBoardEnvelope & { project_revision?: number; story?: StoryDocument; library?: AssetLibraryEnvelope };
type AssetProductionFocus = { assetId: string; target: AssetProductionTarget } | null;
type AssetAssignmentOverrides = { pending?: AssetPlacement; projectRevision?: number; boardEnvelope?: AssetBoardEnvelope; library?: AssetLibraryEnvelope; storyEnvelope?: StoryEnvelope; nodes?: AssetFlowNode[]; edges?: Edge[] };
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
  onRemoveArtifact?: (assetId: string, artifactId: string) => void;
  onApproveAsset?: (assetId: string, artifactId: string) => void;
  onRejectAsset?: (assetId: string, artifactId: string) => void;
  onRegisterAsset?: (assetId: string, artifactId: string) => void;
  onGeneratePrompt?: (assetId: string) => void;
  onGenerateFusionPrompt?: (assetId: string, sourceAssetIds: string[], shotId: string) => void;
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
      ['Alt + 5', '声音资产工坊'],
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
type AssetBoardLayoutState = { preset: AssetGridPreset; mode: AssetBoardLayoutMode; columnWidth: number; columnWidths: AssetBoardColumnWidths; directoryPosition: { x: number; y: number }; gap: number };
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

// These are layout budgets, not guesses about the current DOM. Every core
// card gets a fixed slot so an asset group can be laid out from the same
// numbers that the card itself uses. Prompt text and review details scroll
// inside the slot; they must not change the position of the next group.
export const assetBoardCardHeights = {
  asset: 160,
  prompt: 500,
  promptWithMedia: 650,
  artifact: 260,
  shot: 112,
  default: 106,
} as const;

export function assetBoardStackHeight(heights: number[], gap: number): number {
  if (!heights.length) return 0;
  return heights.reduce((total, height) => total + height, 0) + Math.max(0, heights.length - 1) * gap;
}

export function assetBoardAssetGroupHeight(titleHeights: number[], outputHeights: number[], gap: number): number {
  return Math.max(
    assetBoardCardHeights.asset,
    assetBoardStackHeight(titleHeights, gap),
    assetBoardStackHeight(outputHeights, gap),
  );
}

export function assetBoardCardHeight(node: { node_type: string; config: Record<string, any> }): number {
  const config = node.config || {};
  const isPromptCard = node.node_type === 'handoff' && Boolean(config.prompt_card);
  const hasPromptMedia = isPromptCard && Boolean(
    String(config.artifact_url || config.asset_file_url || '').trim() || config.production_draft,
  );
  if (node.node_type === 'asset') return assetBoardCardHeights.asset;
  if (node.node_type === 'artifact') return assetBoardCardHeights.artifact;
  if (isPromptCard) return hasPromptMedia ? assetBoardCardHeights.promptWithMedia : assetBoardCardHeights.prompt;
  if (node.node_type === 'shot') return assetBoardCardHeights.shot;
  return assetBoardCardHeights.default;
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
      const preferred = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus], [autofocus]');
      const initial = preferred || dialog.querySelector<HTMLElement>(dialogFocusableSelector);
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
      <button type="button" onClick={onSync} disabled={busy || !boardReady || dirty} title={dirty ? '工作区会自动保存，请稍候再同步故事与分镜' : '同步故事与分镜'}>同步故事与分镜</button>
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

 export function assetBoardToFlowNodes(board: AssetBoard, assets: LibraryAsset[], filter: string, showShots: boolean, storyShots: StoryShot[] = [], options: { forceGrid?: boolean; preset?: AssetGridPreset; columnWidth?: number; columnWidths?: AssetBoardColumnWidths; gap?: number; layoutMode?: AssetBoardLayoutMode; collapsedScopes?: Record<string, string | true>; onlyBlocked?: boolean; showCandidates?: boolean; shotId?: string; selectedSelectionKey?: AssetBoardSelectionKey | null; onToggleScope?: (target: AssetBoardCollapseTarget) => void; onContextMenu?: (target: AssetBoardContextTarget) => void; onApprovePrompt?: (assetId: string) => void; onGenerateImage?: (assetId: string) => void; onGeneratePrompt?: (assetId: string) => void; onGenerateFusionPrompt?: (assetId: string, sourceAssetIds: string[], shotId: string) => void; onCopyPrompt?: (assetId: string) => void; onUploadAsset?: (assetId: string, file: File) => void; onRemoveArtifact?: (assetId: string, artifactId: string) => void; onApproveAsset?: (assetId: string, artifactId: string) => void; onRejectAsset?: (assetId: string, artifactId: string) => void; onRegisterAsset?: (assetId: string, artifactId: string) => void; onColumnResize?: (key: keyof AssetBoardColumnWidths, delta: number) => void; onOpenAssetProduction?: (assetId: string, target: AssetProductionTarget, nodeId?: string) => void } = {}): AssetFlowNode[] {
  const requestedPreset = options.preset || String(board.metadata.layout_preset || 'standard') as AssetGridPreset;
  const preset = assetGridPresets[requestedPreset] || assetGridPresets.standard;
  const layoutMode = options.layoutMode || (String(board.metadata.layout_view) === 'matrix' ? 'matrix' : 'adaptive') as AssetBoardLayoutMode;
  const collapsedScopes = options.collapsedScopes || {};
  const useStoredPositions = !options.forceGrid && board.metadata.layout_mode === 'shot_asset_table_v8' && board.metadata.layout_view === layoutMode;
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const promptArtifactFor = (node: AssetBoardNode, asset?: LibraryAsset) => {
    if (node.node_type !== 'handoff' || !node.config.prompt_card || !asset) return undefined;
    const artifacts = Array.isArray(asset.artifacts) ? asset.artifacts as Record<string, any>[] : [];
    const liveImages = artifacts.filter((item) => String(item.status || '') !== 'archived' && String(item.mime_type || '').toLowerCase().startsWith('image/'));
    const configuredId = String(node.config.artifact_id || '');
    const currentId = String(asset.artifactId || asset.artifact_id || '');
    return liveImages.find((item) => String(item.id || item.artifact_id || '') === configuredId)
      || liveImages.find((item) => String(item.id || item.artifact_id || '') === currentId)
      || liveImages[0];
  };
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
  const matrixStackHeights = new Map<string, number[]>();
  const adaptiveFlowGroups = new Map<string, Array<{ key: string; column: string; titleHeights: number[]; outputHeights: number[] }>>();
  const cardHeightFor = (node: AssetBoardNode) => {
    const linkedAsset = node.asset_id ? assetMap.get(node.asset_id) : undefined;
    const promptArtifact = promptArtifactFor(node, linkedAsset);
    return assetBoardCardHeight({
      node_type: node.node_type,
      config: {
        ...node.config,
        asset_prompt: linkedAsset?.prompt || '',
        artifact_url: node.config.artifact_url || promptArtifact?.url || '',
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
      const matrixHeights = matrixStackHeights.get(key) || [];
      matrixHeights.push(estimatedCardHeight);
      matrixStackHeights.set(key, matrixHeights);
      if (layoutMode === 'adaptive' && node.node_type !== 'shot') {
        const assetKey = String(node.asset_id || node.id);
        const groups = adaptiveFlowGroups.get(row) || [];
        const group = groups.find((item) => item.key === assetKey);
        if (group) {
          if (node.node_type === 'asset') group.titleHeights.push(estimatedCardHeight);
          else group.outputHeights.push(estimatedCardHeight);
        } else {
          groups.push({
            key: assetKey,
            column: columnForNode(node),
            titleHeights: node.node_type === 'asset' ? [estimatedCardHeight] : [],
            outputHeights: node.node_type === 'asset' ? [] : [estimatedCardHeight],
          });
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
      const metrics = (adaptiveFlowGroups.get(row) || []).map((group) => {
        const titleHeight = assetBoardStackHeight(group.titleHeights, gap);
        const outputHeight = assetBoardStackHeight(group.outputHeights, gap);
        const groupHeight = assetBoardAssetGroupHeight(group.titleHeights, group.outputHeights, gap);
        return { group, titleHeight, outputHeight, groupHeight };
      });
      const flowMetrics = metrics.filter((item) => item.group.column !== 'fusion');
      const fusionMetrics = metrics.filter((item) => item.group.column === 'fusion');
      const stackHeight = (items: typeof metrics) => items.length ? gap + items.reduce((total, item) => total + item.groupHeight + gap, 0) : gap * 2;
      const flowHeight = stackHeight(flowMetrics);
      const fusionContentHeight = fusionMetrics.reduce((total, item) => total + item.groupHeight, 0) + Math.max(0, fusionMetrics.length - 1) * gap;
      const fusionHeight = fusionMetrics.length ? fusionContentHeight + gap * 2 : gap * 2;
      height = Math.max(height, flowHeight, fusionHeight);

      let flowCursor = gap;
      for (const item of flowMetrics) {
        adaptiveFlowGroupLayout.set(`${row}:${item.group.key}`, { top: flowCursor, height: item.groupHeight, titleHeight: item.titleHeight, outputHeight: item.outputHeight, fusionStack: false });
        flowCursor += item.groupHeight + gap;
      }

      // Fusion is a downstream result for the shot, so keep its whole asset
      // group visually centered inside the same shot row instead of placing
      // it after every upstream asset group. The group remains in the
      // dedicated SHOT FUSION column; only its vertical alignment changes.
      let fusionCursor = fusionMetrics.length ? Math.max(gap, (height - fusionContentHeight) / 2) : gap;
      for (const item of fusionMetrics) {
        adaptiveFlowGroupLayout.set(`${row}:${item.group.key}`, { top: fusionCursor, height: item.groupHeight, titleHeight: item.titleHeight, outputHeight: item.outputHeight, fusionStack: true });
        fusionCursor += item.groupHeight + gap;
      }
    } else {
      for (const column of assetGridColumns) {
        const columnHeight = assetBoardStackHeight(matrixStackHeights.get(`${row}:${column.key}`) || [], gap);
        if (columnHeight) height = Math.max(height, gap * 2 + columnHeight);
      }
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
      const promptArtifact = promptArtifactFor(node, linkedAsset);
      const promptArtifactId = promptArtifact ? String(promptArtifact.id || promptArtifact.artifact_id || '') : '';
      const promptArtifactActive = Boolean(promptArtifactId && linkedAsset?.versions?.some((version: Record<string, any>) => Boolean(version.is_active) && String(version.artifact_id || '') === promptArtifactId));
      const promptArtifactConfig = node.node_type === 'handoff' && node.config.prompt_card && linkedAsset && Array.isArray(linkedAsset.artifacts) ? {
        artifact_id: promptArtifactId || null,
        artifact_url: promptArtifact?.url || null,
        artifact_status: promptArtifact?.status || null,
        artifact_qa_decision: promptArtifact?.qa_decision || promptArtifact?.qaDecision || null,
        artifact_source_type: promptArtifact?.source_type || promptArtifact?.source || null,
        artifact_active: promptArtifactActive,
        artifact_version_id: promptArtifactActive ? linkedAsset?.versions?.find((version: Record<string, any>) => Boolean(version.is_active) && String(version.artifact_id || '') === promptArtifactId)?.id || null : null,
      } : {};
        const prerequisiteGate = linkedAsset?.prerequisiteGate;
        const prerequisiteBlockedDependencies = Array.isArray(prerequisiteGate?.items) ? prerequisiteGate.items.filter((item: Record<string, any>) => item.production_ready !== true) : [];
        const data: AssetBoardNodeData = { ...node, id, position, presentationOnly, sourceNodeId: presentationOnly ? node.id : undefined, collapsed: Boolean(assetScope), onToggleScope: options.onToggleScope, onContextMenu: options.onContextMenu, onApprovePrompt: options.onApprovePrompt, onGenerateImage: options.onGenerateImage, onGeneratePrompt: options.onGeneratePrompt, onGenerateFusionPrompt: options.onGenerateFusionPrompt, onCopyPrompt: options.onCopyPrompt, onUploadAsset: options.onUploadAsset, onRemoveArtifact: options.onRemoveArtifact, onApproveAsset: options.onApproveAsset, onRejectAsset: options.onRejectAsset, onRegisterAsset: options.onRegisterAsset, onColumnResize: options.onColumnResize, onOpenAssetProduction: options.onOpenAssetProduction, config: { ...node.config, ...promptArtifactConfig, prompt: linkedAsset?.prompt || node.config.prompt || '', prompt_pack: linkedAsset?.promptPack || node.config.prompt_pack || {}, prompt_contract_version: linkedAsset?.promptContractVersion || node.config.prompt_contract_version || '', prompt_workflow: linkedAsset?.promptWorkflow || node.config.prompt_workflow || '', prompt_field_order: linkedAsset?.promptFieldOrder || node.config.prompt_field_order || [], asset_prompt: linkedAsset?.prompt || node.config.prompt || '', asset_artifact_count: linkedAsset?.active_artifact_count ?? linkedAsset?.artifact_count ?? linkedAsset?.artifacts?.length ?? 0, asset_file_url: linkedAsset?.filePath || linkedAsset?.file_path || linkedAsset?.previewUrl || '', prompt_quality: linkedAsset?.promptQuality || node.config.prompt_quality || {}, production_draft: Boolean((linkedAsset?.assetMetadata as Record<string, any> | undefined)?.production_draft?.active || (linkedAsset?.assetMetadata as Record<string, any> | undefined)?.metadata?.production_draft?.active || node.config.production_draft), prerequisite_dependencies: linkedAsset?.prerequisiteDependencies || node.config.prerequisite_dependencies || [], prerequisite_gate: prerequisiteGate || node.config.prerequisite_gate || { allowed: true, items: [], reason: '当前资产没有未完成的前置资产' }, prerequisite_items: Array.isArray(prerequisiteGate?.items) ? prerequisiteGate.items : node.config.prerequisite_items || [], prerequisite_gate_allowed: prerequisiteGate?.allowed ?? node.config.prerequisite_gate_allowed ?? true, prerequisite_blocked_reason: prerequisiteGate?.reason || node.config.prerequisite_blocked_reason || '', prerequisite_blocked_dependencies: prerequisiteBlockedDependencies.length ? prerequisiteBlockedDependencies : node.config.prerequisite_blocked_dependencies || [], fusion_prompt_source: linkedAsset?.fusionPromptSource, fusion_prompt_state: linkedAsset?.fusionPromptState, fusion_prompt_stale: Boolean(linkedAsset?.fusionPromptStale), fusion_prompt_stale_reason: linkedAsset?.fusionPromptStaleReason || null, fusion_plan: linkedAsset?.fusionPlan || node.config.fusion_plan || {}, fusion_slot: linkedAsset?.fusionSlot ?? node.config.fusion_slot, fusion_slot_id: (linkedAsset?.fusionPlan as Record<string, any> | undefined)?.fusion_slot_id || node.config.fusion_slot_id, fusion_shot_id: (linkedAsset?.fusionPlan as Record<string, any> | undefined)?.shot_id || node.config.fusion_shot_id, fusion_source_asset_ids: linkedAsset?.fusionSourceAssetIds || node.config.fusion_source_asset_ids || [], fusion_source_statuses: linkedAsset?.fusionSourceStatuses || node.config.fusion_source_statuses || [], fusion_gate_allowed: linkedAsset?.fusionPromptGenerationAllowed ?? node.config.fusion_gate_allowed, fusion_gate_reason: linkedAsset?.fusionPromptBlockedReason || node.config.fusion_gate_reason, grid_row_key: row, grid_column_key: columnForNode(node), shot_scope: rows } };
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

export function assetBoardToFlowEdges(board: AssetBoard, nodes: AssetFlowNode[]): Edge[] {
  const visible = new Map(nodes.map((node) => [node.id, !node.hidden]));
  const candidates = (id: string) => nodes.filter((node) => node.id === id || node.data.sourceNodeId === id);
  const assetIdForNode = (node?: AssetFlowNode) => String(node?.data.asset_id || '');
  const promptCandidates = (id: string, fallback: AssetFlowNode[]) => {
    const assetId = assetIdForNode(fallback[0]);
    if (!assetId) return fallback;
    const promptNodes = nodes.filter((node) => node.data.node_type === 'handoff' && Boolean(node.data.config.prompt_card) && assetIdForNode(node) === assetId);
    return promptNodes.length ? promptNodes : fallback;
  };
  const rowKey = (node: AssetFlowNode) => String(node.data.config.grid_row_key || '');
  const colors: Record<AssetBoardEdgeRelation, string> = { shot_dependency: '#a8d9c9', reference: '#7db6ff', fusion_input: '#d7ff4b', candidate: '#ffca66' };
  const result: Edge[] = [];
  for (const edge of board.edges) {
    if (edge.relation === 'shot_dependency') continue;
    const logicalSources = candidates(edge.source); const logicalTargets = candidates(edge.target);
    // The logical asset card and its own Prompt/image card are one asset
    // handoff, not a useful cross-card dependency for the operator. Keep the
    // semantic candidate relation in the saved board, but do not draw the
    // redundant line through the left side of the asset-flow card.
    if (edge.relation === 'candidate' && logicalSources.some((source) => source.data.node_type === 'asset') && logicalTargets.some((target) => target.data.node_type === 'handoff' && Boolean(target.data.config.prompt_card)) && assetIdForNode(logicalSources[0]) && assetIdForNode(logicalSources[0]) === assetIdForNode(logicalTargets[0])) continue;
    const sources = edge.relation === 'fusion_input' ? promptCandidates(edge.source, logicalSources) : logicalSources;
    const targets = edge.relation === 'fusion_input' ? promptCandidates(edge.target, logicalTargets) : logicalTargets;
    const pairs: Array<[AssetFlowNode, AssetFlowNode]> = [];
    for (const source of sources) {
      const sameRow = targets.filter((target) => rowKey(source) && rowKey(source) === rowKey(target));
      // A fusion input is a shot-scoped relationship. An asset can have
      // presentation copies in several shot rows, but a source copy from
      // S03 must never fall back to the FUSION_S02 primary card just because
      // the target has no S03 presentation. That fallback made the canvas
      // look as if S02 was linked to assets from other shots. Keep the
      // existing fallback for non-fusion relations, which may intentionally
      // connect shared/legacy cards without a row scope.
      const target = edge.relation === 'fusion_input'
        ? sameRow[0]
        : sameRow[0] || targets[0];
      if (target) pairs.push([source, target]);
    }
    const uniquePairs = edge.relation === 'fusion_input'
      ? pairs
      : pairs.length ? pairs : (sources[0] && targets[0] ? [[sources[0], targets[0]] as [AssetFlowNode, AssetFlowNode]] : []);
    uniquePairs.forEach(([source, target], index) => result.push({ id: `${edge.id}:${rowKey(source) || index}`, source: source.id, target: target.id, hidden: !visible.get(source.id) || !visible.get(target.id), type: edge.relation === 'shot_dependency' ? 'smoothstep' : 'bezier', animated: edge.relation === 'candidate', style: { stroke: colors[edge.relation], strokeDasharray: edge.relation === 'reference' ? '5 5' : undefined, opacity: .72 }, data: { relation: edge.relation } }));
  }
  return result;
}

function assetBoardFromFlow(board: AssetBoard, nodes: AssetFlowNode[], edges: Edge[]): AssetBoard {
  const flowEdgeFor = (edgeId: string) => edges.some((edge) => edge.id === edgeId || edge.id.startsWith(`${edgeId}:`));
  const persistedNodeMap = new Map<string, AssetBoardNode>();
  for (const node of nodes.filter((candidate) => !candidate.data.presentationOnly && candidate.data.node_type !== 'row' && candidate.data.node_type !== 'table')) {
    const { onToggleScope, onContextMenu, onApprovePrompt, onGenerateImage, onGeneratePrompt, onGenerateFusionPrompt, onCopyPrompt, onColumnResize, onOpenAssetProduction, collapsed, presentationOnly, sourceNodeId, ...persistedData } = node.data;
    void onToggleScope; void onContextMenu; void onApprovePrompt; void onGenerateImage; void onGeneratePrompt; void onGenerateFusionPrompt; void onCopyPrompt; void onColumnResize; void onOpenAssetProduction; void collapsed; void presentationOnly; void sourceNodeId;
    const config = assetBoardCardIsLocked(node.data)
      ? Object.fromEntries(Object.entries(persistedData.config || {}).filter(([key]) => key !== 'position_source'))
      : persistedData.config;
    const persistedNode = { ...persistedData, config, node_type: node.data.node_type as AssetBoardNode['node_type'], position: { x: node.position.x, y: node.position.y } };
    persistedNodeMap.set(String(persistedNode.id), persistedNode);
  }
  // shot_dependency is a semantic relation, not a visual edge. Keep it even
  // when its presentation edge is intentionally omitted from React Flow.
  // The asset -> own Prompt-card candidate relation is intentionally hidden
  // in the UI, but keep it in the persisted board for backward compatibility.
  const candidatePersistedEdges = board.edges.filter((edge) => edge.relation === 'shot_dependency' || edge.relation === 'candidate' || flowEdgeFor(edge.id));
  // A server response can replace the board envelope while React is still
  // committing the corresponding flow nodes/edges. Keep the last known
  // non-artifact node as a short-lived fallback for semantic edges, then
  // discard any edge that still has no valid endpoint. This turns a transient
  // mixed snapshot into a valid save payload instead of a 422 response.
  const fallbackNodes = new Map(board.nodes.filter((node) => !['row', 'table', 'artifact'].includes(String(node.node_type))).map((node) => [String(node.id), node]));
  for (const edge of candidatePersistedEdges) {
    for (const endpoint of [edge.source, edge.target]) {
      const endpointId = String(endpoint);
      if (!persistedNodeMap.has(endpointId)) {
        const fallback = fallbackNodes.get(endpointId);
        if (fallback) persistedNodeMap.set(endpointId, fallback);
      }
    }
  }
  const persistedNodeIds = new Set([...persistedNodeMap.keys()]);
  const persistedEdges = candidatePersistedEdges.filter((edge) => persistedNodeIds.has(String(edge.source)) && persistedNodeIds.has(String(edge.target)) && String(edge.source) !== String(edge.target));
  const newEdges = edges.filter((edge) => !board.edges.some((candidate) => edge.id === candidate.id || edge.id.startsWith(`${candidate.id}:`))).map((edge) => {
    const sourceNode = nodes.find((node) => node.id === edge.source);
    const targetNode = nodes.find((node) => node.id === edge.target);
    if (!sourceNode || !targetNode || sourceNode.data.node_type === 'row' || targetNode.data.node_type === 'row' || sourceNode.data.node_type === 'table' || targetNode.data.node_type === 'table') return null;
    const source = String(sourceNode.data.sourceNodeId || sourceNode.id);
    const target = String(targetNode.data.sourceNodeId || targetNode.id);
    if (!persistedNodeIds.has(source) || !persistedNodeIds.has(target) || source === target) return null;
    return { id: edge.id, source, target, relation: (edge.data?.relation as AssetBoardEdgeRelation) || 'reference' };
  }).filter((edge): edge is { id: string; source: string; target: string; relation: AssetBoardEdgeRelation } => Boolean(edge));
  return {
    ...board,
    metadata: { ...board.metadata, layout_mode: 'shot_asset_table_v8', layout_preset: board.metadata.layout_preset || 'standard' },
    nodes: [...persistedNodeMap.values()],
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
  const shotIds = new Set((asset.promptRelevantShots || (asset.dependencies || []).map((item) => item.shot_id).filter(Boolean)).map((id: string) => String(id)));
  const shots = (story?.story.shots || []).filter((shot) => shotIds.size === 0 || shotIds.has(String(shot.id))) as unknown as Record<string, unknown>[];
  const promptPack = normalizePromptPack(asset.assetClass, asset.promptPack || metadata.prompt_pack || {}, {
    identityAnchor: anchors,
    mustPreserve: asset.mustPreserve || metadata.must_preserve || [],
    mustAvoid: asset.mustAvoid || metadata.must_avoid || [],
    context: { shots, references: asset.references || [] },
  });
  if (asset.assetClass === 'audio') {
    const webPackage = buildMiniMaxWebPromptPackage(promptPack, prompt, { shots, references: asset.references || [] });
    return formatMiniMaxWebPromptPackage(webPackage, asset.name || '', asset.id);
  }
  const compiledPrompt = buildNaturalLanguagePrompt(asset.assetClass, promptPack, prompt, { shots, references: asset.references || [] });
  const deps = (asset.dependencies || []).map((item) => `${item.shot_id || '未指定镜头'} · ${item.role || '依赖'}`).join('；');
  const storyGoal = story?.story.spec.creative_goal || '';
  const characterReferencePlan = asset.assetClass === 'character'
    ? '首轮只生成一张角色设定参考板：同一张合成图包含面部/上半身身份特写，以及正面、侧面、背面全身结构视图；中性棚拍背景、稳定光线、无动作姿态、无文字和水印。融合验证不理想时，再按需追加镜头化或动作化图片。'
    : '';
  return [
    `FRAMEFLOW 视觉资产生产 · ${assetClassLabels[asset.assetClass] || asset.assetClass} · Prompt Contract v${PROMPT_CONTRACT_VERSION} · ${PROMPT_WORKFLOW_ID}`,
    `资产名称：${asset.name || asset.id}`,
    `资产 ID：${asset.id}`,
    storyGoal ? `项目创意目标：${storyGoal}` : '',
    deps ? `镜头依赖：${deps}` : '',
    characterReferencePlan,
    `资产身份/生产规格补充：${renderPromptValue({ identityAnchors: anchors, assetSpec: spec })}`,
    `可直接执行的自然语言 Prompt：\n${compiledPrompt}`,
    '执行边界：结构化字段只用于控制生成，不要把字段名、标签、合同版本或说明文字生成到画面中。保持身份锚点、空间关系、材质证据、光线因果和连续性；生成前仍需用户确认具体图像工具。',
  ].filter(Boolean).join('\n\n');
}

function composeFusionPrompt(asset: LibraryAsset, sources: LibraryAsset[], story: StoryEnvelope | null): string {
  const metadata = asset.assetMetadata || {};
  const spec = asset.assetSpec || metadata.asset_spec || {};
  const fusionShotIds = asset.promptRelevantShots || [asset.fusionPlan?.shot_id, String(asset.id).match(/SH\d+/i)?.[0]].filter(Boolean) as string[];
  const shots = (story?.story.shots || []).filter((shot) => fusionShotIds.map(String).includes(String(shot.id))) as unknown as Record<string, unknown>[];
  const sourceBlocks = sources.map((source) => {
    const sourceMetadata = source.assetMetadata || {};
    const sourceShots = (story?.story.shots || []).filter((shot) => (source.promptRelevantShots || []).map(String).includes(String(shot.id))) as unknown as Record<string, unknown>[];
    const sourcePromptPack = normalizePromptPack(source.assetClass, source.promptPack || sourceMetadata.prompt_pack || {}, {
      identityAnchor: source.identityAnchors || sourceMetadata.identity_anchors || {},
      mustPreserve: source.mustPreserve || sourceMetadata.must_preserve || [],
      mustAvoid: source.mustAvoid || sourceMetadata.must_avoid || [],
      context: { shots: sourceShots, references: source.references || [] },
    });
    return [
      `输入资产：${source.name || source.id}（${assetClassLabels[source.assetClass] || source.assetClass} · ${source.id}）`,
      source.prompt ? `已确认资产描述：${buildNaturalLanguagePrompt(source.assetClass, sourcePromptPack, source.prompt, { shots: sourceShots, references: source.references || [] })}` : '',
      `输入资产规格与身份锚点：${renderPromptValue({ assetSpec: source.assetSpec || sourceMetadata.asset_spec || {}, identityAnchors: source.identityAnchors || sourceMetadata.identity_anchors || {} })}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  const sourceLocks = sources.map((source) => `${assetClassLabels[source.assetClass] || source.assetClass}「${source.name || source.id}」：${renderPromptValue(source.identityAnchors || source.assetMetadata?.identity_anchors || {})}`).join('；');
  const fusionPack = normalizePromptPack('fusion', asset.promptPack || metadata.prompt_pack || {}, {
    identityAnchor: sourceLocks,
    mustPreserve: asset.mustPreserve || metadata.must_preserve || [],
    mustAvoid: asset.mustAvoid || metadata.must_avoid || [],
    context: {
      shots,
      references: sources.flatMap((source) => source.references || []).concat(asset.references || []),
    },
  });
  const compiledPrompt = buildNaturalLanguagePrompt('fusion', fusionPack, asset.prompt || '', { shots, references: sources.flatMap((source) => source.references || []).concat(asset.references || []) });
  return [
    `FRAMEFLOW 镜头融合资产生产 · Prompt Contract v${PROMPT_CONTRACT_VERSION} · ${PROMPT_WORKFLOW_ID}`,
    `融合目标：${asset.name || asset.id}（${asset.id}）`,
    story?.story.spec.creative_goal ? `项目创意目标：${story.story.spec.creative_goal}` : '',
    `融合目标规格补充：${renderPromptValue(spec)}`,
    sourceBlocks ? `连接输入资产：\n${sourceBlocks}` : '连接输入资产：尚未连接角色、场景或道具资产。',
    `可直接执行的自然语言融合 Prompt：\n${compiledPrompt}`,
    '融合边界：先建立角色-道具接触单元，再放入场景；明确前景/中景/背景、尺度链、遮挡、接触阴影、投射阴影、环境光遮蔽、材质响应、动作节拍和连续性。不要把字段名、标签或合同说明生成到画面中。',
  ].filter(Boolean).join('\n\n');
}

const promptDetailLabels: Record<string, string> = {
  schemaVersion: '合同版本', workflow: '提示词流程', promptIntent: '生产意图', assetType: '资产类型', identityAnchor: '身份锚点', identityLock: '身份锁定', visibleEvent: '可见事件',
  spatialGeography: '空间地理', materialEvidence: '材质证据', lightingCausality: '光线因果', cameraExecution: '摄影机执行', atmosphereBehavior: '空气与效果', eventConsequence: '事件后果',
  roleAndAge: '年龄与角色',
  faceAndExpression: '脸部与表情', hairAndHeadSilhouette: '发型与头部轮廓', costumeAndMaterials: '服装与材质', detailAndMaterialBehavior: '细节与材质行为', bodyPoseAction: '身体比例与动作', visibleMoment: '可见瞬间', backgroundContext: '背景语境', stableAnchors: '稳定身份锚点',
  faceShape: '脸型', eyesAndBrows: '眉眼与眼神', noseAndMouth: '鼻型与嘴型', skinAndMakeup: '肤色与妆面',
  distinctiveFeatures: '辨识特征', color: '颜色', cutAndSilhouette: '发型与轮廓', textureAndStrands: '发丝质感', motionRule: '发丝运动规则',
  buildAndProportion: '身形与比例', posture: '姿态与重心', handsAndGesture: '手势与手指', headToToe: '从头到脚',
  materialsAndWear: '材质与磨损', palette: '配色', signatureAccessories: '固定配件', restingExpression: '静态表情',
  gazeRule: '视线规则', microExpressions: '微表情', movementQuality: '动作质量', actionBeats: '动作节拍', referenceSheet: '参考板版式',
  locationAndFunction: '地点与叙事功能', identityAndPurpose: '地点与功能', geography: '场景地理', spatialLayoutAndGeography: '空间布局与地理', foreground: '前景', midground: '中景', background: '背景', foregroundMidgroundBackground: '前中后景',
  landmarks: '固定地标', setDressingAndFixedAnchors: '陈设与固定锚点', propsAndSetDressing: '陈设与道具', surfacesAndMaterials: '表面材质', materialsAndSurfaceState: '材质与表面状态', detailEvidenceAndAtmosphere: '细节证据与空气', lightingAndAtmosphere: '光线与空气', lightingWeatherAtmosphere: '光线天气与空气',
  actionSpace: '动作空间', actionBlockingZones: '动作阻挡区', propPlacementZones: '道具预留区', continuityAnchors: '连续性锚点', continuityLocks: '连续性锁定', shotPlan: '镜头计划', intent: '镜头意图', framing: '景别与构图',
  camera: '机位与角度', lens: '焦段/视角', focus: '焦点与景深', depthOfField: '景深', actionBeat: '动作节拍', screenDirection: '屏幕方向',
  continuity: '连续性检查点', visualStyle: '视觉渲染', medium: '媒介', depthAndTexture: '景深与纹理', opticalEffects: '光学效果',
  primary: '主效果', secondary: '辅助效果', placement: '作用区域', referenceStrategy: '参考策略', preserve: '保持', change: '允许改变',
  continuityChecklist: '连续性检查清单', stableIdentityAnchors: '稳定身份锚点', shotSpecificDetail: '本镜头细节', optionalIncidentalDetail: '可选偶发细节', mayVary: '允许变化',
  characterDetails: '角色细节', sceneDetails: '场景细节', propDetails: '道具细节', itemDetails: '物体细节', fusionDetails: '融合细节', detailAnchorRegistry: '细节锚点注册表', referenceRoles: '参考图角色', referenceId: '参考 ID', controls: '控制范围', mustNotControl: '不控制范围',
  objectIdentity: '物体身份', silhouetteAndProportions: '轮廓与比例', structureAndFunction: '结构与功能', materialAndCondition: '材质与状态', colorMarkingsAndLabelPolicy: '颜色标记与文字策略', scaleAndInteraction: '尺度与交互',
  fusionModule: '融合模块', shotUsage: '镜头用途', seedanceReferenceRole: 'Seedance 参考用途', styleAndLightingAuthority: '风格与光线权威', characterIdentityLock: '角色身份锁', itemIdentityLock: '道具身份锁', sceneIdentityLock: '场景身份锁', interactionAndContact: '交互与接触', placementScaleAndCamera: '位置尺度与摄影机', lightingShadowsAndMaterialIntegration: '光影与材质整合', compositionAndDepth: '构图与景深', motionContinuityNotes: '运动连续性',
  generationNotes: '生成说明', suggestedSize: '建议尺寸', negativePrompt: '负向约束', mustPreserve: '必须保留', mustAvoid: '必须避免',
  audioDetails: '声音制作字段', operation: '操作', sourceText: '朗读文本', textStatus: '文本状态', voiceIdentity: '声音身份', language: '语言', dialect: '方言 / 口音',
  performanceDirection: '表演方向', emotion: '情绪', intensity: '强度', pace: '语速 / 节奏', pausePlan: '停顿计划', pronunciation: '发音标注', soundTags: '语气 / 声音标签',
  provider: 'Provider', model: '模型', voiceId: '音色 ID', speed: '语速参数', pitch: '音调参数', volume: '音量参数', languageBoost: '语言增强', format: '格式', sampleRate: '采样率', bitrate: '比特率', channel: '声道', targetDuration: '目标时长', relevantShots: '关联镜头', stems: '分轨', distance: '投射距离',
};

function isPromptDetailRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function promptDetailHasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.some(promptDetailHasValue);
  if (isPromptDetailRecord(value)) return Object.values(value).some(promptDetailHasValue);
  return true;
}

function promptDetailLabel(key: string): string {
  return promptDetailLabels[key] || key;
}

function promptDetailText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.filter(promptDetailHasValue).map(promptDetailText).join('；');
  if (isPromptDetailRecord(value)) return Object.entries(value).filter(([, item]) => promptDetailHasValue(item)).map(([key, item]) => `${promptDetailLabel(key)}：${promptDetailText(item)}`).join('\n');
  return String(value);
}

function PromptDetailRows({ value }: { value: unknown }) {
  const entries = isPromptDetailRecord(value)
    ? Object.entries(value).filter(([, item]) => promptDetailHasValue(item))
    : [['detail', value] as [string, unknown]].filter(([, item]) => promptDetailHasValue(item));
  return <div className="asset-prompt-detail-rows">{entries.map(([key, item]) => <div className="asset-prompt-detail-row" key={key}><span>{promptDetailLabel(key)}</span><p>{promptDetailText(item)}</p></div>)}</div>;
}

function PromptDetailsPanel({ asset, promptPack, promptQuality }: { asset: LibraryAsset; promptPack?: Record<string, unknown>; promptQuality?: LibraryAsset['promptQuality'] }) {
  const rawPack = promptPack || asset.promptPack || asset.assetMetadata?.prompt_pack || {};
  const pack = isPromptDetailRecord(rawPack) ? rawPack : {};
  const groups: Array<{ title: string; value: unknown }> = [];
  const pushGroup = (title: string, value: unknown) => { if (promptDetailHasValue(value)) groups.push({ title, value }); };
  const isCharacterAsset = asset.assetClass === 'character';
  const isSceneAsset = ['scene', 'environment', 'environment_state', 'environment_prop'].includes(asset.assetClass);
  const isPropAsset = ['prop', 'product', 'item', 'vfx'].includes(asset.assetClass);
  const isAudioAsset = asset.assetClass === 'audio';
  const isFusionAsset = asset.assetClass === 'fusion';
  const hasExplicitCharacterDetails = isPromptDetailRecord(pack.characterDetails);
  const hasExplicitSceneDetails = isPromptDetailRecord(pack.sceneDetails);
  const hasExplicitPropDetails = isPromptDetailRecord(pack.propDetails || pack.itemDetails);
  const hasExplicitFusionDetails = isPromptDetailRecord(pack.fusionDetails);
  const characterDetails = hasExplicitCharacterDetails ? pack.characterDetails : isCharacterAsset ? {
    identityAnchor: pack.identityAnchor || pack.identity,
    faceExpression: pack.faceExpression,
    hairSilhouette: pack.hairSilhouette,
    poseAction: pack.poseAction,
    wardrobeMaterial: pack.wardrobeMaterial,
    weapon: pack.weapon,
    wingStructure: pack.wingStructure,
  } : {};
  const sceneDetails = hasExplicitSceneDetails ? pack.sceneDetails : isSceneAsset ? {
    locationAndFunction: pack.locationAndFunction || pack.location,
    geography: pack.geography || pack.layout,
    propsAndSetDressing: pack.propsAndSetDressing || pack.props || pack.landmarks,
    surfacesAndMaterials: pack.surfacesAndMaterials || pack.surfaceMaterials,
    lightingAndAtmosphere: pack.lightingAndAtmosphere || pack.lighting,
    actionSpace: pack.actionSpace,
    continuityAnchors: pack.continuityAnchors || pack.continuity,
  } : {};
  const propDetails = hasExplicitPropDetails ? (pack.propDetails || pack.itemDetails) : isPropAsset ? {
    objectIdentity: pack.objectIdentity || pack.identity,
    silhouetteAndProportions: pack.silhouetteAndProportions || pack.silhouette,
    structureAndFunction: pack.structureAndFunction || pack.structure,
    materialAndCondition: pack.materialAndCondition || pack.materials || pack.condition,
    colorMarkingsAndLabelPolicy: pack.colorMarkingsAndLabelPolicy || pack.color || pack.markings,
    scaleAndInteraction: pack.scaleAndInteraction || pack.scale || pack.interaction,
  } : {};
  if (isAudioAsset) {
    pushGroup('MiniMax Speech 2.8 Web 控制字段', pack.audioDetails);
    pushGroup('FRAMEFLOW 声音生产元数据', {
      promptIntent: pack.promptIntent,
      identityAnchor: pack.identityAnchor,
      shotPlan: pack.shotPlan,
      continuityChecklist: pack.continuityChecklist,
      mustPreserve: pack.mustPreserve,
      mustAvoid: pack.mustAvoid || pack.negativePrompt,
      generationNotes: pack.generationNotes,
    });
  } else {
    if (isCharacterAsset || hasExplicitCharacterDetails) pushGroup('人物细节', characterDetails);
    if (isSceneAsset || hasExplicitSceneDetails) pushGroup('场景细节', sceneDetails);
    if (isPropAsset || hasExplicitPropDetails) pushGroup('道具 / 物体细节', propDetails);
    if (isFusionAsset || hasExplicitFusionDetails) pushGroup('融合细节', pack.fusionDetails);
    pushGroup('提示词意图与执行', {
      promptIntent: pack.promptIntent,
      referenceRoles: pack.referenceRoles,
      identityLock: pack.identityLock,
      visibleEvent: pack.visibleEvent,
      spatialGeography: pack.spatialGeography,
      materialEvidence: pack.materialEvidence,
      lightingCausality: pack.lightingCausality,
      cameraExecution: pack.cameraExecution,
      atmosphereBehavior: pack.atmosphereBehavior,
      generationNotes: pack.generationNotes,
      suggestedSize: pack.suggestedSize,
    });
    pushGroup('镜头 / 光线 / 连续性', {
      identityAnchor: pack.identityAnchor,
      shotPlan: pack.shotPlan,
      visualStyle: pack.visualStyle,
      referenceStrategy: pack.referenceStrategy,
      continuityChecklist: pack.continuityChecklist,
      negativePrompt: pack.negativePrompt,
    });
  }
  const quality = promptQuality || asset.promptQuality;
  const coverage = quality?.coverage;
  const coverageLabel = coverage && Number.isFinite(Number(coverage.passed)) && Number.isFinite(Number(coverage.total))
    ? `细节覆盖 ${coverage.passed}/${coverage.total} · ${coverage.percent ?? 0}%`
    : `Prompt Contract v${String(pack.schemaVersion || '2.0')}`;
  if (!groups.length && !coverage) return null;
  return <details className="asset-prompt-details" open>
    <summary><span>结构化提示词细节</span><small>{coverageLabel} · {quality?.status === 'ready' ? '检查通过' : '可继续补充'}</small></summary>
    {quality?.missing?.length ? <p className="asset-prompt-details-warning">建议补充：{quality.missing.join('、')}</p> : null}
    <div className="asset-prompt-detail-groups">{groups.map((group) => <section key={group.title}><h4>{group.title}</h4><PromptDetailRows value={group.value} /></section>)}</div>
  </details>;
}

function AssetGenerationOrder({ items, selectedAssetId, onFocusAsset }: { items: AssetGenerationOrderItem[]; selectedAssetId?: string; onFocusAsset: (assetId: string) => void }) {
  return <section className="asset-generation-order" aria-labelledby="asset-generation-order-title">
    <div className="asset-generation-order-heading"><div><span>ASSET ORDER</span><h3 id="asset-generation-order-title">建议资产生成顺序</h3></div><small>{items.length ? `${items.length} 项` : '暂无视觉资产'}</small></div>
    {items.length ? <ol>{items.map((item, index) => <li key={item.assetId} className={selectedAssetId === item.assetId ? 'selected' : ''}><span className="asset-generation-order-number">{String(index + 1).padStart(2, '0')}</span><span className={`asset-generation-status-light ${item.status}`} title={item.statusTitle} aria-label={item.statusTitle} /><button type="button" onClick={() => onFocusAsset(item.assetId)}>{item.label}</button></li>)}</ol> : <p className="asset-generation-order-empty">当前项目还没有可排序的视觉资产。</p>}
  </section>;
}

function AssetProductionPanel({ asset, story, fusionSources, busy, projectRevision, assetBoardDirty, promptDraft, promptPackDraft, promptQualityDraft, selectedCardType, onSave, onHandoff, onImport, onStartQa, onApprove, onRegister, onApprovePromptCard, onGenerateImageCard, onGeneratePrompt, onGenerateFusionPrompt, onManualProductionApproval, onDraftChange }: { asset?: LibraryAsset; story: StoryEnvelope | null; fusionSources: LibraryAsset[]; busy: boolean; projectRevision?: number; assetBoardDirty: boolean; promptDraft?: string; promptPackDraft?: Record<string, unknown>; promptQualityDraft?: LibraryAsset['promptQuality']; selectedCardType?: 'asset' | 'handoff' | 'artifact'; onSave: (assetId: string, body: Record<string, unknown>) => void; onHandoff: (asset: LibraryAsset, prompt: string) => void; onImport: (asset: LibraryAsset, file: File) => void; onStartQa: (artifactId: string, qaType?: AssetQaType) => void; onApprove: (artifactId: string) => void; onRegister: (artifactId: string) => void; onApprovePromptCard: (assetId: string) => void; onGenerateImageCard: (assetId: string) => void; onGeneratePrompt?: (assetId: string) => void; onGenerateFusionPrompt: (assetId: string, sourceAssetIds: string[], shotId: string) => void; onManualProductionApproval?: (assetId: string, approved: boolean, reason: string, artifactId: string) => void; onDraftChange?: (assetId: string, draft: AssetEditorDraft) => void }) {
  const [prompt, setPrompt] = useState('');
  const [assetSpec, setAssetSpec] = useState('{}');
  const [anchors, setAnchors] = useState('{}');
  const [mustPreserve, setMustPreserve] = useState('');
  const [mustAvoid, setMustAvoid] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [manualApprovalReason, setManualApprovalReason] = useState('');
  const pendingHydrationDraftRef = useRef<string | null>(null);
  useEffect(() => {
    if (!asset) return;
    const metadata = asset.assetMetadata || {};
    const nestedMetadata = metadata.metadata && typeof metadata.metadata === 'object' ? metadata.metadata as Record<string, unknown> : {};
    const stored = metadata.asset_editor_draft && typeof metadata.asset_editor_draft === 'object' ? metadata.asset_editor_draft as Record<string, unknown> : nestedMetadata.asset_editor_draft && typeof nestedMetadata.asset_editor_draft === 'object' ? nestedMetadata.asset_editor_draft as Record<string, unknown> : {};
    const nextDraft: AssetEditorDraft = {
      prompt: promptDraft !== undefined ? promptDraft : typeof stored.prompt === 'string' ? stored.prompt : String(asset.prompt || ''),
      assetSpec: typeof stored.assetSpec === 'string' ? stored.assetSpec : JSON.stringify(asset.assetSpec || metadata.asset_spec || {}, null, 2),
      anchors: typeof stored.anchors === 'string' ? stored.anchors : JSON.stringify(asset.identityAnchors || metadata.identity_anchors || {}, null, 2),
      mustPreserve: typeof stored.mustPreserve === 'string' ? stored.mustPreserve : (asset.mustPreserve || metadata.must_preserve || []).join('\n'),
      mustAvoid: typeof stored.mustAvoid === 'string' ? stored.mustAvoid : (asset.mustAvoid || metadata.must_avoid || []).join('\n'),
    };
    pendingHydrationDraftRef.current = JSON.stringify(nextDraft);
    setPrompt(nextDraft.prompt);
    setAssetSpec(nextDraft.assetSpec);
    setAnchors(nextDraft.anchors);
    setMustPreserve(nextDraft.mustPreserve);
    setMustAvoid(nextDraft.mustAvoid);
  }, [asset?.id, promptDraft]);
  useEffect(() => {
    if (!asset || !onDraftChange) return;
    const draft: AssetEditorDraft = { prompt, assetSpec, anchors, mustPreserve, mustAvoid };
    const serialized = JSON.stringify(draft);
    if (pendingHydrationDraftRef.current !== null) {
      if (pendingHydrationDraftRef.current === serialized) pendingHydrationDraftRef.current = null;
      return;
    }
    onDraftChange(asset.id, draft);
  }, [anchors, asset?.id, assetSpec, mustAvoid, mustPreserve, onDraftChange, prompt]);
  if (!asset) return <section className="asset-production-empty"><span>ASSET PRODUCTION</span><h2>选择一个资产开始制作</h2><p>从画布中选择角色、场景、道具或融合节点。这里会生成 Prompt、管理参考图和候选版本。</p></section>;
  const shotLabels = (asset.dependencies || []).map((item) => item.shot_id).filter(Boolean).join('、');
  const artifacts = Array.isArray(asset.artifacts) ? asset.artifacts as any[] : [];
  const liveArtifacts = artifacts.filter((item) => String(item.status || '') !== 'archived');
  const currentArtifact = liveArtifacts.find((item) => item.id === asset.artifactId || item.artifact_id === asset.artifactId) || liveArtifacts.find((item) => ['active', 'approved', 'registered', 'current'].includes(String(item.status || '').toLowerCase())) || liveArtifacts[0];
  const currentFileUrl = String(asset.filePath || asset.file_path || asset.previewUrl || currentArtifact?.url || currentArtifact?.file_path || '');
  const currentArtifactId = String(asset.artifactId || asset.artifact_id || currentArtifact?.id || '');
  const currentFileId = currentArtifactId || '当前登记文件';
  const manualApprovalActive = Boolean(asset.readiness.manual_approval_active);
  const isAudioAsset = asset.assetClass === 'audio';
  const isFusion = asset.assetClass === 'fusion';
  const fusionPromptReady = !isFusion || asset.fusionPromptSource === 'fusion-connection-agent';
  const fusionShotId = String(asset.fusionPlan?.shot_id || asset.promptRelevantShots?.[0] || String(asset.id).match(/SH\d+/i)?.[0] || '').toUpperCase();
  const fusionSourceIds = fusionSources.map((source) => source.id);
  const fusionBlockedSources = fusionSources.filter((source) => source.readiness?.production_ready !== true && source.production_ready !== true);
  const fusionSlot = Boolean(asset.fusionSlot || asset.assetMetadata?.fusion_slot || asset.assetMetadata?.fusionSlot);
  const fusionGateAllowed = typeof asset.fusionPromptGenerationAllowed === 'boolean' ? asset.fusionPromptGenerationAllowed : fusionSources.length >= 2 && fusionBlockedSources.length === 0;
  const prerequisiteGateAllowed = asset.prerequisiteGate?.allowed !== false;
  const prerequisiteItems = Array.isArray(asset.prerequisiteGate?.items) ? asset.prerequisiteGate.items : [];
  const prerequisiteAssetSummary = prerequisiteItems.map((item: Record<string, any>) => String(item.name || item.asset_id || '前置资产')).join('、');
  const prerequisiteBlockedDependencies = prerequisiteItems.filter((item: Record<string, any>) => item.production_ready !== true);
  const prerequisiteIncompleteSummary = prerequisiteBlockedDependencies.map((item: Record<string, any>) => String(item.name || item.asset_id || '前置资产')).join('、');
  const prerequisiteBlockedReason = prerequisiteIncompleteSummary ? `未完成：${prerequisiteIncompleteSummary}` : String(asset.prerequisiteGate?.reason || '前置资产尚未完成审核');
  const generationReferenceAssets = mergeGenerationReferenceAssets(generationReferenceAssetsForAsset(asset), prerequisiteItems, asset.id);
  const fusionCanGenerate = isFusion && prerequisiteGateAllowed && fusionSources.length >= 2 && fusionBlockedSources.length === 0 && fusionGateAllowed && Boolean(fusionShotId);
  const audioPromptShotIds = Array.isArray(asset.promptRelevantShots) ? asset.promptRelevantShots.map(String) : [];
  const audioPromptShots = (story?.story.shots || []).filter((shot) => !audioPromptShotIds.length || audioPromptShotIds.includes(String(shot.id))) as unknown as Record<string, unknown>[];
  const minimaxWebPackage = isAudioAsset ? buildMiniMaxWebPromptPackage(promptPackDraft || asset.promptPack || asset.assetMetadata?.prompt_pack || {}, prompt, { shots: audioPromptShots, references: asset.references || [] }) : null;
  const minimaxWebPackageText = minimaxWebPackage ? formatMiniMaxWebPromptPackage(minimaxWebPackage, asset.name || '', asset.id) : '';
  const copyMiniMaxText = async () => {
    if (!minimaxWebPackage?.copyText) return;
    try { await navigator.clipboard.writeText(minimaxWebPackage.copyText); } catch { /* The package remains visible for manual copying. */ }
  };
  const save = () => {
    try {
      const parsedSpec = parseObjectText(assetSpec);
      const parsedAnchors = parseObjectText(anchors);
      setJsonError('');
      onSave(asset.id, { expected_revision: projectRevision, asset_class: asset.assetClass, prompt: isFusion && !fusionPromptReady ? String(asset.prompt || '') : prompt, prompt_pack: promptPackDraft || asset.promptPack || asset.assetMetadata?.prompt_pack || {}, asset_spec: parsedSpec, identity_anchors: parsedAnchors, must_preserve: mustPreserve.split('\n').map((item) => item.trim()).filter(Boolean), must_avoid: mustAvoid.split('\n').map((item) => item.trim()).filter(Boolean), source: asset.source || 'chatgpt-web', authorization_status: asset.authorizationStatus || 'pending', fusion_source_asset_ids: isFusion ? fusionSourceIds : undefined });
    } catch (error) { setJsonError((error as Error).message); }
  };
  const selectionContextLabel = selectedCardType === 'handoff' ? 'Prompt / 图片卡' : selectedCardType === 'artifact' ? '候选版本卡' : '资产卡';
  return <section className="asset-production-panel">
    {generationReferenceAssets.length > 0 && <div className={`asset-reference-panel-summary ${prerequisiteIncompleteSummary ? 'blocked' : 'ready'}`} role="status"><strong>图片生成参考资产</strong><span>参考图：{generationReferenceAssets.map((item) => item.role ? `${item.label}（${item.role}）` : item.label).join('、')}</span><small>{prerequisiteIncompleteSummary ? `未完成：${prerequisiteIncompleteSummary}` : '以上资产可作为当前图片生成参考图；括号内为参考职责'}</small>{!prerequisiteGateAllowed && <small>参考图未全部完成前，上传候选、图片生成、媒体 QA 与登记会保持锁定。</small>}</div>}
    <header><span>{selectionContextLabel} · {assetClassLabels[asset.assetClass] || asset.assetClass} · {asset.id}</span><h2>{asset.name || asset.id}</h2><p>{assetBoardStatusLabel(asset.readiness.status)} · 等级 {asset.grade || 'B'}{shotLabels ? ` · 镜头 ${shotLabels}` : ''}{isFusion && asset.fusionPromptStale ? ' · 融合输入已变化' : ''}</p>{asset.assetClass === 'character' && <div className="character-reference-plan-note"><strong>首轮角色参考图 · 1 张</strong><span>一张合成图包含面部 / 上半身特写 + 正面、侧面、背面全身视图。融合效果不理想时，再按需追加镜头化图片。</span></div>}{prerequisiteItems.length > 0 && <div className={`asset-prerequisite-panel-summary ${prerequisiteGateAllowed ? 'ready' : 'blocked'}`} role="status"><strong>生成所需前置资产</strong><span>前置资产：{prerequisiteAssetSummary}</span><small>{prerequisiteIncompleteSummary ? `当前未完成：${prerequisiteIncompleteSummary}` : '当前：全部完成，可进入生产'}</small>{!prerequisiteGateAllowed && <small>Prompt 仍可查看、编辑和复制；上传候选、图片生成、媒体 QA 与登记会在前置资产完成后开放。</small>}</div>}{!prerequisiteGateAllowed && prerequisiteItems.length === 0 && <div className="asset-prerequisite-panel-warning" role="status"><strong>前置资产未完成</strong><span>{prerequisiteBlockedReason}</span></div>}{asset.prompt && !isAudioAsset && (!isFusion || fusionPromptReady) && <div className="asset-prompt-gate"><span>Prompt QA：{String(asset.promptQaDecision || 'Pending')} · 图像：{String(asset.generationStatus || 'planned')}</span><div>{asset.promptQaDecision !== 'Approved' && <button onClick={() => onApprovePromptCard(asset.id)} disabled={busy}>通过 Prompt QA</button>}{asset.promptQaDecision === 'Approved' && asset.imageGenerationEligible !== false && asset.generationStatus !== 'generated-pending-qa' && <button className="asset-prompt-gate-primary" onClick={() => onGenerateImageCard(asset.id)} disabled={busy || !prerequisiteGateAllowed}>{asset.assetClass === 'character' ? '确认并生成角色结构参考图' : '确认并生成图像'}</button>}</div></div>}{asset.readiness.registered_ready && !asset.readiness.production_ready && <div className="manual-production-gate"><strong>已登记资产可人工确认</strong><small>仅豁免 Prompt / Prompt QA，当前登记文件、图片 QA、授权与融合门仍然有效。</small><textarea value={manualApprovalReason} onChange={(event) => setManualApprovalReason(event.target.value)} placeholder="填写人工审核原因" rows={2} /><button onClick={() => onManualProductionApproval?.(asset.id, true, manualApprovalReason.trim(), currentFileId)} disabled={busy || !manualApprovalReason.trim() || !currentArtifactId || !onManualProductionApproval}>人工通过可入镜</button></div>}{manualApprovalActive && <div className="manual-production-active"><span>当前登记文件已人工通过可入镜</span><button onClick={() => onManualProductionApproval?.(asset.id, false, '撤销人工通过', currentFileId)} disabled={busy || !onManualProductionApproval}>撤销人工通过</button></div>}</header>
     <div className="asset-production-actions"><button onClick={save} disabled={busy}>{isAudioAsset ? '保存声音字段 / 规格' : '保存 Prompt / 规格'}</button>{!isFusion && <button className="asset-ai-prompt-button" onClick={() => onGeneratePrompt?.(asset.id)} disabled={busy || !onGeneratePrompt}>AI 编写 Prompt</button>}<button className="asset-chatgpt-button" onClick={() => onHandoff({ ...asset, promptPack: promptPackDraft || asset.promptPack }, prompt)} disabled={busy || (!prompt.trim() && !isAudioAsset) || (isAudioAsset && !minimaxWebPackage?.copyText) || (isFusion && !fusionPromptReady)}>{isFusion && !fusionPromptReady ? '历史融合 Prompt 不可执行' : isAudioAsset ? '复制 MiniMax Web 包' : '复制 Prompt'}</button></div>
    {isFusion && <section className="fusion-inputs-panel"><div><span>FUSION WORKFLOW</span><h3>{fusionPromptReady ? '正式融合 Prompt' : '等待基础资产就绪'}</h3><p>{String(asset.fusionPromptBlockedReason || asset.fusionPlan?.shot_intent || '系统已根据当前分镜自动关联角色、场景和道具；前置资产全部成为正式资产后才能生成融合 Prompt。')}</p></div><div className="fusion-plan-summary"><span>目标镜头：{fusionShotId || '未绑定'}</span><span>规划状态：{fusionPromptReady ? (asset.fusionPromptStale ? '输入已变化 · 待重新融合' : '已生成正式 Prompt') : fusionSlot ? '自动关联 · 等待前置资产' : '等待基础资产就绪'}</span></div><div className="fusion-input-list">{fusionSources.length ? fusionSources.map((source) => <span key={source.id} className={source.readiness?.production_ready === true || source.production_ready === true ? 'ready' : 'blocked'}>{assetClassLabels[source.assetClass] || source.assetClass} · {source.name || source.id}{source.readiness?.production_ready === true || source.production_ready === true ? ' · 已就绪' : ` · ${source.readiness?.next_action || '未就绪'}`}</span>) : <small>系统尚未从当前分镜解析到可融合的基础资产，请先完成对应分镜资产需求。</small>}</div>{assetBoardDirty && <p className="fusion-connection-warning">当前工作区布局尚未保存；点击生成时会先保存最新工作区状态。</p>}{fusionBlockedSources.length > 0 && <p className="fusion-connection-warning">存在未达到 production_ready 的输入资产：{fusionBlockedSources.map((source) => source.name || source.id).join('、')}</p>}{!fusionGateAllowed && asset.fusionPromptBlockedReason && <p className="fusion-connection-warning">{asset.fusionPromptBlockedReason}</p>}{!fusionShotId && <p className="fusion-connection-warning">该融合资产尚未绑定有效镜头。</p>}<div className="fusion-input-actions"><button className="fusion-compose-button" onClick={() => setPrompt(composeFusionPrompt(asset, fusionSources, story))} disabled={busy || fusionSources.length < 2}>预览融合输入</button><button className="fusion-compose-button fusion-ai-button" onClick={() => onGenerateFusionPrompt(asset.id, fusionSourceIds, fusionShotId)} disabled={busy || !fusionCanGenerate}>生成融合 Prompt（AI）</button></div></section>}
    {minimaxWebPackage && <section className="asset-minimax-web-panel"><div className="asset-minimax-web-heading"><div><span>MINIMAX SPEECH 2.8 WEB</span><h3>可直接测试的声音输入包</h3></div><b className={minimaxWebPackage.copyText ? 'ready' : 'blocked'}>{minimaxWebPackage.copyText ? '朗读文本已确认' : '先确认唯一台词'}</b></div><p>文本框只粘贴“朗读文本”一段；音色、情绪、语速、音调和音量在 MiniMax Web 页面设置。资产 ID、镜头、QA、环境声和混音说明不会进入朗读文本。</p><pre>{minimaxWebPackageText}</pre><div className="asset-minimax-web-actions"><button type="button" className="asset-minimax-copy-package" onClick={() => onHandoff({ ...asset, promptPack: promptPackDraft || asset.promptPack }, prompt)} disabled={!minimaxWebPackage.copyText}>复制 MiniMax Web 测试包</button><button type="button" onClick={() => void copyMiniMaxText()} disabled={!minimaxWebPackage.copyText}>复制已确认朗读文本</button><a href="https://www.minimax.io/audio" target="_blank" rel="noreferrer">打开 MiniMax Web</a></div></section>}
    <label>{isAudioAsset ? '声音资产内部状态（不直接粘贴到 MiniMax）' : 'Prompt'}<textarea data-asset-production-prompt value={prompt} readOnly={isFusion} onChange={(event) => setPrompt(event.target.value)} placeholder={isAudioAsset ? 'AI 生成后会显示文本确认状态；实际朗读文本请在 MiniMax Web 测试包中查看。' : '描述这个资产的身份、结构、材质、镜头用途和视觉要求…'} /></label>
    <PromptDetailsPanel asset={asset} promptPack={promptPackDraft} promptQuality={promptQualityDraft} />
    {jsonError && <p className="asset-form-error" role="alert">{jsonError}</p>}
    <label>资产生产规格 JSON<textarea className={jsonError ? 'invalid' : ''} value={assetSpec} onChange={(event) => { setAssetSpec(event.target.value); setJsonError(''); }} spellCheck={false} /></label>
    <label>身份/结构锚点 JSON<textarea className={jsonError ? 'invalid' : ''} value={anchors} onChange={(event) => { setAnchors(event.target.value); setJsonError(''); }} spellCheck={false} /></label>
    <div className="asset-production-two-col"><label>必须保留<textarea value={mustPreserve} onChange={(event) => setMustPreserve(event.target.value)} placeholder="每行一条" /></label><label>必须避免<textarea value={mustAvoid} onChange={(event) => setMustAvoid(event.target.value)} placeholder="每行一条" /></label></div>
    {prerequisiteGateAllowed ? <div className="asset-drop-zone" data-asset-production-upload onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) onImport(asset, file); }}><strong>拖入候选图片、视频或声音</strong><span>服务端会按媒体类型进入图片 QA、视频 QA、声音 QA 或参考审核，不会覆盖当前版本。</span><label className="asset-file-button">选择候选媒体<input type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/wav,audio/mpeg,audio/mp4,audio/x-m4a" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImport(asset, file); event.currentTarget.value = ''; }} /></label></div> : <div className="asset-prerequisite-upload-locked"><strong>等待前置资产完成后上传候选</strong><span>{prerequisiteBlockedReason}</span></div>}
    <section className="asset-current-file"><h3>当前选中文件</h3>{currentFileUrl ? <div className="asset-current-file-card"><div><strong>{currentFileId}</strong><span>{currentArtifact?.source_type || currentArtifact?.source || '当前登记文件'} · {assetBoardStatusLabel(String(currentArtifact?.status || asset.readiness.status || 'ready'))}</span></div><a href={currentFileUrl} target="_blank" rel="noreferrer">预览文件</a></div> : <p>当前资产尚无登记文件。候选文件不会在这里批量展开。</p>}{currentArtifact && <div className="asset-current-file-actions">{['generated_pending_qa', 'reference_pending_review', 'audit_blocked'].includes(String(currentArtifact.status)) && <button onClick={() => onStartQa(String(currentArtifact.id), String(currentArtifact.metadata?.qa_type || (String(currentArtifact.mime_type || '').startsWith('video/') ? 'video' : asset.workflow?.kind === 'reference' ? 'reference' : 'image')) as AssetQaType)} disabled={busy || !prerequisiteGateAllowed}>开始媒体 QA</button>}{currentArtifact.status === 'qa_in_progress' && <button onClick={() => onApprove(String(currentArtifact.id))} disabled={busy || !prerequisiteGateAllowed}>打开 QA / 审核</button>}{currentArtifact.status === 'approved_pending_registration' && <button onClick={() => onRegister(String(currentArtifact.id))} disabled={busy || !prerequisiteGateAllowed}>登记当前文件</button>}{currentArtifact.status === 'reference' && <span className="asset-reference-chip">已通过参考审核 · 不可入镜</span>}</div>}</section>
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
  return ({ home: '项目总览', story: '故事与分镜', canvas: '资产生产工作区', timeline: '后期时间线', audio: '声音工作区', settings: '设置与 Provider' })[mode];
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
          {contextOpen && <div className="assistant-context-detail"><p>读取：项目规格、故事与分镜、资产数据、声音资产工坊、资产生产画布、后期时间线、工作流图和版本号。</p><p>当前选区：{selectedNodeIds.length ? `${selectedNodeIds.length} 个工作流节点` : '未选择工作流节点'}{selectedEdgeIds.length ? ` · ${selectedEdgeIds.length} 条连接` : ''}。</p><p>未保存状态：{[dirty && '流程图', storyDirty && '故事', assetBoardDirty && '资产画布', audioDirty && '声音', timelineDirty && '时间线'].filter(Boolean).join('、') || '无'}。</p></div>}
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
      <section className="home-primary-grid"><div className="home-primary-action"><div className="home-section-heading"><div><small>PRIMARY NEXT STEP</small><h2>现在该做什么</h2></div><span>系统按阻塞和审批优先级排序</span></div>{selected.primary_next_task ? <HomeTaskRow task={selected.primary_next_task} primary onOpen={() => onOpenTask(selected.primary_next_task as DashboardTask)} /> : selected.project.status === 'completed' && selected.project.progress.percent >= 100 ? <div className="home-all-done"><strong>项目已完成</strong><span>所有阶段都已通过，可以进入交付复盘。</span></div> : <div className="home-no-task"><strong>当前阶段尚未完成</strong><span>{selected.project.current_stage_label || '请打开流程详情'} · {selected.project.progress.percent}% · 系统暂未生成可执行任务，请刷新或进入对应阶段检查。</span><button type="button" onClick={onRefresh} disabled={busy}>刷新任务状态</button></div>}</div><div className="home-activity"><div className="home-section-heading"><div><small>RECENT ACTIVITY</small><h2>最近活动</h2></div></div><div className="home-activity-list">{selected.recent_activity.length ? selected.recent_activity.slice(0, 4).map((activity) => <div className="home-activity-row" key={activity.id}><HomeStatusBadge status={activity.status} /><span>{activity.label}</span><small>{activity.created_at ? new Date(activity.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '刚刚'}</small></div>) : <p className="home-empty-inline">暂无运行记录。</p>}</div></div></section>
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

type AssetRejectFeedbackDraft = {
  assetId: string;
  artifactId: string;
  assetName: string;
  shotIds: string[];
  value: string;
};

function AssetRejectFeedbackModal({ draft, busy, onChange, onClose, onSubmit }: { draft: AssetRejectFeedbackDraft; busy: boolean; onChange: (value: string) => void; onClose: () => void; onSubmit: () => void }) {
  const dialogFocus = useDialogFocus(true);
  const trimmedValue = draft.value.trim();
  const hasArtifact = Boolean(draft.artifactId);
  const placeholder = '例如：\n• 脸部身份漂移，左眉尾的微特征消失\n• 右手与武器接触不自然，握持方向错误\n• 雨光从右侧打来，但场景固定光源应从左向右\n• 背景护栏位置和上一镜头不一致';
  return <div className="modal-backdrop feedback-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogFocus.dialogRef} onKeyDown={dialogFocus.onKeyDown} className="confirm-dialog feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-reject-feedback-title" aria-describedby="asset-reject-feedback-description">
      <header className="feedback-dialog-heading">
        <div className="feedback-dialog-title">
          <span>{hasArtifact ? 'MEDIA QA · PROMPT REBUILD' : 'PROMPT · REWRITE'}</span>
          <h2 id="asset-reject-feedback-title">{hasArtifact ? '退回并重写 Prompt' : '重写 Prompt'}</h2>
          <p>{draft.assetId} · {draft.assetName}</p>
        </div>
        <div className="feedback-dialog-status" aria-label={hasArtifact ? '图片审核不通过' : 'Prompt 重写'}><i aria-hidden="true">{hasArtifact ? '!' : '↻'}</i><span>{hasArtifact ? '图片审核不通过' : 'Prompt 重写'}</span></div>
        <button type="button" className="close-button" onClick={onClose} aria-label="关闭审核反馈窗口">×</button>
      </header>
      <div className="feedback-dialog-intro" id="asset-reject-feedback-description">
        <span className="feedback-dialog-intro-mark" aria-hidden="true">{hasArtifact ? 'QA' : 'P'}</span>
        <div><strong>这次需要修正什么？</strong><p>{hasArtifact ? '请写下画面中可以被观察和验证的具体问题。系统会按新的 Prompt Contract 与 skill-v2 规则重写草稿，并保留历史 Prompt。' : '请写下希望调整的内容、参考图要求或连续性问题。系统会按新的 Prompt Contract 与 skill-v2 规则重写草稿，并保留历史 Prompt。'}</p></div>
      </div>
      {draft.shotIds.length > 0 && <div className="feedback-dialog-meta"><span>影响镜头</span><div>{draft.shotIds.map((shotId) => <b key={shotId}>{shotId}</b>)}</div></div>}
      <label className="feedback-dialog-field" htmlFor="asset-reject-feedback-input"><span>问题描述 / 修改方向 <em>必填</em></span><textarea id="asset-reject-feedback-input" name="asset-reject-feedback-input" autoFocus data-dialog-initial-focus value={draft.value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && trimmedValue && !busy) { event.preventDefault(); onSubmit(); } }} placeholder={placeholder} maxLength={2000} rows={7} /></label>
      <div className="feedback-dialog-helper"><span>建议包含：人物身份 · 动作与接触 · 场景空间 · 光线连续性</span><strong>{draft.value.length}/2000</strong></div>
      <footer className="feedback-dialog-actions">
        <span className="feedback-dialog-shortcut">Esc 取消 · ⌘/Ctrl + Enter 提交</span>
        <div><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="button" className="primary-button" onClick={onSubmit} disabled={busy || !trimmedValue}>{busy ? '正在提交…' : hasArtifact ? '提交审核并重写' : '提交并重写 Prompt'}</button></div>
      </footer>
    </section>
  </div>;
}

function AssetContextMenu({ menu, shots, busy, onClose, onDelete, onMove, onCopy }: { menu: { x: number; y: number; target: AssetBoardContextTarget }; shots: StoryShot[]; busy: boolean; onClose: () => void; onDelete: () => void; onMove: (shotId: string) => void; onCopy: () => void }) {
  const currentShot = String(menu.target.rowKey || '').toUpperCase();
  const left = Math.min(menu.x, Math.max(12, window.innerWidth - 292));
  const top = Math.min(menu.y, Math.max(12, window.innerHeight - 360));
  return <div className="asset-context-menu" style={{ left, top }} role="menu" onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
    <header><div><span>ASSET ACTIONS</span><strong>{menu.target.label}</strong><small>{menu.target.assetId} · {menu.target.nodeType === 'artifact' ? '候选版本' : menu.target.nodeType === 'handoff' ? 'Prompt / 图片卡' : '逻辑资产'}</small></div><button onClick={onClose} aria-label="关闭资产菜单">×</button></header>
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
          return <article className={`project-manager-row ${current ? 'current' : ''}`} data-project-id={item.document.id} key={item.document.id}>
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
        {archivedProjects.length > 0 && <section className="archived-projects" aria-label="已归档项目"><h3>已归档项目</h3>{archivedProjects.map((item) => <article className="project-manager-row archived" data-project-id={item.document.id} key={item.document.id}><div className="project-manager-info"><div className="project-manager-name"><strong>{item.document.name}</strong><span className="project-status archived">已归档</span></div><small>{item.document.ratio || '—'} · {item.document.duration || 0}s · 修订版 v{item.revision}</small></div><div className="project-manager-actions"><button onClick={() => onRestore(item)} disabled={busy}>恢复</button><button className="danger-button" onClick={() => onDelete(item)} disabled={busy}>删除</button></div></article>)}</section>}
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

type StoryCheckIssue = StoryChecks['issues'][number];

const storyCheckFieldLabels: Record<string, string> = {
  composition: '构图', movement: '运镜 / 动作', performance: '表演', dialogue: '对白', narration: '旁白',
  lighting: '光线', color: '色彩', style: '风格', firstFrame: '首帧', lastFrame: '尾帧', continuity: '连续性',
};

function storyIssueTitle(issue: StoryCheckIssue): string {
  const titles: Record<string, string> = {
    dialogue_overrun: '对白 / 旁白超出镜头时长',
    asset_gap: '资产引用待登记（下一步）',
    shot_field_missing: '镜头缺少必填字段',
    shot_duration_invalid: '镜头时长无效',
    generator_duration_limit: '镜头超过当前生成器的时长限制',
    shot_id_missing: '镜头缺少稳定 ID',
    shot_id_duplicate: '镜头 ID 重复',
  };
  return titles[issue.code] || issue.message;
}

function storyIssueGuidance(issue: StoryCheckIssue, shot?: StoryShot): string {
  const details = issue.details || {};
  if (issue.code === 'dialogue_overrun') {
    const estimated = Number(details.estimated_dialogue_duration || 0);
    const duration = Number(shot?.duration || 0);
    return `${shot?.id || '该镜头'} 当前约 ${duration || '—'} 秒，对白 / 旁白估算约 ${estimated || '—'} 秒。请缩短对白，或把镜头时长调整到不小于约 ${estimated || '—'} 秒；也可以用“拆分”把对白和动作拆成两个镜头，修改后点击“保存镜头表”。`;
  }
  if (issue.code === 'asset_gap') {
    return '这是故事与分镜完成后进入资产生产前的正常待处理项。这些 ID 已被镜头引用，但资产数据中还没有对应登记；进入“资产生产工作区”后登记或关联角色、场景、道具和声音资产即可。';
  }
  if (issue.code === 'shot_field_missing') {
    const field = String(details.field || '必填字段');
    return `定位到对应镜头，在“${storyCheckFieldLabels[field] || field}”字段补齐内容，然后点击“保存镜头表”。`;
  }
  if (issue.code === 'shot_duration_invalid') return '定位到对应镜头，把时长改为大于 0 的有效数字，然后保存镜头表。';
  if (issue.code === 'generator_duration_limit') return '定位到对应镜头，把单镜头时长缩短到生成器允许的范围，或拆分为多个镜头后保存。';
  if (issue.code === 'shot_id_missing' || issue.code === 'shot_id_duplicate') return '请在镜头表中修复稳定 ID，确保每个镜头都有唯一 ID，再保存镜头表。';
  return '请定位到对应镜头，按检查信息补齐或修正字段，然后点击“保存镜头表”重新检查。';
}

function storyIssueMissingAssets(issue: StoryCheckIssue): Array<{ shot_id: string; asset_id: string }> {
  const raw = issue.details?.missing_assets;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({ shot_id: String(item.shot_id || '—'), asset_id: String(item.asset_id || '—') }));
}

const settingsCapabilityLabels: Record<string, string> = {
  orchestrator: '编排 Agent', vision: '视觉理解', image: '图片生成', image_edit: '图片编辑', video: '视频生成',
  tts: '语音 / TTS', music: '音乐', sfx: '音效', lip_sync: '口型同步', upscale: '放大 / 修复', upload: '媒体上传',
};
const settingsProviderLabels: Record<string, string> = {
  openai: 'OpenAI', openai_compatible: 'OpenAI-compatible', jimeng_cli: '即梦官方 CLI', opencode: 'OpenCode Agent', comfyui: 'ComfyUI 本地', minimax: 'MiniMax TTS',
};
const settingsProviderTypes = ['openai', 'openai_compatible', 'jimeng_cli', 'opencode', 'comfyui', 'minimax'];
const settingsEnvForType: Record<string, string> = { openai: 'OPENAI_API_KEY', openai_compatible: 'DEEPSEEK_API_KEY', opencode: 'OPENCODE_SERVER_PASSWORD', comfyui: 'COMFYUI_API_KEY', minimax: 'MINIMAX_CN_API_KEY' };
const settingsProviderCapabilities: Record<string, string[]> = {
  openai: ['orchestrator', 'vision', 'image', 'image_edit'],
  openai_compatible: ['orchestrator'],
  opencode: ['orchestrator'],
  jimeng_cli: ['video'],
  comfyui: ['image', 'image_edit', 'video', 'music', 'sfx', 'lip_sync', 'upscale', 'upload'],
  minimax: ['tts'],
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
const MINIMAX_TTS_MODELS = [
  { id: 'speech-2.8-hd', description: '高质量同步语音' },
  { id: 'speech-2.8-turbo', description: '低延迟同步语音' },
  { id: 'speech-2.6-hd', description: '高质量同步语音' },
  { id: 'speech-2.6-turbo', description: '低延迟同步语音' },
  { id: 'speech-02-hd', description: '高质量同步语音' },
  { id: 'speech-02-turbo', description: '低延迟同步语音' },
  { id: 'speech-01-hd', description: '高质量同步语音' },
  { id: 'speech-01-turbo', description: '低延迟同步语音' },
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

const minimaxRegionLabels: Record<MiniMaxRegion, { name: string; baseUrl: string; environmentVariable: string }> = {
  cn: { name: '中国区', baseUrl: 'https://api.minimax.cn/v1', environmentVariable: 'MINIMAX_CN_API_KEY' },
  global: { name: '国际区', baseUrl: 'https://api.minimax.io/v1', environmentVariable: 'MINIMAX_GLOBAL_API_KEY' },
};
const minimaxRegions: MiniMaxRegion[] = ['cn', 'global'];

function MiniMaxCredentialPanel({ selected, activeRegion, preferredModel, modelOptions, secrets, environmentVariables, busy, onModelChange, onSecretChange, onEnvironmentChange, onWrite, onImport, onClear, onSelectRegion }: {
  selected?: SettingsProvider;
  activeRegion: MiniMaxRegion;
  preferredModel: string;
  modelOptions: Array<{ id: string; description: string }>;
  secrets: Record<MiniMaxRegion, string>;
  environmentVariables: Record<MiniMaxRegion, string>;
  busy: boolean;
  onModelChange: (model: string) => void;
  onSecretChange: (region: MiniMaxRegion, value: string) => void;
  onEnvironmentChange: (region: MiniMaxRegion, value: string) => void;
  onWrite: (region: MiniMaxRegion) => void;
  onImport: (region: MiniMaxRegion) => void;
  onClear: (region: MiniMaxRegion) => void;
  onSelectRegion: (region: MiniMaxRegion) => void;
}) {
  const canManageCredentials = Boolean(selected);
  return <section className="settings-credential-card settings-minimax-credentials">
    <div className="settings-subheading"><small>MINIMAX TTS · REGION AWARE</small><h4>MiniMax TTS 接入</h4><p>{canManageCredentials ? '模型、执行区域和 API Key 集中管理；中国区和国际区使用两个独立的系统凭据槽位。' : '先保存 MiniMax Provider 配置；保存后即可在这里分别管理两个区域的系统凭据。'}</p></div>
    <div className="settings-minimax-model-config">
      <label>默认 TTS 模型<select aria-label="默认 TTS 模型" value={preferredModel || 'speech-2.8-hd'} onChange={(event) => onModelChange(event.target.value)}>{modelOptions.map((model) => <option key={model.id} value={model.id}>{model.id} · {model.description}</option>)}</select></label>
      <div className="settings-minimax-runtime-summary"><span>当前执行区域</span><strong>{minimaxRegionLabels[activeRegion].name}</strong><small>{activeRegion} · {minimaxRegionLabels[activeRegion].baseUrl}</small></div>
    </div>
    <div className="settings-minimax-section-heading"><div><small>REGION CREDENTIALS</small><strong>双区域 API Key</strong></div><span>在区域卡片中选择当前执行区</span></div>
    <div className="settings-minimax-region-grid">
      {minimaxRegions.map((region) => {
        const label = minimaxRegionLabels[region];
        const status = selected?.credential_regions?.[region];
        const configured = Boolean(status?.configured);
        const active = activeRegion === region;
        const environmentOptions = region === 'cn' ? ['MINIMAX_CN_API_KEY', 'MINIMAX_API_KEY'] : ['MINIMAX_GLOBAL_API_KEY'];
        return <article className={`settings-minimax-region-card ${active ? 'active' : ''}`} key={region}>
          <div className="settings-minimax-region-heading"><div><strong>{label.name}</strong><small>{region} · {label.baseUrl}</small></div><span className={configured ? 'configured' : ''}>{configured ? `已配置 ${status?.credential_mask || '••••••••'}` : '未配置'}</span></div>
          <label>该区域 API Key<input type="password" value={secrets[region]} onChange={(event) => onSecretChange(region, event.target.value)} placeholder={`输入${label.name} API Key`} aria-label={`${label.name} MiniMax API Key`} autoComplete="off" disabled={!canManageCredentials} /></label>
          <div className="settings-minimax-region-actions"><button type="button" onClick={() => onWrite(region)} disabled={busy || !canManageCredentials || !secrets[region]}>保存此区 Key</button><button type="button" className={active ? 'settings-region-active' : ''} onClick={() => onSelectRegion(region)} disabled={active}>{active ? '当前执行区' : '选择此区'}</button></div>
          <div className="settings-credential-actions settings-minimax-import-actions"><select value={environmentVariables[region]} onChange={(event) => onEnvironmentChange(region, event.target.value)} aria-label={`${label.name} 环境变量`} disabled={!canManageCredentials}><option value={environmentOptions[0]}>{environmentOptions[0]}</option>{environmentOptions.slice(1).map((name) => <option key={name} value={name}>{name}（兼容）</option>)}</select><button type="button" onClick={() => onImport(region)} disabled={busy || !canManageCredentials}>导入变量</button><button type="button" className="danger-button" onClick={() => onClear(region)} disabled={busy || !canManageCredentials || !configured}>清除该区 Key</button></div>
        </article>;
      })}
    </div>
    <small className="settings-security-note">Key 只写入系统凭据库，不进入 Provider JSON、项目文件、运行快照、日志或浏览器存储。切换区域或模型后，请点击下方“保存 Provider 配置”写入运行时；连接探测、音色目录和 TTS 生成都会使用这里显示的当前区域与模型。</small>
  </section>;
}

type SettingsDraft = { providerType: string; displayName: string; baseUrl: string; capabilities: string[]; enabled: boolean; modelConfig: string; serverUsername: string; agent: string; preferredModel: string; thinkingStrength: string; cliExecutable: string; minimaxRegion: 'cn' | 'global' };

type SettingsPresetView = {
  provider?: SettingsProvider;
  status: string;
  detail: string;
};

function normalizeSettingsUrl(value: unknown): string {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function findSettingsPresetProvider(preset: SettingsPreset, providers: SettingsProvider[]): SettingsProvider | undefined {
  return providers.find((provider) => provider.id === preset.id)
    || providers.find((provider) => provider.provider_type === preset.provider_type);
}

function buildSettingsPresetView(preset: SettingsPreset, providers: SettingsProvider[]): SettingsPresetView {
  const provider = findSettingsPresetProvider(preset, providers);
  if (!provider) {
    return { status: '可添加', detail: `预设链接：${preset.base_url}` };
  }

  const actualConfig = provider.model_config || {};
  const presetConfig = preset.model_config || {};
  const actualRegion = provider.provider_type === 'minimax'
    ? String(provider.active_region || actualConfig.region || 'cn').toLowerCase()
    : '';
  const presetRegion = provider.provider_type === 'minimax'
    ? String(presetConfig.region || 'cn').toLowerCase()
    : '';
  const actualModel = provider.provider_type === 'minimax'
    ? String(actualConfig.tts_model || '')
    : provider.provider_type === 'opencode'
      ? String(actualConfig.orchestrator_model || actualConfig.preferred_model || '')
      : String(actualConfig.model_version || actualConfig.default_model || '');
  const presetModel = provider.provider_type === 'minimax'
    ? String(presetConfig.tts_model || '')
    : provider.provider_type === 'opencode'
      ? String(presetConfig.orchestrator_model || presetConfig.preferred_model || '')
      : String(presetConfig.model_version || presetConfig.default_model || '');
  const differsFromPreset = provider.id !== preset.id
    || normalizeSettingsUrl(provider.base_url) !== normalizeSettingsUrl(preset.base_url)
    || (provider.provider_type === 'minimax' && actualRegion !== presetRegion)
    || (Boolean(actualModel) && actualModel !== presetModel);
  const regionLabel = provider.provider_type === 'minimax'
    ? (actualRegion === 'global' ? '国际区' : '中国区')
    : '';
  const modelLabel = actualModel ? `模型：${actualModel}` : '';
  const detail = [regionLabel, `实际链接：${provider.base_url}`, modelLabel].filter(Boolean).join(' · ');
  return {
    provider,
    status: differsFromPreset ? '已修改 · 以实际配置为准' : '已在接入目录',
    detail,
  };
}

function SettingsView({ settings, busy, onRefresh, onSaveProvider, onAddPreset, onDeleteProvider, onWriteCredential, onImportCredential, onClearCredential, onProbe }: {
  settings: SettingsEnvelope | null;
  busy: boolean;
  onRefresh: () => void;
  onSaveProvider: (providerId: string | null, body: Record<string, unknown>) => Promise<boolean>;
  onAddPreset: (presetId: string) => void;
  onDeleteProvider: (providerId: string) => void;
  onWriteCredential: (providerId: string, value: string, region?: MiniMaxRegion) => void;
  onImportCredential: (providerId: string, environmentVariable: string, region?: MiniMaxRegion) => void;
  onClearCredential: (providerId: string, region?: MiniMaxRegion) => void;
  onProbe: (providerId: string) => Promise<boolean>;
}) {
  const providers = settings?.providers || [];
  const [selectedId, setSelectedId] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [providerManagementMode, setProviderManagementMode] = useState(false);
  const [secret, setSecret] = useState('');
  const [environmentVariable, setEnvironmentVariable] = useState('OPENAI_API_KEY');
  const [minimaxSecrets, setMinimaxSecrets] = useState<Record<MiniMaxRegion, string>>({ cn: '', global: '' });
  const [minimaxEnvironmentVariables, setMinimaxEnvironmentVariables] = useState<Record<MiniMaxRegion, string>>({ cn: 'MINIMAX_CN_API_KEY', global: 'MINIMAX_GLOBAL_API_KEY' });
  const [draft, setDraft] = useState<SettingsDraft>({ providerType: 'openai', displayName: '', baseUrl: 'https://api.openai.com/v1', capabilities: ['orchestrator'], enabled: true, modelConfig: '{}', serverUsername: 'opencode', agent: 'build', preferredModel: '', thinkingStrength: 'max', cliExecutable: 'dreamina', minimaxRegion: 'cn' });
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
  // The provider probe is the source of truth for what can actually run on
  // the connected OpenCode Server. Keep the Go catalog only as descriptive
  // metadata; do not put unprobed model IDs into the selectable list.
  const detectedModelOptions = selected?.provider_type === 'opencode'
    ? Array.from(new Set(selected.models.map((candidate) => String(candidate).trim()).filter(Boolean))).map((id) => {
      const goModel = OPEN_CODE_GO_MODELS.find((model) => normalizeGoModelId(id) === model.id);
      const catalogEntry = selected.model_catalog?.find((item) => String(item.id || '') === id);
      const catalogLabel = String(catalogEntry?.label || id);
      const availabilityLabel = goModel
        ? `${goModel.name} · ${goModel.focus}`
        : `${catalogLabel} · ${id}`;
      return {
        id,
        label: `${availabilityLabel} · 已检测可用`,
        focus: goModel?.focus || '当前探测可用',
        note: goModel?.note || '该模型由当前 OpenCode Server 连接探测返回，可用于当前 Provider。',
        quota: goModel?.quota,
      };
    })
    : [];
  const currentModelIsDetected = detectedModelOptions.some((model) => model.id === draft.preferredModel);
  const currentModelFallback = selected?.provider_type === 'opencode' && draft.preferredModel && !currentModelIsDetected
    ? [{ id: draft.preferredModel, label: `当前配置 · ${draft.preferredModel}`, focus: '当前配置', note: '该模型不在当前官方 Go 目录中，请重新探测并选择 Go 模型。' }]
    : [];
  const opencodeModelOptions = [...detectedModelOptions, ...currentModelFallback];
  const selectedGoModel = OPEN_CODE_GO_MODELS.find((model) => normalizeGoModelId(draft.preferredModel) === model.id);
  const selectedDetectedModel = detectedModelOptions.find((model) => model.id === draft.preferredModel);
  const probe = selected?.last_probe || null;
  const probeModels = Array.isArray(probe?.models) ? probe.models : [];
  const probeCapabilities = Array.isArray(probe?.capabilities) ? probe.capabilities : [];
  const probeVoices = Array.isArray(probe?.voices) ? probe.voices as Array<Record<string, unknown>> : [];
  const minimaxModelOptions = selected?.models.length
    ? selected.models.map((id) => ({ id, description: '最近探测到的模型' }))
    : MINIMAX_TTS_MODELS;
  const probePending = Boolean(selected && probePendingId === selected.id);
  const currentCredentialMissing = selected?.provider_type === 'minimax' && !selected.credential_configured;
  const probeStatus = probePending ? '正在检测' : currentCredentialMissing ? '缺少凭据' : probe?.error_kind === 'auth' ? '凭据无效' : probe?.ok === true ? '连接正常' : probe?.ok === false ? '连接失败' : '尚未检测';
  const probeStatusClass = probePending ? 'checking' : currentCredentialMissing || probe?.ok === false ? 'error' : probe?.ok === true ? 'success' : 'pending';
  const runtimeMinimaxRegion: MiniMaxRegion = selected?.provider_type === 'minimax' ? (selected.active_region === 'global' ? 'global' : 'cn') : draft.minimaxRegion;
  const activeMinimaxRegion: MiniMaxRegion = draft.providerType === 'minimax' ? draft.minimaxRegion : runtimeMinimaxRegion;
  const runtimeMinimaxLabel = minimaxRegionLabels[runtimeMinimaxRegion].name;
  const runtimeMinimaxEnvironment = minimaxRegionLabels[runtimeMinimaxRegion].environmentVariable;
  const authCredentialHint = selected?.provider_type === 'minimax' ? `凭据无效（auth）：请更新 ${runtimeMinimaxEnvironment}（${runtimeMinimaxLabel}）后重新检测。` : `凭据无效（auth）：请更新 ${settingsEnvForType[selected?.provider_type || ''] || '对应凭据'} 后重新检测。`;

  useEffect(() => {
    if (isCreating) return;
    if (!providers.length) { setSelectedId(''); return; }
    if (!providers.some((provider) => provider.id === selectedId)) setSelectedId(providers[0].id);
  }, [providers, selectedId, isCreating]);

  useEffect(() => {
    if (!selected) return;
    const config = selected.model_config || {};
    setDraft({ providerType: selected.provider_type, displayName: selected.display_name, baseUrl: selected.base_url, capabilities: [...selected.capabilities], enabled: selected.enabled, modelConfig: JSON.stringify(config, null, 2), serverUsername: String(config.server_username || 'opencode'), agent: String(config.agent || 'build'), preferredModel: String(config.model_version || config.orchestrator_model || config.preferred_model || config.tts_model || ''), thinkingStrength: String(config.thinking_strength || config.reasoning_effort || 'max'), cliExecutable: String(config.executable || 'dreamina'), minimaxRegion: selected.active_region === 'global' || config.region === 'global' || selected.base_url.includes('minimax.io') ? 'global' : 'cn' });
    setSecret('');
    setEnvironmentVariable(settingsEnvForType[selected.provider_type] || 'OPENAI_API_KEY');
    setMinimaxSecrets({ cn: '', global: '' });
    setMinimaxEnvironmentVariables({ cn: 'MINIMAX_CN_API_KEY', global: 'MINIMAX_GLOBAL_API_KEY' });
  }, [selected?.id, selected?.model_config]);

  const selectProvider = (provider: SettingsProvider) => { setIsCreating(false); setSelectedId(provider.id); setSaveFeedback(null); };
  const startCreate = () => { setIsCreating(true); setSelectedId(''); setSecret(''); setMinimaxSecrets({ cn: '', global: '' }); setMinimaxEnvironmentVariables({ cn: 'MINIMAX_CN_API_KEY', global: 'MINIMAX_GLOBAL_API_KEY' }); setSaveFeedback(null); setDraft({ providerType: 'openai', displayName: '新 Provider', baseUrl: 'https://api.openai.com/v1', capabilities: ['orchestrator'], enabled: true, modelConfig: '{}', serverUsername: 'opencode', agent: 'build', preferredModel: '', thinkingStrength: 'max', cliExecutable: 'dreamina', minimaxRegion: 'cn' }); };
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
    if (draft.providerType === 'minimax') Object.assign(config, { region: draft.minimaxRegion, tts_model: draft.preferredModel || 'speech-2.8-hd', language_boost: null });
    const body: Record<string, unknown> = { display_name: draft.displayName.trim(), base_url: draft.providerType === 'jimeng_cli' ? 'cli://dreamina' : draft.providerType === 'minimax' ? (draft.minimaxRegion === 'global' ? 'https://api.minimax.io/v1' : 'https://api.minimax.cn/v1') : draft.baseUrl.trim(), capabilities: draft.capabilities.filter((capability) => supportedCapabilities.includes(capability)), enabled: draft.enabled, model_config: config };
    if (isCreating) body.provider_type = draft.providerType;
    const saved = await onSaveProvider(isCreating ? null : selectedId, body);
    if (saved) setDraft((current) => ({ ...current, modelConfig: JSON.stringify(config, null, 2) }));
    setSaveFeedback(saved ? { kind: 'success', text: '保存成功 · Provider 配置已写入' } : { kind: 'error', text: '保存失败 · 请查看顶部提示' });
  };
  if (!settings) return <div className="empty-state">正在读取 V3 设置控制面…</div>;
  const routeSummary = (['orchestrator', 'tts', 'image', 'video'] as const).map((capability) => {
    const binding = settings.bindings.find((item) => item.capability === capability);
    const provider = providers.find((item) => item.id === binding?.provider_profile_id);
    const config = provider?.model_config || {};
    const model = provider
      ? binding?.model
        || String(config.orchestrator_model || config.tts_model || config.model_version || config.preferred_model || 'Provider 默认')
      : '';
    const status = !provider ? '未配置' : provider.healthy === true ? '已就绪' : provider.healthy === false ? '需检查' : '待检测';
    const statusClass = !provider ? 'unbound' : provider.healthy === true ? 'ready' : provider.healthy === false ? 'check' : 'pending';
    const region = provider?.provider_type === 'minimax'
      ? ` · ${provider.active_region === 'global' ? '国际区' : '中国区'}`
      : '';
    return { capability, providerName: provider?.display_name || '—', model, status, statusClass, region };
  });
  return <section className="settings-view">
    <header className="settings-heading"><div><span>V3 CONTROL PLANE</span><h2>设置与 Provider 控制面</h2><p>管理模型接入、系统凭据和本地运行环境；Provider 状态变化会自动更新运行路由。所有配置均属于 V3，不兼容旧版接口。</p></div><button onClick={onRefresh} disabled={busy}>重新检测全部状态</button></header>
    <div className="settings-health-grid">
      <article className="settings-health-card"><small>运行时</small><strong>{settings.system.runtime.toUpperCase()}</strong><span>FrameFlow {settings.system.version} · Schema {settings.system.schema_version}</span></article>
      <article className={`settings-health-card ${settings.system.keyring.available ? 'ok' : 'danger'}`}><small>系统凭据库</small><strong>{settings.system.keyring.available ? '可用' : '不可用'}</strong><span>{settings.system.keyring.backend || '未发现可用后端'}</span></article>
      <article className={`settings-health-card ${settings.system.media.ffmpeg && settings.system.media.ffprobe ? 'ok' : 'warn'}`}><small>媒体工具链</small><strong>{settings.system.media.ffmpeg && settings.system.media.ffprobe ? 'FFmpeg 就绪' : '需要补齐'}</strong><span>ffmpeg / ffprobe · {Math.round(settings.system.disk_free_bytes / 1024 / 1024 / 1024)} GB 可用</span></article>
      <article className={`settings-health-card ${settings.system.minimax?.credential_configured ? 'ok' : 'warn'}`}><small>MiniMax TTS</small><strong>{settings.system.minimax?.credential_configured ? '已配置' : '未配置'}</strong><span>{settings.system.minimax?.active_region === 'global' ? '当前执行区：国际区' : '当前执行区：中国区'} · 两区凭据独立</span></article>
    </div>
    <section className="settings-route-summary" aria-label="当前运行路由"><div className="settings-route-summary-heading"><div><small>RUNTIME ROUTING</small><h3>当前运行路由</h3></div><span>Provider 状态变化会自动重新匹配</span></div><div className="settings-route-summary-grid">{routeSummary.map((item) => <article className={`settings-route-card ${item.statusClass}`} key={item.capability}><small>{settingsCapabilityLabels[item.capability]}</small><strong>{item.providerName}</strong><span>{item.status}{item.model ? ` · ${item.model}` : ''}{item.region}</span></article>)}</div></section>
    <div className="settings-layout">
      <aside className="settings-provider-column"><div className="settings-column-heading"><div><small>PROVIDERS</small><h3>接入目录</h3></div><div className="settings-column-heading-actions"><button type="button" onClick={startCreate}>＋ 新配置</button><button type="button" className={`settings-provider-manage-toggle ${providerManagementMode ? 'active' : ''}`} aria-label="Provider 管理" aria-pressed={providerManagementMode} title={providerManagementMode ? '已开启管理模式：点击关闭删除按钮' : '开启管理模式以显示彻底删除按钮'} onClick={() => setProviderManagementMode((current) => !current)}>Provider 管理</button></div></div>
        {providerManagementMode && <p className="settings-management-note">管理模式已开启：删除会清理 Provider 配置、系统凭据和能力绑定；快速接入预设会保留。</p>}
        {providers.map((provider) => <div key={provider.id} className={`settings-provider-item ${!isCreating && provider.id === selectedId ? 'active' : ''} ${providerManagementMode ? 'management-mode' : ''}`} role="group">
          <button type="button" className="settings-provider-select" onClick={() => selectProvider(provider)}><span className="settings-provider-status">{provider.enabled ? '●' : '○'}</span><span><b>{provider.display_name}</b><small>{settingsProviderLabels[provider.provider_type] || provider.provider_type}</small></span><i className={provider.healthy === true ? 'ok' : provider.healthy === false ? 'danger' : ''}>{provider.credential_configured ? '已接入' : provider.provider_type === 'comfyui' || provider.provider_type === 'opencode' || provider.provider_type === 'jimeng_cli' ? '待连接' : '缺凭据'}</i></button>
          {providerManagementMode && <button type="button" className="settings-provider-delete" aria-label={`删除 ${provider.display_name}`} title="永久删除此 Provider" onClick={() => onDeleteProvider(provider.id)} disabled={busy}>×</button>}
        </div>)}
        <div className="settings-presets"><div className="settings-presets-heading"><small>快速接入预设</small><span>删除配置后仍可重新添加</span></div>{settings.presets.map((preset: SettingsPreset) => { const presetView = buildSettingsPresetView(preset, providers); return <button key={preset.preset_id} className={presetView.provider ? 'settings-preset-installed' : ''} aria-label={presetView.provider ? `打开 ${preset.display_name} 当前配置` : `添加 ${preset.display_name} Provider`} onClick={() => presetView.provider ? selectProvider(presetView.provider) : onAddPreset(preset.preset_id)} disabled={busy}><b>{presetView.provider ? `打开 ${preset.display_name}` : preset.display_name}</b><span className="settings-preset-status">{presetView.status}</span><span className="settings-preset-detail">{presetView.detail}</span></button>; })}</div>
      </aside>
        <div className="settings-editor">
          <div className="settings-editor-heading"><div><small>{isCreating ? 'NEW PROVIDER' : 'PROVIDER PROFILE'}</small><h3>{isCreating ? '创建新的 V3 Provider' : selected?.display_name || '选择 Provider'}</h3></div>{selected && <div className="settings-editor-actions"><button onClick={async () => { setProbePendingId(selected.id); try { await onProbe(selected.id); } finally { setProbePendingId(null); } }} disabled={busy}>连接探测</button>{providerManagementMode && <button className="danger-button" onClick={() => onDeleteProvider(selected.id)} disabled={busy}>删除配置</button>}</div>}</div>
         {selected && <section className={`settings-connection-result ${probeStatusClass}`} role="status" aria-live="polite"><div className="settings-connection-heading"><small>CONNECTION STATUS</small><strong>{probeStatus}</strong><span>{currentCredentialMissing ? `当前${runtimeMinimaxLabel}尚未配置独立 API Key，请在下方凭据卡写入后再探测。` : probe?.error_kind === 'auth' ? authCredentialHint : probe?.error ? String(probe.error) : probePending ? '正在验证接入点、认证与可用模型，请稍候…' : probe?.ok === true ? `Provider 已响应，当前区域：${selected.provider_type === 'minimax' ? runtimeMinimaxLabel : '默认接入点'}。下面的数据来自最近一次探测。` : '点击右上角“连接探测”获取实时状态。'}</span></div><dl><div><dt>延迟</dt><dd>{probe?.latency_ms != null ? `${Number(probe.latency_ms)} ms` : '—'}</dd></div><div><dt>可用模型</dt><dd>{probeModels.length ? `${probeModels.length} 个` : '—'}</dd></div><div><dt>声明能力</dt><dd>{probeCapabilities.length ? probeCapabilities.map((capability) => settingsCapabilityLabels[String(capability)] || String(capability)).join('、') : '—'}</dd></div>{selected.provider_type === 'minimax' && <div><dt>可用音色</dt><dd>{probeVoices.length ? `${probeVoices.length} 个` : '—'}</dd></div>}<div><dt>最近检测</dt><dd>{probe?.checked_at ? new Date(Number(probe.checked_at) * 1000).toLocaleString('zh-CN') : '—'}</dd></div>{probe?.server_version != null && <div><dt>Server 版本</dt><dd>{String(probe.server_version)}</dd></div>}</dl>{selected.provider_type === 'minimax' && probeVoices.length > 0 && <p className="settings-help">音色 ID：{probeVoices.slice(0, 12).map((voice) => String(voice.voice_id || voice.id || '')).filter(Boolean).join('、')}{probeVoices.length > 12 ? ' …' : ''}</p>}</section>}
          <div className="settings-form-grid"><label>显示名称<input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label><label>Provider 类型<select value={draft.providerType} disabled={!isCreating} onChange={(event) => setDraft({ ...draft, providerType: event.target.value, capabilities: [] })}>{settingsProviderTypes.map((type) => <option key={type} value={type}>{settingsProviderLabels[type]}</option>)}</select></label>{draft.providerType === 'jimeng_cli' ? <label className="settings-wide">CLI 可执行文件（只填写程序路径）<input value={draft.cliExecutable} onChange={(event) => setDraft({ ...draft, cliExecutable: event.target.value })} placeholder="dreamina 或 dreamina.exe 的完整路径" /><small className="settings-field-help">不要把 curl 安装命令填在这里；安装命令请在终端执行，成功后这里保持为 dreamina。</small></label> : <label className="settings-wide">Base URL<input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://… 或本机 http://127.0.0.1…" /></label>}</div>
          <div className="settings-capability-picker"><span>支持能力</span>{Object.entries(settingsCapabilityLabels).map(([capability, label]) => { const supported = supportedCapabilities.includes(capability); return <label className={supported ? '' : 'unsupported'} key={capability}><input type="checkbox" checked={draft.capabilities.includes(capability)} disabled={!supported} onChange={() => toggleCapability(capability)} />{label}{!supported && <small>不支持</small>}</label>; })}{unsupportedSelectedCapabilities.length > 0 && <p className="settings-capability-help">当前配置中存在不受此 Provider 适配器支持的能力，保存时会自动忽略这些选项。</p>}<p className="settings-capability-explain">{draft.providerType === 'opencode' ? '这里表示 Provider 适配器可以承担的能力，不是单个 Go 模型的媒体生成能力。OpenCode Go 负责文本编排；图片、视频、声音等任务会按自动运行路由交给其他 Provider。' : '这里表示当前 Provider 适配器可以承担的能力；具体模型仍以连接探测和自动运行路由为准。'}</p></div>
         <label className="settings-toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用此 Provider（停用后不可被自动运行路由选择）</label>
          {draft.providerType === 'opencode' && <div className="settings-agent-form"><div className="settings-subheading"><small>OPENCODE AGENT</small><h4>Agent 接入参数</h4></div><div className="settings-form-grid"><label>Server 用户名<input value={draft.serverUsername} onChange={(event) => setDraft({ ...draft, serverUsername: event.target.value })} /></label><label>Agent<input value={draft.agent} onChange={(event) => setDraft({ ...draft, agent: event.target.value })} /></label><label>思考强度<select value={draft.thinkingStrength} onChange={(event) => setDraft({ ...draft, thinkingStrength: event.target.value })}><option value="auto">自动（跟随模型）</option><option value="low">低 · 快速响应</option><option value="medium">中 · 平衡</option><option value="high">高 · 深度规划</option><option value="max">最大 · 复杂创作 / QA</option></select></label><label className="settings-wide">主力模型<select value={draft.preferredModel} onChange={(event) => setDraft({ ...draft, preferredModel: event.target.value })} disabled={!opencodeModelOptions.length}><option value="">{opencodeModelOptions.length ? '请选择主力模型' : '请先连接探测模型'}</option>{opencodeModelOptions.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label></div>{selectedGoModel && <div className="settings-go-model-card"><div className="settings-go-model-heading"><span>FRAMEFLOW 调度建议</span><strong>{selectedGoModel.name}</strong></div><div className="settings-go-model-focus"><small>更偏向视频制作</small><b>{selectedGoModel.focus}</b></div><p>{selectedGoModel.note}</p>{selectedGoModel.quota && <small className="settings-go-model-quota">官方典型额度：每 5 小时约 {selectedGoModel.quota} 次请求</small>}</div>}{draft.preferredModel && !selectedGoModel && !selectedDetectedModel && <div className="settings-go-model-card settings-go-model-card-warning"><div className="settings-go-model-heading"><span>当前配置</span><strong>{draft.preferredModel}</strong></div><p>该模型不在当前 OpenCode Go 官方目录中。重新探测后可切换到上方 Go 模型组合。</p></div>}<p className="settings-help">模型列表优先来自最近一次连接探测；OpenCode Go 官方组合仅用于补充用途说明。“思考强度”会作为 OpenCode 的 variant 参数发送。“更偏向视频制作”是 FRAMEFLOW 的调度建议，不代表模型原生支持图片或视频生成。保存后会写入 OpenCode 的编排模型配置，并自动同步“编排 Agent”能力绑定。</p></div>}
          {draft.providerType === 'jimeng_cli' && <div className="settings-agent-form"><div className="settings-subheading"><small>DREAMINA CLI</small><h4>即梦视频模型</h4></div><label className="settings-wide">默认模型<select className="settings-jimeng-model-select" value={draft.preferredModel || 'seedance2.0fast'} onChange={(event) => setDraft({ ...draft, preferredModel: event.target.value })}>{JIMENG_VIDEO_MODELS.map((model) => <option key={model.id} value={model.id}>{model.id} · {model.description}</option>)}</select></label><p className="settings-help">模型列表已按当前 dreamina CLI 帮助同步；VIP、图生/首尾帧专用模型会在不匹配的生成模式下被后端拦截。安装命令请在终端执行，不要填入上方路径。登录命令：dreamina login --headless。</p></div>}
          {draft.providerType === 'minimax' && <MiniMaxCredentialPanel selected={selected} activeRegion={activeMinimaxRegion} preferredModel={draft.preferredModel} modelOptions={minimaxModelOptions} secrets={minimaxSecrets} environmentVariables={minimaxEnvironmentVariables} busy={busy} onModelChange={(model) => setDraft((current) => ({ ...current, preferredModel: model }))} onSecretChange={(region, value) => setMinimaxSecrets((current) => ({ ...current, [region]: value }))} onEnvironmentChange={(region, value) => setMinimaxEnvironmentVariables((current) => ({ ...current, [region]: value }))} onWrite={(region) => { if (!selected) return; onWriteCredential(selected.id, minimaxSecrets[region], region); setMinimaxSecrets((current) => ({ ...current, [region]: '' })); }} onImport={(region) => { if (!selected) return; onImportCredential(selected.id, minimaxEnvironmentVariables[region], region); }} onClear={(region) => { if (!selected) return; onClearCredential(selected.id, region); }} onSelectRegion={(region) => setDraft((current) => ({ ...current, minimaxRegion: region, baseUrl: minimaxRegionLabels[region].baseUrl }))} />}
          <label className="settings-json-field">扩展配置 JSON<textarea value={draft.modelConfig} onChange={(event) => setDraft({ ...draft, modelConfig: event.target.value })} spellCheck={false} /></label>
         <div className="settings-save-row"><button className="settings-primary" onClick={saveProvider} disabled={busy || !draft.displayName.trim() || !draft.baseUrl.trim()}>{isCreating ? '创建 Provider' : '保存 Provider 配置'}</button>{saveFeedback && <span className={`settings-save-feedback ${saveFeedback.kind}`} role="status">{saveFeedback.text}</span>}</div>
        {!isCreating && selected && (selected.provider_type === 'jimeng_cli' ? <section className="settings-credential-card"><div className="settings-subheading"><small>LOCAL CLI LOGIN</small><h4>即梦本机登录态</h4><p>{selected.credential_configured ? 'CLI 已检测到本机登录态。' : '不填写 API Key；请先安装官方 CLI，并运行 dreamina login 或 dreamina login --headless。'}</p></div><small className="settings-security-note">登录态由官方 dreamina CLI 自己管理，FrameFlow 不读取、不保存 Cookie 或 token。</small></section> : selected.provider_type !== 'minimax' ? <section className="settings-credential-card"><div className="settings-subheading"><small>CREDENTIALS</small><h4>系统凭据库</h4><p>{selected.credential_configured ? `当前状态：已配置 ${selected.credential_mask || '••••••••'}` : selected.provider_type === 'opencode' || selected.provider_type === 'comfyui' ? '当前 Provider 可以不配置密钥，连接由本地服务决定。' : '当前状态：未配置 API Key'}</p></div><div className="settings-credential-actions"><input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="输入后仅写入系统凭据库，不会保存到网页" autoComplete="off"/><button onClick={() => { onWriteCredential(selected.id, secret); setSecret(''); }} disabled={busy || !secret}>写入凭据库</button><select value={environmentVariable} onChange={(event) => setEnvironmentVariable(event.target.value)}><option>{settingsEnvForType[selected.provider_type] || 'OPENAI_API_KEY'}</option><option>OPENAI_API_KEY</option><option>DEEPSEEK_API_KEY</option><option>OPENCODE_SERVER_PASSWORD</option><option>COMFYUI_API_KEY</option><option>MINIMAX_API_KEY</option></select><button onClick={() => onImportCredential(selected.id, environmentVariable)} disabled={busy}>导入环境变量</button><button className="danger-button" onClick={() => onClearCredential(selected.id)} disabled={busy}>清除系统凭据</button></div><small className="settings-security-note">API Key 不回显、不进入项目 JSON、运行快照、日志、前端 localStorage 或 Provider 探测结果。</small></section> : null)}
       </div>
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
  // Withdrawal advances the project revision. React state is asynchronous, so
  // two nearby clicks must not send the same stale expected_revision.
  const activeAssetRemovalQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeAssetRemovalCountRef = useRef(0);
  assetBoardEnvelopeRef.current = assetBoardEnvelope;
  assetBoardNodesRef.current = assetBoardNodes;
  assetBoardSelectedKeyRef.current = assetBoardSelectedKey;
  assetBoardColumnWidthsRef.current = assetBoardColumnWidths;
  const [assetBoardGap, setAssetBoardGap] = useState(16);
  const [assetBoardCollapsedScopes, setAssetBoardCollapsedScopes] = useState<Record<string, string | true>>({});
  const [assetBoardLocator, setAssetBoardLocator] = useState('');
  const assetBoardLocatorTimerRef = useRef<number | null>(null);
  const [assetBoardIndexOpen, setAssetBoardIndexOpen] = useState(false);
  const [assetBoardIndexPosition, setAssetBoardIndexPosition] = useState({ x: 11, y: 100 });
  const [assetBoardDirectoryQuery, setAssetBoardDirectoryQuery] = useState('');
  const [assetProductionFocus, setAssetProductionFocus] = useState<AssetProductionFocus>(null);
  const [assetPromptDraft, setAssetPromptDraft] = useState<{ assetId: string; prompt: string; promptPack?: Record<string, unknown>; promptQuality?: LibraryAsset['promptQuality'] } | null>(null);
  const [assetEditorDraftDirty, setAssetEditorDraftDirty] = useState(false);
  const [settings, setSettings] = useState<SettingsEnvelope | null>(null);
  const [storyRun, setStoryRun] = useState<StoryRun | null>(null);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('V3 工作台已连接');
  const [autoSaveState, setAutoSaveState] = useState<AutoSaveState>('idle');
  const [autoSaveError, setAutoSaveError] = useState('');
  const [autoSaveErrorOpen, setAutoSaveErrorOpen] = useState(false);
  const [autoSaveChangeVersion, setAutoSaveChangeVersion] = useState(0);
  const [assetPromptRun, setAssetPromptRun] = useState<AssetPromptRunState>({ status: 'idle', message: '', startedAt: null });
  const [storyDirty, setStoryDirty] = useState(false);
  const [newEdgeRelation, setNewEdgeRelation] = useState<EdgeRelation>('execution');
  const [agentPlan, setAgentPlan] = useState<AgentPlan | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantWorkspaceV2Enabled, setAssistantWorkspaceV2Enabled] = useState(true);
  const [projectReloadVersion, setProjectReloadVersion] = useState(0);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [assistantSkillId, setAssistantSkillId] = useState('video-script-storyboard');
  const [workflowManifests, setWorkflowManifests] = useState<WorkflowManifest[]>([]);
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [paidConfirmation, setPaidConfirmation] = useState<{ estimate: RunEstimate; graphRevision: number; nodeIds: string[] } | null>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; message: string; confirmLabel: string; danger?: boolean; resolve: (value: boolean) => void } | null>(null);
  const [rejectFeedback, setRejectFeedback] = useState<AssetRejectFeedbackDraft | null>(null);
  const requestConfirmation = useCallback((title: string, message: string, confirmLabel = '确认', danger = false) => new Promise<boolean>((resolve) => setConfirmation({ title, message, confirmLabel, danger, resolve })), []);
  const closeConfirmation = useCallback((accepted: boolean) => { confirmation?.resolve(accepted); setConfirmation(null); }, [confirmation]);
  const [assetCreateOpen, setAssetCreateOpen] = useState(false);
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
  const generateFusionPromptRef = useRef<(assetId: string, sourceAssetIds: string[], shotId: string) => void>(() => undefined);
  const graphEnvelopeRef = useRef<GraphEnvelope | null>(null);
  const nodesRef = useRef<FlowNode[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const storyRef = useRef<StoryEnvelope | null>(null);
  const timelineEnvelopeRef = useRef<TimelineEnvelope | null>(null);
  const assetBoardEdgesRef = useRef<Edge[]>([]);
  const assetBoardLayoutRef = useRef<AssetBoardLayoutState>({ preset: 'standard', mode: 'adaptive', columnWidth: 310, columnWidths: defaultAssetBoardColumnWidths, directoryPosition: { x: 11, y: 100 }, gap: 16 });
  const assetBoardDirtyRef = useRef(false);
  // Incremented whenever a server response replaces the board snapshot. An
  // autosave queued before that replacement must never write its stale flow
  // back over the authoritative response.
  const assetBoardMutationEpochRef = useRef(0);
  const audioStudioRef = useRef<AudioStudioEnvelope | null>(null);
  const audioDraftRef = useRef<AudioStudioDocument | null>(null);
  const audioRevisionRef = useRef<number | null>(null);
  const assetEditorDraftsRef = useRef<Map<string, AssetEditorDraft>>(new Map());
  const autoSaveTimerRef = useRef<number | null>(null);
  const autoSaveRetryTimerRef = useRef<number | null>(null);
  const autoSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const autoSaveInFlightRef = useRef(false);
  const autoSaveFailureDetailsRef = useRef<Record<string, string>>({});
  const autoSaveRetryAllowedRef = useRef(true);
  const dirtyStateRef = useRef({ graph: false, story: false, assetBoard: false, assetEditor: false, audio: false, timeline: false });
  const projectIdRef = useRef('');
  const projectLoadSequence = useRef(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const clearAssetBoardHistory = useCallback(() => {
    assetBoardHistory.current = { past: [], future: [] };
    assetBoardDragSnapshot.current = null;
  }, []);

  graphEnvelopeRef.current = graphEnvelope;
  nodesRef.current = nodes;
  edgesRef.current = edges;
  storyRef.current = story;
  timelineEnvelopeRef.current = timelineEnvelope;
  assetBoardEdgesRef.current = assetBoardEdges;
  assetBoardLayoutRef.current = { preset: assetBoardLayoutPreset, mode: assetBoardLayoutMode, columnWidth: assetBoardColumnWidth, columnWidths: assetBoardColumnWidths, directoryPosition: assetBoardIndexPosition, gap: assetBoardGap };
  assetBoardDirtyRef.current = assetBoardDirty;
  dirtyStateRef.current = { graph: dirty, story: storyDirty, assetBoard: assetBoardDirty, assetEditor: assetEditorDraftDirty, audio: audioDirty, timeline: timelineDirty };
  projectIdRef.current = projectId;

  useEffect(() => {
    if (!audioStudio) {
      audioDraftRef.current = null;
      audioRevisionRef.current = null;
      return;
    }
    if (!audioDirty) {
      audioStudioRef.current = audioStudio;
      audioDraftRef.current = audioStudio.document;
      audioRevisionRef.current = audioStudio.revision;
    }
  }, [audioDirty, audioStudio?.revision]);

  const bumpAutoSaveChange = useCallback(() => {
    autoSaveRetryAllowedRef.current = true;
    if (autoSaveRetryTimerRef.current !== null) {
      window.clearTimeout(autoSaveRetryTimerRef.current);
      autoSaveRetryTimerRef.current = null;
    }
    setAutoSaveChangeVersion((value) => value + 1);
  }, []);
  const markGraphDirty = useCallback(() => { setDirty(true); bumpAutoSaveChange(); }, [bumpAutoSaveChange]);
  const markStoryDirty = useCallback(() => { setStoryDirty(true); bumpAutoSaveChange(); }, [bumpAutoSaveChange]);
  const markAssetBoardDirty = useCallback(() => { assetBoardDirtyRef.current = true; setAssetBoardDirty(true); bumpAutoSaveChange(); }, [bumpAutoSaveChange]);
  const markTimelineDirty = useCallback(() => { setTimelineDirty(true); bumpAutoSaveChange(); }, [bumpAutoSaveChange]);
  const markAudioDirty = useCallback(() => { setAudioDirty(true); bumpAutoSaveChange(); }, [bumpAutoSaveChange]);
  const commitAssetBoardServerState = useCallback((envelope: AssetBoardEnvelope, nextNodes: AssetFlowNode[], nextEdges: Edge[]) => {
    // Update all refs before scheduling React state updates. Any queued
    // autosave that runs in this window can therefore only see one coherent
    // server snapshot, never a new envelope paired with old flow edges.
    assetBoardEnvelopeRef.current = envelope;
    assetBoardNodesRef.current = nextNodes;
    assetBoardEdgesRef.current = nextEdges;
    assetBoardDirtyRef.current = false;
    dirtyStateRef.current.assetBoard = false;
    assetBoardMutationEpochRef.current += 1;
    setAssetBoardEnvelope(envelope);
    setAssetBoardNodes(nextNodes);
    setAssetBoardEdges(nextEdges);
    setAssetBoardDirty(false);
  }, []);
  const handleAudioDocumentChange = useCallback((document: AudioStudioDocument, isDirty: boolean) => {
    audioDraftRef.current = document;
    if (isDirty) markAudioDirty();
  }, [markAudioDirty]);
  const handleAssetEditorDraftChange = useCallback((assetId: string, draft: AssetEditorDraft) => {
    const previous = assetEditorDraftsRef.current.get(assetId);
    if (previous && JSON.stringify(previous) === JSON.stringify(draft)) return;
    assetEditorDraftsRef.current.set(assetId, draft);
    setAssetEditorDraftDirty(true);
    bumpAutoSaveChange();
  }, [bumpAutoSaveChange]);

  const project = projects.find((item) => item.document.id === projectId);
  const currentPageDirty = mode === 'story' ? storyDirty : mode === 'timeline' ? timelineDirty : mode === 'canvas' ? assetBoardDirty || assetEditorDraftDirty : mode === 'audio' ? audioDirty : dirty;
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
  const handleAssetBoardControlSelection = useCallback((event: React.MouseEvent<HTMLElement>) => {
    // Chromium on macOS treats Control-click as a context-menu gesture and
    // @xyflow's d3 drag filter ignores ctrlKey, so ReactFlow never receives a
    // selectable click. Handle that cross-platform modifier at the board
    // boundary before the event reaches the flow renderer.
    if (!event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, input, textarea, select, label, a')) return;
    const card = target?.closest('.asset-board-card');
    const nodeId = card?.closest<HTMLElement>('.react-flow__node')?.dataset.id;
    if (!nodeId) return;
    event.preventDefault();
    event.stopPropagation();
    setAssetBoardNodes((current) => current.map((node) => node.id === nodeId ? { ...node, selected: !node.selected } : node));
  }, []);
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
  const generateFusionPromptFromBoard = useCallback((assetId: string, sourceAssetIds: string[], shotId: string) => { generateFusionPromptRef.current(assetId, sourceAssetIds, shotId); }, []);
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
    pending_changes: { graph: dirty, story: storyDirty, asset_board: assetBoardDirty, asset_editor_draft: assetEditorDraftDirty, timeline: timelineDirty },
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
    const isFusionNode = (node?: AssetFlowNode) => Boolean(node?.data.asset_id && assetClassFor(node) === 'fusion');
    for (const edge of assetBoardEdges) {
      const source = flowNodesById.get(edge.source);
      const target = flowNodesById.get(edge.target);
      const relation = String(edge.data?.relation || '');
      const targetIsFusion = isFusionNode(target) && target?.data.asset_id === selectedProductionAsset.id;
      if (targetIsFusion && source?.data.asset_id && assetClassFor(source) !== 'fusion' && relation === 'fusion_input') sourceIds.add(String(source.data.asset_id));
      const sourceIsFusion = isFusionNode(source) && source?.data.asset_id === selectedProductionAsset.id;
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
    if (asset.assetClass === 'audio') {
      const metadata = asset.assetMetadata || {};
      const pack = normalizePromptPack('audio', asset.promptPack || metadata.prompt_pack || {}, {
        identityAnchor: asset.identityAnchors || metadata.identity_anchors || {},
        mustPreserve: asset.mustPreserve || metadata.must_preserve || [],
        mustAvoid: asset.mustAvoid || metadata.must_avoid || [],
        context: { shots: [], references: asset.references || [] },
      });
      const webPackage = buildMiniMaxWebPromptPackage(pack, asset.prompt, { shots: [], references: asset.references || [] });
      if (!webPackage.copyText) {
        setNotice('朗读文本尚未 confirmed；不能复制 MiniMax 文本包，请先确认唯一台词。');
        return;
      }
    }
    const fullPrompt = composeAssetPrompt(asset, story, asset.prompt);
    try {
      await navigator.clipboard.writeText(fullPrompt);
      setNotice(asset.assetClass === 'audio' ? `「${asset.name || asset.id}」MiniMax Web 测试包已复制；文本框只粘贴包内“朗读文本”一段。` : `「${asset.name || asset.id}」Prompt 已复制`);
    } catch {
      setNotice('浏览器未授权剪贴板，请手动复制右侧 Prompt。');
    }
  };

  const refreshPromptBoard = async (library: AssetLibraryEnvelope) => {
    if (!projectId) return;
    const board = await studioApi.assetBoard(projectId);
      const boardNodes = assetBoardToFlowNodes(board.board, library.assets, assetBoardFilter, assetBoardShowShots, story?.story.shots || [], { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onRemoveArtifact: removeUploadedAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
    commitAssetBoardServerState(board, boardNodes, assetBoardToFlowEdges(board.board, boardNodes));
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
    const characterPlan = asset.assetClass === 'character' ? '本次只生成 1 张角色结构参考板（面部/上半身特写 + 正面、侧面、背面全身视图），后续融合不理想时再按需追加镜头图。' : '本次生成 1 个图片候选。';
    const confirmed = await requestConfirmation('确认图像生成', `将使用 Codex Image 生成「${asset.name || assetId}」并产生费用。${characterPlan}生成结果会进入待图片 QA，不会直接登记为就绪资产。是否确认？`, '确认生成', true);
    if (!confirmed) { setNotice('已取消图像生成，仍保留 Prompt 卡。'); return; }
    setBusy(true);
    try {
      const result = await studioApi.generateAssetImage(projectId, assetId, { prompt: asset.prompt, prompt_version: asset.promptVersion, size: '1024x1024', quality: 'medium', confirmed: true });
      const [library, projectEnvelope] = await Promise.all([studioApi.assetLibrary(projectId), studioApi.projects()]);
      setAssetLibrary(library); setProjects(projectEnvelope.projects); await refreshPromptBoard(library); setNotice(`${asset.assetClass === 'character' ? '角色结构参考图' : '图像候选'}已生成 · ${String(result.artifact?.id || result.artifact_id || 'artifact')} · 待图片 QA 与资产登记`);
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
      const boardNodes = assetBoardToFlowNodes(synced.board, assigned.library.assets, assetBoardFilter, assetBoardShowShots, assigned.story.shots, { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onRemoveArtifact: removeUploadedAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
      setStory({ ...currentStory, story: assigned.story, revision: assigned.project_revision });
      setStoryDirty(false);
      setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: assigned.project_revision } : item));
      setAssetLibrary(assigned.library);
      commitAssetBoardServerState(synced, boardNodes, assetBoardToFlowEdges(synced.board, boardNodes));
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
    if (assetBoardLocatorTimerRef.current !== null) window.clearTimeout(assetBoardLocatorTimerRef.current);
    assetBoardLocatorTimerRef.current = window.setTimeout(() => {
      setAssetBoardLocator((current) => current === normalized ? '' : current);
      assetBoardLocatorTimerRef.current = null;
    }, 720);
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
        markAssetBoardDirty();
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
  }, [assetBoardEnvelope, assetBoardIndexPosition, clampAssetBoardIndexPosition, markAssetBoardDirty]);
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
    markAssetBoardDirty();
  }, [applyFixedAssetBoardFrame, assetBoardLayoutMode, markAssetBoardDirty]);
  useLayoutEffect(() => {
    setAssetBoardNodes((current) => {
      let changed = false;
       const next = current.map((node) => {
         if ((node.id !== 'asset-grid:table' && node.data.onOpenAssetProduction === openAssetProductionShortcut && node.data.onGeneratePrompt === generatePromptFromBoard && node.data.onGenerateFusionPrompt === generateFusionPromptFromBoard) || (node.id === 'asset-grid:table' && node.data.onColumnResize === resizeAssetBoardColumn && node.data.onOpenAssetProduction === openAssetProductionShortcut && node.data.onGeneratePrompt === generatePromptFromBoard && node.data.onGenerateFusionPrompt === generateFusionPromptFromBoard)) return node;
         changed = true;
         return { ...node, data: { ...node.data, onColumnResize: resizeAssetBoardColumn, onOpenAssetProduction: openAssetProductionShortcut, onGeneratePrompt: generatePromptFromBoard, onGenerateFusionPrompt: generateFusionPromptFromBoard } };
       });
      return changed ? next : current;
    });
  }, [assetBoardNodes, generateFusionPromptFromBoard, generatePromptFromBoard, openAssetProductionShortcut, resizeAssetBoardColumn]);
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

  const refreshProjectList = useCallback(async () => {
    const { projects: items } = await studioApi.projects();
    const normalized = items.map((item) => ({ ...item, document: { ...item.document, productionStatus: item.document.productionStatus || 'in_progress' } }));
    setProjects(normalized);
    return normalized;
  }, []);
  const openProjectManager = useCallback(() => {
    if (busy || projectManagerOpen) return;
    setProjectManagerOpen(true);
    void refreshProjectList().catch((error: Error) => setNotice(error.message));
  }, [busy, projectManagerOpen, refreshProjectList]);

  useEffect(() => {
    refreshProjectList().then((normalized) => {
      if (normalized.length) setProjectId(normalized[0].document.id);
    }).catch((error: Error) => setNotice(error.message));
     studioApi.dashboard().then((value) => { setDashboard(value); setDashboardError(''); }).catch((error: Error) => { setDashboardError(error.message); setNotice(error.message); });
    studioApi.settings().then((value) => { setSettings(value); setAssistantWorkspaceV2Enabled(value.feature_flags?.assistant_workspace_v2 !== false); }).catch((error: Error) => setNotice(error.message));
    studioApi.workflows().then(({ workflows }) => setWorkflowManifests(workflows)).catch(() => setWorkflowManifests(fallbackAssistantSkills));
  }, [refreshProjectList]);

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
    setStoryRun(null);
    setRun(null);
    setDirty(false);
    setStoryDirty(false);
    setTimelineDirty(false);
    setAssetBoardDirty(false);
    assetBoardDirtyRef.current = false;
    assetBoardMutationEpochRef.current += 1;
    setAssetEditorDraftDirty(false);
    assetEditorDraftsRef.current.clear();
    setAutoSaveState('idle');
    setAutoSaveError('');
    setAutoSaveErrorOpen(false);
    audioStudioRef.current = null;
    audioDraftRef.current = null;
    audioRevisionRef.current = null;
    setBusy(true);
    studioApi.loadProjectSnapshot(projectId, controller.signal)
      .then(({ graph: envelope, timeline: timelineEnvelope, timelinePreflight: preflight, story: storyEnvelope, storyRuns, assetLibrary: library, assetBoard, dashboard: dashboardEnvelope, audioStudio: audioEnvelope }) => {
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
      const boardNodes = assetBoardToFlowNodes(assetBoard.board, library.assets, 'all', true, storyEnvelope.story.shots, { preset: loadedPreset, columnWidth: loadedColumnWidth, gap: loadedGap, layoutMode: loadedLayoutMode, collapsedScopes: {}, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onRemoveArtifact: removeUploadedAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
        commitAssetBoardServerState(assetBoard, boardNodes, assetBoardToFlowEdges(assetBoard.board, boardNodes));
         setDashboard(dashboardEnvelope);
         setDashboardError('');
        setStoryRun(storyRuns.runs[0] || null);
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
  }, [clearAssetBoardHistory, projectId, projectReloadVersion]);

  useEffect(() => {
    if (!assetBoardEnvelope) return;
    const selectedIds = new Set(assetBoardNodes.filter((node) => node.selected).map((node) => node.id));
    const boardNodes = assetBoardToFlowNodes(assetBoardEnvelope.board, assetLibrary?.assets || [], assetBoardFilter, assetBoardShowShots, story?.story.shots || [], { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onRemoveArtifact: removeUploadedAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut }).map((node) => selectedIds.has(node.id) ? { ...node, selected: true } : node);
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
    let refreshed: AssetBoardSyncEnvelope;
    if (!current || !preserveLayout) {
      refreshed = await studioApi.assetBoard(projectId);
    } else {
      try {
        refreshed = await studioApi.syncAssetBoard(projectId, current.revision, true);
      } catch (error) {
        // Uploading a candidate changes the asset library, while other UI
        // actions may have advanced the board revision in the meantime. A
        // stale revision must not make a successful upload look like a no-op;
        // reload the latest board and retry the layout-preserving sync once.
        if (!(error instanceof StudioApiError) || error.status !== 409) throw error;
        const latest = await studioApi.assetBoard(projectId);
        refreshed = await studioApi.syncAssetBoard(projectId, latest.revision, true);
      }
    }
    const syncedLibrary = refreshed.library;
    const syncedProjectRevision = refreshed.project_revision;
    if (syncedProjectRevision) {
      setProjects((currentProjects) => currentProjects.map((item) => item.document.id === projectId ? { ...item, revision: syncedProjectRevision } : item));
    }
    if (refreshed.story) {
      setStory((currentStory) => currentStory ? { ...currentStory, revision: syncedProjectRevision || currentStory.revision, story: refreshed.story! } : currentStory);
      setStoryDirty(false);
    }
    if (syncedLibrary) setAssetLibrary(syncedLibrary);
    const assets = syncedLibrary?.assets || libraryOverride?.assets || assetLibrary?.assets || [];
    const boardNodes = assetBoardToFlowNodes(refreshed.board, assets, assetBoardFilter, assetBoardShowShots, story?.story.shots || [], { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onlyBlocked: assetBoardOnlyBlocked, showCandidates: assetBoardShowCandidates, shotId: assetBoardShotId, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onRemoveArtifact: removeUploadedAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
    const selectedNode = selectedAssetId ? boardNodes.find((node) => !node.data.presentationOnly && node.data.node_type === 'asset' && String(node.data.asset_id || '') === selectedAssetId) : undefined;
    const selectedSelectionKey = selectedNode ? assetBoardSelectionKey(selectedNode.data) : null;
    const nextBoardNodes = selectedSelectionKey ? applyAssetBoardSelection(boardNodes, selectedSelectionKey) : boardNodes;
    setAssetBoardSelection(selectedSelectionKey);
    commitAssetBoardServerState(refreshed, nextBoardNodes, assetBoardToFlowEdges(refreshed.board, nextBoardNodes));
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
    const nextNodes = assetBoardToFlowNodes(assetBoardEnvelope.board, assetLibrary?.assets || [], filter, showShots, story?.story.shots || [], { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onlyBlocked, showCandidates, shotId, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onRemoveArtifact: removeUploadedAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
    setAssetBoardNodes(nextNodes); setAssetBoardEdges(assetBoardToFlowEdges(assetBoardEnvelope.board, nextNodes));
  };

  const scheduleAssetGenerationLocator = useCallback((normalized: string, label: string) => {
    if (assetBoardLocatorTimerRef.current !== null) window.clearTimeout(assetBoardLocatorTimerRef.current);
    setAssetBoardLocator('');
    assetBoardLocatorTimerRef.current = window.setTimeout(() => {
      setAssetBoardLocator(normalized);
      assetBoardLocatorTimerRef.current = window.setTimeout(() => {
        setAssetBoardLocator((current) => current === normalized ? '' : current);
        assetBoardLocatorTimerRef.current = null;
      }, 720);
    }, 0);
    setNotice(`已定位：${label}`);
  }, []);

  const focusAssetGenerationTarget = useCallback((assetId: string) => {
    const normalized = assetId.trim();
    if (!normalized) return;
    const targetAsset = assetLibrary?.assets.find((asset) => asset.id === normalized);
    const visibleNode = assetBoardNodes.find((candidate) => !candidate.data.presentationOnly && candidate.data.asset_id === normalized);
    const hiddenByView = !visibleNode && (assetBoardFilter !== 'all' || Boolean(assetBoardShotId) || assetBoardOnlyBlocked);
    if (hiddenByView) {
      setAssetBoardFilter('all');
      setAssetBoardShotId('');
      setAssetBoardOnlyBlocked(false);
      rebuildAssetBoardView({ filter: 'all', shotId: '', onlyBlocked: false });
      scheduleAssetGenerationLocator(normalized, targetAsset?.name || normalized);
      return;
    }
    if (!visibleNode) {
      setNotice(`没有找到“${normalized}”对应的画布节点`);
      return;
    }
    scheduleAssetGenerationLocator(normalized, visibleNode.data.label || targetAsset?.name || normalized);
  }, [assetBoardFilter, assetBoardNodes, assetBoardOnlyBlocked, assetBoardShotId, assetLibrary?.assets, rebuildAssetBoardView, scheduleAssetGenerationLocator]);

  const assetGenerationOrder = useMemo(() => buildAssetGenerationOrder({ assets: assetLibrary?.assets || [], storyShots: story?.story.shots || [], board: assetBoardEnvelope?.board, boardNodes: assetBoardNodes.map((node) => ({ asset_id: node.data.asset_id, config: node.data.config })) }), [assetBoardEnvelope?.board, assetBoardNodes, assetLibrary?.assets, story?.story.shots]);

  const buildAssetBoardFlow = (envelope: AssetBoardEnvelope, library: AssetLibraryEnvelope, shots: StoryShot[]) => {
    const boardNodes = assetBoardToFlowNodes(envelope.board, library.assets, assetBoardFilter, assetBoardShowShots, shots, { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onRemoveArtifact: removeUploadedAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
    return { boardNodes, boardEdges: assetBoardToFlowEdges(envelope.board, boardNodes) };
  };

  const deleteAssetById = async (assetId: string, fallbackLabel: string) => {
    if (!projectId || !project || !assetId) return;
    const source = assetLibrary?.assets.find((asset) => asset.id === assetId);
    const label = source?.name || fallbackLabel || assetId;
    if (!(await requestConfirmation('确认删除逻辑资产', `确认删除逻辑资产「${label}」？其画布卡片、候选和相关内容会一并移除，已上传的物理文件会保留。`, '删除资产', true))) return;
    setBusy(true);
    try {
      const result = await studioApi.deleteAsset(projectId, assetId, project.revision);
      setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: result.revision } : item));
      setAssetLibrary(result.library);
      if (result.story) setStory((current) => current ? { ...current, story: result.story } : current);
      const envelope = result.asset_board || await studioApi.assetBoard(projectId);
      const flow = buildAssetBoardFlow(envelope, result.library, result.story?.shots || story?.story.shots || []);
      commitAssetBoardServerState(envelope, flow.boardNodes, flow.boardEdges);
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
        setNotice(`已复制资产「${copiedName}」及其候选/相关内容${copiedId ? '，当前位于 SHARED' : ''}`);
      }
      void refreshDashboard(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

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
    const route = String(task.route || 'home');
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
      // Asset work is now centered on the production canvas. Keep the
      // dashboard's legacy route value as a data contract, but resolve it to
      // the canvas and select the target asset there.
      setMode('canvas');
      await refreshAssetBoard(true, undefined, task.targetId || null);
      setNotice(`已定位到：${task.title}`);
      return;
    }
    const nextMode: StudioMode = ['home', 'story', 'canvas', 'timeline', 'audio', 'settings'].includes(route) ? route as StudioMode : 'home';
    setMode(nextMode);
    setNotice(`已定位到：${task.title}`);
  };

  const openDashboardStage = (stage: ProjectDashboard['stages'][number]) => {
    const route = String(stage.route || 'home');
    setMode(route === 'assets' ? 'canvas' : ['home', 'story', 'canvas', 'timeline', 'audio', 'settings'].includes(route) ? route as StudioMode : 'home');
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
    if (!(await requestConfirmation('确认删除 Provider', '这会永久删除该 Provider 的接入配置、系统凭据和能力绑定；项目内容与下方快速接入预设会保留。确认继续？', '删除 Provider', true))) return;
    runSettingsAction(async () => { await studioApi.deleteSettingsProvider(providerId); }, 'Provider 配置、系统凭据和能力绑定已彻底删除；快速接入预设仍保留');
  };
  const writeSettingsCredential = (providerId: string, value: string, region?: MiniMaxRegion) => runSettingsAction(async () => { await studioApi.writeSettingsCredential(providerId, value, region); }, region ? `已写入 MiniMax ${minimaxRegionLabels[region].name} Key` : '凭据已写入系统凭据库');
  const importSettingsCredential = (providerId: string, environmentVariable: string, region?: MiniMaxRegion) => runSettingsAction(async () => { await studioApi.importSettingsCredential(providerId, environmentVariable, region); }, region ? `已从 ${environmentVariable} 导入 MiniMax ${minimaxRegionLabels[region].name} Key` : `已从 ${environmentVariable} 导入凭据`);
  const clearSettingsCredential = (providerId: string, region?: MiniMaxRegion) => runSettingsAction(async () => { await studioApi.clearSettingsCredential(providerId, region); }, region ? `MiniMax ${minimaxRegionLabels[region].name} Key 已清除` : '系统凭据已清除');
  const probeSettingsProvider = (providerId: string) => runSettingsAction(async () => { await studioApi.probeSettingsProvider(providerId); }, 'Provider 探测完成，模型目录已更新');
  const refreshMinimaxCatalog = async (region?: MiniMaxRegion) => {
    const providerId = settings?.providers.find((provider) => provider.provider_type === 'minimax')?.id || 'minimax-default';
    const ok = await runSettingsAction(async () => { await studioApi.refreshMinimaxVoices(providerId, region); }, region ? `已刷新 MiniMax ${minimaxRegionLabels[region].name} 音色目录` : 'MiniMax 音色目录已刷新');
    await refreshAudioStudio();
    return ok;
  };
  const refreshTimelinePreflight = async () => {
    if (!projectId) return;
    try { setTimelinePreflight(await studioApi.timelinePreflight(projectId)); } catch (error) { setNotice((error as Error).message); }
  };

  const saveTimeline = async (background = false, expectedRevisionOverride?: number, allowRetry = true): Promise<TimelineEnvelope | null> => {
    const current = timelineEnvelopeRef.current || timelineEnvelope;
    if (!projectId || !current) return null;
    const document = current.document;
    const expectedRevision = expectedRevisionOverride ?? current.revision;
    if (!background) setBusy(true);
    try {
      const saved = await studioApi.saveTimeline(projectId, document, expectedRevision);
      const unchanged = JSON.stringify(timelineEnvelopeRef.current?.document || {}) === JSON.stringify(document);
      const next = unchanged ? saved : { ...saved, document: timelineEnvelopeRef.current?.document || saved.document };
      timelineEnvelopeRef.current = next;
      setTimelineEnvelope((currentEnvelope) => unchanged || !currentEnvelope ? next : { ...next, document: currentEnvelope.document });
      if (unchanged) setTimelineDirty(false);
      if (background) {
        void studioApi.timelinePreflight(projectId).then(setTimelinePreflight).catch(() => undefined);
      } else {
        await refreshTimelinePreflight();
        setNotice(`时间线已保存 · v${saved.revision}`);
        void refreshDashboard(false);
      }
      return next;
    } catch (error) {
      if (background && allowRetry && error instanceof StudioApiError && error.status === 409) {
        try {
          const latest = await studioApi.timeline(projectId);
          const local = timelineEnvelopeRef.current || current;
          const merged = { ...latest, document: local.document };
          timelineEnvelopeRef.current = merged;
          setTimelineEnvelope(merged);
          return await saveTimeline(true, latest.revision, false);
        } catch (retryError) {
          error = retryError;
        }
      }
      if (background && error instanceof StudioApiError && !error.retryable && error.status !== 409) autoSaveRetryAllowedRef.current = false;
      if (background) autoSaveFailureDetailsRef.current['时间线'] = (error as Error).message;
      setNotice((error as Error).message);
      return null;
    } finally { if (!background) setBusy(false); }
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
    const nextNodes = assetBoardToFlowNodes(board, assetLibrary?.assets || [], assetBoardFilter, assetBoardShowShots, story?.story.shots || [], { preset, columnWidth, gap, layoutMode, collapsedScopes: assetBoardCollapsedScopes, onlyBlocked: assetBoardOnlyBlocked, showCandidates: assetBoardShowCandidates, shotId: assetBoardShotId, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onRemoveArtifact: removeUploadedAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut }).map((node) => selectedIds.has(node.id) ? { ...node, selected: true } : node);
    const restoredSelected = getSelectedAssetBoardCards(nextNodes);
    setAssetBoardSelection(restoredSelected.length === 1 ? assetBoardSelectionKey(restoredSelected[0]) : null);
    setAssetBoardEnvelope((current) => current ? { ...current, board } : current);
      const framedNodes = applyFixedAssetBoardFrame(nextNodes);
     setAssetBoardNodes(framedNodes);
    setAssetBoardEdges(assetBoardToFlowEdges(board, nextNodes));
    markAssetBoardDirty();
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
    if (acceptedChanges.some((change) => change.type !== 'select')) markAssetBoardDirty();
     }, [applyFixedAssetBoardFrame, assetBoardEdges, assetBoardNodes, captureAssetBoardSnapshot, markAssetBoardDirty, recordAssetBoardState, rememberAssetBoardEdit, setAssetBoardSelection]);

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
    if (changes.some((change) => change.type !== 'select')) markAssetBoardDirty();
  }, [assetBoardEdges, assetBoardNodes, markAssetBoardDirty, recordAssetBoardState]);

  const connectAssetBoard = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const sourceNode = assetBoardNodes.find((node) => node.id === connection.source);
    const targetNode = assetBoardNodes.find((node) => node.id === connection.target);
    const assetClassFor = (node?: AssetFlowNode) => node?.data.asset_id ? String(assetLibrary?.assets.find((asset) => asset.id === node.data.asset_id)?.assetClass || node.data.config.asset_class || '') : '';
    let source = connection.source;
    let target = connection.target;
    let relation: AssetBoardEdgeRelation = 'reference';
    const sourceCanFeedFusion = ['asset', 'artifact', 'handoff'].includes(String(sourceNode?.data.node_type || ''));
    const targetCanReceiveFusion = ['asset', 'handoff'].includes(String(targetNode?.data.node_type || ''));
    if (targetCanReceiveFusion && assetClassFor(targetNode) === 'fusion' && sourceCanFeedFusion && assetClassFor(sourceNode) !== 'fusion') {
      relation = 'fusion_input';
    } else if (['asset', 'handoff'].includes(String(sourceNode?.data.node_type || '')) && assetClassFor(sourceNode) === 'fusion' && ['asset', 'artifact', 'handoff'].includes(String(targetNode?.data.node_type || '')) && assetClassFor(targetNode) !== 'fusion') {
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
    markAssetBoardDirty();
    if (relation === 'fusion_input') setNotice('已建立融合输入关系；选中融合资产后可生成融合 Prompt');
  }, [assetBoardEdges, assetBoardNodes, assetLibrary?.assets, markAssetBoardDirty, recordAssetBoardState]);

  const saveAssetBoard = async (background = false, expectedRevisionOverride?: number, allowRetry = true, expectedMutationEpoch?: number): Promise<AssetBoardEnvelope | null> => {
    if (background && expectedMutationEpoch !== undefined && expectedMutationEpoch !== assetBoardMutationEpochRef.current) return assetBoardEnvelopeRef.current;
    const current = assetBoardEnvelopeRef.current || assetBoardEnvelope;
    if (!projectId || !current) return null;
    const layout = assetBoardLayoutRef.current;
    const board = assetBoardFromFlow({ ...current.board, metadata: { ...current.board.metadata, layout_preset: layout.preset, layout_view: layout.mode, layout_column_width: layout.columnWidth, layout_column_widths: layout.columnWidths, layout_directory_position: layout.directoryPosition, layout_gap: layout.gap } }, assetBoardNodesRef.current, assetBoardEdgesRef.current);
    const expectedRevision = expectedRevisionOverride ?? current.revision;
    if (!background) setBusy(true);
    try {
      const saved = await studioApi.saveAssetBoard(projectId, board, expectedRevision);
      // A server-side operation such as Fusion Prompt generation may have
      // completed while this request was in flight. Do not apply this older
      // response to the freshly replaced board or queue a stale retry.
      if (background && expectedMutationEpoch !== undefined && expectedMutationEpoch !== assetBoardMutationEpochRef.current) return assetBoardEnvelopeRef.current;
      const latestEnvelope = assetBoardEnvelopeRef.current;
      const latestBoard = latestEnvelope ? assetBoardFromFlow({ ...latestEnvelope.board, metadata: { ...latestEnvelope.board.metadata, layout_preset: assetBoardLayoutRef.current.preset, layout_view: assetBoardLayoutRef.current.mode, layout_column_width: assetBoardLayoutRef.current.columnWidth, layout_column_widths: assetBoardLayoutRef.current.columnWidths, layout_directory_position: assetBoardLayoutRef.current.directoryPosition, layout_gap: assetBoardLayoutRef.current.gap } }, assetBoardNodesRef.current, assetBoardEdgesRef.current) : null;
      const unchanged = JSON.stringify(latestBoard || {}) === JSON.stringify(board);
      const next = unchanged ? saved : latestEnvelope ? { ...saved, board: latestEnvelope.board } : saved;
      assetBoardEnvelopeRef.current = next;
      if (unchanged) {
        const nextNodes = assetBoardToFlowNodes(saved.board, assetLibrary?.assets || [], assetBoardFilter, assetBoardShowShots, story?.story.shots || [], { preset: layout.preset, columnWidth: layout.columnWidth, gap: layout.gap, layoutMode: layout.mode, collapsedScopes: assetBoardCollapsedScopes, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onRemoveArtifact: removeUploadedAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
        const nextEdges = assetBoardToFlowEdges(saved.board, nextNodes);
        commitAssetBoardServerState(saved, nextNodes, nextEdges);
      } else {
        // Preserve newer local edits, but keep the envelope revision coherent
        // for the next queued save.
        assetBoardMutationEpochRef.current += 1;
        setAssetBoardEnvelope(next);
      }
      if (!background) {
        setNotice(`资产画布已保存 · v${saved.revision}`);
        void refreshDashboard(false);
      }
      return next;
    } catch (error) {
      if (background && allowRetry && error instanceof StudioApiError && error.status === 409) {
        try {
          const latest = await studioApi.assetBoard(projectId);
          const local = assetBoardEnvelopeRef.current || current;
          const merged = { ...latest, board: local.board };
          assetBoardEnvelopeRef.current = merged;
          setAssetBoardEnvelope(merged);
          return await saveAssetBoard(true, latest.revision, false, expectedMutationEpoch);
        } catch (retryError) {
          error = retryError;
        }
      }
      if (background && error instanceof StudioApiError && !error.retryable && error.status !== 409) autoSaveRetryAllowedRef.current = false;
      if (background) autoSaveFailureDetailsRef.current['资产画布'] = (error as Error).message;
      setNotice((error as Error).message);
      return null;
    } finally { if (!background) setBusy(false); }
  };

  const syncAssetBoard = async (showProgress = true) => {
    if (!projectId || !assetBoardEnvelope) return null;
    if (assetBoardDirty) {
      setNotice('当前资产生产工作区正在自动保存，请稍候再同步故事与分镜');
      return null;
    }
    if (showProgress) setBusy(true);
    try {
      const synced = await studioApi.syncAssetBoard(projectId, assetBoardEnvelope.revision, true);
      const boardNodes = assetBoardToFlowNodes(synced.board, assetLibrary?.assets || [], assetBoardFilter, assetBoardShowShots, story?.story.shots || [], { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onRemoveArtifact: removeUploadedAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
      commitAssetBoardServerState(synced, boardNodes, assetBoardToFlowEdges(synced.board, boardNodes));
      setNotice(`故事与分镜已同步到资产画布 · ${boardNodes.filter((node) => node.data.node_type === 'shot').length} 个镜头节点`);
      return synced;
    } catch (error) {
      setNotice((error as Error).message);
      return null;
    } finally { if (showProgress) setBusy(false); }
  };

  const openAssetCreate = () => {
    if (!projectId || !project) { setNotice('请先选择一个项目'); return; }
    if (mode !== 'canvas') { setMode('canvas'); setNotice('请在资产生产工作区新增逻辑资产'); return; }
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

  const generateAssetPrompts = async (targetAssetId?: string, options: { reviewFeedback?: string; sourceQaRunId?: string; storyOverride?: StoryEnvelope } = {}) => {
    const sourceStory = options.storyOverride || story;
    if (!projectId || !sourceStory) {
      setNotice('请先选择项目并加载故事与分镜。');
      setAssetPromptRun({ status: 'error', message: '没有加载项目或故事与分镜，任务未启动。', startedAt: null });
      return;
    }
    const startedAt = Date.now();
    const preparingMessage = storyDirty ? '正在保存故事与分镜，保存完成后开始资产审计…' : '正在准备资产 Prompt 生成任务…';
    setAssetPromptRun({ status: storyDirty ? 'preparing' : 'running', message: preparingMessage, startedAt });
    setNotice(targetAssetId ? '正在生成当前资产的 Prompt 草稿，请稍候…' : '正在执行资产总控并生成 Prompt 卡，请稍候；不要重复点击。');
    setBusy(true);
    try {
      const currentStory = storyDirty && !options.storyOverride ? await saveStory(false) : sourceStory;
      if (!currentStory) {
        setAssetPromptRun({ status: 'error', message: '故事与分镜保存失败，资产 Prompt 任务未启动。', startedAt });
        return;
      }
      setAssetPromptRun({ status: 'running', message: '正在调用资产总控模型，执行依赖审计并生成 Prompt 卡…', startedAt });
      const result = await studioApi.generateAssetPrompts(projectId, { expected_revision: currentStory.revision, ...(targetAssetId ? { target_asset_id: targetAssetId } : {}), ...(options.reviewFeedback?.trim() ? { review_feedback: options.reviewFeedback.trim(), source_qa_run_id: options.sourceQaRunId } : {}) });
      setStory(result.story); setStoryDirty(false); setAssetLibrary(result.library); setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: result.revision } : item));
      const flow = buildAssetBoardFlow(result.asset_board, result.library, result.story.story.shots);
      const nextBoardNodes = targetAssetId ? flow.boardNodes.map((node) => ({ ...node, selected: node.data.node_type === 'asset' && String(node.data.asset_id || '') === targetAssetId })) : flow.boardNodes;
      commitAssetBoardServerState(result.asset_board, nextBoardNodes, flow.boardEdges); setMode('canvas');
      if (targetAssetId) {
        const generated = result.run.promptCards.find((card) => card.id === targetAssetId);
        setAssetPromptDraft(generated?.prompt ? { assetId: targetAssetId, prompt: generated.prompt, promptPack: generated.promptPack, promptQuality: generated.promptQuality } : null);
        setAssetProductionFocus({ assetId: targetAssetId, target: 'prompt' });
      }
      const fusionPlanCount = Array.isArray(result.run.fusionPlans) ? result.run.fusionPlans.length : 0;
      const successMessage = targetAssetId ? options.reviewFeedback ? '已按审核反馈重写当前资产 Prompt 草稿，请检查并保存后进入 Prompt QA。' : '当前资产 Prompt 草稿已生成，请编辑并保存后进入 Prompt QA。' : `已生成 ${result.run.promptCards.length} 张基础资产 Prompt 卡，并建立 ${fusionPlanCount} 张镜头融合卡；等待 Prompt QA 和用户确认。`;
      setAssetPromptRun({ status: 'success', message: successMessage, startedAt });
      setNotice(targetAssetId ? options.reviewFeedback ? '已按审核反馈重写 Prompt 草稿 · 请检查并保存后进入 Prompt QA' : '已为当前资产生成 Prompt 草稿 · 请编辑并保存后进入 Prompt QA' : `已生成 ${result.run.promptCards.length} 张基础资产 Prompt 卡 · 自动建立 ${fusionPlanCount} 张镜头融合卡 · 等待 QA`); void refreshDashboard(false);
    } catch (error) {
      const message = (error as Error).message;
      setAssetPromptRun({ status: 'error', message: `任务未完成：${message}`, startedAt });
      setNotice(message);
    } finally { setBusy(false); }
  };
  generateAssetPromptRef.current = (assetId: string) => { void generateAssetPrompts(assetId); };

  const handoffAssetToChatGPT = async (asset: LibraryAsset, prompt: string) => {
    const fullPrompt = composeAssetPrompt(asset, story, prompt);
    try {
      await navigator.clipboard.writeText(fullPrompt);
    } catch {
      setNotice('浏览器未授权剪贴板，请手动复制右侧 Prompt。');
      return;
    }
    setNotice('Prompt 已复制');
  };

  const importAssetCandidate = async (asset: LibraryAsset, file: File) => {
    if (!projectId) return;
    const mediaType = file.type || ({ mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[file.name.toLowerCase().split('.').pop() || ''] || '';
    if (!/^(image\/(png|jpeg|webp)|video\/(mp4|webm|quicktime)|audio\/(wav|mpeg|mp4|x-m4a))$/.test(mediaType)) {
      setNotice('仅支持 PNG/JPEG/WebP 图片、MP4/WebM/MOV 视频和 WAV/MP3/M4A 音频。');
      return;
    }
    setNotice(`正在上传候选${mediaType.startsWith('video/') ? '视频' : mediaType.startsWith('audio/') ? '声音' : '图片'}「${file.name}」…`);
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
      setNotice(`上传失败：${(error as Error).message}`);
    } finally { setBusy(false); }
  };

  const refreshAssetProduction = async () => {
    if (!projectId) return;
    const [library, projectEnvelope] = await Promise.all([studioApi.assetLibrary(projectId), studioApi.projects()]);
    setAssetLibrary(library);
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
      const result = await studioApi.registerAssetArtifact(projectId, artifactId, replaceActive);
      const projectRevision = Number(result.project_revision ?? result.revision);
      if (Number.isFinite(projectRevision) && projectRevision > 0) {
        setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: projectRevision } : item));
      }
      const registeredLibrary = result.library as AssetLibraryEnvelope | undefined;
      const registeredBoard = result.asset_board as AssetBoardEnvelope | undefined;
      if (registeredLibrary && registeredBoard) {
        setAssetLibrary(registeredLibrary);
        const flow = buildAssetBoardFlow(registeredBoard, registeredLibrary, story?.story.shots || []);
        commitAssetBoardServerState(registeredBoard, flow.boardNodes, flow.boardEdges);
      } else {
        await refreshAssetProduction();
      }
      // Set the success notice after all projection refreshes so the generic
      // autosave status cannot immediately hide the registration result.
      setNotice(replaceActive ? '候选已登记并替换当前 active 版本；历史版本仍保留。' : '候选已登记为资产版本；已有 active 时默认保留当前版本。');
      void refreshDashboard(false);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };

  const removeActiveAssetImage = async (assetId: string, artifactId: string) => {
    if (!projectId) return;
    const asset = assetLibrary?.assets.find((candidate) => candidate.id === assetId);
    const artifact = asset?.artifacts?.find((candidate: Record<string, any>) => String(candidate.id || candidate.artifact_id || '') === artifactId);
    if (!asset || !artifact) {
      setNotice('当前登记图片已不存在，请刷新资产生产工作区后重试。');
      return;
    }
    if (!(await requestConfirmation(
      '撤下当前登记图片',
      `将先从「${asset.name || assetId}」撤下当前登记图片，再允许重新上传新的候选图。原文件、资产版本、QA 和审计记录会保留在项目文件夹中。撤下后该资产暂时不可入镜，直到新图完成 QA 与登记。`,
      '撤下并重新上传',
      true,
    ))) return;
    activeAssetRemovalCountRef.current += 1;
    const queuedRemoval = activeAssetRemovalQueueRef.current.then(async () => {
      setBusy(true);
      try {
        const resolveLatestRevision = async () => {
          const latest = await studioApi.projects();
          const current = latest.projects.find((item) => item.document.id === projectId);
          if (!current) throw new Error('当前项目已不存在，请刷新项目列表后重试。');
          // Keep the visible project row aligned immediately, even before the
          // next React render commits the response state.
          setProjects((items) => items.map((item) => item.document.id === projectId
            ? { ...item, revision: Math.max(Number(item.revision) || 0, Number(current.revision) || 0) }
            : item));
          return Number(current.revision);
        };

        let expectedRevision = await resolveLatestRevision();
        let result: Record<string, any>;
        try {
          result = await studioApi.removeActiveAssetVersion(projectId, assetId, expectedRevision);
        } catch (error) {
          // Another normal project write may land between the revision read
          // and DELETE. Refresh once and retry the same logical asset; any
          // persistent conflict remains visible to the user.
          if (!(error instanceof StudioApiError) || error.status !== 409) throw error;
          expectedRevision = await resolveLatestRevision();
          result = await studioApi.removeActiveAssetVersion(projectId, assetId, expectedRevision);
        }
        const library = result.library as AssetLibraryEnvelope;
        const board = result.asset_board as AssetBoardEnvelope;
        const storyDocument = result.story as StoryDocument | undefined;
        if (result.project_revision !== undefined) {
          setProjects((current) => current.map((item) => item.document.id === projectId
            ? { ...item, revision: Math.max(Number(item.revision) || 0, Number(result.project_revision) || 0) }
            : item));
        }
        setAssetLibrary(library);
        if (storyDocument) setStory((current) => current ? { ...current, revision: Number(result.project_revision ?? current.revision), story: storyDocument } : current);
        const resolvedBoard = board || await studioApi.assetBoard(projectId);
        const flow = buildAssetBoardFlow(resolvedBoard, library, storyDocument?.shots || story?.story.shots || []);
        commitAssetBoardServerState(resolvedBoard, flow.boardNodes, flow.boardEdges);
        clearAssetBoardHistory();
        setNotice(result.active_removed === false ? '当前已经没有 active 图片，可直接上传新的候选图。' : '当前登记图片已撤下并归档；现在可以上传新的候选图，完成 QA 后再登记。');
        void refreshDashboard(false);
      } catch (error) {
        setNotice(`撤下失败：${(error as Error).message}`);
      } finally {
        activeAssetRemovalCountRef.current -= 1;
        if (activeAssetRemovalCountRef.current === 0) setBusy(false);
      }
    });
    // A failed withdrawal must not prevent a later queued withdrawal from
    // running. The operation itself owns the user-facing error notice.
    activeAssetRemovalQueueRef.current = queuedRemoval.catch(() => undefined);
    await queuedRemoval;
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
      const nextNodes = assetBoardToFlowNodes(result.asset_board.board, result.library.assets, assetBoardFilter, assetBoardShowShots, story?.story.shots || [], { preset: assetBoardLayoutPreset, columnWidth: assetBoardColumnWidth, gap: assetBoardGap, layoutMode: assetBoardLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onRemoveArtifact: removeUploadedAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
      const nextEdges = assetBoardToFlowEdges(result.asset_board.board, nextNodes);
      commitAssetBoardServerState(result.asset_board, nextNodes, nextEdges);
      clearAssetBoardHistory();
      setNotice(`融合 Prompt 已生成 · ${assetId} · ${shotId} · 待 Prompt QA`);
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };
  generateFusionPromptRef.current = (assetId: string, sourceAssetIds: string[], shotId: string) => { void generateFusionPrompt(assetId, sourceAssetIds, shotId); };

  const rejectAssetAndRewrite = async (assetId: string, artifactId: string, feedback: string) => {
    if (!projectId) return;
    const asset = assetLibrary?.assets.find((candidate) => candidate.id === assetId);
    setBusy(true);
    try {
      const runs = await studioApi.assetQaRuns(projectId, artifactId);
      let run = runs.qa_runs.find((candidate: Record<string, any>) => ['pending', 'running', 'blocked'].includes(String(candidate.status))) || runs.qa_runs[0];
      if (!run?.id) {
        const started = await studioApi.startAssetQa(projectId, artifactId, 'image', true);
        run = started.qa_run as Record<string, any>;
      }
      if (!run?.id || String(run.status) === 'blocked') throw new Error('该候选无法进入人工图片 QA，请检查资产映射或授权状态。');
      await studioApi.submitAssetQa(projectId, String(run.id), { decision: 'Reject and rebuild prompt', observed_issues: [feedback], affected_shots: asset?.promptRelevantShots || [], rebuild_required: true, report: { manual_review: true, review_source: 'asset-prompt-card', note: '图片审核不通过，已将具体反馈交给新的 Prompt 重写流程。', review_feedback: feedback } });
      const freshStory = await studioApi.story(projectId);
      setStory(freshStory);
      setStoryDirty(false);
      await generateAssetPrompts(assetId, { reviewFeedback: feedback, sourceQaRunId: String(run.id), storyOverride: freshStory });
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };

  const rewritePromptFromBoard = async (assetId: string, feedback: string) => {
    await generateAssetPrompts(assetId, { reviewFeedback: feedback });
  };

  const openRejectFeedback = (assetId: string, artifactId: string) => {
    const asset = assetLibrary?.assets.find((candidate) => candidate.id === assetId);
    const shotIds = [...new Set([
      ...(Array.isArray(asset?.promptRelevantShots) ? asset.promptRelevantShots : []),
      ...(asset?.dependencies || []).map((item) => item.shot_id)
    ].filter(Boolean).map((shotId) => String(shotId).toUpperCase()))].slice(0, 12);
    setRejectFeedback({ assetId, artifactId, assetName: String(asset?.name || '未命名资产'), shotIds, value: '' });
  };

  const submitRejectFeedback = () => {
    if (!rejectFeedback) return;
    const feedback = rejectFeedback.value.trim();
    if (!feedback) return;
    const { assetId, artifactId } = rejectFeedback;
    setRejectFeedback(null);
    if (artifactId) void rejectAssetAndRewrite(assetId, artifactId, feedback);
    else void rewritePromptFromBoard(assetId, feedback);
  };

  function uploadAssetFromBoard(assetId: string, file: File) {
    const asset = assetLibrary?.assets.find((candidate) => candidate.id === assetId);
    if (!asset) {
      setNotice(`未找到资产 ${assetId}，请刷新资产画布后重试。`);
      return;
    }
    void importAssetCandidate(asset, file);
  }

  function approveAssetFromBoard(_assetId: string, artifactId: string) {
    void approveAssetCandidate(artifactId);
  }

  function rejectAssetFromBoard(assetId: string, artifactId: string) {
    openRejectFeedback(assetId, artifactId);
  }

  function registerAssetFromBoard(_assetId: string, artifactId: string) {
    void registerAssetCandidate(artifactId);
  }

  function removeUploadedAssetFromBoard(assetId: string, artifactId: string) {
    const asset = assetLibrary?.assets.find((candidate) => candidate.id === assetId);
    const artifact = asset?.artifacts?.find((candidate: Record<string, any>) => String(candidate.id || candidate.artifact_id || '') === artifactId);
    if (!projectId || !asset || !artifact) {
      setNotice('当前候选图片已不存在，请刷新资产画布后重试。');
      return;
    }
    const activeVersion = asset?.versions?.find((version: Record<string, any>) => Boolean(version.is_active) && String(version.artifact_id) === artifactId);
    if (activeVersion) {
      void removeActiveAssetImage(assetId, artifactId);
      return;
    }
    if (['ready', 'superseded'].includes(String(artifact.status || ''))) {
      setNotice('已登记或当前 active 版本不能从缩略图移除，请在版本历史中处理。');
      return;
    }
    void (async () => {
      const confirmed = await requestConfirmation(
        '移除当前上传图片',
        `将从当前项目工作区撤下「${asset.name || assetId}」的这张候选图片。逻辑资产、Prompt、历史审核记录和原文件会保留，之后可以重新上传新的候选图片。`,
        '移除图片',
        true,
      );
      if (!confirmed) return;
      setBusy(true);
      try {
        const result = await studioApi.archiveAssetArtifact(projectId, artifactId);
        const library = result.library || await studioApi.assetLibrary(projectId);
        const board = result.asset_board || await studioApi.assetBoard(projectId);
        const flow = buildAssetBoardFlow(board, library, story?.story.shots || []);
        setAssetLibrary(library);
        commitAssetBoardServerState(board, flow.boardNodes, flow.boardEdges);
        clearAssetBoardHistory();
        if (result.project_revision !== undefined) {
          setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: result.project_revision as number } : item));
        }
        setNotice('当前候选图片已从工作区移除，可重新上传新的图片；原文件与历史记录已保留。');
        void refreshDashboard(false);
      } catch (error) {
        setNotice(`移除失败：${(error as Error).message}`);
      } finally {
        setBusy(false);
      }
    })();
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
    const bodyWithDraftCleared = { ...body, metadata: { ...(body.metadata as Record<string, unknown> | undefined), asset_editor_draft: null } };
    const saveBody = promptValue && hasImage && existingDraft?.active
      ? { ...bodyWithDraftCleared, metadata: { ...bodyWithDraftCleared.metadata, production_draft: { ...existingDraft, active: false, updated_at: new Date().toISOString() } } }
      : bodyWithDraftCleared;
    setBusy(true);
    studioApi.updateAssetMetadata(projectId, assetId, saveBody).then(({ revision }) => { setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision } : item)); assetEditorDraftsRef.current.delete(assetId); setAssetEditorDraftDirty(assetEditorDraftsRef.current.size > 0); setAssetPromptDraft((current) => current?.assetId === assetId ? null : current); setNotice(`资产规格已保存，项目修订版 ${revision}`); return studioApi.assetLibrary(projectId); }).then((library) => { setAssetLibrary(library); return refreshAssetBoard(false, library); }).then(() => { void refreshDashboard(false); }).catch((error: Error) => setNotice(error.message)).finally(() => setBusy(false));
  };

  const saveAssetEditorDraft = async (assetId: string, draft: AssetEditorDraft, expectedRevisionOverride?: number, allowRetry = true): Promise<boolean> => {
    const currentProject = projects.find((item) => item.document.id === projectId) || project;
    if (!projectId || !currentProject) return false;
    const expectedRevision = expectedRevisionOverride ?? currentProject.revision;
    try {
      const result = await studioApi.updateAssetMetadata(projectId, assetId, { expected_revision: expectedRevision, metadata: { asset_editor_draft: draft } });
      setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: result.revision } : item));
      if (result.library) setAssetLibrary(result.library);
      else setAssetLibrary(await studioApi.assetLibrary(projectId));
      if (result.asset_board) {
        const localBoard = assetBoardEnvelopeRef.current;
        const boardDirtyNow = dirtyStateRef.current.assetBoard;
        const nextBoard = boardDirtyNow && localBoard ? { ...result.asset_board, board: localBoard.board } : result.asset_board;
        assetBoardEnvelopeRef.current = nextBoard;
        setAssetBoardEnvelope(nextBoard);
      }
      const currentDraft = assetEditorDraftsRef.current.get(assetId);
      if (currentDraft && JSON.stringify(currentDraft) === JSON.stringify(draft)) {
        assetEditorDraftsRef.current.delete(assetId);
        setAssetEditorDraftDirty(assetEditorDraftsRef.current.size > 0);
      }
      return true;
    } catch (error) {
      if (allowRetry && error instanceof StudioApiError && error.status === 409) {
        try {
          const latestProjects = await studioApi.projects();
          setProjects(latestProjects.projects);
          const latest = latestProjects.projects.find((item) => item.document.id === projectId);
          if (latest) return await saveAssetEditorDraft(assetId, assetEditorDraftsRef.current.get(assetId) || draft, latest.revision, false);
        } catch (retryError) {
          error = retryError;
        }
      }
      if (error instanceof StudioApiError && !error.retryable && error.status !== 409) autoSaveRetryAllowedRef.current = false;
      autoSaveFailureDetailsRef.current[`资产编辑 ${assetId}`] = (error as Error).message;
      setNotice((error as Error).message);
      return false;
    }
  };

  const createAgentPlan = async (message: string, skillId = assistantSkillId): Promise<boolean> => {
    if (!project || !graphEnvelope || dirty) {
    setNotice(dirty ? '当前工作流图正在自动保存，请稍候再让 Agent 读取稳定版本。' : '尚未加载项目图。');
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

  const saveStory = async (manageBusy = true, background = false, expectedRevisionOverride?: number, allowRetry = true): Promise<StoryEnvelope | null> => {
    const current = storyRef.current || story;
    if (!current || !projectId) return null;
    const document = current.story;
    const expectedRevision = expectedRevisionOverride ?? current.revision;
    if (manageBusy) setBusy(true);
    try {
      if (!background) setNotice('正在保存故事与分镜…');
      const saved = await studioApi.saveStory(projectId, document, expectedRevision);
      const unchanged = JSON.stringify(storyRef.current?.story || {}) === JSON.stringify(document);
      const next = unchanged ? saved : { ...saved, story: storyRef.current?.story || saved.story };
      storyRef.current = next;
      setStory(next);
      setProjects((currentProjects) => currentProjects.map((item) => item.document.id === projectId ? { ...item, revision: saved.revision } : item));
      if (saved.library) setAssetLibrary(saved.library);
      if (unchanged && saved.asset_board && saved.library) {
        const flow = buildAssetBoardFlow(saved.asset_board, saved.library, saved.story.shots);
        commitAssetBoardServerState(saved.asset_board, flow.boardNodes, flow.boardEdges);
      }
      if (unchanged) setStoryDirty(false);
      if (!background) {
        setNotice(`故事与分镜已保存 · v${saved.revision}`);
        void refreshDashboard(false);
      }
      return next;
    } catch (error) {
      if (background && allowRetry && error instanceof StudioApiError && error.status === 409) {
        try {
          const latest = await studioApi.story(projectId);
          const local = storyRef.current || current;
          const merged = { ...latest, story: local.story };
          storyRef.current = merged;
          setStory(merged);
          return await saveStory(false, true, latest.revision, false);
        } catch (retryError) {
          error = retryError;
        }
      }
      if (background && error instanceof StudioApiError && !error.retryable && error.status !== 409) autoSaveRetryAllowedRef.current = false;
      if (background) autoSaveFailureDetailsRef.current['故事与分镜'] = (error as Error).message;
      setNotice((error as Error).message);
      return null;
    } finally { if (manageBusy) setBusy(false); }
  };

  const generateStoryCandidate = async (mode: 'optimize' | 'direct' = 'optimize') => {
    if (!story || !projectId) return;
    setBusy(true);
    try {
      const currentStory = storyDirty ? await saveStory(false) : story;
      if (!currentStory) return;
      const currentSpec = currentStory.story.spec;
      const generatorProfile = currentSpec.generator_profile || project?.document.generator || 'seedance2.5';
      const created = await studioApi.createStoryRun(projectId, { goal: mode === 'direct' ? 'script_storyboard' : 'full', workflow_mode: mode === 'direct' ? 'storyboard_from_source' : 'optimize_script_and_storyboard', strength: 'balanced', duration: currentSpec.duration, ratio: currentSpec.ratio, generator: generatorProfile, generator_profile: generatorProfile, shot_count_min: currentSpec.shot_count_min, shot_count_target: currentSpec.shot_count_target, shot_count_max: currentSpec.shot_count_max, audience: currentSpec.audience, platform: currentSpec.platform, language: currentSpec.language, brand_requirements: currentSpec.brand_requirements, must_preserve: currentSpec.must_preserve, must_avoid: currentSpec.must_avoid });
      const started = await studioApi.startStoryRun(created.id);
      setStoryRun(started.run);
      setNotice(mode === 'direct' ? '原文直转分镜候选已生成，等待审阅' : '拍摄剧本与分镜候选已生成，等待逐层接受');
      void refreshDashboard(false);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  };

  const acceptStoryLayer = async (scope: 'all' | 'script_only' | 'shots_only' = 'all', shotIds: string[] = []) => {
    if (!storyRun) return;
    setBusy(true);
    try {
      const directMode = String(storyRun.input?.workflow_mode || storyRun.storyboard_output?.workflowMode || '') === 'storyboard_from_source';
      const effectiveScope = directMode && scope === 'all' ? 'shots_only' : scope;
      const result = storyRun.status === 'storyboard_review_required' ? await studioApi.acceptStoryboard(storyRun.id, effectiveScope, shotIds) : await studioApi.acceptRegulator(storyRun.id);
      setStoryRun(result.run);
      const refreshed = await studioApi.story(projectId);
      setStory(refreshed);
      setProjects((current) => current.map((item) => item.document.id === projectId ? { ...item, revision: refreshed.revision } : item));
      const library = await studioApi.assetLibrary(projectId);
      setAssetLibrary(library);
      await refreshAssetBoard(true, library);
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
      if (restored.library) setAssetLibrary(restored.library);
      if (restored.asset_board && restored.library) {
        const flow = buildAssetBoardFlow(restored.asset_board, restored.library, restored.story.shots);
        commitAssetBoardServerState(restored.asset_board, flow.boardNodes, flow.boardEdges);
      } else {
        const library = restored.library || await studioApi.assetLibrary(projectId);
        setAssetLibrary(library);
        await refreshAssetBoard(true, library);
      }
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
    markGraphDirty();
    rememberEdit(before);
  }, [markGraphDirty, rememberEdit]);

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
      markGraphDirty();
    }
  }, [edges, markGraphDirty, nodes, rememberEdit]);

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
    markGraphDirty();
    setHistoryRevision((value) => value + 1);
    setNotice('已撤销上一步编辑');
  }, [edges, markGraphDirty, nodes]);

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
    markGraphDirty();
    setHistoryRevision((value) => value + 1);
    setNotice('已重做上一步编辑');
  }, [edges, markGraphDirty, nodes]);

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
          markGraphDirty();
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
          markGraphDirty();
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
  }, [duplicateSelectedNodes, markGraphDirty, mode, nodes, redo, undo]);

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
        markAssetBoardDirty();
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
        markAssetBoardDirty();
        setNotice(`已剪切 ${selected.length} 个节点`);
      } else {
        setNotice(`已复制 ${selected.length} 个节点，可使用 Ctrl+V 粘贴`);
      }
    };
    window.addEventListener('keydown', onAssetShortcut);
    return () => window.removeEventListener('keydown', onAssetShortcut);
  }, [assetBoardEdges, assetBoardNodes, markAssetBoardDirty, mode, recordAssetBoardState, setAssetBoardSelection]);

  const save = async (background = false, expectedRevisionOverride?: number, allowRetry = true): Promise<GraphEnvelope | null> => {
    const current = graphEnvelopeRef.current || graphEnvelope;
    if (!current || !projectId) return null;
    const graph = fromFlow(current.graph, nodesRef.current, edgesRef.current);
    const expectedRevision = expectedRevisionOverride ?? current.revision;
    if (!background) setBusy(true);
    try {
      const saved = await studioApi.saveGraph(projectId, graph, expectedRevision);
      const unchanged = JSON.stringify(fromFlow(graphEnvelopeRef.current?.graph || saved.graph, nodesRef.current, edgesRef.current)) === JSON.stringify(graph);
      graphEnvelopeRef.current = saved;
      setGraphEnvelope(saved);
      if (unchanged) setDirty(false);
      if (!background) {
        setNotice(`工作流图已保存 · v${saved.revision}`);
        void refreshDashboard(false);
      }
      return saved;
    } catch (error) {
      if (background && allowRetry && error instanceof StudioApiError && error.status === 409) {
        try {
          const latest = await studioApi.graph(projectId);
          graphEnvelopeRef.current = latest;
          setGraphEnvelope(latest);
          return await save(true, latest.revision, false);
        } catch (retryError) {
          error = retryError;
        }
      }
      if (background && error instanceof StudioApiError && !error.retryable && error.status !== 409) autoSaveRetryAllowedRef.current = false;
      if (background) autoSaveFailureDetailsRef.current['流程图'] = (error as Error).message;
      setNotice((error as Error).message);
      return null;
    } finally { if (!background) setBusy(false); }
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
    const nextNodes = assetBoardToFlowNodes(board, assetLibrary?.assets || [], assetBoardFilter, assetBoardShowShots, story?.story.shots || [], { forceGrid: true, preset, columnWidth: nextColumnWidth, columnWidths: nextColumnWidths, gap: nextGap, layoutMode: nextLayoutMode, collapsedScopes: assetBoardCollapsedScopes, onToggleScope: toggleAssetBoardScope, onContextMenu: openAssetContextMenu, onApprovePrompt: approveAssetPromptCard, onGenerateImage: generateAssetImageCard, onCopyPrompt: copyAssetPromptCard, onUploadAsset: uploadAssetFromBoard, onApproveAsset: approveAssetFromBoard, onRejectAsset: rejectAssetFromBoard, onRegisterAsset: registerAssetFromBoard, onRemoveArtifact: removeUploadedAssetFromBoard, onOpenAssetProduction: openAssetProductionShortcut });
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
    markAssetBoardDirty();
    setNotice(`${nextLayoutMode === 'adaptive' ? '自适应资产流' : '资产类型矩阵'} · 列宽 ${nextColumnWidth}px · 间距 ${nextGap}px`);
  }, [assetBoardCollapsedScopes, assetBoardColumnWidth, assetBoardColumnWidths, assetBoardEdges, assetBoardEnvelope, assetBoardFilter, assetBoardGap, assetBoardLayoutMode, assetBoardLayoutPreset, assetBoardNodes, assetBoardShowShots, assetLibrary?.assets, markAssetBoardDirty, recordAssetBoardState, story?.story.shots, toggleAssetBoardScope]);

  const autoLayoutAssetBoard = useCallback(() => applyAssetGridLayout(assetBoardLayoutPreset), [applyAssetGridLayout, assetBoardLayoutPreset]);

  const resetAssetBoardColumns = useCallback(() => {
    if (!assetBoardEnvelope) return;
    const widths = defaultAssetBoardColumnWidths;
    setAssetBoardColumnWidths(widths);
    setAssetBoardColumnWidth(310);
    setAssetBoardEnvelope((current) => current ? { ...current, board: { ...current.board, metadata: { ...current.board.metadata, layout_column_widths: widths, layout_column_width: 310 } } } : current);
    setAssetBoardNodes((current) => applyFixedAssetBoardFrame(current, widths).map((node) => node.data.presentationOnly || assetBoardCardIsLocked(node.data) ? node : { ...node, data: { ...node.data, config: { ...node.data.config, position_source: 'manual' } } }));
    markAssetBoardDirty();
    setAssetBoardToolbarOpen(null);
    setNotice('已恢复默认列宽；将自动保存画布');
  }, [applyFixedAssetBoardFrame, assetBoardEnvelope, markAssetBoardDirty]);

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

  const saveAudioStudio = async (document: AudioStudioDocument, background = false, expectedRevisionOverride?: number, allowRetry = true): Promise<AudioStudioEnvelope | null> => {
    const current = audioStudioRef.current || audioStudio;
    if (!projectId || !current) return null;
    if (!background) audioDraftRef.current = document;
    const expectedRevision = expectedRevisionOverride ?? audioRevisionRef.current ?? current.revision;
    if (!background) setBusy(true);
    try {
      const saved = await studioApi.saveAudioStudio(projectId, document, expectedRevision);
      audioRevisionRef.current = saved.revision;
      const unchanged = JSON.stringify(audioDraftRef.current || {}) === JSON.stringify(document);
      if (unchanged) {
        audioStudioRef.current = saved;
        setAudioStudio(saved);
        setAudioDirty(false);
      }
      setProjects((currentProjects) => currentProjects.map((item) => item.document.id === projectId ? { ...item, revision: saved.revision, document: { ...item.document, audio: saved.document } } : item));
      if (!background) {
        setNotice(`声音工作区已保存 · v${saved.revision}`);
        void refreshDashboard(false);
      }
      return saved;
    } catch (error) {
      if (background && allowRetry && error instanceof StudioApiError && error.status === 409) {
        try {
          const latest = await studioApi.audioStudio(projectId);
          audioRevisionRef.current = latest.revision;
          return await saveAudioStudio(audioDraftRef.current || document, true, latest.revision, false);
        } catch (retryError) {
          error = retryError;
        }
      }
      if (background && error instanceof StudioApiError && !error.retryable && error.status !== 409) autoSaveRetryAllowedRef.current = false;
      if (background) autoSaveFailureDetailsRef.current['声音工作区'] = (error as Error).message;
      setNotice((error as Error).message);
      return null;
    } finally { if (!background) setBusy(false); }
  };

  const runAutoSave = () => {
    const targetProjectId = projectId;
    const queued = autoSaveQueueRef.current.then(async () => {
      if (!targetProjectId || targetProjectId !== projectIdRef.current || busy || agentBusy) return;
      autoSaveInFlightRef.current = true;
      autoSaveFailureDetailsRef.current = {};
      autoSaveRetryAllowedRef.current = true;
      setAutoSaveState('saving');
      setAutoSaveError('');
      setAutoSaveErrorOpen(false);
      const failures: string[] = [];
      let savedCount = 0;
      const saveOne = async (label: string, action: () => Promise<unknown | null>) => {
        const result = await action();
        if (result) savedCount += 1;
        else failures.push(label);
      };
      try {
        const pending = dirtyStateRef.current;
        const boardMutationEpoch = assetBoardMutationEpochRef.current;
        // Asset-board edits are saved before story edits because saving a story
        // also rebuilds the board projection from the latest storyboard.
        if (pending.graph) await saveOne('流程图', () => save(true));
        if (pending.assetBoard && assetBoardDirtyRef.current && boardMutationEpoch === assetBoardMutationEpochRef.current) {
          await saveOne('资产画布', () => saveAssetBoard(true, undefined, true, boardMutationEpoch));
        }
        for (const [assetId, draft] of assetEditorDraftsRef.current.entries()) await saveOne(`资产编辑 ${assetId}`, () => saveAssetEditorDraft(assetId, draft));
        if (pending.story) await saveOne('故事与分镜', () => saveStory(false, true));
        const audioDocument = audioDraftRef.current || audioStudioRef.current?.document;
        if (pending.audio && audioDocument) await saveOne('声音工作区', () => saveAudioStudio(audioDocument, true));
        if (pending.audio && !audioDocument) {
          autoSaveRetryAllowedRef.current = false;
          autoSaveFailureDetailsRef.current['声音工作区'] = '当前声音草稿尚未同步到自动保存队列';
          failures.push('声音工作区');
        }
        if (pending.timeline) await saveOne('时间线', () => saveTimeline(true));
      } finally {
        autoSaveInFlightRef.current = false;
      }
      if (failures.length) {
        const labels = [...new Set(failures)].map((label) => autoSaveFailureDetailsRef.current[label] ? `${label}（${autoSaveFailureDetailsRef.current[label]}）` : label);
        const message = `自动保存失败：${labels.join('、')}。系统将在稍后重试。`;
        setAutoSaveState('error');
        setAutoSaveError(message);
        setAutoSaveErrorOpen(true);
        if (autoSaveRetryAllowedRef.current) {
          if (autoSaveRetryTimerRef.current !== null) window.clearTimeout(autoSaveRetryTimerRef.current);
          autoSaveRetryTimerRef.current = window.setTimeout(() => {
            autoSaveRetryTimerRef.current = null;
            setAutoSaveChangeVersion((value) => value + 1);
          }, AUTO_SAVE_RETRY_DELAY_MS);
        }
      } else if (savedCount > 0 || !Object.values(dirtyStateRef.current).some(Boolean) && assetEditorDraftsRef.current.size === 0) {
        setAutoSaveState('saved');
        setAutoSaveError('');
        setAutoSaveErrorOpen(false);
      }
    });
    autoSaveQueueRef.current = queued.catch((error: unknown) => {
      autoSaveInFlightRef.current = false;
      const message = error instanceof Error ? error.message : '未知错误';
      setAutoSaveState('error');
      setAutoSaveError(`自动保存失败：${message}。系统将在稍后重试。`);
      setAutoSaveErrorOpen(true);
      if (autoSaveRetryAllowedRef.current) {
        if (autoSaveRetryTimerRef.current !== null) window.clearTimeout(autoSaveRetryTimerRef.current);
        autoSaveRetryTimerRef.current = window.setTimeout(() => {
          autoSaveRetryTimerRef.current = null;
          setAutoSaveChangeVersion((value) => value + 1);
        }, AUTO_SAVE_RETRY_DELAY_MS);
      }
    });
    return queued;
  };

  const hasPendingAutoSave = dirty || storyDirty || assetBoardDirty || assetEditorDraftDirty || audioDirty || timelineDirty;
  useEffect(() => {
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    if (!projectId || !hasPendingAutoSave || busy || agentBusy) return undefined;
    setAutoSaveState('scheduled');
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      void runAutoSave();
    }, AUTO_SAVE_DELAY_MS);
    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
    // runAutoSave reads the latest editor snapshots through refs. The change
    // version is the explicit debounce trigger for edits that keep dirty=true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentBusy, autoSaveChangeVersion, busy, hasPendingAutoSave, projectId]);

  useEffect(() => () => {
    if (autoSaveTimerRef.current !== null) window.clearTimeout(autoSaveTimerRef.current);
    if (autoSaveRetryTimerRef.current !== null) window.clearTimeout(autoSaveRetryTimerRef.current);
    if (assetBoardLocatorTimerRef.current !== null) window.clearTimeout(assetBoardLocatorTimerRef.current);
  }, []);

  const refreshAudioStudio = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const [audioEnvelope, library] = await Promise.all([studioApi.audioStudio(projectId), studioApi.assetLibrary(projectId)]);
      audioStudioRef.current = audioEnvelope;
      audioDraftRef.current = audioEnvelope.document;
      audioRevisionRef.current = audioEnvelope.revision;
      setAudioStudio(audioEnvelope);
      setAssetLibrary(library);
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
      setAudioStudio((current) => {
        const next = current ? { ...current, revision: result.revision, assets: result.library.assets.filter((asset) => ['audio', 'music', 'sfx'].includes(String(asset.assetClass))) } : current;
        audioStudioRef.current = next;
        audioRevisionRef.current = result.revision;
        return next;
      });
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
    if (mode === 'audio') return audioStudio ? saveAudioStudio(audioDraftRef.current || audioStudio.document) : null;
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
    { id: 'audio', label: '打开声音资产工坊', description: '制作人物声音、对白、音乐 Cue、音效和声轨交接', shortcut: 'Alt 5', onSelect: () => setMode('audio') },
    { id: 'settings', label: '打开设置与 Provider', description: '管理模型接入、凭据和能力路由', shortcut: 'Alt 6', onSelect: () => setMode('settings') },
    { id: 'save', label: '保存当前页面', description: currentPageDirty ? '写入当前页面的未保存修改' : '当前页面没有待保存的修改', shortcut: 'Ctrl / ⌘ S', disabled: busy, onSelect: () => { void saveCurrentPage(); } },
    { id: 'assistant', label: '打开 AI 创作助手', description: '读取当前项目并生成可审阅的结构化修改', shortcut: 'Ctrl / ⌘ Shift A', onSelect: () => setAssistantOpen(true) },
    { id: 'project', label: '打开项目管理', description: '切换、排序或新建项目', onSelect: openProjectManager },
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
        if (autoSaveErrorOpen) { event.preventDefault(); setAutoSaveErrorOpen(false); return; }
        if (rejectFeedback) { event.preventDefault(); setRejectFeedback(null); return; }
        if (confirmation) { event.preventDefault(); closeConfirmation(false); return; }
        if (paidConfirmation) { event.preventDefault(); setPaidConfirmation(null); return; }
        if (commandPaletteOpen) { event.preventDefault(); setCommandPaletteOpen(false); return; }
        if (shortcutHelpOpen) { event.preventDefault(); setShortcutHelpOpen(false); return; }
        if (assistantOpen) { event.preventDefault(); setAssistantOpen(false); return; }
        if (projectManagerOpen) { event.preventDefault(); setProjectManagerOpen(false); return; }
        if (assetCreateOpen) { event.preventDefault(); setAssetCreateOpen(false); return; }
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
          markAssetBoardDirty();
          setNotice(`已移除 ${removableCandidates.length} 个候选版本卡；将自动保存`);
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
      if (!primary && event.altKey && /^[1-6]$/.test(event.key)) {
        event.preventDefault();
        const modes: Record<string, StudioMode> = { '1': 'home', '2': 'story', '3': 'canvas', '4': 'timeline', '5': 'audio', '6': 'settings' };
        const nextMode = modes[event.key];
        if (nextMode) setMode(nextMode);
        return;
      }
      if (!primary && (event.key === '?' || event.key === '/')) {
        event.preventDefault();
        setShortcutHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onGlobalShortcut);
    return () => window.removeEventListener('keydown', onGlobalShortcut);
  }, [assetBoardEdges, assetBoardIndexOpen, assetBoardNodes, assetBoardToolbarOpen, assetContextMenu, assetCreateOpen, assistantOpen, autoSaveErrorOpen, busy, closeConfirmation, commandPaletteOpen, confirmation, deleteAssetById, markAssetBoardDirty, mode, paidConfirmation, projectManagerOpen, recordAssetBoardState, redoAssetBoard, rejectFeedback, saveCurrentPage, setAssetBoardSelection, shortcutHelpOpen, undoAssetBoard]);

  const autoSaveStatusText = autoSaveState === 'scheduled'
    ? '修改将自动保存…'
    : autoSaveState === 'saving'
      ? '自动保存中…'
      : autoSaveState === 'error'
        ? autoSaveError
        : autoSaveState === 'saved'
          ? '已自动保存'
          : currentPageDirty
            ? `等待自动保存 · ${notice}`
            : projectId
              ? `自动保存已开启 · ${notice}`
              : notice;

  return (
    <div className="studio-shell">
      <aside className="studio-sidebar" aria-label="Primary navigation">
        <div className="brand"><b>F</b><div><strong>FRAMEFLOW</strong><span>AI VIDEO OS · V3</span></div></div>
        <button className="create-button" onClick={() => { if (mode === 'canvas') openAssetCreate(); else void openAssetBoard(); }} disabled={busy || !project}>{mode === 'canvas' ? '＋ 新增资产' : '进入资产生产'}</button>
        <nav aria-label="Primary workspace navigation">
          <p>工作空间</p>
          <button className={mode === 'home' ? 'active' : ''} aria-current={mode === 'home' ? 'page' : undefined} onClick={() => setMode('home')}>⌂ 首页 / 项目总览</button>
          <button className={mode === 'story' ? 'active' : ''} aria-current={mode === 'story' ? 'page' : undefined} onClick={() => setMode('story')}>▥ 故事与分镜</button>
          <button className={mode === 'canvas' ? 'active' : ''} aria-current={mode === 'canvas' ? 'page' : undefined} onClick={() => setMode('canvas')}>◇ 资产生产工作区 <i aria-hidden="true">{assetLibrary?.summary.total || 0}</i></button>
          <button className={mode === 'audio' ? 'active' : ''} aria-current={mode === 'audio' ? 'page' : undefined} onClick={() => setMode('audio')}>♫ 声音资产工坊 <i aria-hidden="true">{audioStudio?.document.dialogues.length || 0}</i></button>
          <button className={mode === 'timeline' ? 'active' : ''} aria-current={mode === 'timeline' ? 'page' : undefined} onClick={() => setMode('timeline')}>≋ 后期时间线</button>
          <p>系统</p>
          <button className={mode === 'settings' ? 'active' : ''} aria-current={mode === 'settings' ? 'page' : undefined} onClick={() => setMode('settings')}>⚙ 设置与 Provider</button>
        </nav>
        <div className="sidebar-footer"><span>V3 ONLY · 本地优先运行时</span><span>/api/v2 · revision protected</span></div>
      </aside>
      <main className="studio-main">
        <h1 className="a11y-page-title">{({ home: '项目总览', story: '故事与分镜', canvas: '资产生产工作区', timeline: '后期时间线', audio: '声音资产工坊', settings: '设置与 Provider' } as Record<StudioMode, string>)[mode]}</h1>
        <header className="studio-topbar">
          <div className="topbar-project">
            <strong className="project-title" title={project?.document.name || '尚未选择项目'}>{project?.document.name || '尚未选择项目'}</strong>
            <button type="button" className="project-manager-trigger" onClick={openProjectManager} disabled={busy}>项目管理</button>
            {mode !== 'home' && <div className="save-state-wrap">
              {autoSaveState === 'error' ? <>
                <button type="button" className="save-state auto-save-error save-state-error-button" onClick={() => setAutoSaveErrorOpen((value) => !value)} aria-expanded={autoSaveErrorOpen} aria-controls="auto-save-error-details" title="点击查看自动保存失败的完整原因"><span>自动保存失败</span><small>{autoSaveErrorOpen ? '收起详情' : '查看详情'}</small></button>
                {autoSaveErrorOpen && <div id="auto-save-error-details" className="save-error-popover" role="alert">
                  <div className="save-error-popover-head"><strong>自动保存失败</strong><button type="button" onClick={() => setAutoSaveErrorOpen(false)} aria-label="关闭错误详情">×</button></div>
                  <p>{autoSaveError || '系统未返回具体错误描述，请稍后重试。'}</p>
                </div>}
              </> : <span className={`save-state ${currentPageDirty ? 'dirty ' : ''}auto-save-${autoSaveState}`} role="status" aria-live="polite" title={autoSaveStatusText}>{autoSaveStatusText}</span>}
            </div>}
          </div>
          <div className="top-actions"><button type="button" className={`assistant-launcher ${agentPlan?.status === 'awaiting_review' ? 'has-plan' : ''}`} onClick={() => setAssistantOpen(true)} title="打开 FRAMEFLOW AI 创作助手（Ctrl / ⌘ + Shift + A）"><span>✦</span> AI 助手{agentPlan?.status === 'awaiting_review' && <i>待审阅</i>}</button><button type="button" className="shortcut-launcher" onClick={() => setShortcutHelpOpen(true)} title="查看工作台快捷键（?）"><span>⌨</span> 快捷键 <kbd>?</kbd></button>{mode !== 'home' && <><button type="button" onClick={saveCurrentPage} disabled={!currentPageDirty || busy} title="保存当前页面的修改（Ctrl / ⌘ + S）">保存</button>{mode !== 'canvas' && <button type="button" className="run-button" onClick={startRun} disabled={busy || !graphEnvelope} title="运行专业流程图；故事页的 AI 分镜候选请使用“AI 整合并优化为拍摄剧本”">✦ {selectedNodeIds.length ? `运行所选 ${selectedNodeIds.length} 项` : '启动工作流'}</button>}</>}</div>
        </header>
        <div className="studio-content">
          {busy && <div className="progress-bar" />}
          {mode === 'story' && <StoryWorkbench story={story} storyRun={storyRun} dirty={storyDirty} busy={busy} notice={notice} assetPromptRun={assetPromptRun} onChange={(next) => { setStory((current) => current ? { ...current, story: next } : current); markStoryDirty(); }} onSave={saveStory} onGenerateOptimized={() => { void generateStoryCandidate('optimize'); }} onGenerateStoryboard={() => { void generateStoryCandidate('direct'); }} onAccept={acceptStoryLayer} onRollback={rollbackStory} onOpenAssetBoard={openAssetBoard} onGenerateAssetPrompts={generateAssetPrompts} />}
          {mode === 'home' && <HomeView dashboard={dashboard} error={dashboardError} currentProjectId={projectId} busy={busy} onSelectProject={(id) => { setProjectId(id); setMode('home'); }} onOpenTask={openDashboardTask} onOpenStage={openDashboardStage} onRefresh={() => { void refreshDashboard(); }} />}
          {mode === 'audio' && <AudioStudioView projectId={projectId} projectName={project?.document.name || '当前项目'} envelope={audioStudio} assetLibrary={assetLibrary} settings={settings} story={story} busy={busy} onSave={saveAudioStudio} onRefresh={refreshAudioStudio} onRefreshMinimaxCatalog={refreshMinimaxCatalog} onCreateAsset={createAudioAsset} onNotice={setNotice} onDirtyChange={(isDirty) => { if (!isDirty) setAudioDirty(false); }} onDocumentChange={handleAudioDocumentChange} onOpenStory={() => setMode('story')} />}
          {mode === 'timeline' && <TimelineView envelope={timelineEnvelope} preflight={timelinePreflight} story={story} assetLibrary={assetLibrary} renderJob={renderJob} busy={busy} onChange={(document) => { setTimelineEnvelope((current) => current ? { ...current, document } : current); markTimelineDirty(); }} onSave={saveTimeline} onAssemble={assembleTimeline} onPreview={previewTimeline} onRender={renderTimeline} />}
          {mode === 'settings' && <SettingsView settings={settings} busy={busy} onRefresh={refreshSettings} onSaveProvider={saveSettingsProvider} onAddPreset={addSettingsPreset} onDeleteProvider={deleteSettingsProvider} onWriteCredential={writeSettingsCredential} onImportCredential={importSettingsCredential} onClearCredential={clearSettingsCredential} onProbe={probeSettingsProvider} />}
          {mode === 'canvas' && (
            <section className="canvas-wrap asset-board-wrap" onMouseDownCapture={handleAssetBoardControlSelection}>
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
                    onMoveEnd={(viewport) => { setAssetBoardEnvelope((current) => current ? { ...current, board: { ...current.board, viewport } } : current); markAssetBoardDirty(); }}
                    defaultViewport={assetBoardEnvelope?.board.viewport as Viewport | undefined}
                  />
                </Suspense>
            </section>
          )}
        </div>
      </main>
      <aside className="context-panel" aria-label="Project context" tabIndex={0}>
        <header><span>PROJECT CONTEXT</span><h2>{project?.document.name || '尚未选择项目'}</h2><p>{project?.document.brief || '项目上下文、运行和审批状态会显示在这里。'}</p></header>
          {mode === 'canvas' && <AssetGenerationOrder items={assetGenerationOrder} selectedAssetId={selectedProductionAsset?.id} onFocusAsset={focusAssetGenerationTarget} />}
          {mode === 'canvas' ? selectedAssetBoardCards.length > 1 ? <section className="asset-selection-multi-state"><span>ASSET BOARD SELECTION</span><h3>已选中多个卡片</h3><p>当前选中了 {selectedAssetBoardCards.length} 张卡片。请单独选择一张卡片查看对应的资产、Prompt 或候选版本。</p></section> : <AssetProductionPanel asset={selectedProductionAsset} selectedCardType={selectedAssetBoardNode?.data.node_type === 'asset' || selectedAssetBoardNode?.data.node_type === 'handoff' || selectedAssetBoardNode?.data.node_type === 'artifact' ? selectedAssetBoardNode.data.node_type : undefined} story={story} fusionSources={selectedFusionSources} busy={busy} projectRevision={project?.revision} assetBoardDirty={assetBoardDirty} promptDraft={assetPromptDraft && assetPromptDraft.assetId === selectedProductionAsset?.id ? assetPromptDraft.prompt : undefined} promptPackDraft={assetPromptDraft && assetPromptDraft.assetId === selectedProductionAsset?.id ? assetPromptDraft.promptPack : undefined} promptQualityDraft={assetPromptDraft && assetPromptDraft.assetId === selectedProductionAsset?.id ? assetPromptDraft.promptQuality : undefined} onSave={saveAssetMetadata} onHandoff={handoffAssetToChatGPT} onImport={importAssetCandidate} onStartQa={startAssetQa} onApprove={approveAssetCandidate} onRegister={registerAssetCandidate} onApprovePromptCard={approveAssetPromptCard} onGenerateImageCard={generateAssetImageCard} onGeneratePrompt={generateAssetPrompts} onGenerateFusionPrompt={generateFusionPrompt} onManualProductionApproval={manualProductionApproval} onDraftChange={handleAssetEditorDraftChange} /> : <>
        {selectedNode && <section className="node-inspector"><h3>{selectedNode.data.kind === 'group' ? '分组 Inspector' : '节点 Inspector'}</h3><label>节点名称<input value={selectedNode.data.label} onChange={(event) => updateSelectedNode({ label: event.target.value })} /></label>{selectedNode.data.kind !== 'group' && <><label className="check-row"><input type="checkbox" checked={Boolean(selectedNode.data.config.paid)} onChange={(event) => updateSelectedNode({}, { paid: event.target.checked })} />付费节点</label><label>预计费用<input type="number" min="0" step="0.01" value={String(selectedNode.data.config.estimated_cost ?? '')} onChange={(event) => updateSelectedNode({}, { estimated_cost: event.target.value === '' ? 0 : Number(event.target.value) })} /></label></>}{selectedNode.data.kind === 'group' && <label className="check-row"><input type="checkbox" checked={Boolean(selectedNode.data.config.collapsed)} onChange={(event) => updateSelectedNode({}, { collapsed: event.target.checked })} />折叠组内容</label>}<label className="check-row"><input type="checkbox" checked={selectedNode.data.locked} onChange={(event) => updateSelectedNode({ locked: event.target.checked })} />锁定节点位置</label><small className="inspector-hint">修改会进入图编辑历史，保存时受 revision 冲突保护。</small></section>}
        <section><h3>制作规格</h3><dl><div><dt>画幅</dt><dd>{project?.document.ratio || '—'}</dd></div><div><dt>时长</dt><dd>{project?.document.duration || 0}s</dd></div><div><dt>图版本</dt><dd>v{graphEnvelope?.revision || 0}</dd></div><div><dt>时间线</dt><dd>v{timelineEnvelope?.revision || 0}{timelineDirty ? ' · 未保存' : ''}</dd></div></dl></section>
        {renderJob && <section><h3>交付作业</h3><div className="run-card"><b>{renderJob.status}</b><code>{renderJob.id}</code>{renderJob.result?.delivery && <small>MP4、字幕、项目 JSON、资产清单和 manifest 已生成</small>}{renderJob.error && <small>{String(renderJob.error.message || '渲染失败')}</small>}</div></section>}
        <section><h3>监督式运行</h3>{run ? <div className="run-card"><b>{runStatusLabel(run.status)}</b><code>{run.id}</code><span>{run.estimate.node_count} 节点 · {run.estimate.paid_node_count} 付费</span>{'nodes' in run && <small>{(run as WorkflowRunDetail).nodes.filter((node) => ['succeeded', 'cached'].includes(node.status)).length}/{(run as WorkflowRunDetail).nodes.length} 个节点完成</small>}<div className="run-actions">{['queued', 'running'].includes(run.status) && <button onClick={() => controlRun('pause')} disabled={busy}>暂停</button>}{['paused', 'failed'].includes(run.status) && <button onClick={() => controlRun('resume')} disabled={busy}>恢复</button>}{!['succeeded', 'failed', 'canceled'].includes(run.status) && <button onClick={() => controlRun('cancel')} disabled={busy}>取消</button>}</div></div> : <p className="muted">尚未启动 V3 工作流。可选择节点进行局部运行。</p>}</section>
         <section className="assistant-context-launcher"><div className="assistant-context-launcher-head"><div><span>FRAMEFLOW AI</span><h3>创作助手</h3></div><b>{agentPlan?.status === 'awaiting_review' ? '待审阅' : '在线'}</b></div><p>读取全流程、当前项目和 Video Skill，生成可审阅的结构化修改。</p><button onClick={() => setAssistantOpen(true)}>打开 AI 助手 <span>✦</span></button></section>
        <section><h3>安全门</h3><ul><li>付费生成必须确认</li><li>批准资产不可覆盖</li><li>运行保存不可变快照</li><li>失败只重跑受影响节点</li></ul></section>
        </>}
      </aside>
      {assistantWorkspaceV2Enabled ? <AssistantWorkspace open={assistantOpen} project={project} mode={mode} graph={graphEnvelope} story={story} assetBoard={assetBoardEnvelope} assetLibrary={assetLibrary} audioStudio={audioStudio} timeline={timelineEnvelope} settings={settings} selectedNodeIds={selectedNodeIds} selectedEdgeIds={selectedEdgeIds} selectedAssetId={selectedProductionAsset?.id} dirty={dirty} storyDirty={storyDirty} assetBoardDirty={assetBoardDirty} audioDirty={audioDirty} timelineDirty={timelineDirty} skills={workflowManifests} selectedSkillId={assistantSkillId} onSkillChange={setAssistantSkillId} onClose={() => setAssistantOpen(false)} onNavigate={setMode} onApplied={() => { setProjectReloadVersion((value) => value + 1); setAgentPlan(null); setNotice('Agent 修改已写入工作台，正在刷新所有工作区…'); }} onNotice={setNotice} /> : <AssistantDrawer open={assistantOpen} project={project} mode={mode} graph={graphEnvelope} story={story} assetLibrary={assetLibrary} audioStudio={audioStudio} timeline={timelineEnvelope} selectedNodeIds={selectedNodeIds} selectedEdgeIds={selectedEdgeIds} dirty={dirty} storyDirty={storyDirty} assetBoardDirty={assetBoardDirty} audioDirty={audioDirty} timelineDirty={timelineDirty} plan={agentPlan} busy={agentBusy} skills={workflowManifests} selectedSkillId={assistantSkillId} onSkillChange={setAssistantSkillId} onCreate={createAgentPlan} onApply={() => { void applyAgentPlan(); }} onReject={() => { void rejectAgentPlan(); }} onClose={() => setAssistantOpen(false)} onNavigate={setMode} />}
      <CommandPalette open={commandPaletteOpen} query={commandQuery} actions={commandActions} onQueryChange={setCommandQuery} onClose={closeCommandPalette} />
      <ShortcutHelp open={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} />
      {assetCreateOpen && <AssetCreateModal draft={assetCreateDraft} shots={story?.story.shots || []} busy={busy} onChange={(patch) => setAssetCreateDraft((current) => ({ ...current, ...patch }))} onClose={() => setAssetCreateOpen(false)} onSubmit={() => { void addAssetToBoard(); }} />}
      {rejectFeedback && <AssetRejectFeedbackModal draft={rejectFeedback} busy={busy} onChange={(value) => setRejectFeedback((current) => current ? { ...current, value } : current)} onClose={() => setRejectFeedback(null)} onSubmit={submitRejectFeedback} />}
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
