import type { AssistantRunEvent, AssistantWorkspaceOperation } from './assistant-types';

/** Merge replayed SSE events without allowing a reconnect to duplicate items. */
export function mergeAssistantRunEvents(current: AssistantRunEvent[], incoming: AssistantRunEvent[]): AssistantRunEvent[] {
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  incoming.forEach((event) => bySequence.set(event.sequence, event));
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

/** Only safe draft/review operations are selectable by default. */
export function selectableAssistantOperationIds(operations: AssistantWorkspaceOperation[]): Set<string> {
  return new Set(operations.filter((operation) => operation.risk !== 'blocked').map((operation) => operation.id));
}

export function toggleAssistantOperation(current: ReadonlySet<string>, operation: AssistantWorkspaceOperation): Set<string> {
  if (operation.risk === 'blocked') return new Set(current);
  const next = new Set(current);
  if (next.has(operation.id)) next.delete(operation.id);
  else next.add(operation.id);
  return next;
}
