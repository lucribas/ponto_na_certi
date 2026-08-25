import { civilDate, type CivilDate } from '../domain';
import { findRagItem, ragCatalogs, type RagItem } from './rag';
import type { GoogleCalendarRule, GoogleCalendarSettings } from './settings';

export const RAG_CALENDAR_RULE_IMPORT_VERSION = 2;
const AUTOMATIC_RAG_CATALOG_ID = 'reunioes-rag';
const AUTOMATIC_RULE_ID_PREFIX = 'calendar-rag:';
const LEGACY_DUPLICATE_RAG_ITEM_IDS: Readonly<Record<string, string>> = {
  'reunioes-rag:012:design-review': 'reunioes-rag:010:design-review',
  'reunioes-rag:014:design-review': 'reunioes-rag:010:design-review',
};

export interface CalendarEvent {
  readonly id: string;
  readonly calendarId: string;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly status?: string;
  readonly selfResponseStatus?: string;
  readonly transparency?: string;
}

export interface CalendarEventMatch {
  readonly event: CalendarEvent;
  readonly rule: GoogleCalendarRule;
  readonly matchedPhrases: readonly string[];
}

export interface CalendarAllocationDraft {
  readonly date: CivilDate;
  readonly eventId: string;
  readonly eventTitle: string;
  readonly start: string;
  readonly end: string;
  readonly durationMinutes: number;
  readonly tagId?: string;
  readonly ragCatalogId?: string;
  readonly ragItemId?: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly matchedPhrases: readonly string[];
}

export interface CalendarComposition {
  readonly allocationsByDate: ReadonlyMap<
    CivilDate,
    readonly CalendarAllocationDraft[]
  >;
  readonly conflictsByDate: ReadonlyMap<CivilDate, readonly string[]>;
  readonly matchedEventCount: number;
}

/**
 * Importação única e idempotente das regras do RAG. Regras já associadas ao
 * mesmo item são preservadas e impedem a criação de uma segunda regra. A
 * versão 2 amplia regras automáticas ainda limitadas ao título para também
 * pesquisar na descrição do evento.
 */
export function initializeRagCalendarRules(
  settings: GoogleCalendarSettings,
  defaultTagId?: string,
): GoogleCalendarSettings {
  if (settings.ragRuleImportVersion === RAG_CALENDAR_RULE_IMPORT_VERSION)
    return settings;
  const catalog = ragCatalogs.find(({ id }) => id === AUTOMATIC_RAG_CATALOG_ID);
  if (!catalog) return settings;

  const migratedRules = settings.rules.map((rule) => {
    const canonicalItemId =
      rule.ragCatalogId === AUTOMATIC_RAG_CATALOG_ID && rule.ragItemId
        ? LEGACY_DUPLICATE_RAG_ITEM_IDS[rule.ragItemId]
        : undefined;
    const canonicalRule: GoogleCalendarRule = canonicalItemId
      ? { ...rule, ragItemId: canonicalItemId }
      : rule;
    return isImportedRagCalendarRule(canonicalRule) &&
      canonicalRule.fields.length === 1 &&
      canonicalRule.fields[0] === 'title'
      ? { ...canonicalRule, fields: ['title', 'description'] as const }
      : canonicalRule;
  });
  const existingTargets = new Set(
    migratedRules.flatMap((rule) =>
      rule.ragCatalogId && rule.ragItemId
        ? [`${rule.ragCatalogId}\u0000${rule.ragItemId}`]
        : [],
    ),
  );
  const seenEvents = new Set<string>();
  const generated: GoogleCalendarRule[] = [];
  for (const item of catalog.items) {
    if (item.kind === 'SKIP') continue;
    const eventKey = normalizeCalendarText(item.event);
    if (!eventKey || seenEvents.has(eventKey)) continue;
    seenEvents.add(eventKey);
    const targetKey = `${catalog.id}\u0000${item.id}`;
    if (existingTargets.has(targetKey)) continue;
    generated.push(automaticRagRule(catalog.id, item, defaultTagId));
    existingTargets.add(targetKey);
  }
  return {
    ...settings,
    ragRuleImportVersion: RAG_CALENDAR_RULE_IMPORT_VERSION,
    rules: [...migratedRules, ...generated],
  };
}

/**
 * Completa regras RAG contextuais que nasceram antes de existir uma TAG
 * padrão. Regras que já apontam para uma TAG escolhida pelo usuário são
 * preservadas.
 */
export function assignDefaultTagToContextualRagRules(
  settings: GoogleCalendarSettings,
  defaultTagId: string,
): GoogleCalendarSettings {
  const rules = settings.rules.map((rule) => {
    if (rule.tagId !== undefined) return rule;
    const item = findRagItem(rule.ragCatalogId, rule.ragItemId);
    const needsContextualTag =
      item?.kind === 'PROJECT' &&
      (item.channel.projectSource === 'TAG' ||
        item.channel.activitySource === 'TAG');
    if (!needsContextualTag) return rule;
    return { ...rule, tagId: defaultTagId };
  });
  return rules.some((rule, index) => rule !== settings.rules[index])
    ? { ...settings, rules }
    : settings;
}

