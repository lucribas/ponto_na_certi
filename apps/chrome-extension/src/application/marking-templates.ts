import {
  civilDate,
  formatDurationMinutes,
  parseDurationMinutes,
} from '../domain';
import type { CivilDate } from '../domain';
import type { PreviewAllocation } from './types';
import type {
  MarkingTemplate,
  MarkingTemplateEntry,
  TemplateApplicationRule,
  Weekday,
} from './settings';

export type TemplateApplicationBasis = 'percentage' | 'duration';
export type TemplateOverflowStrategy = 'reject' | 'scale';

export interface TemplateAllocationDraft {
  readonly mode: TemplateApplicationBasis;
  readonly value: string;
  readonly durationMinutes: number;
  readonly duration: string;
  readonly tagId?: string;
  readonly ragCatalogId?: string;
  readonly ragItemId?: string;
  readonly isRemainder: boolean;
}

export interface AutomaticTemplateApplication {
  readonly rule: TemplateApplicationRule;
  readonly allocations: readonly TemplateAllocationDraft[];
}

export class TemplateOverflowError extends Error {
  constructor(
    readonly requestedMinutes: number,
    readonly availableMinutes: number,
  ) {
    super(
      `O template totaliza ${formatDurationMinutes(requestedMinutes)}, mas o dia possui ${formatDurationMinutes(availableMinutes)}.`,
    );
    this.name = 'TemplateOverflowError';
  }
}

export function createMarkingTemplate(
  id: string,
  name: string,
  sourceDuration: string,
  allocations: readonly PreviewAllocation[],
  createdAt: string,
): MarkingTemplate {
  const sourceDurationMinutes = parseDurationMinutes(sourceDuration);
  if (sourceDurationMinutes <= 0)
    throw new Error('O dia precisa ter duração positiva.');
  if (allocations.length === 0)
    throw new Error('O dia ainda não possui marcações para salvar.');
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error('Informe um nome para o template.');
  const entries = allocations.map((allocation, index) => ({
    id: `${id}::${String(index + 1)}`,
    percentage: percentageOf(allocation.durationMinutes, sourceDurationMinutes),
    durationMinutes: allocation.durationMinutes,
    ...(allocation.tagId === undefined ? {} : { tagId: allocation.tagId }),
    ...(allocation.ragCatalogId === undefined
      ? {}
      : { ragCatalogId: allocation.ragCatalogId }),
    ...(allocation.ragItemId === undefined
      ? {}
      : { ragItemId: allocation.ragItemId }),
  }));
  return {
    id,
    name: normalizedName,
    sourceDurationMinutes,
    entries,
    createdAt,
  };
}

export function applyMarkingTemplate(
  template: MarkingTemplate,
  totalMinutes: number,
  basis: TemplateApplicationBasis,
  overflowStrategy: TemplateOverflowStrategy,
  defaultTagId?: string,
): readonly TemplateAllocationDraft[] {
  ensureApplicableTemplate(template, totalMinutes);
  if (basis === 'percentage') {
    return allocationsFromWeights(
      template.entries.map((entry) => ({ entry, weight: entry.percentage })),
      totalMinutes,
      totalMinutes,
      'percentage',
      defaultTagId,
    );
  }

  const requestedMinutes = template.entries.reduce(
    (total, entry) => total + entry.durationMinutes,
    0,
  );
  if (requestedMinutes > totalMinutes) {
    if (overflowStrategy === 'reject')
      throw new TemplateOverflowError(requestedMinutes, totalMinutes);
    return allocationsFromWeights(
      template.entries.map((entry) => ({
        entry,
        weight: entry.durationMinutes,
      })),
      totalMinutes,
      totalMinutes,
      'duration',
      defaultTagId,
    );
  }

  const allocations: TemplateAllocationDraft[] = template.entries.map((entry) =>
    draftFromEntry(entry, entry.durationMinutes, 'duration', false),
  );
  const remainderMinutes = totalMinutes - requestedMinutes;
  if (remainderMinutes > 0) {
    allocations.push({
      mode: 'duration',
      value: formatDurationMinutes(remainderMinutes),
      durationMinutes: remainderMinutes,
      duration: formatDurationMinutes(remainderMinutes),
      ...(defaultTagId === undefined ? {} : { tagId: defaultTagId }),
      isRemainder: true,
    });
  } else if (allocations.length > 0) {
    const last = allocations.at(-1);
    if (last)
      allocations[allocations.length - 1] = { ...last, isRemainder: true };
  }
  return allocations;
}

