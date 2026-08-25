import { describe, expect, it } from 'vitest';

import { cancelOperation } from '../../../src/background/coordinator';
import {
  OperationBusyError,
  OperationDisplayError,
  OperationEffectLock,
  type OperationStateStore,
} from '../../../src/background/operation-lock';
import {
  emptyOperation,
  type OperationData,
} from '../../../src/application/types';

describe('serialização de efeitos da operação', () => {
  it('rejeita duplo clique antes de executar um segundo efeito', async () => {
    const lock = new OperationEffectLock();
    const original = previewState();
    let current: OperationData | undefined = original;
    let releaseEffect: (() => void) | undefined;
    let effectCalls = 0;
    const store = memoryStore(
      () => current,
      (value) => (current = value),
    );

    const first = lock.run(original, 'apply', store, async (locked) => {
      effectCalls++;
      await new Promise<void>((resolve) => (releaseEffect = resolve));
      return { ...locked, phase: 'waiting-review' };
    });
    await waitUntil(() => current?.inFlight === 'apply');

    await expect(
      lock.run(original, 'apply', store, (locked) => {
        effectCalls++;
        return Promise.resolve(locked);
      }),
    ).rejects.toBeInstanceOf(OperationBusyError);
    expect(effectCalls).toBe(1);

    releaseEffect?.();
    await expect(first).resolves.toMatchObject({
      phase: 'waiting-review',
      inFlight: undefined,
    });
  });

  it('não sobrescreve cancelamento ocorrido enquanto o efeito estava em voo', async () => {
    const lock = new OperationEffectLock();
    const original = previewState();
    let current: OperationData | undefined = original;
    let releaseEffect: (() => void) | undefined;
    const store = memoryStore(
      () => current,
      (value) => (current = value),
    );

    const running = lock.run(original, 'apply', store, async (locked) => {
      await new Promise<void>((resolve) => (releaseEffect = resolve));
      return { ...locked, phase: 'waiting-review' };
    });
    await waitUntil(() => current?.inFlight === 'apply');
    current = {
      ...cancelOperation(current),
      revision: current.revision + 1,
    };
    releaseEffect?.();

    await expect(running).resolves.toMatchObject({ phase: 'cancelled' });
    expect(current.phase).toBe('cancelled');
  });

  it('preserva somente falhas explicitamente classificadas para exibição', async () => {
    const lock = new OperationEffectLock();
    const original: OperationData = {
      ...previewState(),
      captureProgress: {
        ahgora: { status: 'running', detail: 'Consultando o espelho…' },
        channel: { status: 'waiting', detail: 'Aguardando.' },
      },
    };
    let current: OperationData | undefined = original;
    const store = memoryStore(
      () => current,
      (value) => (current = value),
    );

    await expect(
      lock.run(original, 'capture', store, () => {
        throw new OperationDisplayError('Conceda acesso ao iframe do espelho.');
      }),
    ).rejects.toBeInstanceOf(OperationDisplayError);
    expect(current).toMatchObject({
      phase: 'failed',
      message: 'Conceda acesso ao iframe do espelho.',
      captureProgress: {
        ahgora: {
          status: 'failed',
          detail: 'Conceda acesso ao iframe do espelho.',
        },
        channel: { status: 'waiting' },
      },
    });
  });

  it('encerra o sistema Channel quando a captura falha após concluir o Ahgora', async () => {
    const lock = new OperationEffectLock();
    const original: OperationData = {
      ...previewState(),
      captureProgress: {
        ahgora: { status: 'done', detail: 'Concluído.' },
        channel: { status: 'running', detail: 'Consultando.' },
      },
    };
    let current: OperationData | undefined = original;
    const store = memoryStore(
      () => current,
      (value) => (current = value),
    );

    await expect(
      lock.run(original, 'capture', store, () => {
        throw new OperationDisplayError('Falha ao consultar o Channel.');
      }),
    ).rejects.toBeInstanceOf(OperationDisplayError);
    expect(current.captureProgress).toMatchObject({
      ahgora: { status: 'done' },
      channel: {
        status: 'failed',
        detail: 'Falha ao consultar o Channel.',
      },
    });
  });

  it('encerra a comparação quando as fontes concluíram mas a composição falha', async () => {
    const lock = new OperationEffectLock();
    const original: OperationData = {
      ...previewState(),
      captureProgress: {
        ahgora: { status: 'done', detail: 'Concluído.' },
        channel: { status: 'done', detail: 'Concluído.' },
        calendar: { status: 'done', detail: 'Desabilitado.' },
        comparison: { status: 'waiting', detail: 'Aguardando.' },
      },
    };
    let current: OperationData | undefined = original;
    const store = memoryStore(
      () => current,
      (value) => (current = value),
    );

    await expect(
      lock.run(original, 'capture', store, () => {
        throw new OperationDisplayError('Falha ao compor os dias.');
      }),
    ).rejects.toBeInstanceOf(OperationDisplayError);
    expect(current.captureProgress?.comparison).toEqual({
      status: 'failed',
      detail: 'Falha ao compor os dias.',
    });
  });

  it('mantém mensagem genérica para erros não classificados', async () => {
    const lock = new OperationEffectLock();
    const original = previewState();
    let current: OperationData | undefined = original;
    const store = memoryStore(
      () => current,
      (value) => (current = value),
    );

    await expect(
      lock.run(original, 'capture', store, () => {
        throw new Error('detalhe interno');
      }),
    ).rejects.toThrow('detalhe interno');
    expect(current).toMatchObject({
      phase: 'failed',
      message: 'A ação falhou sem iniciar outra escrita.',
    });
  });
});

function previewState(): OperationData {
  return {
    ...emptyOperation('lock-test'),
    phase: 'preview',
    items: [],
  };
}

function memoryStore(
  read: () => OperationData | undefined,
  write: (state: OperationData) => void,
): OperationStateStore {
  return {
    load: () => Promise.resolve(read()),
    save: (state) => {
      write(state);
      return Promise.resolve();
    },
  };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error('condição não observada');
}
