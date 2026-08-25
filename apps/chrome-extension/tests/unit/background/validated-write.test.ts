import { describe, expect, it } from 'vitest';

import { cancelOperation } from '../../../src/background/coordinator';
import { executeValidatedChannelFill } from '../../../src/background/validated-write';
import {
  CancellationRegistry,
  createCancellationAwareHandler,
} from '../../../src/background/cancellation';
import {
  emptyOperation,
  type OperationData,
} from '../../../src/application/types';
import { assignExpertProject, civilDate } from '../../../src/domain';

describe('despacho final de escrita', () => {
  it('cancela durante tabs.get/revalidação e não chama o adapter de escrita', async () => {
    let current: OperationData = lockedApplyState();
    let releaseTabValidation: (() => void) | undefined;
    let validationStarted = false;
    let writeCalls = 0;
    const config = current.config;
    if (!config) throw new Error('configuração de teste ausente');
    const assignment = assignExpertProject(
      {
        date: civilDate('2026-07-26'),
        durationMinutes: 240,
      },
      config,
    );

    const pending = executeValidatedChannelFill(current, assignment, {
      validateTab: async () => {
        validationStarted = true;
        await new Promise<void>((resolve) => (releaseTabValidation = resolve));
      },
      loadState: () => Promise.resolve(current),
      cancellationRequested: () => false,
      dispatchFill: () => {
        writeCalls++;
        return Promise.resolve({
          date: assignment.date,
          requestedMinutes: assignment.durationMinutes,
          status: 'filled',
          resultingMinutes: assignment.durationMinutes,
        });
      },
    });
    await waitUntil(() => validationStarted);
    current = {
      ...cancelOperation(current),
      revision: current.revision + 1,
    };
    releaseTabValidation?.();

    await expect(pending).rejects.toThrow(/cancelada ou mudou/);
    expect(writeCalls).toBe(0);
  });

  it('observa CANCEL_OPERATION pelo handler antes de sua persistência e bloqueia o dispatch', async () => {
    let current: OperationData = lockedApplyState();
    let releaseTabValidation: (() => void) | undefined;
    let releaseCancellationSave: (() => void) | undefined;
    let validationStarted = false;
    let cancellationSaveStarted = false;
    let writeCalls = 0;
    const registry = new CancellationRegistry();
    const config = current.config;
    if (!config) throw new Error('configuração de teste ausente');
    const assignment = assignExpertProject(
      { date: civilDate('2026-07-26'), durationMinutes: 240 },
      config,
    );
    const handler = createCancellationAwareHandler(
      registry,
      () => undefined,
      async (message) => {
        if (message.type !== 'CANCEL_OPERATION') {
          throw new Error('mensagem de teste inesperada');
        }
        cancellationSaveStarted = true;
        await new Promise<void>(
          (resolve) => (releaseCancellationSave = resolve),
        );
        current = {
          ...cancelOperation(current),
          revision: current.revision + 1,
        };
        return current;
      },
    );
    const pendingWrite = executeValidatedChannelFill(current, assignment, {
      validateTab: async () => {
        validationStarted = true;
        await new Promise<void>((resolve) => (releaseTabValidation = resolve));
      },
      loadState: () => Promise.resolve(current),
      cancellationRequested: (operationId) => registry.isRequested(operationId),
      dispatchFill: () => {
        writeCalls++;
        return Promise.resolve({
          date: assignment.date,
          requestedMinutes: assignment.durationMinutes,
          status: 'filled',
          resultingMinutes: assignment.durationMinutes,
        });
      },
    });
    await waitUntil(() => validationStarted);

    const pendingCancellation = handler(
      { type: 'CANCEL_OPERATION', operationId: current.operationId },
      undefined,
    );
    expect(registry.isRequested(current.operationId)).toBe(true);
    await waitUntil(() => cancellationSaveStarted);
    releaseTabValidation?.();

    await expect(pendingWrite).rejects.toThrow(/cancelada ou mudou/);
    expect(writeCalls).toBe(0);
    expect(current.phase).not.toBe('cancelled');

    releaseCancellationSave?.();
    await expect(pendingCancellation).resolves.toMatchObject({
      phase: 'cancelled',
    });
  });
});

function lockedApplyState(): OperationData {
  return {
    ...emptyOperation('validated-write-test'),
    revision: 2,
    phase: 'preview',
    inFlight: 'apply',
    targetTab: { id: 20, origin: 'https://target.synthetic' },
    config: {
      project: 'PROJETO',
      activity: 'ATIVIDADE',
      activityType: 'Nenhum',
      task: 'Nenhum',
      period: { kind: 'month', month: '2026-08' },
      overrides: [],
    },
    items: [],
  };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error('condição não observada');
}
