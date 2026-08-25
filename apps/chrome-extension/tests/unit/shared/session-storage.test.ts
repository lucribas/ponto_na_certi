import { describe, expect, it } from 'vitest';

import {
  clearSessionSnapshot,
  loadSessionSnapshot,
  saveSessionSnapshot,
  type SessionStorageArea,
} from '../../../src/shared/session-storage';

function memoryStorage(initial: Record<string, unknown> = {}): {
  readonly area: SessionStorageArea;
  readonly values: Record<string, unknown>;
} {
  const values = { ...initial };
  return {
    values,
    area: {
      get: (key) => Promise.resolve({ [key]: values[key] }),
      set: (items) => {
        Object.assign(values, items);
        return Promise.resolve();
      },
      remove: (key) => {
        Reflect.deleteProperty(values, key);
        return Promise.resolve();
      },
    },
  };
}

describe('transient operation storage', () => {
  it('round-trips only a structural session snapshot and can clear it', async () => {
    const storage = memoryStorage();
    const snapshot = {
      operationId: 'operation-1',
      phase: 'preview',
      sourceTabId: 10,
      targetTabId: 20,
    } as const;

    await saveSessionSnapshot(storage.area, snapshot);
    await expect(loadSessionSnapshot(storage.area)).resolves.toEqual(snapshot);
    expect(JSON.stringify(storage.values)).not.toContain('password');
    await clearSessionSnapshot(storage.area);
    await expect(loadSessionSnapshot(storage.area)).resolves.toBeUndefined();
  });

  it('rejects a malformed external snapshot', async () => {
    const storage = memoryStorage({
      currentOperation: { operationId: 3, phase: false },
    });
    await expect(loadSessionSnapshot(storage.area)).rejects.toThrow(/inválido/);
  });
});
