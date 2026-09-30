/* Async mocks model the promise-based browser boundary. */
/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  captureSenior,
  normalizeSeniorDays,
  querySeniorDocument,
  type SeniorQuery,
  type SeniorQueryResult,
} from '../../src/sites/senior';
import { calculatePunchDays, type CivilDate } from '../../src/domain';
const subject = '1-1-test';
const range = { start: '2026-09-21' as const, end: '2026-09-25' as const };
function day(date: CivilDate, times = ['09:29', '12:46', '13:55', '18:55']) {
  return {
    dataApuracao: date,
    marcacoes: times.map((horaAcesso) => ({
      dataAcesso: date,
      dataApuracao: date,
      horaAcesso,
      origem: 'E',
      uso: 2,
      marcacaoOriginal: { horaAcesso: '00:00' },
    })),
    marcacoesPrevistas: ['08:00', '12:00', '14:00', '18:00'],
    verificado: false,
  };
}
function body(days: unknown[]) {
  return { apuracao: days, colaborador: { id: subject } };
}
function runner(days = [day('2026-09-25')]) {
  return {
    probe: vi.fn(async () => ({ ready: true, subjectKey: subject })),
    query: vi.fn(async (input: SeniorQuery): Promise<SeniorQueryResult> => ({
      ok: true,
      data:
        input.kind === 'period'
          ? {
              result: {
                codigoCalculo: {
                  codigoCalculo: 1,
                  inicioApuracao: '2026-09-21',
                  fimApuracao: '2026-10-20',
                },
                colaborador: { id: subject },
              },
            }
          : input.kind === 'count'
            ? { result: { total: days.length } }
            : body(days),
    })),
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
describe('Senior contrato e normalização', () => {
  it('captura pelo código resolvido e calcula 08:17 ignorando previstas e original', async () => {
    const source = runner();
    const result = await captureSenior(source, range, subject);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('capture failed');
    expect(calculatePunchDays(result.days).records[0]?.duration).toBe('08:17');
    expect(source.query.mock.calls.map(([input]) => input.kind)).toEqual([
      'period',
      'count',
      'days',
    ]);
    expect(source.query.mock.calls[2]?.[0]).toMatchObject({
      calculationCode: 1,
      start: range.start,
      end: range.end,
      resolvedSubject: subject,
    });
    expect(result.issues).toEqual([]);
  });
  it('não transforma previstas em batidas e sinaliza revisão sem excluir uma batida D', () => {
    const manual = day('2026-09-25');
    Object.assign(manual.marcacoes[0] ?? {}, { origem: 'D' });
    const result = normalizeSeniorDays(
      body([{ ...manual, status: { codigo: 5 } }, day('2026-09-22', [])]),
      range,
      subject,
    );
    expect(result.days[0]?.times).toHaveLength(4);
    expect(result.days[1]?.times).toEqual([]);
    expect(result.issues.map((i) => i.severity)).toEqual([
      'requires-review',
      'blocked',
    ]);
  });
  it('bloqueia virada de dia, uso desconhecido e horários inválidos', () => {
    for (const patch of [
      { dataAcesso: '2026-09-26' },
      { uso: 9 },
      { horaAcesso: '99:99' },
    ]) {
      const raw = day('2026-09-25');
      Object.assign(raw.marcacoes[0] ?? {}, patch);
      const result = normalizeSeniorDays(body([raw]), range, subject);
      expect(result.issues[0]?.severity).toBe('blocked');
      expect(result.days[0]?.times).toEqual([]);
    }
  });
  it('preserva batida ímpar para monitoramento, mas bloqueia seu envio', () => {
    const result = normalizeSeniorDays(
      body([day('2026-09-25', ['09:00'])]),
      range,
      subject,
    );
    expect(result.days[0]?.times).toEqual(['09:00']);
    expect(result.issues[0]).toMatchObject({
      severity: 'blocked',
      code: 'odd-punch-count',
    });
  });
  it('rejeita duplicidade e identidade incorreta', () => {
    expect(() =>
      normalizeSeniorDays(
        body([day('2026-09-25'), day('2026-09-25')]),
        range,
        subject,
      ),
    ).toThrow('CONFLICTING_DAYS');
    expect(() => normalizeSeniorDays(body([]), range, 'someone-else')).toThrow(
      'SOURCE_DATA_INVALID',
    );
  });
  it('não aceita uma resposta parcial após repetir a leitura', async () => {
    const source = runner();
    const original = source.query.getMockImplementation();
    if (!original) throw new Error('missing mock');
    source.query.mockImplementation((input) =>
      input.kind === 'count'
        ? Promise.resolve({ ok: true, data: { result: { total: 2 } } })
        : original(input),
    );
    expect(await captureSenior(source, range)).toMatchObject({
      ok: false,
      error: { code: 'INCOMPLETE_RESPONSE' },
    });
    expect(
      source.query.mock.calls.filter(([input]) => input.kind === 'days'),
    ).toHaveLength(2);
  });
  it('interrompe sem nova consulta após cancelamento e recusa troca de colaborador', async () => {
    const source = runner();
    expect(await captureSenior(source, range, 'different')).toMatchObject({
      ok: false,
      error: { code: 'SUBJECT_CHANGED' },
    });
    expect(source.query).not.toHaveBeenCalled();
    const check = vi.fn(async () => {
      if (source.query.mock.calls.length > 0) throw new Error('CANCELLED');
    });
    expect(await captureSenior({ ...source, check }, range)).toMatchObject({
      ok: false,
      error: { code: 'CANCELLED' },
    });
    expect(source.query).toHaveBeenCalledTimes(1);
  });
  it('consulta duas competências e usa os limites retornados', async () => {
    const source = runner();
    source.query.mockImplementation(async (input) => {
      if (input.kind === 'period')
        return {
          ok: true,
          data: {
            result: {
              codigoCalculo:
                input.competence === '2026-10-01'
                  ? {
                      codigoCalculo: 1,
                      inicioApuracao: '2026-09-21',
                      fimApuracao: '2026-10-20',
                    }
                  : {
                      codigoCalculo: 2,
                      inicioApuracao: '2026-10-21',
                      fimApuracao: '2026-11-20',
                    },
              colaborador: { id: subject },
            },
          },
        };
      return {
        ok: true,
        data:
          input.kind === 'count'
            ? { result: { total: 1 } }
            : body([day(input.start as CivilDate)]),
      };
    });
    const result = await captureSenior(source, {
      start: '2026-10-20',
      end: '2026-10-21',
    });
    expect(result).toMatchObject({
      ok: true,
      days: [{ date: '2026-10-20' }, { date: '2026-10-21' }],
    });
  });
  it('rejeita sessão expirada sem tratar como período vazio', async () => {
    const source = runner();
    source.query.mockResolvedValue({ ok: false, code: 'LOGIN_REQUIRED' });
    expect(await captureSenior(source, range)).toMatchObject({
      ok: false,
      error: { code: 'LOGIN_REQUIRED' },
    });
    expect(source.query).toHaveBeenCalledTimes(1);
  });
  it('recusa competência fora do intervalo mesmo quando o servidor retorna fallback', async () => {
    const source = runner();
    expect(
      await captureSenior(source, { start: '2026-11-01', end: '2026-11-02' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'PERIOD_NOT_AVAILABLE' },
    });
    expect(
      source.query.mock.calls.every(([input]) => input.kind === 'period'),
    ).toBe(true);
    expect(source.query.mock.calls.length).toBeLessThanOrEqual(4);
  });
  it('repete falha transitória e usa total do count sem restringir os dias às pendências', async () => {
    vi.stubGlobal('location', {
      origin: 'https://gestaodoponto.certi.org.br',
      pathname: `/gestaoponto-frontend/time-adjustment/employee/${subject}/all`,
    });
    const get = vi
      .fn()
      .mockRejectedValueOnce({ status: 500 })
      .mockResolvedValue({ data: { result: { total: 5, totalPendencia: 1 } } });
    vi.stubGlobal('angular', {
      element: () => ({ injector: () => ({ get: () => ({ get }) }) }),
    });
    expect(
      await querySeniorDocument({
        kind: 'count',
        subjectKey: subject,
        calculationCode: 1,
        ...range,
      }),
    ).toEqual({ ok: true, data: { result: { total: 5 } } });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1]?.[0] as unknown).toContain('/count');
    expect(get.mock.calls[1]?.[1] as unknown).toMatchObject({
      params: {
        filtraPendencias: 'COLABORADOR',
        dataInicial: range.start,
        dataFinal: range.end,
      },
    });
    get.mockReset().mockRejectedValue({ status: 401 });
    expect(
      await querySeniorDocument({
        kind: 'count',
        subjectKey: subject,
        calculationCode: 1,
        ...range,
      }),
    ).toEqual({ ok: false, code: 'LOGIN_REQUIRED' });
    expect(get).toHaveBeenCalledOnce();
  });
  it('o transporte usa somente GET e filtra dados pessoais antes da fronteira', async () => {
    vi.stubGlobal('location', {
      origin: 'https://gestaodoponto.certi.org.br',
      pathname: `/gestaoponto-frontend/time-adjustment/employee/${subject}/pending`,
    });
    const get = vi.fn(async () => ({
      data: {
        ...body([day('2026-09-25')]),
        colaborador: { id: subject, nome: 'PRIVATE', foto: 'PRIVATE' },
      },
    }));
    vi.stubGlobal('angular', {
      element: () => ({ injector: () => ({ get: () => ({ get }) }) }),
    });
    const result = await querySeniorDocument({
      kind: 'days',
      subjectKey: subject,
      calculationCode: 1,
      start: range.start,
      end: range.end,
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain('marcacaoOriginal');
    expect(get.mock.calls[0]).toBeDefined();
  });
});
