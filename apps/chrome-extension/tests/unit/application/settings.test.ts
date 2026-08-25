import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  defaultExtensionSettings,
  loadExtensionSettings,
  resolveChannelTagInCatalog,
  saveExtensionSettings,
} from '../../../src/application/settings';

afterEach(() => vi.unstubAllGlobals());

describe('preferências da extensão', () => {
  it('resolve uma TAG do Extrato contra rótulos codificados do catálogo', () => {
    const resolution = resolveChannelTagInCatalog(
      {
        id: 'inferred',
        name: 'Inferida',
        projectId: '',
        project: 'PETROBRAS_SUSTENTAÇÃO CERTIFICARE',
        activityId: '',
        activity: 'ME04_Medição de agosto.26',
      },
      {
        fetchedAt: '2026-08-24T12:00:00.000Z',
        projects: [
          {
            id: '78',
            label: 'F01C0078.0 PETROBRAS_SUSTENTAÇÃO CERTIFICARE',
            activities: [{ id: '904', label: 'ME04 Medição de agosto.26' }],
          },
        ],
      },
    );

    expect(resolution).toMatchObject({
      project: { id: '78' },
      activity: { id: '904' },
    });
  });

  it('inicia sem TAG particular ou padrão predefinido', () => {
    const settings = defaultExtensionSettings();
    expect(settings.tags).toEqual([]);
    expect(settings.defaultTagId).toBeUndefined();
    expect(settings.googleCalendar.accessMode).toBe('tab');
    expect(settings.googleCalendar.enabled).toBe(true);
    expect(
      settings.googleCalendar.rules.some(
        (rule) => rule.tagId === 'initial-default',
      ),
    ).toBe(false);
  });

  it('remove somente a antiga TAG particular conhecida ao migrar', async () => {
    const stored = {
      version: 1,
      tags: [
        {
          id: 'initial-default',
          name: 'Padrão',
          projectId: '',
          project: 'PROJETO PARTICULAR LEGADO',
          activityId: '',
          activity: 'ATIVIDADE PARTICULAR LEGADA',
          activityType: 'Nenhum',
          task: 'Nenhum',
        },
        {
          id: 'user-tag',
          name: 'TAG do usuário',
          projectId: '1',
          project: 'Projeto do usuário',
          activityId: '2',
          activity: 'Atividade do usuário',
        },
      ],
      defaultTagId: 'initial-default',
      fontScale: 1.3,
      fontScaleCustomized: true,
      theme: 'light',
      ragCatalogOverrides: [],
      markingTemplates: [],
      templateRules: [],
      googleCalendar: {
        enabled: false,
        accessMode: 'oauth',
        connected: false,
        calendars: [],
        selectedCalendarIds: [],
        rules: [],
        ragRuleImportVersion: 2,
      },
      punchAlerts: { enabled: false },
    };
    const set = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: () => Promise.resolve({ extensionSettings: stored }),
          set,
        },
      },
    });

    const loaded = await loadExtensionSettings();

    expect(loaded.tags).toEqual([expect.objectContaining({ id: 'user-tag' })]);
    expect(loaded.defaultTagId).toBeUndefined();
    expect(loaded.googleCalendar.accessMode).toBe('oauth');
    expect(loaded.googleCalendar.enabled).toBe(true);
    expect(set).toHaveBeenCalledOnce();
  });

  it('migra configurações anteriores para o tema claro sem perder dados', async () => {
    const stored = {
      version: 1,
      tags: [],
      fontScale: 1.2,
      fontScaleCustomized: true,
      markingTemplates: [],
      templateRules: [],
    };
    const set = vi.fn((items: Record<string, unknown>) => {
      void items;
      return Promise.resolve();
    });
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: () => Promise.resolve({ extensionSettings: stored }),
          set,
        },
      },
    });

    const loaded = await loadExtensionSettings();
    expect(loaded).toMatchObject({
      fontScale: 1.2,
      theme: 'light',
      tags: [],
      punchAlerts: { enabled: false },
      ragCatalogOverrides: [],
      googleCalendar: {
        enabled: true,
        accessMode: 'tab',
        ragRuleImportVersion: 2,
      },
    });
    expect(
      loaded.googleCalendar.rules.some(
        (rule) =>
          rule.ragCatalogId === 'reunioes-rag' &&
          rule.fields.length === 2 &&
          rule.fields[0] === 'title' &&
          rule.fields[1] === 'description',
      ),
    ).toBe(true);
    expect(set).toHaveBeenCalledOnce();
    expect(set.mock.calls[0]?.[0]?.extensionSettings).toMatchObject({
      theme: 'light',
      punchAlerts: { enabled: false },
      googleCalendar: { enabled: true, accessMode: 'tab' },
    });
  });

  it('persiste e restaura o tema escuro', async () => {
    let stored: unknown;
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: () => Promise.resolve({ extensionSettings: stored }),
          set: (items: Record<string, unknown>) => {
            stored = items.extensionSettings;
            return Promise.resolve();
          },
        },
      },
    });
    const dark = { ...defaultExtensionSettings(), theme: 'dark' as const };

    await saveExtensionSettings(dark);

    await expect(loadExtensionSettings()).resolves.toEqual(dark);
  });

  it('mantém ativa uma conexão Calendar criada antes do switch de uso', async () => {
    const defaults = defaultExtensionSettings();
    const { enabled: previousEnabled, ...legacyCalendar } =
      defaults.googleCalendar;
    void previousEnabled;
    const stored = {
      ...defaults,
      googleCalendar: { ...legacyCalendar, connected: true },
    };
    const set = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: () => Promise.resolve({ extensionSettings: stored }),
          set,
        },
      },
    });

    await expect(loadExtensionSettings()).resolves.toMatchObject({
      googleCalendar: { enabled: true, connected: true },
    });
    expect(set).toHaveBeenCalledOnce();
  });

  it('desliga ao migrar o monitor configurável antigo', async () => {
    const stored = {
      ...defaultExtensionSettings(),
      punchAlerts: {
        enabled: true,
        weekdays: [1, 2, 3, 4, 5],
        lunchExit: '12:00',
        lunchReturn: '13:00',
        workEnd: '18:00',
        graceMinutes: 10,
        soundEnabled: true,
      },
    };
    const set = vi.fn((items: Record<string, unknown>) => {
      void items;
      return Promise.resolve();
    });
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: () => Promise.resolve({ extensionSettings: stored }),
          set,
        },
      },
    });

    await expect(loadExtensionSettings()).resolves.toMatchObject({
      punchAlerts: { enabled: false },
    });
    expect(set.mock.calls[0]?.[0]?.extensionSettings).toMatchObject({
      punchAlerts: { enabled: false },
    });
  });
});
