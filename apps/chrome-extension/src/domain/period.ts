import {
  closingMonth,
  compareCivilDates,
  dateParts,
  makeCivilDate,
  makeClosingMonth,
  monthOf,
  monthParts,
  shiftMonth,
  type Clock,
} from './civil-date';
import type { CivilDate, ClosingMonth } from './types';

export type PeriodRequest =
  | { readonly kind: 'default' }
  | { readonly kind: 'month'; readonly month: ClosingMonth }
  | {
      readonly kind: 'range';
      readonly start: CivilDate;
      readonly end: CivilDate;
    };

export interface ResolvedPeriod {
  readonly mode: PeriodRequest['kind'];
  readonly start: CivilDate;
  readonly end: CivilDate;
  readonly mirrorMonths: readonly ClosingMonth[];
}

export function defaultPeriod(): PeriodRequest {
  return { kind: 'default' };
}

export function monthPeriod(month: string): PeriodRequest {
  return { kind: 'month', month: closingMonth(month) };
}

export function rangePeriod(start: CivilDate, end: CivilDate): PeriodRequest {
  if (compareCivilDates(start, end) > 0) {
    throw new Error('A data inicial deve ser anterior ou igual à data final');
  }
  return { kind: 'range', start, end };
}

export function resolvePeriod(
  request: PeriodRequest,
  clock: Clock,
): ResolvedPeriod {
  switch (request.kind) {
    case 'default': {
      const selectedMonth = shiftMonth(monthOf(clock.today()), -1);
      return closingWindow('default', selectedMonth);
    }
    case 'month':
      return closingWindow('month', request.month);
    case 'range':
      if (compareCivilDates(request.start, request.end) > 0) {
        throw new Error(
          'A data inicial deve ser anterior ou igual à data final',
        );
      }
      return {
        mode: 'range',
        start: request.start,
        end: request.end,
        mirrorMonths: mirrorMonthsForRange(request.start, request.end),
      };
  }
}

export function mirrorMonthForDate(date: CivilDate): ClosingMonth {
  const month = monthOf(date);
  return dateParts(date).day >= 26 ? shiftMonth(month, 1) : month;
}

export function mirrorMonthsForRange(
  start: CivilDate,
  end: CivilDate,
): readonly ClosingMonth[] {
  if (compareCivilDates(start, end) > 0) {
    throw new Error('A data inicial deve ser anterior ou igual à data final');
  }

  const first = mirrorMonthForDate(start);
  const last = mirrorMonthForDate(end);
  const result: ClosingMonth[] = [];
  let current = first;
  while (current <= last) {
    result.push(current);
    current = shiftMonth(current, 1);
  }
  return result;
}

function closingWindow(
  mode: 'default' | 'month',
  selectedMonth: ClosingMonth,
): ResolvedPeriod {
  const previous = monthParts(shiftMonth(selectedMonth, -1));
  const selected = monthParts(selectedMonth);
  return {
    mode,
    start: makeCivilDate(previous.year, previous.month, 26),
    end: makeCivilDate(selected.year, selected.month, 25),
    mirrorMonths: [makeClosingMonth(selected.year, selected.month)],
  };
}
