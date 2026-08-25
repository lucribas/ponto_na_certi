import type { CivilDate } from '../domain';
import { isRagCatalogSnapshot, type RagCatalogSnapshot } from './rag';
import { initializeRagCalendarRules } from './google-calendar';

export interface ChannelCatalogActivity {
  readonly id: string;
  readonly label: string;
}

export interface ChannelCatalogProject {
  readonly id: string;
  readonly label: string;
  readonly activities: readonly ChannelCatalogActivity[];
}

export interface ChannelCatalog {
  readonly fetchedAt: string;
  readonly projects: readonly ChannelCatalogProject[];
}

export interface ChannelTagCatalogResolution {
  readonly project: ChannelCatalogProject;
  readonly activity: ChannelCatalogActivity;
}

export interface ChannelTag {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly project: string;
  readonly activityId: string;
  readonly activity: string;
  readonly activityType?: string;
  readonly task?: string;
  readonly comments?: string;
}

export function resolveChannelTagInCatalog(
  tag: ChannelTag,
  catalog?: ChannelCatalog,
): ChannelTagCatalogResolution | undefined {
  const project = catalog?.projects.find(
    (candidate) =>
      candidate.id === tag.projectId ||
      channelCatalogLabelMatches(candidate.label, tag.project),
  );
  const activity = project?.activities.find(
    (candidate) =>
      candidate.id === tag.activityId ||
      channelCatalogLabelMatches(candidate.label, tag.activity),
  );
  return project && activity ? { project, activity } : undefined;
}

function channelCatalogLabelMatches(
  catalogLabel: string,
  observedLabel: string,
): boolean {
  const normalize = (value: string): string =>
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .toLocaleLowerCase('pt-BR');
  const catalog = normalize(catalogLabel);
  const observed = normalize(observedLabel);
  if (!catalog || !observed) return false;
  return (
    catalog === observed ||
    catalog.endsWith(` ${observed}`) ||
    observed.endsWith(` ${catalog}`)
  );
}

export interface MarkingTemplateEntry {
  readonly id: string;
  readonly tagId?: string;
  readonly ragCatalogId?: string;
  readonly ragItemId?: string;
  /** Percentual observado no dia de origem. */
  readonly percentage: number;
  /** Duração observada no dia de origem. */
  readonly durationMinutes: number;
}

export interface MarkingTemplate {
  readonly id: string;
  readonly name: string;
  readonly sourceDurationMinutes: number;
  readonly entries: readonly MarkingTemplateEntry[];
  readonly createdAt: string;
}

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type ColorTheme = 'light' | 'dark';

export interface PunchAlertSettings {
  readonly enabled: boolean;
}

export type CalendarEventField = 'title' | 'description' | 'location';
export type CalendarMatchMode = 'all' | 'any';
export type CalendarAccessMode = 'oauth' | 'tab';

export interface GoogleCalendarInfo {
  readonly id: string;
  readonly name: string;
  readonly primary?: boolean;
}

export interface GoogleCalendarRule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly calendarIds: readonly string[];
  readonly fields: readonly CalendarEventField[];
  readonly matchMode: CalendarMatchMode;
  readonly phrases: readonly string[];
  readonly excludedPhrases: readonly string[];
  /** Destino em Minhas TAGs ou TAG contextual exigida por um item RAG. */
  readonly tagId?: string;
  readonly ragCatalogId?: string;
  readonly ragItemId?: string;
  readonly ignoreCancelled: boolean;
  readonly ignoreDeclined: boolean;
  readonly ignoreAllDay: boolean;
  readonly busyOnly: boolean;
}

export interface GoogleCalendarSettings {
  /** Controla se os dados do Calendar participam das capturas. */
  readonly enabled?: boolean;
  /** `tab` é o padrão; OAuth permanece disponível como modo opcional. */
  readonly accessMode?: CalendarAccessMode;
  readonly connected: boolean;
  readonly accountEmail?: string;
  readonly calendars: readonly GoogleCalendarInfo[];
  readonly selectedCalendarIds: readonly string[];
  /** A ordem define a precedência: a primeira regra ativa compatível vence. */
  readonly rules: readonly GoogleCalendarRule[];
  readonly ragRuleImportVersion?: number;
  readonly lastSyncedAt?: string;
}

export interface RuleTemplateShare {
  readonly templateId: string;
  readonly percentage: number;
}

export type RecurrenceEnd =
  | { readonly kind: 'never' }
  | { readonly kind: 'on'; readonly date: CivilDate }
  | { readonly kind: 'after'; readonly occurrences: number };

export interface TemplateApplicationRule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly repeatEveryWeeks: number;
  readonly weekdays: readonly Weekday[];
  readonly startsOn: CivilDate;
  readonly ends: RecurrenceEnd;
  readonly templates: readonly RuleTemplateShare[];
}

export interface ExtensionSettings {
  readonly version: 1;
  readonly tags: readonly ChannelTag[];
  readonly defaultTagId?: string;
  readonly catalog?: ChannelCatalog;
  readonly fontScale: number;
  readonly fontScaleCustomized?: boolean;
  readonly theme: ColorTheme;
  readonly ragCatalogOverrides: readonly RagCatalogSnapshot[];
  readonly ragCatalogUpdatedAt?: string;
  readonly markingTemplates: readonly MarkingTemplate[];
  readonly templateRules: readonly TemplateApplicationRule[];
  readonly googleCalendar: GoogleCalendarSettings;
  readonly punchAlerts: PunchAlertSettings;
}

type StoredExtensionSettings = Omit<
  ExtensionSettings,
  | 'markingTemplates'
  | 'templateRules'
  | 'theme'
  | 'googleCalendar'
  | 'punchAlerts'
  | 'ragCatalogOverrides'
