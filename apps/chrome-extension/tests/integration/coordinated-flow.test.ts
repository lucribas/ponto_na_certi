import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  advanceQueue,
  applyTemplateToItem,
  cancelOperation,
  captureAndCompareOperation,
  decideItem,
  editDivergentItem,
  fillCurrentQueueItem,
  fillSelectedQueue,
  prepareItemQueue,
  prepareSelectedQueue,
  reconcileCompletedWrite,
  setAllocationTag,
  selectItemTag,
  selectRemainingItems,
  updateAllocation,
  type CoordinatorAdapters,
} from '../../src/background/coordinator';
import {
  emptyOperation,
  publicState,
  type CaptureProgress,
  type OperationData,
  type WriteProgress,
} from '../../src/application/types';
import { ragCatalogs } from '../../src/application/rag';
import {
  civilDate,
  monthPeriod,
  type ProjectAssignment,
} from '../../src/domain';
import {
  captureAhgora,
  captureAhgoraMonthInDocument,
  probeAhgoraDocument,
  type AhgoraProbeDto,
  type FrameExecution,
  type InjectedMonthCaptureDto,
  type MonthCaptureInput,
  type SourceScriptRunner,
} from '../../src/sites/source';
import {
  runInjectedChannelFill,
  runInjectedChannelRead,
} from '../../src/sites/target';
import { makeMirrorCalendarText } from '../fixtures/source/mirror-calendar';

const projectRoot = resolve(import.meta.dirname, '../..');

