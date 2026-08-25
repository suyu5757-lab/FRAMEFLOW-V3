import { useMemo, useState } from 'react';

const ROW_HEIGHT = 104;
const OVERSCAN = 8;

export function virtualWindow(total: number, scrollTop: number, viewportHeight = 720) {
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const count = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  return { start, end: Math.min(total, start + count) };
}

export function VirtualAssetList({ assets, selectedId, auditAssetIds, onSelect }: {
  assets: Array<Record<string, any>>;
  selectedId?: string;
  auditAssetIds: Set<string>;
  onSelect: (id: string) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const range = useMemo(() => virtualWindow(assets.length, scrollTop), [assets.length, scrollTop]);
  const rows = assets.slice(range.start, range.end);
  const statusOf = (asset: Record<string, any>) => {
    const readiness = asset.readiness || {};
    if (readiness.production_ready) return 'production';
    if (readiness.registered_ready) return 'registered';
    if (readiness.status === 'blocked') return 'blocked';
    if (auditAssetIds.has(String(asset.id))) return 'audit';
    if (Number(asset.artifact_count || asset.artifacts?.length || 0) > 0) return 'candidate';
    return 'missing';
  };
  return <aside className="asset-list" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
    <div style={{ height: range.start * ROW_HEIGHT }} />
    {rows.map((asset) => {
      const status = statusOf(asset);
      const action = String(asset.workflow?.next_action?.label || asset.next_action || '上传候选文件');
      return <button key={asset.id} data-asset-list-id={asset.id} className={asset.id === selectedId ? 'asset-list-item active' : 'asset-list-item'} onClick={() => onSelect(String(asset.id))}>
        <b>{asset.id}</b><span>{asset.name || asset.id}</span>
        <div className="asset-list-status"><i className={status}>{status === 'production' ? '可入镜' : status === 'registered' ? '已登记' : status === 'blocked' ? '阻塞' : status === 'candidate' ? '候选' : status === 'audit' ? '审计' : '待制作'}</i><small>{action}</small></div>
        <small>{asset.assetClass} · {asset.grade || 'B'} · 候选 {asset.artifact_count ?? asset.artifacts?.length ?? 0}</small>
      </button>;
    })}
    <div style={{ height: Math.max(0, (assets.length - range.end) * ROW_HEIGHT) }} />
    {!assets.length && <div className="empty-state compact">当前筛选下没有资产。</div>}
  </aside>;
}
