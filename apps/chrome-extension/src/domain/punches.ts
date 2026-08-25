import { assertIntegerMinutes, formatRubyDurationMinutes } from './duration';
import type { CivilDate, ComparableWorkRecord, PunchDay } from './types';

const PUNCH_TIME_PATTERN = /^\d{2}:\d{2}$/;

export interface PunchOverride {
  readonly date: CivilDate;
  readonly times: readonly string[];
}

export type PunchWarning =
  | {
      readonly kind: 'odd-punch-count';
      readonly date: CivilDate;
      readonly count: number;
    }
  | {
      readonly kind: 'unusual-time';
      readonly date: CivilDate;
      readonly time: string;
    }
  | {
      readonly kind: 'inverted-pair';
      readonly date: CivilDate;
      readonly start: string;
      readonly end: string;
    };

export interface CalculatedWorkRecord extends ComparableWorkRecord {
  readonly times: readonly string[];
  readonly overridden: boolean;
}

export interface PunchCalculation {
  readonly records: readonly CalculatedWorkRecord[];
  readonly warnings: readonly PunchWarning[];
}

export function calculatePunchDays(
  days: readonly PunchDay[],
  overrides: readonly PunchOverride[] = [],
): PunchCalculation {
  const overrideByDate = firstOverrideByDate(overrides);
  const records: CalculatedWorkRecord[] = [];
  const warnings: PunchWarning[] = [];

  for (const day of days) {
    const override = overrideByDate.get(day.date);
    const times = override?.times ?? day.times;
    validatePunchTimes(times, day.date, override !== undefined);

    for (const time of times) {
      if (isOutsideUsualClockRange(time)) {
        warnings.push({ kind: 'unusual-time', date: day.date, time });
      }
    }

    if (times.length === 0) {
      continue;
    }
    if (times.length % 2 !== 0) {
      warnings.push({
        kind: 'odd-punch-count',
        date: day.date,
        count: times.length,
      });
      continue;
    }

    let durationMinutes = 0;
    for (let index = 0; index < times.length; index += 2) {
      const start = times[index];
      const end = times[index + 1];
      if (start === undefined || end === undefined) {
        break;
      }
      const pairMinutes = punchTimeToMinutes(end) - punchTimeToMinutes(start);
      if (pairMinutes < 0) {
        warnings.push({ kind: 'inverted-pair', date: day.date, start, end });
      }
      durationMinutes += pairMinutes;
    }
    assertIntegerMinutes(durationMinutes);
    records.push({
      date: day.date,
      durationMinutes,
      duration: formatRubyDurationMinutes(durationMinutes),
      times: [...times],
      overridden: override !== undefined,
    });
  }

  return { records, warnings };
}

export function punchTimeToMinutes(value: string): number {
  if (!PUNCH_TIME_PATTERN.test(value)) {
    throw new Error(`Batida inválida: ${value}`);
  }
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(3, 5));
  return hours * 60 + minutes;
}

function firstOverrideByDate(
  overrides: readonly PunchOverride[],
): ReadonlyMap<CivilDate, PunchOverride> {
  const result = new Map<CivilDate, PunchOverride>();
  for (const override of overrides) {
    if (!result.has(override.date)) {
      result.set(override.date, override);
    }
  }
  return result;
}

function validatePunchTimes(
  times: readonly string[],
  date: CivilDate,
  isOverride: boolean,
): void {
  if (isOverride && times.length === 0) {
    throw new Error(`Override de batidas inválido para ${date}`);
  }
  if (times.some((time) => !PUNCH_TIME_PATTERN.test(time))) {
    const source = isOverride ? 'Override de batidas' : 'Batida';
    throw new Error(`${source} inválido para ${date}`);
  }
}

function isOutsideUsualClockRange(value: string): boolean {
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(3, 5));
  return hours > 23 || minutes > 59;
}