describe('coordenador real sobre DOM sintético', () => {
  it('cria a TAG padrão pela marcação válida mais recente lida do Channel', async () => {
    const base = configuredState('infer-channel-default-tag');
    if (!base.config) throw new Error('Configuração sintética ausente.');
    const { defaultTagId: _defaultTagId, ...configWithoutDefaultTag } =
      base.config;
    void _defaultTagId;
    const state: OperationData = {
      ...base,
      config: {
        ...configWithoutDefaultTag,
        project: '',
        activity: '',
        tags: [],
      },
    };
    const preview = await captureAndCompareOperation(state, {
      today: civilDate('2026-08-24'),
      captureSource: () =>
        Promise.resolve({
          ok: true,
          tabId: 10,
          frameId: 0,
          months: [],
          days: [
            {
              date: civilDate('2026-07-30'),
              times: ['08:00', '12:00', '13:00', '17:00'],
            },
          ],
          warnings: [],
          realDomValidation: 'manual-validation-pending',
        }),
      readTarget: () =>
        Promise.resolve({
          ok: true,
          rows: [
            {
              rowIndex: 0,
              date: '2026-07-27',
              duration: '08:00',
              durationMinutes: 480,
              markings: [
                {
                  id: 'older',
                  date: '2026-07-27',
                  duration: '08:00',
                  durationMinutes: 480,
                  project: 'PROJETO ANTIGO',
                  activity: 'ATIVIDADE ANTIGA',
                  canDelete: true,
                },
              ],
            },
            {
              rowIndex: 1,
              date: '2026-07-29',
              duration: '08:00',
              durationMinutes: 480,
              markings: [
                {
                  id: 'latest',
                  date: '2026-07-29',
                  duration: '08:00',
                  durationMinutes: 480,
                  project: 'PROJETO MAIS RECENTE',
                  activity: 'ATIVIDADE MAIS RECENTE',
                  canDelete: true,
                },
              ],
            },
          ],
          errors: [],
        }),
      writeTarget: () =>
        Promise.resolve({
          date: civilDate('2026-07-30'),
          requestedMinutes: 0,
          status: 'failed',
        }),
    });

    const defaultTag = preview.config?.tags?.find(
      (tag) => tag.id === preview.config?.defaultTagId,
    );
    expect(defaultTag).toMatchObject({
      name: 'PROJETO MAIS RECENTE — ATIVIDADE MAIS RECENTE',
      project: 'PROJETO MAIS RECENTE',
      activity: 'ATIVIDADE MAIS RECENTE',
      projectId: '',
      activityId: '',
    });
    expect(
      preview.items.find((item) => item.date === '2026-07-30'),
    ).toMatchObject({
      decision: 'selected',
      tagId: defaultTag?.id,
      allocations: [{ tagId: defaultTag?.id, duration: '08:00' }],
    });
    expect(preview.message).toContain('criada a partir da última marcação');
  });

  it('encerra só o progresso do Ahgora quando uma batida inválida chega ao cálculo', async () => {
    const progress: CaptureProgress[] = [];
    const readTarget = vi.fn(() =>
      Promise.resolve({ ok: true as const, rows: [], errors: [] }),
    );
    const state = configuredState('invalid-source-punch');
    const adapters: CoordinatorAdapters = {
      today: civilDate('2026-08-24'),
      captureSource: () =>
        Promise.resolve({
          ok: true,
          tabId: 1,
          frameId: 0,
          months: [],
          days: [{ date: civilDate('2026-08-20'), times: [''] }],
          warnings: [],
          realDomValidation: 'manual-validation-pending',
        }),
      readTarget,
      writeTarget: () =>
        Promise.resolve({
          date: civilDate('2026-08-20'),
          requestedMinutes: 0,
          status: 'failed',
        }),
      reportCaptureProgress: (value) => {
        progress.push(value);
        return Promise.resolve();
      },
    };

    await expect(captureAndCompareOperation(state, adapters)).rejects.toThrow(
      'O Ahgora retornou batidas em um formato não suportado.',
    );
    expect(readTarget).toHaveBeenCalledOnce();
    expect(progress).toMatchObject([
      {
        ahgora: { status: 'running' },
        channel: { status: 'running' },
      },
      {
        ahgora: { status: 'failed' },
        channel: { status: 'running' },
      },
      {
        ahgora: { status: 'failed' },
        channel: { status: 'done' },
      },
    ]);
  });

  it('exibe as batidas originais do Ahgora quando um dia é omitido', async () => {
    const state = configuredState('omitted-source-day');
    const preview = await captureAndCompareOperation(state, {
      today: civilDate('2026-08-24'),
      captureSource: () =>
        Promise.resolve({
          ok: true,
          tabId: 10,
          frameId: 0,
          months: [],
          days: [
            {
              date: civilDate('2026-08-20'),
              times: ['08:00', '12:00', '13:00'],
            },
          ],
          warnings: [],
          realDomValidation: 'manual-validation-pending',
        }),
      readTarget: () => Promise.resolve({ ok: true, rows: [], errors: [] }),
      writeTarget: () =>
        Promise.resolve({
          date: civilDate('2026-08-20'),
          requestedMinutes: 0,
          status: 'failed',
        }),
    });

    expect(preview.items).toEqual([
      expect.objectContaining({
        date: '2026-08-20',
        status: 'blocked',
        warning: 'Dia omitido; revise as batidas: 08:00, 12:00, 13:00.',
      }),
    ]);
  });

  it('inicia Ahgora, Channel e Google Calendar em paralelo antes da barreira de comparação', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const base = configuredState('parallel-capture');
    if (!base.config) throw new Error('Configuração sintética ausente.');
    const state: OperationData = {
      ...base,
      config: {
        ...base.config,
        googleCalendar: {
          connected: true,
          calendars: [{ id: 'primary', name: 'Principal', primary: true }],
          selectedCalendarIds: ['primary'],
          rules: [
            {
              id: 'daily-rule',
              name: 'Daily',
              enabled: true,
              calendarIds: ['primary'],
              fields: ['title'],
              matchMode: 'all',
              phrases: ['daily'],
              excludedPhrases: [],
              tagId: 'tag-default',
              ignoreCancelled: true,
              ignoreDeclined: true,
              ignoreAllDay: true,
              busyOnly: true,
            },
          ],
        },
      },
    };
    const progress: CaptureProgress[] = [];
    const operation = captureAndCompareOperation(state, {
      today: civilDate('2026-08-24'),
      captureSource: async () => {
        started.push('ahgora');
        await gate;
        return {
          ok: true,
          tabId: 10,
          frameId: 0,
          months: [],
          days: [],
          warnings: [],
          realDomValidation: 'manual-validation-pending',
        };
      },
      readTarget: async () => {
        started.push('channel');
        await gate;
        return { ok: true, rows: [], errors: [] };
      },
      captureCalendar: async () => {
        started.push('calendar');
        await gate;
        return [];
      },
      writeTarget: () =>
        Promise.resolve({
          date: civilDate('2026-08-24'),
          requestedMinutes: 0,
          status: 'failed',
        }),
      reportCaptureProgress: (value) => {
        progress.push(value);
        return Promise.resolve();
      },
    });

    await vi.waitFor(() =>
      expect(started).toEqual(['ahgora', 'channel', 'calendar']),
    );
    expect(progress[0]).toMatchObject({
      ahgora: { status: 'running' },
      channel: { status: 'running' },
      calendar: { status: 'running' },
      comparison: { status: 'waiting' },
    });

    release();
    const preview = await operation;
    expect(preview.phase).toBe('preview');
    expect(preview.captureProgress).toMatchObject({
      ahgora: { status: 'done' },
      channel: { status: 'done' },
      calendar: { status: 'done' },
      comparison: { status: 'done' },
    });
  });

  it('preenche os dias somente na comparação final quando o Channel termina primeiro', async () => {
    let releaseAhgora!: () => void;
    const ahgoraGate = new Promise<void>(
      (resolve) => (releaseAhgora = resolve),
    );
    const progress: CaptureProgress[] = [];
    let settled = false;
    const operation = captureAndCompareOperation(
      configuredState('channel-finishes-first'),
      {
        today: civilDate('2026-08-24'),
        captureSource: async () => {
          await ahgoraGate;
          return {
            ok: true,
            tabId: 10,
            frameId: 0,
            months: [],
            days: [
              {
                date: civilDate('2026-07-27'),
                times: ['08:00', '12:00', '13:00', '17:00'],
              },
            ],
            warnings: [],
            realDomValidation: 'manual-validation-pending',
          };
        },
        readTarget: () =>
          Promise.resolve({ ok: true as const, rows: [], errors: [] }),
        writeTarget: () =>
          Promise.resolve({
            date: civilDate('2026-07-27'),
            requestedMinutes: 0,
            status: 'failed',
          }),
        reportCaptureProgress: (value) => {
          progress.push(value);
          return Promise.resolve();
        },
      },
    );
    void operation.then(() => (settled = true));

    await vi.waitFor(() => {
      const channelFinishedFirst = progress.some(
        (entry) =>
          entry.ahgora.status === 'running' &&
          entry.channel.status === 'done' &&
          entry.comparison?.status === 'waiting',
      );
      expect(channelFinishedFirst).toBe(true);
    });
    expect(settled).toBe(false);

    releaseAhgora();
    const preview = await operation;
    expect(preview.items).toMatchObject([
      {
        date: '2026-07-27',
        ahgoraDuration: '08:00',
        status: 'missing',
        decision: 'selected',
        allocations: [{ duration: '08:00', isRemainder: true }],
      },
    ]);
    expect(preview.captureProgress?.comparison).toMatchObject({
      status: 'done',
      detail: '1 dia(s) preparado(s) para revisão.',
    });
  });

  it('aplica automaticamente uma regra semanal aos novos dias capturados', async () => {
    const sourceRunner = new SyntheticSourceRunner(
      makeMirrorCalendarText('2026-08', {
        '2026-07-27': ['08:00', '12:00', '13:00', '17:00'],
      }),
    );
    const base = configuredState('automatic-template-rule');
    if (!base.config) throw new Error('Configuração sintética ausente.');
    const configured: OperationData = {
      ...base,
      config: {
        ...base.config,
        markingTemplates: [
          {
            id: 'weekly-template',
            name: 'Segunda padrão',
            sourceDurationMinutes: 480,
            createdAt: '2026-08-24T12:00:00.000Z',
            entries: [
              {
                id: 'weekly-template::1',
                tagId: 'tag-default',
                percentage: 75,
                durationMinutes: 360,
              },
              {
                id: 'weekly-template::2',
                tagId: 'tag-secondary',
                percentage: 25,
                durationMinutes: 120,
              },
            ],
          },
        ],
        templateRules: [
          {
            id: 'monday-rule',
            name: 'Segundas padrão',
            enabled: true,
            repeatEveryWeeks: 1,
            weekdays: [1],
            startsOn: civilDate('2026-07-01'),
            ends: { kind: 'never' },
            templates: [{ templateId: 'weekly-template', percentage: 100 }],
          },
        ],
      },
    };
    const preview = await captureAndCompareOperation(
      configured,
      adaptersFor(
        sourceRunner,
        makeExtractDocument(''),
        await fixtureDocument('form'),
        () => undefined,
      ),
    );

    expect(preview.items[0]).toMatchObject({
      date: '2026-07-27',
      decision: 'selected',
      appliedRuleId: 'monday-rule',
      appliedRuleName: 'Segundas padrão',
      allocations: [
        { duration: '06:00', tagId: 'tag-default' },
        { duration: '02:00', tagId: 'tag-secondary' },
      ],
    });
  });

  it('permite ajustar proporcionalmente um template de horas que excede o novo dia', async () => {
    const sourceRunner = new SyntheticSourceRunner(
      makeMirrorCalendarText('2026-08', {
        '2026-07-27': ['08:00', '12:00', '13:00', '17:00'],
      }),
    );
    const preview = await captureAndCompareOperation(
      configuredState('manual-template-overflow'),
      adaptersFor(
        sourceRunner,
        makeExtractDocument(''),
        await fixtureDocument('form'),
        () => undefined,
      ),
    );
    const template = {
      id: 'nine-hours',
      name: 'Dia de nove horas',
      sourceDurationMinutes: 540,
      createdAt: '2026-08-24T12:00:00.000Z',
      entries: [
        {
          id: 'nine-hours::1',
          tagId: 'tag-default',
          percentage: 66.6667,
          durationMinutes: 360,
        },
        {
          id: 'nine-hours::2',
          tagId: 'tag-secondary',
          percentage: 33.3333,
          durationMinutes: 180,
        },
      ],
    } as const;

    expect(() =>
      applyTemplateToItem(
        preview,
        '2026-07-27',
        template,
        'duration',
        'reject',
      ),
    ).toThrow(/09:00/);
    const adjusted = applyTemplateToItem(
      preview,
      '2026-07-27',
      template,
      'duration',
      'scale',
    );
    expect(adjusted.items[0]).toMatchObject({
      decision: 'selected',
      appliedTemplateIds: ['nine-hours'],
      allocations: [
        { duration: '05:20', tagId: 'tag-default' },
        { duration: '02:40', tagId: 'tag-secondary', isRemainder: true },
      ],
    });
  });

  it('aplica template somente ao saldo e preserva as marcações do Calendar', async () => {
    const sourceRunner = new SyntheticSourceRunner(
      makeMirrorCalendarText('2026-08', {
        '2026-07-27': ['08:00', '12:00', '13:00', '17:00'],
      }),
    );
    const preview = await captureAndCompareOperation(
      configuredState('template-after-calendar'),
      adaptersFor(
        sourceRunner,
        makeExtractDocument(''),
        await fixtureDocument('form'),
        () => undefined,
      ),
    );
    const calendarAllocation = {
      id: '2026-07-27::calendar::daily::0',
      mode: 'duration' as const,
      value: '01:00',
      durationMinutes: 60,
      duration: '01:00',
      tagId: 'tag-secondary',
      isRemainder: false,
      provenance: {
        kind: 'calendar' as const,
        eventId: 'daily',
        eventTitle: 'Daily do projeto',
        start: '2026-07-27T09:00:00-03:00',
        end: '2026-07-27T10:00:00-03:00',
        ruleId: 'daily-rule',
        ruleName: 'Daily',
        matchedPhrases: ['daily'],
      },
    };
    const withCalendar: OperationData = {
      ...preview,
      items: preview.items.map((item) =>
        item.id === '2026-07-27'
          ? { ...item, allocations: [calendarAllocation] }
          : item,
      ),
    };
    const template = {
      id: 'balanced',
      name: 'Divisão balanceada',
      sourceDurationMinutes: 480,
      createdAt: '2026-08-24T12:00:00.000Z',
      entries: [
        {
          id: 'balanced::1',
          tagId: 'tag-default',
          percentage: 75,
          durationMinutes: 360,
        },
        {
          id: 'balanced::2',
          tagId: 'tag-secondary',
          percentage: 25,
          durationMinutes: 120,
        },
      ],
    } as const;

    const adjusted = applyTemplateToItem(
      withCalendar,
      '2026-07-27',
      template,
      'percentage',
      'reject',
    );
    const allocations = adjusted.items[0]?.allocations ?? [];

    expect(allocations[0]).toBe(calendarAllocation);
    expect(allocations).toMatchObject([
      {
        id: calendarAllocation.id,
        duration: '01:00',
        provenance: { kind: 'calendar', eventId: 'daily' },
      },
      { duration: '05:15', tagId: 'tag-default' },
      { duration: '01:45', tagId: 'tag-secondary', isRemainder: true },
    ]);
    expect(
      allocations.reduce(
        (total, allocation) => total + allocation.durationMinutes,
        0,
      ),
    ).toBe(480);

    const withoutBalance: OperationData = {
      ...withCalendar,
      items: withCalendar.items.map((item) =>
        item.id === '2026-07-27'
          ? {
              ...item,
              allocations: [
                {
                  ...calendarAllocation,
                  durationMinutes: 480,
                  duration: '08:00',
                  value: '08:00',
                },
              ],
            }
          : item,
      ),
    };
    expect(() =>
      applyTemplateToItem(
        withoutBalance,
        '2026-07-27',
        template,
        'percentage',
        'reject',
      ),
    ).toThrow(/Não há saldo disponível/);
  });

  it('leva a origem RAG da regra do Calendar para a marcação capturada', async () => {
    const catalog = ragCatalogs.find((entry) =>
      entry.items.some((item) => item.kind === 'AD_HOC'),
    );
    const ragItem = catalog?.items.find((item) => item.kind === 'AD_HOC');
    if (!catalog || !ragItem) throw new Error('Fixture RAG ausente.');
    const sourceRunner = new SyntheticSourceRunner(
      makeMirrorCalendarText('2026-08', {
        '2026-07-27': ['08:00', '12:00', '13:00', '17:00'],
      }),
    );
    const base = configuredState('calendar-rag-source');
    if (!base.config) throw new Error('Configuração sintética ausente.');
    const preview = await captureAndCompareOperation(
      {
        ...base,
        config: {
          ...base.config,
          googleCalendar: {
            connected: true,
            calendars: [{ id: 'primary', name: 'Principal', primary: true }],
            selectedCalendarIds: ['primary'],
            rules: [
              {
                id: 'calendar-rag-rule',
                name: 'Lightning Talk',
                enabled: true,
                calendarIds: ['primary'],
                fields: ['title'],
                matchMode: 'all',
                phrases: ['lightning talk'],
                excludedPhrases: [],
                ragCatalogId: catalog.id,
                ragItemId: ragItem.id,
                ignoreCancelled: true,
                ignoreDeclined: true,
                ignoreAllDay: true,
                busyOnly: true,
              },
            ],
          },
        },
      },
      {
        ...adaptersFor(
          sourceRunner,
          makeExtractDocument(''),
          await fixtureDocument('form'),
          () => undefined,
        ),
        captureCalendar: () =>
          Promise.resolve([
            {
              id: 'calendar-event',
              calendarId: 'primary',
              title: 'Lightning Talk',
              start: '2026-07-27T09:00:00-03:00',
              end: '2026-07-27T09:30:00-03:00',
              allDay: false,
              status: 'confirmed',
              selfResponseStatus: 'accepted',
              transparency: 'opaque',
            },
          ]),
      },
    );

    expect(preview.items[0]?.allocations?.[0]).toMatchObject({
      duration: '00:30',
      ragCatalogId: catalog.id,
      ragItemId: ragItem.id,
      provenance: {
        kind: 'calendar',
        eventId: 'calendar-event',
        ruleId: 'calendar-rag-rule',
      },
    });
    expect(preview.items[0]?.allocations?.[0]).not.toHaveProperty('tagId');
  });

  it('preserva todas as marcações individuais lidas do Channel na prévia', async () => {
    const sourceRunner = new SyntheticSourceRunner(
      makeMirrorCalendarText('2026-08', {
        '2026-07-27': ['08:00', '12:00', '13:00', '17:00'],
      }),
    );
    const base = adaptersFor(
      sourceRunner,
      makeExtractDocument(''),
      await fixtureDocument('form'),
      () => undefined,
    );
    const preview = await captureAndCompareOperation(
      configuredState('channel-markings'),
      {
        ...base,
        readTarget: () =>
          Promise.resolve({
            ok: true as const,
            rows: [
              {
                rowIndex: 0,
                date: '2026-07-27',
                duration: '08:00',
                durationMinutes: 480,
                project: 'PROJETO_SINTETICO',
                activity: 'ATIVIDADE_SINTETICA',
                markings: [
                  {
                    id: '42',
                    date: '2026-07-27',
                    duration: '05:00',
                    durationMinutes: 300,
                    project: 'PROJETO_SINTETICO',
                    activity: 'ATIVIDADE_SINTETICA',
                    canDelete: true,
                  },
                  {
                    id: '43',
                    date: '2026-07-27',
                    duration: '03:00',
                    durationMinutes: 180,
                    project: 'PROJETO_SECUNDARIO',
                    activity: 'ATIVIDADE_SECUNDARIA',
                    canDelete: true,
                  },
                ],
              },
            ],
            errors: [],
          }),
      },
    );

    expect(preview.items[0]).toMatchObject({
      date: '2026-07-27',
      status: 'equal',
      channelMarkings: [
        {
          id: '42',
          duration: '05:00',
          project: 'PROJETO_SINTETICO',
          activity: 'ATIVIDADE_SINTETICA',
          canDelete: true,
        },
        {
          id: '43',
          duration: '03:00',
          project: 'PROJETO_SECUNDARIO',
          activity: 'ATIVIDADE_SECUNDARIA',
          canDelete: true,
        },
      ],
    });
    expect(preview.items[0]).not.toHaveProperty('warning');
  });

  it('volta o dia ao estado editável depois que todas as marcações são excluídas', async () => {
    const sourceRunner = new SyntheticSourceRunner(
      makeMirrorCalendarText('2026-08', {
        '2026-07-27': ['08:00', '12:00', '13:00', '17:00'],
      }),
    );
    const base = adaptersFor(
      sourceRunner,
      makeExtractDocument(''),
      await fixtureDocument('form'),
      () => undefined,
    );

    const refreshed = await captureAndCompareOperation(
      configuredState('channel-markings-deleted'),
      {
        ...base,
        readTarget: () =>
          Promise.resolve({ ok: true as const, rows: [], errors: [] }),
      },
    );

    expect(refreshed.items[0]).toMatchObject({
      date: '2026-07-27',
      status: 'missing',
      decision: 'selected',
      allocations: [
        {
          duration: '08:00',
          durationMinutes: 480,
          isRemainder: true,
        },
      ],
    });
    expect(refreshed.items[0]?.channelMarkings).toBeUndefined();
  });

  it('cria e envia somente o saldo restante ao editar um dia divergente', async () => {
    const sourceRunner = new SyntheticSourceRunner(
      makeMirrorCalendarText('2026-08', {
        '2026-07-27': ['08:00', '12:00', '13:00', '17:16'],
      }),
    );
    const base = adaptersFor(
      sourceRunner,
      makeExtractDocument(''),
      await fixtureDocument('form'),
      () => undefined,
    );
    const readTarget = () =>
      Promise.resolve({
        ok: true as const,
        rows: [
          {
            rowIndex: 0,
            date: '2026-07-27',
            duration: '01:00',
            durationMinutes: 60,
            project: 'Parada de Aprendizagem',
            activity: 'CERTI Reflete',
            markings: [
              {
                id: 'existing-1',
                date: '2026-07-27',
                duration: '01:00',
                durationMinutes: 60,
                project: 'Parada de Aprendizagem',
                activity: 'CERTI Reflete',
                canDelete: true,
              },
            ],
          },
        ],
        errors: [],
      });
    const preview = await captureAndCompareOperation(
      configuredState('edit-divergent-balance'),
      { ...base, readTarget },
    );

    const edited = editDivergentItem(preview, '2026-07-27');
    expect(edited.items[0]).toMatchObject({
      status: 'divergent',
      editingBalanceMinutes: 436,
      decision: 'selected',
      allocations: [
        {
          duration: '07:16',
          durationMinutes: 436,
          value: '100',
          isRemainder: true,
        },
      ],
    });
    expect(publicState(edited)).toMatchObject({
      selectedMinutes: 436,
      selectedCount: 1,
      canApply: true,
    });
    expect(
      updateAllocation(edited, '2026-07-27', '2026-07-27', 'duration', '03:00')
        .items[0]?.allocations,
    ).toMatchObject([
      { duration: '03:00', durationMinutes: 180, isRemainder: false },
      { duration: '04:16', durationMinutes: 256, isRemainder: true },
    ]);

    const writeTarget = vi.fn(
      (_state: OperationData, assignment: ProjectAssignment) =>
        Promise.resolve({
          date: assignment.date,
          requestedMinutes: assignment.durationMinutes,
          resultingMinutes:
            (assignment.expectedExistingMinutes ?? 0) +
            assignment.durationMinutes,
          status: 'filled' as const,
        }),
    );
    const completed = await fillSelectedQueue(prepareSelectedQueue(edited), {
      ...base,
      readTarget,
      writeTarget,
    });

    expect(writeTarget).toHaveBeenCalledTimes(1);
    expect(writeTarget.mock.calls[0]?.[1]).toMatchObject({
      date: '2026-07-27',
      duration: '07:16',
      durationMinutes: 436,
      expectedExistingMinutes: 60,
    });
    expect(completed.phase).toBe('completed');
  });

  it('reconcilia o envio concluído para expor cada marcação e seu identificador', async () => {
    const sourceRunner = new SyntheticSourceRunner(
      makeMirrorCalendarText('2026-08', {
        '2026-07-27': ['08:00', '12:00', '13:00', '17:00'],
      }),
    );
    const base = adaptersFor(
      sourceRunner,
      makeExtractDocument(''),
      await fixtureDocument('form'),
      () => undefined,
    );
    const original = configuredState('completed-write-reconciliation');
    const written: OperationData = {
      ...original,
      phase: 'completed',
      items: [
        {
          id: '2026-07-27',
          date: civilDate('2026-07-27'),
          ahgoraDuration: '08:00',
          channelDuration: '08:00',
          channelProject: 'Múltiplas TAGs',
          channelActivity: '2 marcações',
          status: 'equal',
          decision: 'selected',
          result: 'filled',
        },
      ],
      queue: ['first', 'second'],
      queueIndex: 2,
      message: '2 de 2 apontamentos enviados.',
    };
    const reconciled = await reconcileCompletedWrite(written, {
      ...base,
      readTarget: () =>
        Promise.resolve({
          ok: true as const,
          rows: [
            {
              rowIndex: 0,
              date: '2026-07-27',
              duration: '08:00',
              durationMinutes: 480,
              project: 'PROJETO A + PROJETO B',
              activity: 'ATIVIDADE A + ATIVIDADE B',
              markings: [
                {
                  id: 'created-1',
                  date: '2026-07-27',
                  duration: '05:00',
                  durationMinutes: 300,
                  project: 'PROJETO A',
                  activity: 'ATIVIDADE A',
                  canDelete: true,
                },
                {
                  id: 'created-2',
                  date: '2026-07-27',
                  duration: '03:00',
                  durationMinutes: 180,
                  project: 'PROJETO B',
                  activity: 'ATIVIDADE B',
                  canDelete: true,
                },
              ],
            },
          ],
          errors: [],
        }),
    });

    expect(reconciled).toMatchObject({
      phase: 'completed',
      queueIndex: 2,
      message: '2 de 2 apontamentos enviados.',
      items: [
        {
          date: '2026-07-27',
          status: 'equal',
          result: 'filled',
          channelMarkings: [
            { id: 'created-1', duration: '05:00', canDelete: true },
            { id: 'created-2', duration: '03:00', canDelete: true },
          ],
        },
      ],
    });
  });

  it('divide progressivamente um dia e envia cada saldo como marcação independente', async () => {
    const targetRows: {
      date: ReturnType<typeof civilDate>;
      duration: string;
      durationMinutes: number;
    }[] = [];
    const sourceRunner = new SyntheticSourceRunner(
      makeMirrorCalendarText('2026-08', {
        '2026-07-26': ['08:00', '12:00', '13:00', '17:00'],
      }),
    );
    const base = adaptersFor(
      sourceRunner,
      makeExtractDocument(''),
      await fixtureDocument('form'),
      () => undefined,
    );
    const writeTarget = vi.fn((_state, assignment: ProjectAssignment) => {
      targetRows.push({
        date: assignment.date,
        duration: assignment.duration,
        durationMinutes: assignment.durationMinutes,
      });
      return Promise.resolve({
        date: assignment.date,
        requestedMinutes: assignment.durationMinutes,
        resultingMinutes:
          (assignment.expectedExistingMinutes ?? 0) +
          assignment.durationMinutes,
        status: 'filled' as const,
      });
    });
    const adapters: CoordinatorAdapters = {
      ...base,
      readTarget: () =>
        Promise.resolve({
          ok: true as const,
          rows: targetRows.map((row, rowIndex) => ({ rowIndex, ...row })),
          errors: [],
        }),
      writeTarget,
    };

    const preview = await captureAndCompareOperation(
      configuredState('multiple-markings'),
      adapters,
    );
    const firstSplit = updateAllocation(
      preview,
      '2026-07-26',
      '2026-07-26',
      'duration',
      '03:00',
    );
    expect(firstSplit.items[0]?.allocations).toMatchObject([
      { duration: '03:00', mode: 'duration', isRemainder: false },
      {
        id: '2026-07-26::2',
        duration: '05:00',
        mode: 'duration',
        value: '05:00',
        isRemainder: true,
        tagId: 'tag-default',
      },
    ]);
    const secondSplit = updateAllocation(
      firstSplit,
      '2026-07-26',
      '2026-07-26::2',
      'percentage',
      '25',
    );
    const tagged = setAllocationTag(
      secondSplit,
      '2026-07-26',
      '2026-07-26::2',
      'tag-secondary',
    );
    expect(tagged.items[0]?.allocations).toMatchObject([
      { duration: '03:00', tagId: 'tag-default' },
      { duration: '02:00', tagId: 'tag-secondary' },
      { duration: '03:00', tagId: 'tag-default', isRemainder: true },
    ]);

    const completed = await fillSelectedQueue(
      prepareSelectedQueue(selectRemainingItems(tagged)),
      adapters,
    );
    expect(completed.phase).toBe('completed');
    expect(completed.queue).toEqual([
      '2026-07-26',
      '2026-07-26::2',
      '2026-07-26::3',
    ]);
    expect(writeTarget).toHaveBeenCalledTimes(3);
    expect(
      writeTarget.mock.calls.map(([, assignment]) => ({
        duration: assignment.duration,
        project: assignment.project,
        comments: assignment.comments,
        expected: assignment.expectedExistingMinutes,
      })),
    ).toEqual([
      {
        duration: '03:00',
        project: 'PROJETO_SINTETICO',
        comments: 'Observação padrão',
        expected: 0,
      },
      {
        duration: '02:00',
        project: 'PROJETO_SECUNDARIO',
        comments: 'Observação secundária',
        expected: 180,
      },
      {
        duration: '03:00',
        project: 'PROJETO_SINTETICO',
        comments: 'Observação padrão',
        expected: 300,
      },
    ]);
    expect(completed.items[0]).toMatchObject({
      status: 'equal',
      channelDuration: '08:00',
      channelProject: 'Múltiplas TAGs',
      channelActivity: '3 marcações',
      result: 'filled',
    });
  });

  it('envia toda a seleção após uma única ação', async () => {
    const targetRows: {
      date: ReturnType<typeof civilDate>;
      duration: string;
      durationMinutes: number;
    }[] = [];
    const sourceRunner = new SyntheticSourceRunner(
      makeMirrorCalendarText('2026-08', {
        '2026-07-26': ['08:00', '12:00'],
        '2026-07-28': ['08:00', '12:00'],
      }),
    );
    const base = adaptersFor(
      sourceRunner,
      makeExtractDocument(''),
      await fixtureDocument('form'),
      () => undefined,
    );
    const writeTarget = vi.fn((_state, assignment: ProjectAssignment) => {
      targetRows.push({
        date: assignment.date,
        duration: assignment.duration,
        durationMinutes: assignment.durationMinutes,
      });
      return Promise.resolve({
        date: assignment.date,
        requestedMinutes: assignment.durationMinutes,
        resultingMinutes: assignment.durationMinutes,
        status: 'filled' as const,
      });
    });
    const reportCaptureProgress = vi.fn((progress: CaptureProgress) => {
      void progress;
      return Promise.resolve();
    });
    const writeSnapshots: OperationData[] = [];
    const reportWriteProgress = vi.fn(
      (progressState: OperationData, progress: WriteProgress) => {
        void progress;
        writeSnapshots.push(progressState);
        return Promise.resolve();
      },
    );
    const adapters: CoordinatorAdapters = {
      ...base,
      readTarget: () =>
        Promise.resolve({
          ok: true as const,
          rows: targetRows.map((row, rowIndex) => ({ rowIndex, ...row })),
          errors: [],
        }),
      writeTarget,
      reportCaptureProgress,
      reportWriteProgress,
    };
    const preview = await captureAndCompareOperation(
      configuredState('single-action-batch'),
      adapters,
    );
    const tagged = selectItemTag(preview, '2026-07-28', 'tag-secondary');
    const completed = await fillSelectedQueue(
      prepareSelectedQueue(selectRemainingItems(tagged)),
      adapters,
    );

    expect(completed.phase).toBe('completed');
    expect(writeTarget).toHaveBeenCalledTimes(2);
    expect(
      writeTarget.mock.calls.map(([, assignment]) => ({
        project: assignment.project,
        activity: assignment.activity,
      })),
    ).toEqual([
      {
        project: 'PROJETO_SINTETICO',
        activity: 'ATIVIDADE_SINTETICA',
      },
      {
        project: 'PROJETO_SECUNDARIO',
        activity: 'ATIVIDADE_SECUNDARIA',
      },
    ]);
    expect(completed.items.map(({ result }) => result)).toEqual([
      'filled',
      'filled',
    ]);
    expect(completed.items.map(({ status }) => status)).toEqual([
      'equal',
      'equal',
    ]);
    expect(
      completed.items.map(({ channelProject, channelActivity }) => ({
        channelProject,
        channelActivity,
      })),
    ).toEqual([
      {
        channelProject: 'PROJETO_SINTETICO',
        channelActivity: 'ATIVIDADE_SINTETICA',
      },
      {
        channelProject: 'PROJETO_SECUNDARIO',
        channelActivity: 'ATIVIDADE_SECUNDARIA',
      },
    ]);
    expect(publicState(completed)).toMatchObject({
      reviewCount: 0,
      selectedCount: 0,
    });
    expect(
      reportWriteProgress.mock.calls.map(([, progress]) => ({
        status: progress.status,
        completedItems: progress.completedItems,
        totalItems: progress.totalItems,
      })),
    ).toEqual([
      { status: 'running', completedItems: 0, totalItems: 2 },
      { status: 'running', completedItems: 1, totalItems: 2 },
      { status: 'running', completedItems: 1, totalItems: 2 },
      { status: 'running', completedItems: 2, totalItems: 2 },
      { status: 'done', completedItems: 2, totalItems: 2 },
    ]);
    expect(writeSnapshots[1]?.items[0]?.result).toBe('filled');
    expect(writeSnapshots[3]?.items[1]?.result).toBe('filled');
    expect(completed.writeProgress).toMatchObject({
      status: 'done',
      completedItems: 2,
      totalItems: 2,
    });
    const captureSnapshots = reportCaptureProgress.mock.calls.map(
      ([progress]) => progress,
    );
    expect(captureSnapshots).toHaveLength(5);
    expect(captureSnapshots[0]).toMatchObject({
      ahgora: { status: 'running' },
      channel: { status: 'running' },
    });
    expect(captureSnapshots.at(-1)).toMatchObject({
      ahgora: { status: 'done' },
      channel: { status: 'done' },
      comparison: { status: 'done' },
    });
  });

  it('executa captura → leitura → comparação → seleção → fila de um item sem submit', async () => {
    const sourceRunner = new SyntheticSourceRunner(
      makeMirrorCalendarText('2026-08', {
        '2026-07-26': ['08:00', '12:00', '13:00', '17:00'],
        '2026-07-27': ['08:00', '12:00', '13:00', '17:00'],
      }),
    );
    const extract = makeExtractDocument('27/07/2026 08:00');
    const form = await fixtureDocument('form');
    let submitCount = 0;
    form.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitCount++;
    });
    let fillCalls = 0;
    const adapters = adaptersFor(sourceRunner, extract, form, () => {
      fillCalls++;
    });

    const preview = await captureAndCompareOperation(
      configuredState('coordinated-flow'),
      adapters,
    );
    expect(preview.phase).toBe('preview');
    expect(preview.items).toMatchObject([
      { id: '2026-07-26', status: 'missing', decision: 'selected' },
      { id: '2026-07-27', status: 'equal', decision: 'pending' },
    ]);
    expect(publicState(preview)).toMatchObject({
      capturedMinutes: 960,
      capturedCount: 2,
      reviewMinutes: 480,
      reviewCount: 1,
      selectedMinutes: 480,
      selectedCount: 1,
      canApply: true,
    });

    const selected = decideItem(preview, '2026-07-26', 'selected');
    expect(publicState(selected)).toMatchObject({
      selectedMinutes: 480,
      selectedCount: 1,
    });
    expect(
      publicState(decideItem(selected, '2026-07-26', 'refused')),
    ).toMatchObject({ selectedMinutes: 0, selectedCount: 0 });
    const queued = prepareSelectedQueue(selected);
    const waitingReview = await fillCurrentQueueItem(queued, adapters);
    expect(waitingReview).toMatchObject({
      phase: 'waiting-review',
      queue: ['2026-07-26'],
      queueIndex: 0,
    });
    expect(waitingReview.items[0]?.result).toBe('filled');
    expect(fillCalls).toBe(1);
    expect(submitCount).toBe(0);
    expect(form.querySelector<HTMLInputElement>('#data')?.value).toBe(
      '26/07/2026',
    );

    const completed = await fillCurrentQueueItem(
      advanceQueue(waitingReview),
      adapters,
    );
    expect(completed.phase).toBe('completed');
    expect(fillCalls).toBe(1);
    expect(submitCount).toBe(0);
  });

  it('prepara para envio somente as marcações do dia solicitado', () => {
    const state = configuredState('single-day-send');
    const preview: OperationData = {
      ...state,
      phase: 'preview',
      sourceRows: [
        {
          date: civilDate('2026-07-26'),
          duration: '08:00',
          durationMinutes: 480,
        },
        {
          date: civilDate('2026-07-27'),
          duration: '08:00',
          durationMinutes: 480,
        },
      ],
      items: [
        {
          id: '2026-07-26',
          date: civilDate('2026-07-26'),
          ahgoraDuration: '08:00',
          status: 'missing',
          decision: 'selected',
          allocations: [
            {
              id: '2026-07-26',
              mode: 'duration',
              value: '05:00',
              duration: '05:00',
              durationMinutes: 300,
              tagId: 'tag-default',
              isRemainder: false,
            },
            {
              id: '2026-07-26::2',
              mode: 'duration',
              value: '03:00',
              duration: '03:00',
              durationMinutes: 180,
              tagId: 'tag-secondary',
              isRemainder: true,
            },
          ],
        },
        {
          id: '2026-07-27',
          date: civilDate('2026-07-27'),
          ahgoraDuration: '08:00',
          status: 'missing',
          decision: 'selected',
          tagId: 'tag-default',
        },
      ],
    };

    const queued = prepareItemQueue(preview, '2026-07-26');

    expect(queued.queue).toEqual(['2026-07-26', '2026-07-26::2']);
    expect(queued.writeProgress).toMatchObject({
      status: 'running',
      totalItems: 2,
      currentDate: '2026-07-26',
    });
    expect(queued.queue).not.toContain('2026-07-27');
  });

  it('cancela durante a fila antes da barreira de escrita e não chama o adapter de fill', async () => {
    const sourceRunner = new SyntheticSourceRunner(
      makeMirrorCalendarText('2026-08', {
        '2026-07-26': ['08:00', '12:00'],
      }),
    );
    const form = await fixtureDocument('form');
    let cancelled = false;
    let fillCalls = 0;
    const baseAdapters = adaptersFor(
      sourceRunner,
      makeExtractDocument(''),
      form,
      () => fillCalls++,
    );
    const adapters: CoordinatorAdapters = {
      ...baseAdapters,
      writeTarget: () => {
        cancelled = true;
        return Promise.reject(new Error('cancelled-before-write'));
      },
    };
    const preview = await captureAndCompareOperation(
      configuredState('cancelled-flow'),
      adapters,
    );
    const queued = prepareSelectedQueue(
      decideItem(preview, '2026-07-26', 'selected'),
    );

    await expect(fillCurrentQueueItem(queued, adapters)).rejects.toThrow(
      'cancelled-before-write',
    );
    expect(cancelled).toBe(true);
    expect(fillCalls).toBe(0);
    const stopped = cancelOperation(queued);
    expect(stopped.phase).toBe('cancelled');
    expect(() => advanceQueue(stopped)).toThrow(/não está aguardando revisão/);
  });

  it('orienta fechar o formulário Channel antes de ler o Extrato', async () => {
    const sourceRunner = new SyntheticSourceRunner(
      makeMirrorCalendarText('2026-08', {
        '2026-07-26': ['08:00', '12:00'],
      }),
    );
    const adapters = adaptersFor(
      sourceRunner,
      makeExtractDocument(''),
      await fixtureDocument('form'),
      () => undefined,
    );

    await expect(
      captureAndCompareOperation(configuredState('entry-form-open'), {
        ...adapters,
        readTarget: () =>
          Promise.resolve({ ok: false, code: 'entry-form-open' }),
      }),
    ).rejects.toThrow(/Feche ou cancele o formulário, abra o Extrato/);
  });

  it('não inicia o próximo item depois de cancelar uma fila parcial', async () => {
    const sourceRunner = new SyntheticSourceRunner(
      makeMirrorCalendarText('2026-08', {
        '2026-07-26': ['08:00', '12:00'],
        '2026-07-28': ['08:00', '12:00'],
      }),
    );
    const form = await fixtureDocument('form');
    let fillCalls = 0;
    const adapters = adaptersFor(
      sourceRunner,
      makeExtractDocument(''),
      form,
      () => fillCalls++,
    );
    const preview = await captureAndCompareOperation(
      configuredState('cancel-after-first'),
      adapters,
    );
    const queued = prepareSelectedQueue(selectRemainingItems(preview));
    const afterFirst = await fillCurrentQueueItem(queued, adapters);
    expect(afterFirst.phase).toBe('waiting-review');
    expect(fillCalls).toBe(1);

    const stopped = cancelOperation(afterFirst);
    expect(stopped.phase).toBe('cancelled');
    expect(() => advanceQueue(stopped)).toThrow(/não está aguardando revisão/);
    expect(fillCalls).toBe(1);
  });
});

