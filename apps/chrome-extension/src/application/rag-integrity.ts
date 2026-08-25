import type { ExtensionSettings, MarkingTemplate } from './settings';

export interface RagTarget {
  readonly catalogId: string;
  readonly itemId: string;
}

export interface RagReferenceSummary {
  readonly calendarRules: number;
  readonly templateEntries: number;
  readonly total: number;
}

function targetKey(target: RagTarget): string {
  return `${target.catalogId}\u0000${target.itemId}`;
}

function referencesTarget(
  value: { readonly ragCatalogId?: string; readonly ragItemId?: string },
  target: RagTarget,
): boolean {
  return (
    value.ragCatalogId === target.catalogId && value.ragItemId === target.itemId
  );
}

export function countRagReferences(
  settings: ExtensionSettings,
  targets: readonly RagTarget[],
): RagReferenceSummary {
  const keys = new Set(targets.map(targetKey));
  const matches = (value: {
    readonly ragCatalogId?: string;
    readonly ragItemId?: string;
  }): boolean =>
    value.ragCatalogId !== undefined &&
    value.ragItemId !== undefined &&
    keys.has(
      targetKey({ catalogId: value.ragCatalogId, itemId: value.ragItemId }),
    );
  const calendarRules = settings.googleCalendar.rules.filter(matches).length;
  const templateEntries = settings.markingTemplates.reduce(
    (total, template) => total + template.entries.filter(matches).length,
    0,
  );
  return {
    calendarRules,
    templateEntries,
    total: calendarRules + templateEntries,
  };
}

export function reassignRagReferences(
  settings: ExtensionSettings,
  from: RagTarget,
  to: RagTarget,
): ExtensionSettings {
  const replace = <
    T extends { readonly ragCatalogId?: string; readonly ragItemId?: string },
  >(
    value: T,
  ): T =>
    referencesTarget(value, from)
      ? { ...value, ragCatalogId: to.catalogId, ragItemId: to.itemId }
      : value;
  return {
    ...settings,
    googleCalendar: {
      ...settings.googleCalendar,
      rules: settings.googleCalendar.rules.map(replace),
    },
    markingTemplates: settings.markingTemplates.map(
      (template): MarkingTemplate => ({
        ...template,
        entries: template.entries.map(replace),
      }),
    ),
  };
}

/** Remove consumidores de alvos que deixarão de existir, evitando referências órfãs. */
export function removeRagReferences(
  settings: ExtensionSettings,
  targets: readonly RagTarget[],
): ExtensionSettings {
  const keys = new Set(targets.map(targetKey));
  const keep = (value: {
    readonly ragCatalogId?: string;
    readonly ragItemId?: string;
  }): boolean =>
    value.ragCatalogId === undefined ||
    value.ragItemId === undefined ||
    !keys.has(
      targetKey({ catalogId: value.ragCatalogId, itemId: value.ragItemId }),
    );
  const markingTemplates = settings.markingTemplates
    .map((template): MarkingTemplate => ({
      ...template,
      entries: template.entries.filter(keep),
    }))
    .filter((template) => template.entries.length > 0);
  const survivingTemplateIds = new Set(
    markingTemplates.map((template) => template.id),
  );
  const templateRules = settings.templateRules.flatMap((rule) => {
    const templates = rule.templates.filter(({ templateId }) =>
      survivingTemplateIds.has(templateId),
    );
    if (templates.length === rule.templates.length) return [rule];
    const total = templates.reduce(
      (sum, { percentage }) => sum + percentage,
      0,
    );
    if (templates.length === 0 || total <= 0) return [];
    let assigned = 0;
    const normalizedTemplates = templates.map((share, index) => {
      const percentage =
        index === templates.length - 1
          ? 100 - assigned
          : Number(((share.percentage * 100) / total).toFixed(4));
      assigned += percentage;
      return { ...share, percentage };
    });
    return [{ ...rule, templates: normalizedTemplates }];
  });
  return {
    ...settings,
    googleCalendar: {
      ...settings.googleCalendar,
      rules: settings.googleCalendar.rules.filter(keep),
    },
    markingTemplates,
    templateRules,
  };
}
