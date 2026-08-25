import { describe, expect, it } from 'vitest';

import {
  assignDefaultTagToContextualRagRules,
  automaticRagRule,
  composeCalendarEvents,
  initializeRagCalendarRules,
  isContextualRagCalendarRule,
  isImportedRagCalendarRule,
  matchCalendarEvent,
  normalizeCalendarText,
  reassignContextualRagRulesTag,
  renameUnmodifiedAutomaticRagRule,
  restoreImportedRagCalendarRule,
  type CalendarEvent,
} from '../../../src/application/google-calendar';
import type {
  GoogleCalendarRule,
  GoogleCalendarSettings,
} from '../../../src/application/settings';
import { ragCatalogs } from '../../../src/application/rag';
import { civilDate } from '../../../src/domain';

const event: CalendarEvent = {
  id: 'event-1',
  calendarId: 'primary',
  title: 'DÁILY — Cliente Álfa',
  description: 'Acompanhamento do projeto',
  location: 'Meet',
  start: '2026-08-24T09:00:00-03:00',
  end: '2026-08-24T09:30:00-03:00',
  allDay: false,
  status: 'confirmed',
  selfResponseStatus: 'accepted',
  transparency: 'opaque',
};

function rule(overrides: Partial<GoogleCalendarRule> = {}): GoogleCalendarRule {
  return {
    id: 'rule-1',
    name: 'Daily Alfa',
    enabled: true,
    calendarIds: [],
    fields: ['title', 'description'],
    matchMode: 'all',
    phrases: ['daily', 'cliente alfa'],
    excludedPhrases: [],
    tagId: 'tag-alfa',
    ignoreCancelled: true,
    ignoreDeclined: true,
    ignoreAllDay: true,
    busyOnly: true,
    ...overrides,
  };
}

function settings(
  rules: readonly GoogleCalendarRule[],
): GoogleCalendarSettings {
  return {
    connected: true,
    calendars: [{ id: 'primary', name: 'Principal', primary: true }],
    selectedCalendarIds: ['primary'],
    rules,
  };
}

