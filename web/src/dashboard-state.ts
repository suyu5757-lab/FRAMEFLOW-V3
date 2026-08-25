import type { DashboardStage, DashboardTask, HomeStatus, ProjectDashboard, ProjectHomeSummary } from './types';

export const HOME_STATUS_LABELS: Record<HomeStatus, string> = {
  not_started: '未开始',
  in_progress: '进行中',
  awaiting_confirmation: '待确认',
  awaiting_review: '待审核',
  ready: '已就绪',
  completed: '已完成',
  blocked: '阻塞',
  failed: '失败',
  skipped: '无需执行',
};

export const HOME_STATUS_ICONS: Record<HomeStatus, string> = {
  not_started: '○',
  in_progress: '◐',
  awaiting_confirmation: '!',
  awaiting_review: '◌',
  ready: '✓',
  completed: '✓',
  blocked: '⛔',
  failed: '×',
  skipped: '—',
};

export function statusLabel(status: HomeStatus | string | undefined): string {
  return (status && status in HOME_STATUS_LABELS ? HOME_STATUS_LABELS[status as HomeStatus] : status) || '未知状态';
}

export function statusIcon(status: HomeStatus | string | undefined): string {
  return (status && status in HOME_STATUS_ICONS ? HOME_STATUS_ICONS[status as HomeStatus] : '•');
}

export function statusClass(status: HomeStatus | string | undefined): string {
  return `status-${status || 'unknown'}`;
}

export function progressLabel(progress: ProjectHomeSummary['progress']): string {
  return `${progress.percent}% · ${progress.completed}/${progress.total} 阶段完成`;
}

export function stageProgress(stage: DashboardStage): string {
  if (stage.status === 'skipped') return '无需执行';
  if (stage.total <= 0) return statusLabel(stage.status);
  return `${stage.completed}/${stage.total}`;
}

export function taskPriorityLabel(priority: DashboardTask['priority']): string {
  return priority === 'critical' ? '必须处理' : priority === 'high' ? '优先处理' : '稍后处理';
}

const TASK_STATUS_RANK: Record<string, number> = {
  blocked: 0,
  awaiting_confirmation: 1,
  awaiting_review: 2,
  failed: 3,
};

/** Keep the home action deterministic even when a backend receives tasks from multiple sources. */
export function sortDashboardTasks(tasks: DashboardTask[]): DashboardTask[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => (TASK_STATUS_RANK[left.task.status] ?? 4) - (TASK_STATUS_RANK[right.task.status] ?? 4) || left.index - right.index)
    .map(({ task }) => task);
}

export function primaryDashboardTask(tasks: DashboardTask[]): DashboardTask | null {
  return sortDashboardTasks(tasks)[0] || null;
}

export function dashboardHasActiveWork(dashboard: ProjectDashboard | null): boolean {
  if (!dashboard) return false;
  return dashboard.stages.some((stage) => ['in_progress', 'awaiting_confirmation', 'awaiting_review'].includes(stage.status)) ||
    ['in_progress', 'awaiting_confirmation', 'awaiting_review'].includes(dashboard.project.status);
}
