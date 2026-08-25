import {
  compareCivilDates,
  makeCivilDate,
  makeClosingMonth,
  monthParts,
  shiftMonth,
  type CivilDate,
  type ClosingMonth,
} from '../../domain';
import type { ParsedMirrorMonthDto, SourceParseWarning } from './contracts';

const PUNCH_PATTERN = /^\d{2}:\d{2}$/;
const WEEKDAY_ABBREVIATION_PATTERN = /^[A-Za-z]{3}$/;
const CALENDAR_END_HEADERS = new Set(['Saturday', 'Sat']);

export class SourceCalendarParseError extends Error {
  override readonly name = 'SourceCalendarParseError';
}

export function parseMirrorCalendarText(
  bodyText: string,
  month: ClosingMonth,
): ParsedMirrorMonthDto {
  const lines = bodyText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const calendarHeading = lines.findIndex((line) =>
    CALENDAR_END_HEADERS.has(line),
  );
  if (calendarHeading < 0) {
    throw new SourceCalendarParseError(
      'Início do calendário do Ahgora não encontrado',
    );
  }

  const calendarStart = calendarHeading + 1;
  const summaryStart = lines.findIndex(
    (line, index) => index >= calendarStart && line === 'MONTHLY SUMMARY',
  );
  if (summaryStart < 0) {
    throw new SourceCalendarParseError(
      'Resumo mensal do Ahgora não encontrado',
    );
  }
  const tokens = lines.slice(calendarStart, summaryStart);
  const days = [];
  const warnings: SourceParseWarning[] = [];
  let position = 0;

  const selected = monthParts(month);
  const previous = monthParts(shiftMonth(month, -1));
  const start = makeCivilDate(previous.year, previous.month, 26);
  const end = makeCivilDate(selected.year, selected.month, 25);

  for (const date of civilDateRange(start, end)) {
    const day = Number(date.slice(8, 10)).toString();
    const relativePosition = tokens.slice(position).indexOf(day);
    if (relativePosition < 0) {
      throw new SourceCalendarParseError(
        `Dia ${formatBrazilianDate(date)} não encontrado no calendário`,
      );
    }
    position += relativePosition + 1;
    if (WEEKDAY_ABBREVIATION_PATTERN.test(tokens[position] ?? '')) position++;
    if (tokens[position] === 'star') position++;

    const times: string[] = [];
    while (PUNCH_PATTERN.test(tokens[position] ?? '')) {
      times.push(tokens[position] ?? '');
      position++;
    }
    if (times.length % 2 !== 0) {
      warnings.push({
        kind: 'odd-punch-count',
        date,
        count: times.length,
      });
    }
    days.push({ date, times });
  }

  return { month, days, warnings };
}

export function filterParsedDays(
  parsed: ParsedMirrorMonthDto,
  start: CivilDate,
  end: CivilDate,
): ParsedMirrorMonthDto {
  const includedDates = new Set(
    parsed.days
      .filter(
        ({ date }) =>
          compareCivilDates(date, start) >= 0 &&
          compareCivilDates(date, end) <= 0,
      )
      .map(({ date }) => date),
  );
  return {
    ...parsed,
    days: parsed.days.filter(({ date }) => includedDates.has(date)),
    warnings: parsed.warnings.filter(({ date }) => includedDates.has(date)),
  };
}

function civilDateRange(
  start: CivilDate,
  end: CivilDate,
): readonly CivilDate[] {
  const result: CivilDate[] = [];
  let cursor = start;
  while (compareCivilDates(cursor, end) <= 0) {
    result.push(cursor);
    cursor = nextCivilDate(cursor);
  }
  return result;
}

function nextCivilDate(date: CivilDate): CivilDate {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  try {
    return makeCivilDate(year, month, day + 1);
  } catch {
    if (month === 12) return makeCivilDate(year + 1, 1, 1);
    const nextMonth = makeClosingMonth(year, month + 1);
    const parts = monthParts(nextMonth);
    return makeCivilDate(parts.year, parts.month, 1);
  }
}

function formatBrazilianDate(date: CivilDate): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}