describe('regras do Google Calendar', () => {
  it('inicializa uma regra única por item do JSON RAG usando título e descrição', () => {
    const initialized = initializeRagCalendarRules(
      {
        connected: false,
        calendars: [],
        selectedCalendarIds: [],
        rules: [],
      },
      'tag-default',
    );
    const catalog = ragCatalogs.find(({ id }) => id === 'reunioes-rag');
    if (!catalog) throw new Error('Catálogo RAG ausente.');

    expect(initialized.rules).toHaveLength(catalog.items.length);
    expect(
      new Set(initialized.rules.map(({ ragItemId }) => ragItemId)).size,
    ).toBe(catalog.items.length);
    for (const item of catalog.items) {
      expect(
        initialized.rules.find(({ ragItemId }) => ragItemId === item.id),
      ).toMatchObject({
        enabled: true,
        fields: ['title', 'description'],
        matchMode: 'all',
        phrases: [item.event],
        ragCatalogId: catalog.id,
        ragItemId: item.id,
      });
    }
    const designReviewRule = initialized.rules.find(
      ({ ragItemId }) => ragItemId === 'reunioes-rag:010:design-review',
    );
    if (!designReviewRule) throw new Error('Regra automática ausente.');
    expect(
      matchCalendarEvent(
        { ...event, title: 'Projeto Alfa — Design Review semanal' },
        [designReviewRule],
      ),
    ).toBeDefined();
    expect(
      matchCalendarEvent(
        {
          ...event,
          title: 'Projeto Alfa',
          description: 'Design Review semanal',
        },
        [designReviewRule],
      ),
    ).toBeDefined();
  });

  it('preserva uma regra existente e não duplica a importação ao inicializar novamente', () => {
    const catalog = ragCatalogs.find(({ id }) => id === 'reunioes-rag');
    const item = catalog?.items[0];
    if (!catalog || !item) throw new Error('Fixture RAG ausente.');
    const existing = rule({
      id: 'custom-existing',
      ragCatalogId: catalog.id,
      ragItemId: item.id,
      phrases: [item.event],
      fields: ['title'],
    });
    const initialized = initializeRagCalendarRules({
      connected: false,
      calendars: [],
      selectedCalendarIds: [],
      rules: [existing],
    });

    expect(initialized.rules).toHaveLength(catalog.items.length);
    expect(initialized.rules[0]).toBe(existing);
    expect(initializeRagCalendarRules(initialized)).toBe(initialized);
  });

  it('migra regras automáticas da versão 1 para pesquisar título e descrição', () => {
    const catalog = ragCatalogs.find(({ id }) => id === 'reunioes-rag');
    const item = catalog?.items[0];
    if (!catalog || !item) throw new Error('Fixture RAG ausente.');
    const importedV1 = rule({
      id: `calendar-rag:${item.id}`,
      name: `RAG · ${item.event}`,
      ragCatalogId: catalog.id,
      ragItemId: item.id,
      fields: ['title'],
      phrases: [item.event],
    });

    const migrated = initializeRagCalendarRules({
      connected: false,
      calendars: [],
      selectedCalendarIds: [],
      rules: [importedV1],
      ragRuleImportVersion: 1,
    });

    expect(migrated.ragRuleImportVersion).toBe(2);
    expect(migrated.rules[0]).toMatchObject({
      id: importedV1.id,
      fields: ['title', 'description'],
    });
    expect(
      migrated.rules.filter((candidate) => candidate.ragItemId === item.id),
    ).toHaveLength(1);
  });

  it('identifica e restaura uma regra importada do RAG', () => {
    const imported = initializeRagCalendarRules({
      connected: false,
      calendars: [],
      selectedCalendarIds: [],
      rules: [],
    }).rules[0];
    if (!imported) throw new Error('Regra automática ausente.');
    const edited = {
      ...imported,
      name: 'Nome alterado',
      enabled: false,
      fields: ['description'] as const,
      phrases: ['texto alterado'],
      busyOnly: true,
    };

    expect(isImportedRagCalendarRule(edited)).toBe(true);
    expect(restoreImportedRagCalendarRule(edited)).toMatchObject({
      id: imported.id,
      name: imported.name,
      enabled: true,
      fields: ['title', 'description'],
      phrases: imported.phrases,
      busyOnly: false,
    });
    expect(
      restoreImportedRagCalendarRule({ ...edited, id: 'manual-rule' }),
    ).toBeUndefined();
  });

  it('renomeia somente regra automática ainda no padrão anterior', () => {
    const item = ragCatalogs.find(({ id }) => id === 'reunioes-rag')?.items[0];
    if (!item) throw new Error('Item RAG ausente.');
    const automatic = automaticRagRule('reunioes-rag', item, 'tag-default');

    expect(
      renameUnmodifiedAutomaticRagRule(
        automatic,
        item,
        'Evento renomeado',
        'tag-default',
      ),
    ).toMatchObject({
      name: 'RAG · Evento renomeado',
      phrases: ['Evento renomeado'],
    });

    const customized = { ...automatic, phrases: ['frase personalizada'] };
    expect(
      renameUnmodifiedAutomaticRagRule(
        customized,
        item,
        'Evento renomeado',
        'tag-default',
      ),
    ).toBe(customized);
  });

  it('associa a nova TAG padrão apenas às regras RAG contextuais sem destino', () => {
    const catalog = ragCatalogs.find(({ id }) => id === 'reunioes-rag');
    const contextual = catalog?.items.find(
      (item) =>
        item.kind === 'PROJECT' &&
        (item.channel.projectSource === 'TAG' ||
          item.channel.activitySource === 'TAG'),
    );
    if (!catalog || !contextual)
      throw new Error('Item RAG contextual ausente.');
    const pending = automaticRagRule(catalog.id, contextual);
    const customized = { ...pending, id: 'customized', tagId: 'chosen-tag' };
    const settings: GoogleCalendarSettings = {
      connected: false,
      calendars: [],
      selectedCalendarIds: [],
      rules: [pending, customized],
    };

    const updated = assignDefaultTagToContextualRagRules(
      settings,
      'inferred-tag',
    );

    expect(updated.rules[0]?.tagId).toBe('inferred-tag');
    expect(updated.rules[1]?.tagId).toBe('chosen-tag');
  });

  it('libera a TAG de regras RAG contextuais sem alterar destinos diretos', () => {
    const catalog = ragCatalogs.find(({ id }) => id === 'reunioes-rag');
    const contextual = catalog?.items.find(
      (item) =>
        item.kind === 'PROJECT' &&
        (item.channel.projectSource === 'TAG' ||
          item.channel.activitySource === 'TAG'),
    );
    if (!catalog || !contextual)
      throw new Error('Item RAG contextual ausente.');
    const contextualRule = automaticRagRule(
      catalog.id,
      contextual,
      'tag-incorreta',
    );
    const directRule = rule({ id: 'direct', tagId: 'tag-incorreta' });
    const settings: GoogleCalendarSettings = {
      connected: false,
      calendars: [],
      selectedCalendarIds: [],
      rules: [contextualRule, directRule],
    };

    expect(isContextualRagCalendarRule(contextualRule)).toBe(true);
    expect(isContextualRagCalendarRule(directRule)).toBe(false);

    const reassigned = reassignContextualRagRulesTag(
      settings,
      'tag-incorreta',
      'tag-correta',
    );
    expect(reassigned.rules[0]?.tagId).toBe('tag-correta');
    expect(reassigned.rules[1]?.tagId).toBe('tag-incorreta');

    const pending = reassignContextualRagRulesTag(settings, 'tag-incorreta');
    expect(pending.rules[0]).not.toHaveProperty('tagId');
    expect(pending.rules[1]?.tagId).toBe('tag-incorreta');
  });

  it('migra referências dos Design Reviews removidos para o item canônico', () => {
    const existing = rule({
      id: 'legacy-design-review',
      ragCatalogId: 'reunioes-rag',
      ragItemId: 'reunioes-rag:014:design-review',
      fields: ['title'],
      phrases: ['Design Review'],
    });
    const initialized = initializeRagCalendarRules({
      connected: false,
      calendars: [],
      selectedCalendarIds: [],
      rules: [existing],
    });

    expect(initialized.rules[0]).toMatchObject({
      id: existing.id,
      ragItemId: 'reunioes-rag:010:design-review',
    });
    expect(
      initialized.rules.filter(
        ({ ragItemId }) => ragItemId === 'reunioes-rag:010:design-review',
      ),
    ).toHaveLength(1);
  });

  it('normaliza acentos e aplica a primeira regra ativa compatível', () => {
    expect(normalizeCalendarText('  REUNIÃO   Ágil ')).toBe('reuniao agil');
    const first = rule({ id: 'first', name: 'Primeira' });
    const second = rule({ id: 'second', name: 'Segunda' });

    expect(matchCalendarEvent(event, [first, second])?.rule.id).toBe('first');
  });

  it('suporta OU, campos selecionados, termos proibidos e políticas', () => {
    expect(
      matchCalendarEvent(event, [
        rule({
          matchMode: 'any',
          fields: ['location'],
          phrases: ['presencial', 'meet'],
        }),
      ]),
    ).toBeDefined();
    expect(
      matchCalendarEvent(event, [rule({ excludedPhrases: ['projeto'] })]),
    ).toBeUndefined();
    expect(
      matchCalendarEvent({ ...event, status: 'cancelled' }, [rule()]),
    ).toBeUndefined();
    expect(
      matchCalendarEvent({ ...event, transparency: 'transparent' }, [rule()]),
    ).toBeUndefined();
  });

  it('reserva a duração e sinaliza sobreposição e TAG removida', () => {
    const second = {
      ...event,
      id: 'event-2',
      start: '2026-08-24T09:15:00-03:00',
      end: '2026-08-24T10:00:00-03:00',
    };
    const result = composeCalendarEvents(
      [event, second],
      settings([rule()]),
      new Set<string>(),
    );
    const date = civilDate('2026-08-24');

    expect(
      result.allocationsByDate.get(date)?.map((item) => item.durationMinutes),
    ).toEqual([30, 45]);
    expect(result.conflictsByDate.get(date)).toEqual(
      expect.arrayContaining([
        'Há eventos do Calendar sobrepostos neste dia.',
        'A regra “Daily Alfa” aponta para uma TAG indisponível.',
      ]),
    );
  });

  it('divide um evento que atravessa a meia-noite', () => {
    const result = composeCalendarEvents(
      [
        {
          ...event,
          start: '2026-08-24T23:30:00-03:00',
          end: '2026-08-25T00:30:00-03:00',
        },
      ],
      settings([rule()]),
      new Set(['tag-alfa']),
    );

    expect(
      result.allocationsByDate.get(civilDate('2026-08-24'))?.[0]
        ?.durationMinutes,
    ).toBe(30);
    expect(
      result.allocationsByDate.get(civilDate('2026-08-25'))?.[0]
        ?.durationMinutes,
    ).toBe(30);
  });

  it('transporta um item RAG da regra até a alocação do evento', () => {
    const catalog = ragCatalogs.find((entry) =>
      entry.items.some((item) => item.kind === 'AD_HOC'),
    );
    const ragItem = catalog?.items.find((item) => item.kind === 'AD_HOC');
    if (!catalog || !ragItem) throw new Error('Fixture RAG ausente.');
    const { tagId: previousTagId, ...withoutTag } = rule();
    void previousTagId;
    const result = composeCalendarEvents(
      [event],
      settings([
        {
          ...withoutTag,
          ragCatalogId: catalog.id,
          ragItemId: ragItem.id,
        },
      ]),
      new Set(),
    );
    const allocation = result.allocationsByDate.get(
      civilDate('2026-08-24'),
    )?.[0];

    expect(allocation).toMatchObject({
      ragCatalogId: catalog.id,
      ragItemId: ragItem.id,
      durationMinutes: 30,
    });
    expect(allocation).not.toHaveProperty('tagId');
    expect(result.conflictsByDate.size).toBe(0);
  });
});