export function isContextualRagCalendarRule(rule: GoogleCalendarRule): boolean {
  const item = findRagItem(rule.ragCatalogId, rule.ragItemId);
  return (
    item?.kind === 'PROJECT' &&
    (item.channel.projectSource === 'TAG' ||
      item.channel.activitySource === 'TAG')
  );
}

/**
 * Substitui a TAG de regras RAG contextuais sem alterar regras cujo destino
 * foi configurado diretamente. Sem substituta, a regra fica pendente até uma
 * nova TAG padrão ser escolhida.
 */
export function reassignContextualRagRulesTag(
  settings: GoogleCalendarSettings,
  previousTagId: string,
  replacementTagId?: string,
): GoogleCalendarSettings {
  const rules = settings.rules.map((rule): GoogleCalendarRule => {
    if (rule.tagId !== previousTagId || !isContextualRagCalendarRule(rule))
      return rule;
    if (replacementTagId !== undefined)
      return { ...rule, tagId: replacementTagId };
    const { tagId: removedTagId, ...withoutTag } = rule;
    void removedTagId;
    return withoutTag;
  });
  return rules.some((rule, index) => rule !== settings.rules[index])
    ? { ...settings, rules }
    : settings;
}

export function automaticRagRule(
  catalogId: string,
  item: RagItem,
  defaultTagId?: string,
): GoogleCalendarRule {
  const needsContextualTag =
    item.kind === 'PROJECT' &&
    (item.channel.projectSource === 'TAG' ||
      item.channel.activitySource === 'TAG');
  return {
    id: `${AUTOMATIC_RULE_ID_PREFIX}${item.id}`,
    name: `RAG · ${item.event}`,
    enabled: true,
    calendarIds: [],
    fields: ['title', 'description'],
    matchMode: 'all',
    phrases: [item.event],
    excludedPhrases: [],
    ragCatalogId: catalogId,
    ragItemId: item.id,
    ...(needsContextualTag && defaultTagId ? { tagId: defaultTagId } : {}),
    ignoreCancelled: true,
    ignoreDeclined: true,
    ignoreAllDay: true,
    busyOnly: false,
  };
}

/**
 * Atualiza somente nome/frase de uma regra automática que ainda coincide por
 * completo com o padrão do item antes da edição. Regras personalizadas ficam
 * intocadas.
 */
export function renameUnmodifiedAutomaticRagRule(
  rule: GoogleCalendarRule,
  previousItem: RagItem,
  nextEvent: string,
  defaultTagId?: string,
): GoogleCalendarRule {
  const expected = automaticRagRule(
    AUTOMATIC_RAG_CATALOG_ID,
    previousItem,
    defaultTagId,
  );
  if (!sameAutomaticRule(rule, expected)) return rule;
  return { ...rule, name: `RAG · ${nextEvent}`, phrases: [nextEvent] };
}

function sameAutomaticRule(
  rule: GoogleCalendarRule,
  expected: GoogleCalendarRule,
): boolean {
  const sameList = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
  return (
    rule.id === expected.id &&
    rule.name === expected.name &&
    rule.enabled === expected.enabled &&
    sameList(rule.calendarIds, expected.calendarIds) &&
    sameList(rule.fields, expected.fields) &&
    rule.matchMode === expected.matchMode &&
    sameList(rule.phrases, expected.phrases) &&
    sameList(rule.excludedPhrases, expected.excludedPhrases) &&
    rule.tagId === expected.tagId &&
    rule.ragCatalogId === expected.ragCatalogId &&
    rule.ragItemId === expected.ragItemId &&
    rule.ignoreCancelled === expected.ignoreCancelled &&
    rule.ignoreDeclined === expected.ignoreDeclined &&
    rule.ignoreAllDay === expected.ignoreAllDay &&
    rule.busyOnly === expected.busyOnly
  );
}

export function isImportedRagCalendarRule(rule: GoogleCalendarRule): boolean {
  return (
    rule.id.startsWith(AUTOMATIC_RULE_ID_PREFIX) &&
    rule.ragCatalogId === AUTOMATIC_RAG_CATALOG_ID &&
    rule.ragItemId !== undefined
  );
}

/** Recria uma regra importada com os valores originais do catálogo RAG. */
export function restoreImportedRagCalendarRule(
  rule: GoogleCalendarRule,
  defaultTagId?: string,
): GoogleCalendarRule | undefined {
  if (!isImportedRagCalendarRule(rule)) return undefined;
  const item = findRagItem(rule.ragCatalogId, rule.ragItemId);
  if (!item || item.kind === 'SKIP') return undefined;
  return automaticRagRule(AUTOMATIC_RAG_CATALOG_ID, item, defaultTagId);
}

