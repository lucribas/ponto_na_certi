import { BoundaryValidationError } from '../shared/errors';
import type { OperationData } from './types';

const KEY = 'operationData';

export async function loadOperationData(): Promise<OperationData | undefined> {
  const result = await chrome.storage.session.get(KEY);
  const value = result[KEY];
  if (value === undefined) return undefined;
  if (!isOperationData(value)) {
    throw new BoundaryValidationError('Estado transitório incompatível.');
  }
  return value;
}

export async function saveOperationData(state: OperationData): Promise<void> {
  await chrome.storage.session.set({ [KEY]: state });
}

function isOperationData(value: unknown): value is OperationData {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    Number.isInteger(record.revision) &&
    typeof record.operationId === 'string' &&
    typeof record.phase === 'string' &&
    (record.inFlight === undefined ||
      record.inFlight === 'capture' ||
      record.inFlight === 'apply' ||
      record.inFlight === 'advance' ||
      record.inFlight === 'delete') &&
    Array.isArray(record.items) &&
    Array.isArray(record.queue) &&
    Number.isInteger(record.queueIndex)
  );
}
