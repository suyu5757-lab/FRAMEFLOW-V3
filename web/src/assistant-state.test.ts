import { describe, expect, it } from 'vitest';
import type { AssistantRunEvent, AssistantWorkspaceOperation } from './assistant-types';
import { mergeAssistantRunEvents, selectableAssistantOperationIds, toggleAssistantOperation } from './assistant-state';

const event = (sequence: number, detail = ''): AssistantRunEvent => ({
  id: sequence,
  run_id: 'RUN_1',
  sequence,
  item_id: null,
  event_type: 'item_progress',
  status: 'running',
  data: detail ? { detail } : {},
  created_at: '2026-01-01T00:00:00Z',
});

const operation = (id: string, risk: AssistantWorkspaceOperation['risk'] = 'safe_draft'): AssistantWorkspaceOperation => ({
  id,
  workspace: 'story',
  action: 'candidate_draft',
  title: id,
  summary: '',
  before: null,
  after: { id },
  content: { id },
  source_attachment_ids: [],
  source_refs: [],
  contract_snapshot: {},
  risk,
  requires_confirmation: false,
});

describe('assistant run state', () => {
  it('replays events by sequence and replaces a stale duplicate', () => {
    const merged = mergeAssistantRunEvents([event(2, 'old'), event(1)], [event(2, 'new'), event(3)]);
    expect(merged.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(merged[1].data.detail).toBe('new');
  });

  it('does not select protected operations by default or by toggle', () => {
    const safe = operation('OP_SAFE');
    const blocked = operation('OP_BLOCKED', 'blocked');
    expect([...selectableAssistantOperationIds([safe, blocked])]).toEqual(['OP_SAFE']);
    expect([...toggleAssistantOperation(new Set(['OP_SAFE']), blocked)]).toEqual(['OP_SAFE']);
  });

  it('toggles only the requested operation', () => {
    const first = operation('OP_1');
    const second = operation('OP_2');
    const selected = toggleAssistantOperation(new Set(['OP_1']), second);
    expect([...selected].sort()).toEqual(['OP_1', 'OP_2']);
    expect([...toggleAssistantOperation(selected, first)]).toEqual(['OP_2']);
  });
});