export function automaticTemplateApplication(
  rules: readonly TemplateApplicationRule[],
  templates: readonly MarkingTemplate[],
  date: CivilDate,
  totalMinutes: number,
  defaultTagId?: string,
): AutomaticTemplateApplication | undefined {
  const rule = rules.find(
    (candidate) =>
      candidate.enabled &&
      matchesTemplateRule(candidate, date) &&
      candidate.templates.some((share) =>
        templates.some((template) => template.id === share.templateId),
      ),
  );
  if (!rule) return undefined;
  const weightedEntries = rule.templates.flatMap((share) => {
    const template = templates.find(
      (candidate) => candidate.id === share.templateId,
    );
    if (!template || share.percentage <= 0) return [];
    const totalTemplatePercentage = template.entries.reduce(
      (total, entry) => total + entry.percentage,
      0,
    );
    if (totalTemplatePercentage <= 0) return [];
    return template.entries.map((entry) => ({
      entry,
      weight: (share.percentage * entry.percentage) / totalTemplatePercentage,
    }));
  });
  if (weightedEntries.length === 0) return undefined;
  const requestedPercentage = Math.min(
    100,
    rule.templates.reduce((total, share) => total + share.percentage, 0),
  );
  const assignedMinutes = Math.round(
    (totalMinutes * requestedPercentage) / 100,
  );
  return {
    rule,
    allocations: allocationsFromWeights(
      weightedEntries,
      totalMinutes,
      assignedMinutes,
      'percentage',
      defaultTagId,
    ),
  };
}

export function matchesTemplateRule(
  rule: TemplateApplicationRule,
  date: CivilDate,
): boolean {
  if (date < rule.startsOn || rule.repeatEveryWeeks < 1) return false;
  if (!rule.weekdays.includes(weekdayOf(date))) return false;
  const elapsedWeeks = Math.floor(
    daysBetween(startOfWeek(rule.startsOn), startOfWeek(date)) / 7,
  );
  if (elapsedWeeks % rule.repeatEveryWeeks !== 0) return false;
  if (rule.ends.kind === 'on' && date > rule.ends.date) return false;
  if (rule.ends.kind === 'after')
    return occurrenceNumber(rule, date) <= rule.ends.occurrences;
  return true;
}

export function describeTemplateRule(rule: TemplateApplicationRule): string {
  const days = [...rule.weekdays]
    .sort((left, right) => weekdayOrder(left) - weekdayOrder(right))
    .map((day) => WEEKDAY_SHORT[day])
    .join(', ');
  const frequency =
    rule.repeatEveryWeeks === 1
      ? 'Toda semana'
      : `A cada ${String(rule.repeatEveryWeeks)} semanas`;
  const ending =
    rule.ends.kind === 'never'
      ? 'sem término'
      : rule.ends.kind === 'on'
        ? `até ${formatCivilDate(rule.ends.date)}`
        : `por ${String(rule.ends.occurrences)} ocorrência(s)`;
  return `${frequency}, em ${days || 'nenhum dia'}, a partir de ${formatCivilDate(rule.startsOn)}, ${ending}.`;
}

export function totalTemplateDuration(template: MarkingTemplate): number {
  return template.entries.reduce(
    (total, entry) => total + entry.durationMinutes,
    0,
  );
}

function ensureApplicableTemplate(
  template: MarkingTemplate,
  totalMinutes: number,
): void {
  if (totalMinutes <= 0) throw new Error('Duração do novo dia indisponível.');
  if (template.entries.length === 0)
    throw new Error('O template não possui marcações.');
}

function allocationsFromWeights(
  weightedEntries: readonly {
    readonly entry: MarkingTemplateEntry;
    readonly weight: number;
  }[],
  totalDayMinutes: number,
  assignedMinutes: number,
  mode: TemplateApplicationBasis,
  defaultTagId?: string,
): readonly TemplateAllocationDraft[] {
  const minutes = distributeMinutes(
    assignedMinutes,
    weightedEntries.map(({ weight }) => weight),
  );
  const allocations = weightedEntries.flatMap(({ entry }, index) => {
    const durationMinutes = minutes[index] ?? 0;
    return durationMinutes > 0
      ? [draftFromEntry(entry, durationMinutes, mode, false, totalDayMinutes)]
      : [];
  });
  const remainderMinutes = totalDayMinutes - assignedMinutes;
  if (remainderMinutes > 0) {
    allocations.push({
      mode,
      value:
        mode === 'percentage'
          ? String(percentageOf(remainderMinutes, totalDayMinutes))
          : formatDurationMinutes(remainderMinutes),
      durationMinutes: remainderMinutes,
      duration: formatDurationMinutes(remainderMinutes),
      ...(defaultTagId === undefined ? {} : { tagId: defaultTagId }),
      isRemainder: true,
    });
  } else {
    const last = allocations.at(-1);
    if (last)
      allocations[allocations.length - 1] = { ...last, isRemainder: true };
  }
  return allocations;
}

