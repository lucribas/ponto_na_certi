import { describe, expect, it } from 'vitest';

import {
  countRagReferences,
  reassignRagReferences,
  removeRagReferences,
} from '../../../src/application/rag-integrity';
import { defaultExtensionSettings } from '../../../src/application/settings';

const from = { catalogId: 'reunioes-rag', itemId: 'item-a' };
const to = { catalogId: 'reunioes-por-area', itemId: 'item-b' };

function referencedSettings() {
  const base = defaultExtensionSettings();
  const firstRule = base.googleCalendar.rules[0];
  if (!firstRule) throw new Error('Regra automática ausente.');
  return {
    ...base,
    googleCalendar: {
      ...base.googleCalendar,
      rules: [
        {
          ...firstRule,
          id: 'calendar-reference',
          ragCatalogId: from.catalogId,
          ragItemId: from.itemId,
        },
      ],
    },
    markingTemplates: [
      {
        id: 'template-1',
        name: 'Template',
        sourceDurationMinutes: 60,
        createdAt: '2026-08-24T12:00:00.000Z',
        entries: [
          {
            id: 'entry-1',
            ragCatalogId: from.catalogId,
            ragItemId: from.itemId,
            percentage: 100,
            durationMinutes: 60,
          },
        ],
      },
      {
        id: 'template-preserved',
        name: 'Template preservado',
        sourceDurationMinutes: 60,
        createdAt: '2026-08-24T12:00:00.000Z',
        entries: [
          {
            id: 'entry-preserved',
            tagId: 'initial-default',
            percentage: 100,
            durationMinutes: 60,
          },
        ],
      },
    ],
    templateRules: [
      {
        id: 'rule-mixed',
        name: 'Regra mista',
        enabled: true,
        repeatEveryWeeks: 1,
        weekdays: [1] as const,
        startsOn: '2026-08-24' as const,
        ends: { kind: 'never' as const },
        templates: [
          { templateId: 'template-1', percentage: 50 },
          { templateId: 'template-preserved', percentage: 50 },
        ],
      },
      {
        id: 'rule-removed',
        name: 'Regra removida',
        enabled: true,
        repeatEveryWeeks: 1,
        weekdays: [2] as const,
        startsOn: '2026-08-24' as const,
        ends: { kind: 'never' as const },
        templates: [{ templateId: 'template-1', percentage: 100 }],
      },
      {
        id: 'rule-preserved',
        name: 'Regra personalizada preservada',
        enabled: false,
        repeatEveryWeeks: 3,
        weekdays: [4] as const,
        startsOn: '2026-08-24' as const,
        ends: { kind: 'after' as const, occurrences: 7 },
        templates: [{ templateId: 'template-preserved', percentage: 100 }],
      },
    ],
  };
}

describe('integridade de referências RAG', () => {
  it('conta e reatribui regras e entradas de template juntas', () => {
    const settings = referencedSettings();

    expect(countRagReferences(settings, [from])).toEqual({
      calendarRules: 1,
      templateEntries: 1,
      total: 2,
    });

    const reassigned = reassignRagReferences(settings, from, to);
    expect(reassigned.googleCalendar.rules[0]).toMatchObject({
      ragCatalogId: to.catalogId,
      ragItemId: to.itemId,
    });
    expect(reassigned.markingTemplates[0]?.entries[0]).toMatchObject({
      ragCatalogId: to.catalogId,
      ragItemId: to.itemId,
    });
    expect(reassigned.markingTemplates[1]).toEqual(
      settings.markingTemplates[1],
    );
    expect(reassigned.templateRules).toEqual(settings.templateRules);
    expect(countRagReferences(reassigned, [from]).total).toBe(0);
  });

  it('remove consumidores e templates esvaziados sem manter regras órfãs', () => {
    const cleaned = removeRagReferences(referencedSettings(), [from]);

    expect(cleaned.googleCalendar.rules).toEqual([]);
    expect(cleaned.markingTemplates.map(({ id }) => id)).toEqual([
      'template-preserved',
    ]);
    expect(cleaned.templateRules).toEqual([
      expect.objectContaining({
        id: 'rule-mixed',
        templates: [{ templateId: 'template-preserved', percentage: 100 }],
      }),
      referencedSettings().templateRules[2],
    ]);
  });
});