export function normalizeCalendarText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchCalendarEvent(
  event: CalendarEvent,
  rules: readonly GoogleCalendarRule[],
): CalendarEventMatch | undefined {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (
      rule.calendarIds.length > 0 &&
      !rule.calendarIds.includes(event.calendarId)
    )
      continue;
    if (rule.ignoreCancelled && event.status === 'cancelled') continue;
    if (rule.ignoreDeclined && event.selfResponseStatus === 'declined')
      continue;
    if (rule.ignoreAllDay && event.allDay) continue;
    if (rule.busyOnly && event.transparency === 'transparent') continue;

    const searchable = normalizeCalendarText(
      rule.fields
        .map((field) =>
          field === 'title'
            ? event.title
            : field === 'description'
              ? (event.description ?? '')
              : (event.location ?? ''),
        )
        .join(' '),
    );
    const phrases = rule.phrases.map(normalizeCalendarText).filter(Boolean);
    const excluded = rule.excludedPhrases
      .map(normalizeCalendarText)
      .filter(Boolean);
    if (
      phrases.length === 0 ||
      excluded.some((term) => searchable.includes(term))
    )
      continue;
    const matched = phrases.filter((term) => searchable.includes(term));
    if (
      (rule.matchMode === 'all' && matched.length !== phrases.length) ||
      (rule.matchMode === 'any' && matched.length === 0)
    )
      continue;
    return { event, rule, matchedPhrases: matched };
  }
  return undefined;
}

export function composeCalendarEvents(
  events: readonly CalendarEvent[],
  settings: GoogleCalendarSettings,
  validTagIds: ReadonlySet<string>,
): CalendarComposition {
  const byDate = new Map<CivilDate, CalendarAllocationDraft[]>();
  const conflicts = new Map<CivilDate, string[]>();
  let matchedEventCount = 0;
  for (const event of events) {
    const match = matchCalendarEvent(event, settings.rules);
    if (!match) continue;
    matchedEventCount += 1;
    const segments = splitEventByDay(match);
    for (const allocation of segments) {
      const entries = byDate.get(allocation.date) ?? [];
      entries.push(allocation);
      byDate.set(allocation.date, entries);
      const ragItem = findRagItem(
        match.rule.ragCatalogId,
        match.rule.ragItemId,
      );
      const needsContextualTag =
        ragItem?.kind === 'PROJECT' &&
        (ragItem.channel.projectSource === 'TAG' ||
          ragItem.channel.activitySource === 'TAG');
      if (match.rule.ragCatalogId && (!ragItem || ragItem.kind === 'SKIP')) {
        addConflict(
          conflicts,
          allocation.date,
          `A regra “${match.rule.name}” aponta para um item de fonte indisponível.`,
        );
      } else if (
        (!match.rule.ragCatalogId || needsContextualTag) &&
        (match.rule.tagId === undefined || !validTagIds.has(match.rule.tagId))
      ) {
        addConflict(
          conflicts,
          allocation.date,
          `A regra “${match.rule.name}” aponta para uma TAG indisponível.`,
        );
      }
    }
  }
  for (const [date, allocations] of byDate) {
    allocations.sort((left, right) => left.start.localeCompare(right.start));
    for (let index = 1; index < allocations.length; index += 1) {
      const previous = allocations[index - 1];
      const current = allocations[index];
      if (
        previous &&
        current &&
        Date.parse(current.start) < Date.parse(previous.end)
      ) {
        addConflict(
          conflicts,
          date,
          'Há eventos do Calendar sobrepostos neste dia.',
        );
        break;
      }
    }
  }
  return {
    allocationsByDate: byDate,
    conflictsByDate: conflicts,
    matchedEventCount,
  };
}

function splitEventByDay(match: CalendarEventMatch): CalendarAllocationDraft[] {
  const start = new Date(match.event.start);
  const end = new Date(match.event.end);
  if (!Number.isFinite(start.getTime()) || end <= start) return [];
  const allocations: CalendarAllocationDraft[] = [];
  let cursor = start;
  while (cursor < end) {
    const nextDay = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate() + 1,
    );
    const segmentEnd = nextDay < end ? nextDay : end;
    const durationMinutes = Math.round(
      (segmentEnd.getTime() - cursor.getTime()) / 60_000,
    );
    if (durationMinutes > 0) {
      allocations.push({
        date: localCivilDate(cursor),
        eventId: match.event.id,
        eventTitle: match.event.title || 'Evento sem título',
        start: cursor.toISOString(),
        end: segmentEnd.toISOString(),
        durationMinutes,
        ...(match.rule.tagId === undefined ? {} : { tagId: match.rule.tagId }),
        ...(match.rule.ragCatalogId === undefined
          ? {}
          : { ragCatalogId: match.rule.ragCatalogId }),
        ...(match.rule.ragItemId === undefined
          ? {}
          : { ragItemId: match.rule.ragItemId }),
        ruleId: match.rule.id,
        ruleName: match.rule.name,
        matchedPhrases: match.matchedPhrases,
      });
    }
    cursor = segmentEnd;
  }
  return allocations;
}

function localCivilDate(value: Date): CivilDate {
  return civilDate(
    `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`,
  );
}

function addConflict(
  conflicts: Map<CivilDate, string[]>,
  date: CivilDate,
  message: string,
): void {
  const current = conflicts.get(date) ?? [];
  if (!current.includes(message)) current.push(message);
  conflicts.set(date, current);
}
