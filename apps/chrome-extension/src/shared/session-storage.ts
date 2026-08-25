import { BoundaryValidationError } from './errors';

export interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  remove(key: string): Promise<void>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface SessionSnapshot {
  readonly operationId: string;
  readonly phase:
    | 'detecting'
    | 'captured'
    | 'validated'
    | 'preview'
    | 'filling'
    | 'completed'
    | 'cancelled'
    | 'failed';
  readonly sourceTabId?: number;
  readonly targetTabId?: number;
}

const STORAGE_KEY = 'currentOperation';
const SESSION_PHASES = new Set<SessionSnapshot['phase']>([
  'detecting',
  'captured',
  'validated',
  'preview',
  'filling',
  'completed',
  'cancelled',
  'failed',
]);

function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.operationId === 'string' &&
    record.operationId.length > 0 &&
    SESSION_PHASES.has(record.phase as SessionSnapshot['phase']) &&
    (record.sourceTabId === undefined ||
      Number.isInteger(record.sourceTabId)) &&
    (record.targetTabId === undefined || Number.isInteger(record.targetTabId))
  );
}

export async function loadSessionSnapshot(
  storage: SessionStorageArea,
): Promise<SessionSnapshot | undefined> {
  const result = await storage.get(STORAGE_KEY);
  const candidate = result[STORAGE_KEY];
  if (candidate === undefined) return undefined;
  if (!isSessionSnapshot(candidate)) {
    throw new BoundaryValidationError('Snapshot de sessão inválido.');
  }
  return candidate;
}

export async function saveSessionSnapshot(
  storage: SessionStorageArea,
  snapshot: SessionSnapshot,
): Promise<void> {
  await storage.set({ [STORAGE_KEY]: snapshot });
}

export async function clearSessionSnapshot(
  storage: SessionStorageArea,
): Promise<void> {
  await storage.remove(STORAGE_KEY);
}