function draftFromEntry(
  entry: MarkingTemplateEntry,
  durationMinutes: number,
  mode: TemplateApplicationBasis,
  isRemainder: boolean,
  totalDayMinutes = durationMinutes,
): TemplateAllocationDraft {
  return {
    mode,
    value:
      mode === 'percentage'
        ? String(percentageOf(durationMinutes, totalDayMinutes))
        : formatDurationMinutes(durationMinutes),
    durationMinutes,
    duration: formatDurationMinutes(durationMinutes),
    ...(entry.tagId === undefined ? {} : { tagId: entry.tagId }),
    ...(entry.ragCatalogId === undefined
      ? {}
      : { ragCatalogId: entry.ragCatalogId }),
    ...(entry.ragItemId === undefined ? {} : { ragItemId: entry.ragItemId }),
    isRemainder,
  };
}

function distributeMinutes(
  totalMinutes: number,
  weights: readonly number[],
): readonly number[] {
  const positiveWeights = weights.map((weight) => Math.max(0, weight));
  const totalWeight = positiveWeights.reduce(
    (total, weight) => total + weight,
    0,
  );
  if (totalWeight <= 0)
    throw new Error('O template não possui proporções válidas.');
  const exact = positiveWeights.map(
    (weight) => (totalMinutes * weight) / totalWeight,
  );
  const result = exact.map(Math.floor);
  let remainder =
    totalMinutes - result.reduce((total, value) => total + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort(
      (left, right) =>
        right.fraction - left.fraction || left.index - right.index,
    );
  for (const { index } of order) {
    if (remainder <= 0) break;
    result[index] = (result[index] ?? 0) + 1;
    remainder -= 1;
  }
  return result;
}

function occurrenceNumber(
  rule: TemplateApplicationRule,
  date: CivilDate,
): number {
  let count = 0;
  let cursor = rule.startsOn;
  while (cursor <= date) {
    if (matchesRuleWithoutEnd(rule, cursor)) count += 1;
    cursor = addDays(cursor, 1);
  }
  return count;
}

function matchesRuleWithoutEnd(
  rule: TemplateApplicationRule,
  date: CivilDate,
): boolean {
  if (date < rule.startsOn || !rule.weekdays.includes(weekdayOf(date)))
    return false;
  const elapsedWeeks = Math.floor(
    daysBetween(startOfWeek(rule.startsOn), startOfWeek(date)) / 7,
  );
  return elapsedWeeks % rule.repeatEveryWeeks === 0;
}

function weekdayOf(date: CivilDate): Weekday {
  return asUtcDate(date).getUTCDay() as Weekday;
}

function weekdayOrder(day: Weekday): number {
  return day === 0 ? 7 : day;
}

function startOfWeek(date: CivilDate): CivilDate {
  const value = asUtcDate(date);
  const day = value.getUTCDay();
  value.setUTCDate(value.getUTCDate() - (day === 0 ? 6 : day - 1));
  return fromUtcDate(value);
}

function addDays(date: CivilDate, days: number): CivilDate {
  const value = asUtcDate(date);
  value.setUTCDate(value.getUTCDate() + days);
  return fromUtcDate(value);
}

function daysBetween(start: CivilDate, end: CivilDate): number {
  return Math.round(
    (asUtcDate(end).getTime() - asUtcDate(start).getTime()) / 86_400_000,
  );
}

function asUtcDate(date: CivilDate): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
}

function fromUtcDate(date: Date): CivilDate {
  return civilDate(
    `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`,
  );
}

function formatCivilDate(date: CivilDate): string {
  const [year, month, day] = date.split('-');
  return `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
}

function percentageOf(minutes: number, totalMinutes: number): number {
  return Number(((minutes * 100) / totalMinutes).toFixed(4));
}

const WEEKDAY_SHORT: Readonly<Record<Weekday, string>> = {
  0: 'dom.',
  1: 'seg.',
  2: 'ter.',
  3: 'qua.',
  4: 'qui.',
  5: 'sex.',
  6: 'sáb.',
};
