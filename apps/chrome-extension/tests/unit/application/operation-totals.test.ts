import { describe, expect, it } from 'vitest';

import {
  emptyOperation,
  isStaleOperationState,
  operationTotals,
  type OperationData,
} from '../../../src/application/types';
import { civilDate } from '../../../src/domain';

describe('totais numéricos da operação', () => {
  it('separa capturado, novos para revisar e selecionados sem parsear duração textual', () => {
    const state = previewState();

    expect(operationTotals(state)).toEqual({
      capturedMinutes: 990,
      capturedCount: 3,
      reviewMinutes: 930,
      reviewCount: 2,
      selectedMinutes: 480,
      selectedCount: 1,
    });

    const refused: OperationData = {
      ...state,
      items: state.items.map((item) =>
        item.id === '2026-07-26' ? { ...item, decision: 'refused' } : item,
      ),
    };
    expect(operationTotals(refused)).toMatchObject({
      reviewMinutes: 930,
      reviewCount: 2,
      selectedMinutes: 0,
      selectedCount: 0,
    });

    const confirmed: OperationData = {
      ...state,
      items: state.items.map((item) =>
        item.id === '2026-07-26' ? { ...item, result: 'filled' } : item,
      ),
    };
    expect(operationTotals(confirmed)).toMatchObject({
      reviewMinutes: 450,
      reviewCount: 1,
      selectedMinutes: 0,
      selectedCount: 0,
    });
  });

  it('rejeita snapshots atrasados sem bloquear o progresso mais novo', () => {
    const running: OperationData = {
      ...emptyOperation('capture-order'),
      revision: 2,
      phase: 'capturing',
      captureProgress: {
        ahgora: { status: 'done', detail: 'Ahgora concluído.' },
        channel: { status: 'done', detail: 'Channel concluído.' },
        calendar: { status: 'done', detail: 'Calendar desabilitado.' },
        comparison: { status: 'running', detail: 'Comparando.' },
      },
    };
    const olderProgress: OperationData = {
      ...running,
      captureProgress: {
        ahgora: { status: 'running', detail: 'Consultando Ahgora.' },
        channel: { status: 'done', detail: 'Channel concluído.' },
        calendar: { status: 'done', detail: 'Calendar desabilitado.' },
        comparison: { status: 'waiting', detail: 'Aguardando.' },
      },
    };
    const runningProgress = running.captureProgress;
    if (!runningProgress) throw new Error('Progresso sintético ausente.');
    const completed: OperationData = {
      ...running,
      revision: 3,
      phase: 'preview',
      captureProgress: {
        ...runningProgress,
        comparison: { status: 'done', detail: '1 dia preparado.' },
      },
    };

    expect(isStaleOperationState(running, olderProgress)).toBe(true);
    expect(isStaleOperationState(running, completed)).toBe(false);
    expect(isStaleOperationState(completed, running)).toBe(true);
    expect(
      isStaleOperationState(completed, {
        ...running,
        operationId: 'new-operation',
        revision: 0,
      }),
    ).toBe(false);
  });
});

function previewState(): OperationData {
  return {
    ...emptyOperation('totals-test'),
    phase: 'preview',
    sourceRows: [
      {
        date: civilDate('2026-07-26'),
        duration: 'texto deliberadamente não numérico',
        durationMinutes: 480,
      },
      {
        date: civilDate('2026-07-27'),
        duration: 'ignorado no cálculo',
        durationMinutes: 450,
      },
      {
        date: civilDate('2026-07-28'),
        duration: 'também ignorado',
        durationMinutes: 60,
      },
    ],
    items: [
      {
        id: '2026-07-26',
        date: civilDate('2026-07-26'),
        ahgoraDuration: 'qualquer texto',
        status: 'missing',
        decision: 'selected',
      },
      {
        id: '2026-07-27',
        date: civilDate('2026-07-27'),
        ahgoraDuration: 'qualquer texto',
        status: 'missing',
        decision: 'pending',
      },
      {
        id: '2026-07-28',
        date: civilDate('2026-07-28'),
        ahgoraDuration: 'qualquer texto',
        status: 'divergent',
        decision: 'pending',
      },
    ],
  };
}
