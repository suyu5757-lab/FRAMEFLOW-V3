import { describe, expect, it } from 'vitest';
import type { DashboardTask, ProjectDashboard } from './types';
import { dashboardHasActiveWork, primaryDashboardTask, stageProgress, statusLabel } from './dashboard-state';

const task = (id: string, status: DashboardTask['status']): DashboardTask => ({
  id,
  category: 'process',
  title: id,
  reason: id,
  priority: 'normal',
  status,
  route: 'home',
  action: id,
});

describe('dashboard state helpers', () => {
  it('labels an empty project as not started and selects story work as the primary task', () => {
    expect(statusLabel('not_started')).toBe('未开始');
    expect(primaryDashboardTask([task('complete-story', 'not_started')])?.id).toBe('complete-story');
  });

  it('always prioritizes blockers, confirmations, reviews, then failures', () => {
    const selected = primaryDashboardTask([
      task('normal', 'in_progress'),
      task('failed', 'failed'),
      task('review', 'awaiting_review'),
      task('confirm', 'awaiting_confirmation'),
      task('blocked', 'blocked'),
    ]);
    expect(selected?.id).toBe('blocked');
  });

  it('does not count skipped stages as progress work', () => {
    expect(stageProgress({ id: 'audio', label: '声音', order: 6, status: 'skipped', completed: 0, total: 0, reason: '', route: 'timeline' })).toBe('无需执行');
  });

  it('recognizes active and review work without treating a completed project as active', () => {
    const base: ProjectDashboard = {
      project: { project_id: 'P', name: 'P', status: 'completed', progress: { completed: 1, total: 1, percent: 100 }, current_stage_id: null, current_stage_label: null, blocker_count: 0, review_count: 0, next_task: null },
      stages: [], primary_next_task: null, task_queue: [], metrics: { content: {}, assets: {}, execution: {}, delivery: {} }, recent_activity: [], source_revisions: { project: 1, graph: 1, timeline: 1 },
    };
    expect(dashboardHasActiveWork(base)).toBe(false);
    expect(dashboardHasActiveWork({ ...base, project: { ...base.project, status: 'awaiting_review' } })).toBe(true);
  });
});
