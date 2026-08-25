import type { OperationData, RegisteredTab } from '../application/types';
import type { ChannelAssignment } from '../domain';
import type { InjectedChannelFillResult } from '../sites/target';

export interface ValidatedWriteDependencies {
  validateTab(binding: RegisteredTab): Promise<void>;
  loadState(): Promise<OperationData | undefined>;
  cancellationRequested(operationId: string): boolean;
  dispatchFill(
    tabId: number,
    assignment: ChannelAssignment,
  ): Promise<InjectedChannelFillResult>;
}

export async function executeValidatedChannelFill(
  expected: OperationData,
  assignment: ChannelAssignment,
  dependencies: ValidatedWriteDependencies,
): Promise<InjectedChannelFillResult> {
  const binding = expected.targetTab;
  if (
    !binding ||
    (expected.inFlight !== 'apply' && expected.inFlight !== 'advance')
  ) {
    throw new Error('A operação não está pronta para escrita.');
  }

  await dependencies.validateTab(binding);
  const current = await dependencies.loadState();
  if (
    dependencies.cancellationRequested(expected.operationId) ||
    !sameWriteLease(current, expected, binding)
  ) {
    throw new Error('A operação foi cancelada ou mudou antes da escrita.');
  }

  // Não inserir await entre esta validação e o despacho: executeChannelFill
  // chama chrome.scripting.executeScript sincronicamente ao criar a Promise.
  return dependencies.dispatchFill(binding.id, assignment);
}

function sameWriteLease(
  current: OperationData | undefined,
  expected: OperationData,
  binding: RegisteredTab,
): current is OperationData {
  return (
    current !== undefined &&
    current.operationId === expected.operationId &&
    current.phase !== 'cancelled' &&
    current.revision === expected.revision &&
    current.inFlight === expected.inFlight &&
    current.targetTab?.id === binding.id &&
    current.targetTab.origin === binding.origin
  );
}