function configuredState(operationId: string): OperationData {
  return {
    ...emptyOperation(operationId),
    sourceTab: { id: 10, origin: 'https://source.synthetic' },
    targetTab: { id: 20, origin: 'https://target.synthetic' },
    config: {
      project: 'PROJETO_SINTETICO',
      activity: 'ATIVIDADE_SINTETICA',
      activityType: 'Nenhum',
      task: 'Nenhum',
      period: monthPeriod('2026-08'),
      overrides: [],
      tags: [
        {
          id: 'tag-default',
          name: 'Padrão',
          projectId: '11',
          project: 'PROJETO_SINTETICO',
          activityId: '111',
          activity: 'ATIVIDADE_SINTETICA',
          comments: 'Observação padrão',
        },
        {
          id: 'tag-secondary',
          name: 'Secundária',
          projectId: '22',
          project: 'PROJETO_SECUNDARIO',
          activityId: '222',
          activity: 'ATIVIDADE_SECUNDARIA',
          comments: 'Observação secundária',
        },
      ],
      defaultTagId: 'tag-default',
    },
  };
}

function adaptersFor(
  sourceRunner: SourceScriptRunner,
  extract: Document,
  form: Document,
  onFill: () => void,
): CoordinatorAdapters {
  return {
    today: civilDate('2026-08-22'),
    captureSource: (tabId, period) =>
      captureAhgora(sourceRunner, {
        tabId,
        today: civilDate('2026-08-22'),
        period,
      }),
    readTarget: (_tabId, input) => runInjectedChannelRead(input, extract),
    writeTarget: (_state, assignment: ProjectAssignment) => {
      onFill();
      return runInjectedChannelFill(assignment, form);
    },
  };
}

