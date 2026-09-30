import { civilDate } from './civil-date';
import type { CivilDate } from './types';

export type PunchSourceId = 'ahgora' | 'senior';
export interface DateRange {
  readonly start: CivilDate;
  readonly end: CivilDate;
}
export interface SourceSlice extends DateRange {
  readonly provider: PunchSourceId;
}
export const SENIOR_CUTOVER = civilDate('2026-09-21');
export const SOURCE_NAMES = { ahgora: 'Ahgora', senior: 'Senior' } as const;
export function sourceForDate(date: CivilDate): PunchSourceId {
  return date < SENIOR_CUTOVER ? 'ahgora' : 'senior';
}
export function planSourceSlices(
  range: DateRange,
  today: CivilDate,
): readonly SourceSlice[] {
  civilDate(range.start);
  civilDate(range.end);
  civilDate(today);
  if (range.start > range.end) throw new Error('Intervalo de ponto inválido.');
  const end = range.end < today ? range.end : today;
  if (range.start > end) return [];
  const slices: SourceSlice[] = [];
  if (range.start < SENIOR_CUTOVER)
    slices.push({
      provider: 'ahgora',
      start: range.start,
      end: end < SENIOR_CUTOVER ? end : civilDate('2026-09-20'),
    });
  if (end >= SENIOR_CUTOVER)
    slices.push({
      provider: 'senior',
      start: range.start > SENIOR_CUTOVER ? range.start : SENIOR_CUTOVER,
      end,
    });
  return slices;
}
