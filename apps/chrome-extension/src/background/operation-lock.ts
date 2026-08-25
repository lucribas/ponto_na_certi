import type { OperationData } from '../application/types';

export interface OperationStateStore {
  load(): Promise<OperationData | undefined>;
  save(state: OperationData): Promise<void>;
}

export class OperationBusyError extends Error {}
export class OperationDisplayError extends Error {}

export class OperationEffectLock {
  private readonly active = new Set<string>();

  async run(
    state: OperationData,
    kind: NonNullable<OperationData['inFlight']>,
    store: OperationStateStore,
    effect: (locked: OperationData) => Promise<OperationData>,
  ): Promise<OperationData> {
    if (state.inFlight !== undefined || this.active.has(state.operationId)) {
      throw new OperationBusyError('Já existe uma ação em andamento.');
    }
    this.active.add(state.operationId);
    let locked: OperationData;
    try {
      const latest = await store.load();
      if (
        latest?.operationId !== state.operationId ||
        latest.revision !== state.revision ||
        latest.inFlight !== undefined
      ) {
        throw new OperationBusyError(
          'A operação mudou antes de iniciar a ação.',
        );
      }
      locked = {
        ...state,
        inFlight: kind,
        revision: state.revision + 1,
      };
      await store.save(locked);
    } catch (error) {
      this.active.delete(state.operationId);
      throw error;
    }
    try {
      const result = await effect(locked);
      const current = await store.load();
      if (current?.operationId !== state.operationId) {
        throw new OperationBusyError('A operação foi substituída.');
      }
      if (current.phase === 'cancelled') return current;
      if (current.revision !== locked.revision || current.inFlight !== kind) {
        throw new OperationBusyError(
          'A operação mudou durante a ação; o resultado antigo foi descartado.',
        );
      }
      const committed: OperationData = {
        ...result,
        inFlight: undefined,
        revision: locked.revision + 1,
      };
      await store.save(committed);
      return committed;
    } catch (error) {
      const current = await store.load();
      if (
        current?.operationId === state.operationId &&
        current.revision === locked.revision &&
        current.inFlight === kind
      ) {
        const message =
          error instanceof OperationDisplayError
            ? error.message
            : 'A ação falhou sem iniciar outra escrita.';
        await store.save({
          ...current,
          phase: 'failed',
          inFlight: undefined,
          revision: current.revision + 1,
          ...(kind === 'capture' && current.captureProgress
            ? {
                captureProgress: failRunningCaptureSystem(
                  current.captureProgress,
                  message,
                ),
              }
            : {}),
          message,
        });
      }
      throw error;
    } finally {
      this.active.delete(state.operationId);
    }
  }
}

function failRunningCaptureSystem(
  progress: NonNullable<OperationData['captureProgress']>,
  detail: string,
): NonNullable<OperationData['captureProgress']> {
  if (
    progress.comparison?.status === 'running' ||
    (progress.comparison?.status === 'waiting' &&
      progress.ahgora.status !== 'running' &&
      progress.channel.status !== 'running' &&
      progress.calendar?.status !== 'running')
  ) {
    return {
      ...progress,
      comparison: { status: 'failed', detail },
    };
  }
  if (progress.calendar?.status === 'running') {
    return {
      ...progress,
      calendar: { status: 'failed', detail },
    };
  }
  if (progress.channel.status === 'running') {
    return {
      ...progress,
      channel: { status: 'failed', detail },
    };
  }
  if (progress.ahgora.status === 'running') {
    return {
      ...progress,
      ahgora: { status: 'failed', detail },
    };
  }
  return progress;
}
