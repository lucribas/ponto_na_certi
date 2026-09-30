import {
  civilDate,
  monthOf,
  shiftMonth,
  type CivilDate,
  type DateRange,
} from '../../domain';
import type {
  CaptureSourceResult,
  CapturedPunchDay,
  SourceDayIssue,
} from '../punch-source';
import type { SeniorQuery, SeniorQueryResult } from './injected';

export const SENIOR_ORIGIN = 'https://gestaodoponto.certi.org.br';
export const SENIOR_ENTRY = `${SENIOR_ORIGIN}/gestaoponto-frontend/`;
export interface SeniorRunner {
  probe(): Promise<{ ready: boolean; subjectKey?: string }>;
  query(input: SeniorQuery): Promise<SeniorQueryResult>;
  check?: (() => Promise<void>) | undefined;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
function date(value: unknown): CivilDate {
  if (typeof value !== 'string') throw new Error('SOURCE_DATA_INVALID');
  try {
    return civilDate(value);
  } catch {
    throw new Error('SOURCE_DATA_INVALID');
  }
}
function nextDate(value: CivilDate): CivilDate {
  const d = new Date(`${value}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return civilDate(d.toISOString().slice(0, 10));
}

export function normalizeSeniorDays(
  value: unknown,
  range: DateRange,
  subject: string,
): { days: CapturedPunchDay[]; issues: SourceDayIssue[] } {
  if (
    !record(value) ||
    !Array.isArray(value.apuracao) ||
    !record(value.colaborador) ||
    value.colaborador.id !== subject
  )
    throw new Error('SOURCE_DATA_INVALID');
  const days: CapturedPunchDay[] = [];
  const issues: SourceDayIssue[] = [];
  const seen = new Set<string>();
  for (const raw of value.apuracao) {
    if (!record(raw) || !Array.isArray(raw.marcacoes))
      throw new Error('SOURCE_DATA_INVALID');
    const day = date(raw.dataApuracao);
    if (day < range.start || day > range.end)
      throw new Error('SOURCE_DATA_INVALID');
    if (seen.has(day)) throw new Error('CONFLICTING_DAYS');
    seen.add(day);
    const times: string[] = [];
    let blocked: string | undefined;
    for (const punch of raw.marcacoes) {
      if (!record(punch)) throw new Error('SOURCE_DATA_INVALID');
      if (punch.dataAcesso !== day || punch.dataApuracao !== day)
        blocked =
          'Jornada entre datas diferentes ou data de marcação incompatível; revise na Senior.';
      if (punch.uso !== 2 || (punch.origem !== 'E' && punch.origem !== 'D'))
        blocked =
          'Uso ou origem de marcação ainda não suportado; revise na Senior.';
      if (
        typeof punch.horaAcesso !== 'string' ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(punch.horaAcesso)
      )
        blocked = 'Horário de marcação inválido na Senior.';
      else times.push(punch.horaAcesso);
    }
    if (times.some((time, i) => i > 0 && time <= (times[i - 1] ?? '')))
      blocked = 'Ordem de marcações ambígua; revise na Senior.';
    const odd = !blocked && times.length % 2 === 1;
    if (odd) blocked = 'Quantidade ímpar de marcações; revise na Senior.';
    if (blocked)
      issues.push({
        date: day,
        severity: 'blocked',
        code: odd ? 'odd-punch-count' : 'unsupported-punch',
        message: blocked,
      });
    else if (
      (record(raw.status) && Number(raw.status.codigo) !== 0) ||
      (Array.isArray(raw.incidentes) && raw.incidentes.length > 0)
    )
      issues.push({
        date: day,
        severity: 'requires-review',
        message:
          'A Senior informa pendência ou incidente neste dia. Revise antes de selecionar individualmente.',
      });
    if (!times.length && !blocked)
      issues.push({
        date: day,
        severity: 'blocked',
        message: 'A Senior não possui batidas realizadas neste dia.',
      });
    days.push({
      provider: 'senior',
      date: day,
      times: blocked && !odd ? [] : times,
    });
  }
  return { days, issues };
}

export async function captureSenior(
  runner: SeniorRunner,
  range: DateRange,
  expectedSubject?: string,
): Promise<CaptureSourceResult> {
  try {
    date(range.start);
    date(range.end);
    if (range.start > range.end) throw new Error('SOURCE_DATA_INVALID');
    await runner.check?.();
    const probe = await runner.probe();
    if (!probe.ready || !probe.subjectKey) throw new Error('LOGIN_REQUIRED');
    if (expectedSubject && expectedSubject !== probe.subjectKey)
      throw new Error('SUBJECT_CHANGED');
    const subjectKey = probe.subjectKey;
    const query = async (
      input: Omit<SeniorQuery, 'subjectKey'>,
    ): Promise<unknown> => {
      await runner.check?.();
      const response = await runner.query({ ...input, subjectKey });
      await runner.check?.();
      if (!response.ok) throw new Error(response.code);
      return response.data;
    };
    // Try the following month first: the observed closing window is 21 → 20.
    // Coverage is always validated against server dates, never inferred from this order.
    const candidates: string[] = [];
    let month = monthOf(range.start);
    const last = shiftMonth(monthOf(range.end), 1);
    while (month <= last) {
      candidates.push(`${month}-01`);
      month = shiftMonth(month, 1);
    }
    candidates.unshift(`${shiftMonth(monthOf(range.start), 1)}-01`);
    candidates.push(`${shiftMonth(monthOf(range.start), -1)}-01`);
    const periods: {
      start: CivilDate;
      end: CivilDate;
      code: number;
      subject: string;
    }[] = [];
    const covered = (): boolean => {
      let cursor = range.start;
      for (const period of [...periods].sort((a, b) =>
        a.start.localeCompare(b.start),
      )) {
        if (period.end < cursor) continue;
        if (period.start > cursor) return false;
        if (period.end >= range.end) return true;
        cursor = nextDate(period.end);
      }
      return false;
    };
    for (const competence of new Set(candidates)) {
      const value = await query({ kind: 'period', competence });
      if (!record(value) || !record(value.result))
        throw new Error('SOURCE_DATA_INVALID');
      // A missing competence cannot establish coverage; continue the finite search.
      if (
        Object.keys(value.result).length === 0 ||
        value.result.codigoCalculo === null
      )
        continue;
      const c = value.result.codigoCalculo;
      const employee = value.result.colaborador;
      if (
        !record(c) ||
        !record(employee) ||
        typeof employee.id !== 'string' ||
        !employee.id ||
        !Number.isInteger(c.codigoCalculo)
      )
        throw new Error('SOURCE_DATA_INVALID');
      const start = date(c.inicioApuracao);
      const end = date(c.fimApuracao);
      if (start > end) throw new Error('SOURCE_DATA_INVALID');
      if (
        start <= range.end &&
        end >= range.start &&
        !periods.some(
          (p) => p.code === c.codigoCalculo && p.subject === employee.id,
        )
      )
        periods.push({
          start,
          end,
          code: c.codigoCalculo as number,
          subject: employee.id,
        });
      if (covered()) break;
    }
    if (!covered()) throw new Error('PERIOD_NOT_AVAILABLE');
    const days: CapturedPunchDay[] = [];
    const issues: SourceDayIssue[] = [];
    let cursor = range.start;
    for (const period of periods.sort((a, b) =>
      a.start.localeCompare(b.start),
    )) {
      if (period.end < cursor) continue;
      const start = cursor;
      const end = period.end < range.end ? period.end : range.end;
      const context = {
        calculationCode: period.code,
        resolvedSubject: period.subject,
        start,
        end,
      };
      let matched = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const count = await query({ ...context, kind: 'count' });
        if (
          !record(count) ||
          !record(count.result) ||
          !Number.isInteger(count.result.total) ||
          Number(count.result.total) < 0
        )
          throw new Error('SOURCE_DATA_INVALID');
        const value = await query({ ...context, kind: 'days' });
        const parsed = normalizeSeniorDays(
          value,
          { start, end },
          period.subject,
        );
        if (parsed.days.length !== count.result.total) continue;
        days.push(...parsed.days);
        issues.push(...parsed.issues);
        matched = true;
        break;
      }
      if (!matched) throw new Error('INCOMPLETE_RESPONSE');
      if (end >= range.end) break;
      cursor = nextDate(end);
    }
    return { ok: true, days, issues };
  } catch (error: unknown) {
    const code = error instanceof Error ? error.message : 'NETWORK_ERROR';
    const messages: Record<string, string> = {
      LOGIN_REQUIRED: 'Conclua o login na Senior e abra Meus acertos de ponto.',
      SUBJECT_CHANGED:
        'O colaborador da Senior mudou. Reconecte e capture novamente.',
      PERIOD_NOT_AVAILABLE:
        'A Senior não disponibilizou todas as competências necessárias ao intervalo.',
      INCOMPLETE_RESPONSE:
        'A contagem e os dias da Senior não conferem. Capture novamente.',
      CANCELLED: 'Captura da Senior cancelada.',
      CLIENT_UNAVAILABLE:
        'O cliente de consulta da Senior não está disponível.',
      ACCESS_DENIED: 'A Senior recusou acesso à consulta.',
    };
    return {
      ok: false,
      error: {
        code,
        message:
          messages[code] ??
          'Não foi possível validar as batidas da Senior. Reconecte e capture novamente.',
      },
    };
  }
}
