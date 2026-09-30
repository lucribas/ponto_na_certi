/* Async mocks model the promise-based browser boundary. */
/* eslint-disable @typescript-eslint/require-await */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureAndCompareOperation,
  selectRemainingItems,
  decideItem,
  type CoordinatorAdapters,
} from '../../src/background/coordinator';
import {
  emptyOperation,
  clearCapturedOperation,
  sourceConnectionsReady,
  requiredSources,
  type OperationData,
} from '../../src/application/types';
import { loadOperationData } from '../../src/application/storage';
import type { CaptureSourceResult } from '../../src/sites/punch-source';
import type { PeriodRequest } from '../../src/domain';
function state(period: PeriodRequest): OperationData {
  return {
    ...emptyOperation('test'),
    sourceTab: { id: 1, origin: 'https://app.ahgora.com.br' },
    seniorTab: {
      id: 2,
      origin: 'https://gestaodoponto.certi.org.br',
      subjectKey: 'test',
    },
    targetTab: { id: 3, origin: 'https://channel.certi.org.br' },
    requestedPeriod: period,
    config: {
      project: 'p',
      activity: 'a',
      activityType: 'Nenhum',
      task: 'Nenhum',
      period,
      overrides: [],
      tags: [
        {
          id: 'tag',
          name: 'T',
          project: 'p',
          activity: 'a',
          projectId: '1',
          activityId: '1',
        },
      ],
      defaultTagId: 'tag',
    },
  };
}
function adapters() {
  return {
    today: '2026-09-29',
    captureSource: vi.fn(async (): Promise<CaptureSourceResult> => ({
      ok: true,
      days: [{ date: '2026-09-20', times: ['08:00', '12:00'] }],
    })),
    captureSenior: vi.fn(async (): Promise<CaptureSourceResult> => ({
      ok: true,
      days: [{ date: '2026-09-21', times: ['08:00', '12:00'] }],
      issues: [
        {
          date: '2026-09-21',
          severity: 'requires-review',
          message: 'Pendência Senior',
        },
      ],
    })),
    readTarget: vi.fn(async () => ({
      ok: true as const,
      rows: [],
      errors: [],
    })),
    writeTarget: vi.fn(async () => {
      throw new Error('No writes allowed');
    }),
  } satisfies CoordinatorAdapters;
}
afterEach(() => vi.unstubAllGlobals());
describe('operação com duas fontes', () => {
  it('usa o mês atual antes de salvar o período, em sintonia com o seletor inicial', () => {
    expect(requiredSources(emptyOperation('new'), '2026-09-29')).toEqual([
      'ahgora',
      'senior',
    ]);
    expect(requiredSources(emptyOperation('new'), '2026-10-01')).toEqual([
      'senior',
    ]);
  });
  it('dispensa Senior em intervalo histórico, mesmo se houver uma conexão salva', async () => {
    const a = adapters();
    await captureAndCompareOperation(
      state({ kind: 'range', start: '2026-09-20', end: '2026-09-20' }),
      a,
    );
    expect(a.captureSource).toHaveBeenCalledOnce();
    expect(a.captureSenior).not.toHaveBeenCalled();
  });

  it('captura as partes sem sobreposição e exige seleção individual das pendências', async () => {
    const a = adapters();
    const preview = await captureAndCompareOperation(
      state({ kind: 'range', start: '2026-09-20', end: '2026-09-21' }),
      a,
    );
    expect(a.captureSource.mock.calls).toHaveLength(1);
    expect(a.captureSenior.mock.calls).toHaveLength(1);
    expect(
      preview.items.map((i) => [i.date, i.sourceProvider, i.decision]),
    ).toEqual([
      ['2026-09-20', 'ahgora', 'selected'],
      ['2026-09-21', 'senior', 'pending'],
    ]);
    expect(selectRemainingItems(preview).items[1]?.decision).toBe('pending');
    expect(
      decideItem(preview, '2026-09-21', 'selected').items[1]?.decision,
    ).toBe('selected');
    expect(a.writeTarget).not.toHaveBeenCalled();
  });
  it('não exige Ahgora após o corte e não publica resposta parcial', async () => {
    const seniorOnly = {
      ...state({ kind: 'range', start: '2026-09-21', end: '2026-09-21' }),
      sourceTab: undefined,
    };
    const a = adapters();
    expect(sourceConnectionsReady(seniorOnly, '2026-09-29')).toBe(true);
    await captureAndCompareOperation(seniorOnly, a);
    expect(a.captureSource).not.toHaveBeenCalled();
    a.captureSenior.mockResolvedValue({
      ok: false,
      error: { code: 'TIMEOUT', message: 'Senior indisponível' },
    });
    await expect(
      captureAndCompareOperation(
        state({ kind: 'range', start: '2026-09-20', end: '2026-09-21' }),
        a,
      ),
    ).rejects.toThrow('Senior indisponível');
    expect(a.writeTarget).not.toHaveBeenCalled();
  });
  it('descarta resultado após cancelamento entre fontes', async () => {
    const a = adapters();
    let cancelled = false;
    a.captureSource.mockImplementation(async () => {
      cancelled = true;
      return { ok: true, days: [] };
    });
    await expect(
      captureAndCompareOperation(
        state({ kind: 'range', start: '2026-09-20', end: '2026-09-21' }),
        { ...a, cancellationRequested: () => cancelled },
      ),
    ).rejects.toThrow();
    expect(a.captureSenior).not.toHaveBeenCalled();
  });
  it('troca de período limpa filas e capturas sem perder configuração', () => {
    const old = state({
      kind: 'range',
      start: '2026-09-21',
      end: '2026-09-21',
    });
    const next = clearCapturedOperation({
      ...old,
      phase: 'preview',
      queue: ['old'],
      sourceRows: [
        { date: '2026-09-21', duration: '04:00', durationMinutes: 240 },
      ],
    });
    expect(next.queue).toEqual([]);
    expect(next.phase).toBe('setup');
    expect(next.sourceRows).toBeUndefined();
    expect(next.config).toEqual(old.config);
  });
  it('migra operação v1 para nova captura sem tocar configurações locais', async () => {
    const set = vi.fn(async () => undefined);
    const localSet = vi.fn();
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          get: async () => ({
            operationData: { version: 1, operationId: 'old', queue: ['write'] },
          }),
          set,
        },
        local: { set: localSet },
      },
    });
    const next = await loadOperationData();
    expect(next?.version).toBe(2);
    expect(next?.operationId).not.toBe('old');
    expect(next?.queue).toEqual([]);
    expect(next?.phase).toBe('setup');
    expect(localSet).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledOnce();
  });
});