function makeExtractDocument(resultText: string): Document {
  const document = new DOMParser().parseFromString(
    `<!doctype html><html><body><main id="conteudo"><select id="totalItensPagina"><option>10</option><option>Não paginar</option></select><input name="dataInicial"><input name="dataFinal"><button value="Filtrar">Filtrar</button><table><tbody id="tblListagem">carregando</tbody></table></main></body></html>`,
    'text/html',
  );
  document
    .querySelector('[value*="Filtrar"]')
    ?.addEventListener('click', () => {
      const replacement = document.createElement('tbody');
      replacement.id = 'tblListagem';
      replacement.textContent = resultText;
      document.querySelector('#tblListagem')?.replaceWith(replacement);
    });
  return document;
}

async function fixtureDocument(name: string): Promise<Document> {
  const html = await readFile(
    resolve(projectRoot, `tests/fixtures/target/${name}.html`),
    'utf8',
  );
  return new DOMParser().parseFromString(html, 'text/html');
}

class SyntheticSourceRunner implements SourceScriptRunner {
  private readonly topDocument: Document;
  private readonly mirrorDocument: Document;

  constructor(calendar: string) {
    this.topDocument = new DOMParser().parseFromString(
      '<!doctype html><html><head><title>Portal Ahgora</title></head><body><iframe id="mirror"></iframe></body></html>',
      'text/html',
    );
    this.mirrorDocument = new DOMParser().parseFromString(
      `<!doctype html><html><body>
        <button>AUGUST/2026</button>
        <button>MONTHLY SUMMARY</button>
        <pre>${calendar}\nHoras Trabalhadas</pre>
      </body></html>`,
      'text/html',
    );
  }

