import {
  compareCivilDates,
  makeCivilDate,
  monthParts,
  shiftMonth,
  type CivilDate,
  type ClosingMonth,
} from '../../../src/domain';

export function makeMirrorCalendarText(
  month: ClosingMonth,
  timesByDate: Readonly<Record<string, readonly string[]>> = {},
): string {
  const selected = monthParts(month);
  const previous = monthParts(shiftMonth(month, -1));
  const start = makeCivilDate(previous.year, previous.month, 26);
  const end = makeCivilDate(selected.year, selected.month, 25);
  const tokens = [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];

  let cursor = start;
  while (compareCivilDates(cursor, end) <= 0) {
    tokens.push(String(Number(cursor.slice(8, 10))), 'Mon');
    tokens.push(...(timesByDate[cursor] ?? []));
    cursor = nextDay(cursor);
  }
  tokens.push('MONTHLY SUMMARY', 'Horas Trabalhadas');
  return tokens.join('\n');
}

function nextDay(date: CivilDate): CivilDate {
  const cursor = new Date(`${date}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  return cursor.toISOString().slice(0, 10) as CivilDate;
}