> & {
  readonly markingTemplates?: readonly MarkingTemplate[];
  readonly templateRules?: readonly TemplateApplicationRule[];
  readonly theme?: ColorTheme;
  readonly ragCatalogOverrides?: readonly RagCatalogSnapshot[];
  readonly googleCalendar?: GoogleCalendarSettings;
  readonly punchAlerts?: PunchAlertSettings;
};

const KEY = 'extensionSettings';

const LEGACY_PERSONAL_TAG_ID = 'initial-default';

export function defaultExtensionSettings(): ExtensionSettings {
  const googleCalendar = initializeRagCalendarRules({
    enabled: true,
    accessMode: 'tab',
    connected: false,
    calendars: [],
    selectedCalendarIds: [],
    rules: [],
  });
  return {
    version: 1,
    tags: [],
    fontScale: 1.3,
    fontScaleCustomized: false,
    theme: 'light',
    ragCatalogOverrides: [],
    markingTemplates: [],
    templateRules: [],
    googleCalendar,
    punchAlerts: defaultPunchAlertSettings(),
  };
}

export function defaultPunchAlertSettings(): PunchAlertSettings {
  return { enabled: false };
}

export async function loadExtensionSettings(): Promise<ExtensionSettings> {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  if (!isExtensionSettings(stored)) return defaultExtensionSettings();
  const removeLegacyPersonalTag = stored.tags.some(isLegacyPersonalTag);
  const tags = removeLegacyPersonalTag
    ? stored.tags.filter((tag) => !isLegacyPersonalTag(tag))
    : stored.tags;
  const defaultTagId = tags.some((tag) => tag.id === stored.defaultTagId)
    ? stored.defaultTagId
    : undefined;
  const legacyPunchAlerts =
    stored.punchAlerts !== undefined &&
    Object.keys(stored.punchAlerts).some((key) => key !== 'enabled');
  const rawGoogleCalendar = stored.googleCalendar ?? {
    enabled: true,
    accessMode: 'tab' as const,
    connected: false,
    calendars: [],
    selectedCalendarIds: [],
    rules: [],
  };
  const storedGoogleCalendar = removeLegacyPersonalTag
    ? {
        ...rawGoogleCalendar,
        rules: rawGoogleCalendar.rules.map((rule) => {
          if (rule.tagId !== LEGACY_PERSONAL_TAG_ID) return rule;
          const { tagId: previousTagId, ...withoutTag } = rule;
          void previousTagId;
          return withoutTag;
        }),
      }
    : rawGoogleCalendar;
  const googleCalendar = initializeRagCalendarRules(
    {
      ...storedGoogleCalendar,
      enabled: true,
      accessMode: storedGoogleCalendar.accessMode ?? 'tab',
    },
    defaultTagId,
  );
  const needsMigration =
    removeLegacyPersonalTag ||
    defaultTagId !== stored.defaultTagId ||
    stored.fontScaleCustomized === undefined ||
    stored.theme === undefined ||
    stored.ragCatalogOverrides === undefined ||
    stored.markingTemplates === undefined ||
    stored.templateRules === undefined ||
    stored.googleCalendar === undefined ||
    storedGoogleCalendar.enabled !== true ||
    storedGoogleCalendar.accessMode === undefined ||
    googleCalendar !== storedGoogleCalendar ||
    stored.punchAlerts === undefined ||
    legacyPunchAlerts;
  const { defaultTagId: previousDefaultTagId, ...storedWithoutDefault } =
    stored;
  void previousDefaultTagId;
  const normalized: ExtensionSettings = {
    ...storedWithoutDefault,
    tags,
    ...(defaultTagId === undefined ? {} : { defaultTagId }),
    fontScale:
      stored.fontScaleCustomized === undefined && stored.fontScale === 1
        ? 1.3
        : stored.fontScale,
    fontScaleCustomized: stored.fontScaleCustomized ?? stored.fontScale !== 1,
    theme: stored.theme ?? 'light',
    ragCatalogOverrides: stored.ragCatalogOverrides ?? [],
    markingTemplates: stored.markingTemplates ?? [],
    templateRules: stored.templateRules ?? [],
    googleCalendar,
    punchAlerts: {
      enabled: legacyPunchAlerts
        ? false
        : (stored.punchAlerts?.enabled ?? false),
    },
  };
  if (needsMigration) await saveExtensionSettings(normalized);
  return normalized;
}

function isLegacyPersonalTag(tag: ChannelTag): boolean {
  return tag.id === LEGACY_PERSONAL_TAG_ID;
}

export async function saveExtensionSettings(
  settings: ExtensionSettings,
): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}

function isExtensionSettings(value: unknown): value is StoredExtensionSettings {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.tags) &&
    typeof candidate.fontScale === 'number' &&
    (candidate.markingTemplates === undefined ||
      Array.isArray(candidate.markingTemplates)) &&
    (candidate.templateRules === undefined ||
      Array.isArray(candidate.templateRules)) &&
    (candidate.fontScaleCustomized === undefined ||
      typeof candidate.fontScaleCustomized === 'boolean') &&
    (candidate.theme === undefined ||
      candidate.theme === 'light' ||
      candidate.theme === 'dark') &&
    (candidate.ragCatalogOverrides === undefined ||
      (Array.isArray(candidate.ragCatalogOverrides) &&
        candidate.ragCatalogOverrides.every(isRagCatalogSnapshot))) &&
    (candidate.ragCatalogUpdatedAt === undefined ||
      typeof candidate.ragCatalogUpdatedAt === 'string') &&
    (candidate.punchAlerts === undefined ||
      isPunchAlertSettings(candidate.punchAlerts))
  );
}

function isPunchAlertSettings(value: unknown): value is PunchAlertSettings {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.enabled === 'boolean';
}