  probe(): Promise<readonly FrameExecution<AhgoraProbeDto>[]> {
    return Promise.resolve([
      {
        frameId: 0,
        result: runWithDocument(this.topDocument, probeAhgoraDocument),
      },
      {
        frameId: 7,
        result: runWithDocument(this.mirrorDocument, probeAhgoraDocument),
      },
    ]);
  }

  captureMonth(
    _tabId: number,
    frameId: number,
    input: MonthCaptureInput,
  ): Promise<FrameExecution<InjectedMonthCaptureDto>> {
    return runWithDocument(this.mirrorDocument, async () => ({
      frameId,
      result: await captureAhgoraMonthInDocument(input),
    }));
  }
}

function runWithDocument<TResult>(
  selectedDocument: Document,
  action: () => TResult,
): TResult;
function runWithDocument<TResult>(
  selectedDocument: Document,
  action: () => Promise<TResult>,
): Promise<TResult>;
function runWithDocument<TResult>(
  selectedDocument: Document,
  action: () => TResult | Promise<TResult>,
): TResult | Promise<TResult> {
  const previous = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: selectedDocument,
  });
  try {
    const result = action();
    if (result instanceof Promise) {
      return result.finally(() => restoreDocument(previous));
    }
    restoreDocument(previous);
    return result;
  } catch (error) {
    restoreDocument(previous);
    throw error;
  }
}

function restoreDocument(previous: Document): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: previous,
  });
}
