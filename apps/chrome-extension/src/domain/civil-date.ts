import type { CivilDate, ClosingMonth } from './types';

const CIVIL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOSING_MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

interface MonthParts {
  readonly year: number;
  readonly month: number;
}

export interface Clock {
  today(): CivilDate;
}

export function civilDate(value: string): CivilDate {
  const match = CIVIL_DATE_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Data civil inválida: ${value}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`Data civil inválida: ${value}`);
  }

  return value as CivilDate;
}

export function closingMonth(value: string): ClosingMonth {
  const match = CLOSING_MONTH_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Mês de fechamento inválido: ${value}`);
  }

  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Mês de fechamento inválido: ${value}`);
  }

  return value as ClosingMonth;
}

export function dateParts(value: CivilDate): DateParts {
  const match = CIVIL_DATE_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Data civil inválida: ${value}`);
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

export function monthParts(value: ClosingMonth): MonthParts {
  const match = CLOSING_MONTH_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Mês de fechamento inválido: ${value}`);
  }

  return { year: Number(match[1]), month: Number(match[2]) };
}

export function makeCivilDate(
  year: number,
  month: number,
  day: number,
): CivilDate {
  return civilDate(`${pad(year, 4)}-${pad(month)}-${pad(day)}`);
}

export function makeClosingMonth(year: number, month: number): ClosingMonth {
  return closingMonth(`${pad(year, 4)}-${pad(month)}`);
}

export function shiftMonth(value: ClosingMonth, delta: number): ClosingMonth {
  const { year, month } = monthParts(value);
  const absoluteMonth = year * 12 + (month - 1) + delta;
  const shiftedYear = Math.floor(absoluteMonth / 12);
  const shiftedMonth = modulo(absoluteMonth, 12) + 1;
  return makeClosingMonth(shiftedYear, shiftedMonth);
}

export function monthOf(value: CivilDate): ClosingMonth {
  const { year, month } = dateParts(value);
  return makeClosingMonth(year, month);
}

export function compareCivilDates(left: CivilDate, right: CivilDate): number {
  return left.localeCompare(right);
}

export function formatBrazilianDate(value: CivilDate): string {
  const { year, month, day } = dateParts(value);
  return `${pad(day)}/${pad(month)}/${pad(year, 4)}`;
}

export function fixedClock(today: string): Clock {
  const parsedToday = civilDate(today);
  return { today: () => parsedToday };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0');
}
