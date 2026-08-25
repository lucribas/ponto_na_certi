import type {
  CaptureProgress,
  OperationConfig,
  OperationData,
  PreviewAllocation,
  PreviewItem,
  WriteProgress,
} from '../application/types';
import {
  applyMarkingTemplate,
  automaticTemplateApplication,
  type TemplateAllocationDraft,
  type TemplateApplicationBasis,
  type TemplateOverflowStrategy,
} from '../application/marking-templates';
import type { ChannelTag, MarkingTemplate } from '../application/settings';
import {
  assignDefaultTagToContextualRagRules,
  composeCalendarEvents,
  type CalendarComposition,
  type CalendarEvent,
} from '../application/google-calendar';
import { findRagItem } from '../application/rag';
import {
  assignAdHoc,
  assignExpertProject,
  calculatePunchDays,
  civilDate,
  compareAhgoraWithChannel,
  formatDurationMinutes,
  formatBrazilianDate,
  parseDurationMinutes,
  resolvePeriod,
  type CivilDate,
  type ComparableWorkRecord,
  type ChannelAssignment,
} from '../domain';
import type { CaptureAhgoraResult } from '../sites/source';
import type {
  InjectedChannelFillResult,
  InjectedChannelReadInput,
  InjectedChannelReadResult,
} from '../sites/target';
import { formatPortugueseQuantity } from '../shared/portuguese';

export interface CoordinatorAdapters {
  readonly today: CivilDate;
  captureSource(
    tabId: number,
    period: NonNullable<OperationData['resolvedPeriod']>,
  ): Promise<CaptureAhgoraResult>;
  readTarget(
    tabId: number,
    input: InjectedChannelReadInput,
  ): Promise<InjectedChannelReadResult>;
  writeTarget(
    state: OperationData,
    assignment: ChannelAssignment,
  ): Promise<InjectedChannelFillResult>;
  reportCaptureProgress?(progress: CaptureProgress): Promise<void>;
  reportWriteProgress?(
    state: OperationData,
    progress: WriteProgress,
  ): Promise<void>;
  cancellationRequested?(operationId: string): boolean;
  captureCalendar?(
    period: NonNullable<OperationData['resolvedPeriod']>,
    calendarIds: readonly string[],
  ): Promise<readonly CalendarEvent[]>;
}

export async function captureAndCompareOperation(
  state: OperationData,
  adapters: CoordinatorAdapters,
): Promise<OperationData> {
  if (!state.sourceTab || !state.targetTab || !state.config) {
    throw new Error(
      'Registre as abas Ahgora e Channel e informe a configuração.',
    );
  }
  const { sourceTab, targetTab, config } = state;
  const period = resolvePeriod(config.period, {
    today: () => adapters.today,
  });
  const calendarSettings = config.googleCalendar;
  const calendarEnabled = Boolean(
    calendarSettings &&
    (calendarSettings.enabled ?? calendarSettings.connected) &&
    calendarSettings.connected &&
    calendarSettings.selectedCalendarIds.length > 0 &&
    calendarSettings.rules.some((rule) => rule.enabled),
  );
  let progress: CaptureProgress = {
    ahgora: {
      status: 'running',
      detail: `Consultando ${String(period.mirrorMonths.length)} mês(es) do espelho…`,
    },
    channel: {
      status: 'running',
      detail: 'Resolvendo sessão e consultando o Extrato via DWR…',
    },
    calendar: calendarEnabled
      ? {
          status: 'running',
          detail: 'Consultando eventos dos calendários selecionados…',
        }
      : {
          status: 'done',
          detail: 'Conexão Google Calendar desabilitada.',
        },
    comparison: {
      status: 'waiting',
      detail: 'Aguardando Ahgora, Channel e Google Calendar.',
    },
  };
  // Serializa apenas a persistência dos snapshots. As consultas continuam em
  // paralelo, mas uma atualização de progresso mais antiga nunca sobrescreve
  // outra mais recente no storage da extensão.
  let progressReport = Promise.resolve();
  const reportProgress = async (): Promise<void> => {
    const snapshot = progress;
    progressReport = progressReport.then(() =>
      adapters.reportCaptureProgress?.(snapshot),
    );
    await progressReport;
  };
  const updateProgress = async (
    system: keyof CaptureProgress,
    value: CaptureProgress['ahgora'],
  ): Promise<void> => {
    progress = { ...progress, [system]: value };
    await reportProgress();
  };
  await reportProgress();

  const sourcePromise = (async () => {
    try {
      const source = await adapters.captureSource(sourceTab.id, period);
      assertCaptureNotCancelled(state, adapters);
      if (!source.ok) throw new Error(source.error.message);
      let calculation: ReturnType<typeof calculatePunchDays>;
      try {
        calculation = calculatePunchDays(source.days, config.overrides);
      } catch {
        throw new Error(
          'O Ahgora retornou batidas em um formato não suportado.',
        );
      }
      const sourceRows: readonly ComparableWorkRecord[] =
        calculation.records.map(({ date, duration, durationMinutes }) => ({
          date,
          duration,
          durationMinutes,
        }));
      await updateProgress('ahgora', {
        status: 'done',
        detail: `${String(source.days.length)} dia(s) recebido(s); ${String(calculation.records.length)} com duração calculada.`,
      });
      return { calculation, sourceRows, sourceDays: source.days };
    } catch (error) {
      const detail = captureFailureMessage(
        error,
        'Não foi possível consultar o Ahgora.',
      );
      await updateProgress('ahgora', { status: 'failed', detail });
      throw new Error(detail, { cause: error });
    }
  })();

  const targetPromise = (async () => {
    try {
      const targetResult = await adapters.readTarget(targetTab.id, {
        startDate: formatBrazilianDate(period.start),
        endDate: formatBrazilianDate(period.end),
      });
      assertCaptureNotCancelled(state, adapters);
      if (!targetResult.ok)
        throw new Error(channelReadFailureMessage(targetResult.code));
      const targetRows = comparableRows(targetResult);
      await updateProgress('channel', {
        status: 'done',
        detail: `${String(targetRows.length)} linha(s) recebida(s) do Extrato.`,
      });
      return {
        targetResult,
        targetRows,
        targetByDate: aggregateRowsByDate(targetRows),
        channelMarkingsByDate: collectChannelMarkingsByDate(targetResult),
      };
    } catch (error) {
      const detail = captureFailureMessage(
        error,
        'Não foi possível consultar o Channel.',
      );
      await updateProgress('channel', { status: 'failed', detail });
      throw new Error(detail, { cause: error });
    }
  })();

  const calendarPromise = (async (): Promise<
    | {
        readonly events: readonly CalendarEvent[];
        readonly composition: CalendarComposition;
      }
    | undefined
  > => {
    if (!calendarEnabled || !calendarSettings) return undefined;
    try {
      if (!adapters.captureCalendar)
        throw new Error('O cliente do Google Calendar não está disponível.');
      const events = await adapters.captureCalendar(
        period,
        calendarSettings.selectedCalendarIds,
      );
      assertCaptureNotCancelled(state, adapters);
      const composition = composeCalendarEvents(
        events,
        calendarSettings,
        new Set((config.tags ?? []).map((tag) => tag.id)),
      );
      await updateProgress('calendar', {
        status: 'done',
        detail: `${String(events.length)} evento(s) lido(s) · ${String(composition.matchedEventCount)} correspondência(s).`,
      });
      return { events, composition };
    } catch (error) {
      const detail = captureFailureMessage(
        error,
        'Não foi possível consultar o Google Calendar.',
      );
      await updateProgress('calendar', { status: 'failed', detail });
      throw new Error(detail, { cause: error });
    }
  })();

  const [sourceResult, targetResult, calendarResult] = await Promise.allSettled(
    [sourcePromise, targetPromise, calendarPromise],
  );
  assertCaptureNotCancelled(state, adapters);
  if (sourceResult.status === 'rejected') throw sourceResult.reason;
  if (targetResult.status === 'rejected') throw targetResult.reason;
  if (calendarResult.status === 'rejected') throw calendarResult.reason;

  const { calculation, sourceRows, sourceDays } = sourceResult.value;
  const {
    targetResult: capturedTarget,
    targetRows,
    targetByDate,
    channelMarkingsByDate,
  } = targetResult.value;
  await updateProgress('comparison', {
    status: 'running',
    detail: 'Cruzando os dias capturados e preparando a revisão…',
  });
  const effectiveConfig = inferDefaultTagFromLastChannelMarking(
    config,
    capturedTarget,
  );
  const inferredDefaultTag =
    effectiveConfig.defaultTagId === config.defaultTagId
      ? undefined
      : effectiveConfig.tags?.find(
          (tag) => tag.id === effectiveConfig.defaultTagId,
        );
  const calendarComposition =
    inferredDefaultTag && calendarResult.value && effectiveConfig.googleCalendar
      ? composeCalendarEvents(
          calendarResult.value.events,
          effectiveConfig.googleCalendar,
          new Set((effectiveConfig.tags ?? []).map((tag) => tag.id)),
        )
      : calendarResult.value?.composition;
  const comparisons = compareCapturedDays(sourceRows, targetByDate);
  const warningDates = new Set(
    calculation.warnings.map((warning) => warning.date),
  );
  const items: PreviewItem[] = comparisons.map((comparison) => {
    const blocked = comparison.ahgoraMinutes <= 0;
    let automaticallySelected =
      comparison.status === 'missing' &&
      !blocked &&
      !warningDates.has(comparison.date);
    const target = targetByDate.get(comparison.date);
    const channelMarkings = channelMarkingsByDate.get(comparison.date) ?? [];
    const defaultTagId = effectiveConfig.defaultTagId;
    const tagId = comparison.status === 'missing' ? defaultTagId : undefined;
    let automatic: ReturnType<typeof automaticTemplateApplication> | undefined;
    let automaticWarning: string | undefined;
    const calendarDrafts =
      calendarComposition?.allocationsByDate.get(comparison.date) ?? [];
    const calendarMinutes = calendarDrafts.reduce(
      (total, allocation) => total + allocation.durationMinutes,
      0,
    );
    const calendarConflicts = [
      ...(calendarComposition?.conflictsByDate.get(comparison.date) ?? []),
      ...(calendarMinutes > comparison.ahgoraMinutes
        ? [
            `Os eventos do Calendar somam ${formatDurationMinutes(calendarMinutes)}, acima das ${comparison.ahgoraDuration} do Ahgora.`,
          ]
        : []),
    ];
    if (calendarConflicts.length > 0) {
      automaticallySelected = false;
      automaticWarning = calendarConflicts.join(' ');
    }
    const remainingMinutes = Math.max(
      0,
      comparison.ahgoraMinutes - calendarMinutes,
    );
    if (automaticallySelected) {
      try {
        if (remainingMinutes > 0)
          automatic = automaticTemplateApplication(
            effectiveConfig.templateRules ?? [],
            effectiveConfig.markingTemplates ?? [],
            comparison.date,
            remainingMinutes,
            defaultTagId,
          );
      } catch (error) {
        automaticallySelected = false;
        automaticWarning = `Regra automática não aplicada: ${error instanceof Error ? error.message : 'configuração inválida'}`;
      }
    }
    const calendarAllocations: readonly PreviewAllocation[] =
      calendarDrafts.map((draft, index) => ({
        id: `${comparison.date}::calendar::${draft.eventId}::${String(index)}`,
        mode: 'duration',
        value: formatDurationMinutes(draft.durationMinutes),
        durationMinutes: draft.durationMinutes,
        duration: formatDurationMinutes(draft.durationMinutes),
        ...(draft.tagId === undefined ? {} : { tagId: draft.tagId }),
        ...(draft.ragCatalogId === undefined
          ? {}
          : { ragCatalogId: draft.ragCatalogId }),
        ...(draft.ragItemId === undefined
          ? {}
          : { ragItemId: draft.ragItemId }),
        isRemainder: false,
        provenance: {
          kind: 'calendar',
          eventId: draft.eventId,
          eventTitle: draft.eventTitle,
          start: draft.start,
          end: draft.end,
          ruleId: draft.ruleId,
          ruleName: draft.ruleName,
          matchedPhrases: draft.matchedPhrases,
        },
      }));
    const remainingAllocations: readonly PreviewAllocation[] = automatic
      ? calendarAllocations.length === 0
        ? withAllocationIds(comparison.date, automatic.allocations)
        : automatic.allocations.map((draft, index) => ({
            id: `${comparison.date}::automatic::${String(index)}`,
            ...draft,
            provenance: draft.isRemainder
              ? ({ kind: 'default' } as const)
              : {
                  kind: 'weekly-rule' as const,
                  ruleId: automatic.rule.id,
                  ruleName: automatic.rule.name,
                },
          }))
      : remainingMinutes > 0 && tagId !== undefined
        ? [
            calendarAllocations.length === 0
              ? {
                  id: comparison.date,
                  mode: 'percentage' as const,
                  value: '100',
                  durationMinutes: comparison.ahgoraMinutes,
                  duration: comparison.ahgoraDuration,
                  tagId,
                  isRemainder: true,
                }
              : {
                  id: `${comparison.date}::default`,
                  mode: 'duration' as const,
                  value: formatDurationMinutes(remainingMinutes),
                  durationMinutes: remainingMinutes,
                  duration: formatDurationMinutes(remainingMinutes),
                  tagId,
                  isRemainder: true,
                  provenance: { kind: 'default' as const },
                },
          ]
        : [];
    if (
      comparison.status === 'missing' &&
      remainingMinutes > 0 &&
      remainingAllocations.length === 0
    ) {
      automaticallySelected = false;
      automaticWarning ??=
        'Nenhuma TAG padrão está disponível. Crie uma TAG ou capture um período que contenha uma marcação válida do Channel.';
    }
    const allocations =
      calendarAllocations.length + remainingAllocations.length > 0
        ? [...calendarAllocations, ...remainingAllocations]
        : undefined;
    return {
      id: comparison.date,
      date: comparison.date,
      ahgoraDuration: comparison.ahgoraDuration,
      ...(comparison.status === 'missing'
        ? {}
        : { channelDuration: comparison.channelDuration }),
      status: blocked ? 'blocked' : comparison.status,
      decision: automaticallySelected ? 'selected' : 'pending',
      ...(target?.project === undefined
        ? {}
        : { channelProject: target.project }),
      ...(target?.activity === undefined
        ? {}
        : { channelActivity: target.activity }),
      ...(channelMarkings.length === 0 ? {} : { channelMarkings }),
      ...(tagId === undefined ? {} : { tagId }),
      ...(allocations === undefined ? {} : { allocations }),
      ...(automatic === undefined
        ? {}
        : {
            appliedTemplateIds: automatic.rule.templates.map(
              (share) => share.templateId,
            ),
            appliedRuleId: automatic.rule.id,
            appliedRuleName: automatic.rule.name,
          }),
      ...(blocked
        ? { warning: 'Duração não positiva; preenchimento bloqueado.' }
        : warningDates.has(comparison.date)
          ? { warning: 'Batidas com aviso; revise antes de selecionar.' }
          : automaticWarning === undefined
            ? {}
            : { warning: automaticWarning }),
    };
  });
  const itemDates = new Set(items.map((item) => item.date));
  const ahgoraPunchesByDate = new Map(
    sourceDays.map((day) => [day.date, day.times] as const),
  );
  for (const warning of calculation.warnings) {
    if (!itemDates.has(warning.date)) {
      const punches = ahgoraPunchesByDate.get(warning.date) ?? [];
      itemDates.add(warning.date);
      items.push({
        id: warning.date,
        date: warning.date,
        ahgoraDuration: '—',
        status: 'blocked',
        decision: 'pending',
        warning: `Dia omitido; revise as batidas: ${punches.join(', ')}.`,
      });
    }
  }
  items.sort((left, right) => left.date.localeCompare(right.date));
  await updateProgress('comparison', {
    status: 'done',
    detail: `${String(items.length)} dia(s) preparado(s) para revisão.`,
  });
  const selectedCount = items.filter(
    (item) => item.status === 'missing' && item.decision === 'selected',
  ).length;
  const pendingCount = items.filter(
    (item) => item.status === 'missing' && item.result === undefined,
  ).length;
  return {
    ...state,
    config: effectiveConfig,
    phase: 'preview',
    resolvedPeriod: period,
    sourceRows,
    targetRows,
    captureProgress: progress,
    items,
    queue: [],
    queueIndex: 0,
    message: `${
      inferredDefaultTag
        ? `TAG padrão “${inferredDefaultTag.name}” criada a partir da última marcação do Channel. `
        : ''
    }${
      selectedCount > 0
        ? `Prévia pronta. ${String(selectedCount)} dia(s) novo(s) sem aviso selecionado(s) para envio.`
        : pendingCount === 0
          ? 'Prévia atualizada. Não há novos apontamentos para enviar ao Channel.'
          : 'Prévia pronta. Os dias pendentes possuem avisos e precisam ser selecionados manualmente.'
    }`,
  };
}

/**
 * Barreira pura entre captura e preenchimento da revisão. A comparação sempre
 * parte dos dias completos do Ahgora, independentemente da ordem em que as
 * fontes terminaram.
 */
function compareCapturedDays(
  sourceRows: readonly ComparableWorkRecord[],
  targetByDate: ReadonlyMap<CivilDate, ComparableWorkRecord>,
): ReturnType<typeof compareAhgoraWithChannel> {
  const comparisons = compareAhgoraWithChannel(sourceRows, [
    ...targetByDate.values(),
  ]);
  const expectedDates = new Set(sourceRows.map((row) => row.date));
  if (
    comparisons.length !== expectedDates.size ||
    comparisons.some((comparison) => !expectedDates.has(comparison.date))
  ) {
    throw new Error(
      'A comparação não preservou todos os dias calculados do Ahgora.',
    );
  }
  return comparisons;
}

export async function reconcileCompletedWrite(
  written: OperationData,
  adapters: CoordinatorAdapters,
): Promise<OperationData> {
  try {
    const refreshed = await captureAndCompareOperation(written, adapters);
    const writtenByDate = new Map(
      written.items.map((item) => [item.date, item]),
    );
    return {
      ...refreshed,
      phase: 'completed',
      items: refreshed.items.map((item) => {
        const previous = writtenByDate.get(item.date);
        return previous?.result === undefined
          ? item
          : { ...item, result: previous.result };
      }),
      queue: written.queue,
      queueIndex: written.queueIndex,
      ...(written.writeProgress === undefined
        ? {}
        : { writeProgress: written.writeProgress }),
      ...(written.message === undefined ? {} : { message: written.message }),
    };
  } catch {
    return {
      ...written,
      message: `${written.message ?? 'Envio concluído.'} Capture e compare novamente para detalhar as marcações criadas.`,
    };
  }
}

function channelReadFailureMessage(code: string): string {
  return (
    (
      {
        'entry-form-open':
          'O formulário de apontamento está aberto no Channel. Feche ou cancele o formulário, abra o Extrato e tente novamente.',
        'login-required': 'Conclua o login do Channel e tente novamente.',
        'channel-api-unavailable':
          'A aba Channel não carregou o cliente DWR do Extrato. Abra o Extrato nessa aba e registre-a novamente.',
        'channel-participant-unavailable':
          'O Channel não informou o participante nem na página atual nem no Extrato autenticado. Reabra o Extrato e refaça o login.',
        'channel-company-unavailable':
          'O Channel não informou a empresa nem na página atual nem no Extrato autenticado. Reabra o Extrato e registre a aba novamente.',
        'not-channel-page':
          'A aba registrada não está no Extrato do Channel. Abra o Extrato nessa aba e tente novamente.',
        'no-pagination-option-not-found':
          'A opção Não paginar não foi encontrada no Extrato do Channel.',
        'period-fields-not-found':
          'Os campos de período não foram encontrados no Extrato do Channel.',
        'report-not-refreshed':
          'O Extrato do Channel não confirmou a atualização após Filtrar.',
      } as Readonly<Record<string, string>>
    )[code] ?? `Leitura do Channel indisponível: ${code}.`
  );
}

function channelWriteFailureMessage(code?: string): string {
  return (
    (
      {
        'project-prefix-not-found':
          'O projeto da TAG não foi encontrado no Channel. Atualize o cache e revise a TAG antes de tentar novamente.',
        'activity-prefix-not-found':
          'A atividade da TAG não foi encontrada no projeto do Channel. Atualize o cache e revise a TAG antes de tentar novamente.',
        'activity-type-prefix-not-found':
          'O tipo de atividade da TAG não foi encontrado no Channel. Revise as opções avançadas da TAG.',
        'task-prefix-not-found':
          'A tarefa da TAG não foi encontrada no Channel. Revise as opções avançadas da TAG.',
      } as Readonly<Record<string, string>>
    )[code ?? ''] ??
    'O apontamento não foi confirmado. A fila foi interrompida para evitar duplicidade.'
  );
}

function assertCaptureNotCancelled(
  state: OperationData,
  adapters: CoordinatorAdapters,
): void {
  if (adapters.cancellationRequested?.(state.operationId))
    throw new Error('Captura interrompida pelo usuário.');
}

function captureFailureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function decideItem(
  state: OperationData,
  itemId: string,
  decision: 'selected' | 'refused',
): OperationData {
  requirePhase(state, 'preview');
  if (!state.items.some((item) => item.id === itemId)) {
    throw new Error('Item desconhecido.');
  }
  return {
    ...state,
    items: state.items.map((item) =>
      item.id === itemId ? { ...item, decision } : item,
    ),
  };
}

export function editDivergentItem(
  state: OperationData,
  itemId: string,
): OperationData {
  requirePhase(state, 'preview');
  const item = state.items.find(
    (candidate) =>
      candidate.id === itemId &&
      candidate.status === 'divergent' &&
      candidate.result === undefined,
  );
  if (!item || item.channelDuration === undefined)
    throw new Error('Dia divergente indisponível para edição.');
  const sourceTotal = sourceMinutes(state, item.date);
  const channelTotal = parseDurationMinutes(item.channelDuration);
  const balance = sourceTotal - channelTotal;
  if (balance <= 0)
    throw new Error(
      'O Channel não possui saldo menor que o Ahgora neste dia. Exclua marcações antes de editar.',
    );
  const tagId = state.config?.defaultTagId;
  const allocation: PreviewAllocation = {
    id: item.id,
    mode: 'percentage',
    value: '100',
    durationMinutes: balance,
    duration: formatDurationMinutes(balance),
    ...(tagId === undefined ? {} : { tagId }),
    isRemainder: true,
  };
  return {
    ...state,
    items: state.items.map((candidate) =>
      candidate.id === itemId
        ? {
            ...candidate,
            editingBalanceMinutes: balance,
            allocations: [allocation],
            ...(tagId === undefined ? {} : { tagId }),
            decision: 'selected',
          }
        : candidate,
    ),
    message: `Editando o saldo de ${formatDurationMinutes(balance)} em ${formatBrazilianDate(item.date)}.`,
  };
}

export function selectRemainingItems(state: OperationData): OperationData {
  requirePhase(state, 'preview');
  return {
    ...state,
    items: state.items.map((item) =>
      item.status === 'missing' && item.decision === 'pending'
        ? { ...item, decision: 'selected' }
        : item,
    ),
  };
}

export function selectItemTag(
  state: OperationData,
  itemId: string,
  tagId: string,
): OperationData {
  requirePhase(state, 'preview');
  if (!state.config?.tags?.some((tag) => tag.id === tagId))
    throw new Error('TAG desconhecida.');
  if (
    !state.items.some(
      (item) => item.id === itemId && isEditablePreviewItem(item),
    )
  )
    throw new Error('Item indisponível para definição de TAG.');
  return {
    ...state,
    items: state.items.map((item) =>
      item.id === itemId
        ? {
            ...item,
            tagId,
            ...(item.allocations === undefined
              ? {}
              : {
                  allocations: item.allocations.map((allocation, index) =>
                    index === 0 ? { ...allocation, tagId } : allocation,
                  ),
                }),
          }
        : item,
    ),
  };
}

export function setAllocationTag(
  state: OperationData,
  itemId: string,
  allocationId: string,
  tagId: string,
  useTagSource = false,
): OperationData {
  requireEditableAllocation(state, itemId, allocationId);
  if (!state.config?.tags?.some((tag) => tag.id === tagId))
    throw new Error('TAG desconhecida.');
  return updateItemAllocations(state, itemId, (allocations) =>
    allocations.map((allocation) => {
      if (allocation.id !== allocationId) return allocation;
      const next = { ...allocation, tagId };
      if (useTagSource) {
        delete next.ragCatalogId;
        delete next.ragItemId;
      }
      return next;
    }),
  );
}

export function setAllocationRag(
  state: OperationData,
  itemId: string,
  allocationId: string,
  catalogId: string,
  ragItemId: string,
): OperationData {
  requireEditableAllocation(state, itemId, allocationId);
  const ragItem = findRagItem(catalogId, ragItemId);
  if (!ragItem) throw new Error('Item RAG desconhecido.');
  if (ragItem.kind === 'SKIP')
    throw new Error('Este item está marcado como não apontável no Channel.');
  return updateItemAllocations(state, itemId, (allocations) =>
    allocations.map((allocation) =>
      allocation.id === allocationId
        ? { ...allocation, ragCatalogId: catalogId, ragItemId }
        : allocation,
    ),
  );
}

export function updateAllocation(
  state: OperationData,
  itemId: string,
  allocationId: string,
  mode: 'percentage' | 'duration',
  value: string,
): OperationData {
  const { item, allocation } = requireEditableAllocation(
    state,
    itemId,
    allocationId,
  );
  if (allocation.provenance?.kind === 'calendar')
    throw new Error(
      'A duração de um evento do Calendar não pode ser alterada.',
    );
  const totalMinutes = allocationTotalMinutes(state, item);
  const requestedMinutes = allocationMinutes(mode, value, totalMinutes);
  const allocations = item.allocations ?? [];
  const explicitOtherMinutes = allocations.reduce(
    (total, candidate) =>
      candidate.id !== allocationId && !candidate.isRemainder
        ? total + candidate.durationMinutes
        : total,
    0,
  );
  const availableMinutes = totalMinutes - explicitOtherMinutes;
  if (requestedMinutes > availableMinutes) {
    throw new Error(
      `Esta marcação pode usar no máximo ${formatDurationMinutes(availableMinutes)} (${formatPercentage(availableMinutes, totalMinutes)}%).`,
    );
  }

  const edited: PreviewAllocation = {
    ...allocation,
    mode,
    value: normalizeAllocationValue(mode, value),
    durationMinutes: requestedMinutes,
    duration: formatDurationMinutes(requestedMinutes),
    isRemainder: false,
  };
  const explicit: PreviewAllocation[] = allocations
    .filter(
      (candidate) => candidate.id !== allocationId && !candidate.isRemainder,
    )
    .map((candidate) => ({ ...candidate, isRemainder: false as const }));
  const editedIndex = allocations.findIndex(
    (candidate) => candidate.id === allocationId,
  );
  const insertionIndex = allocations
    .slice(0, editedIndex)
    .filter((candidate) => !candidate.isRemainder).length;
  explicit.splice(insertionIndex, 0, edited);
  const usedMinutes = explicit.reduce(
    (total, candidate) => total + candidate.durationMinutes,
    0,
  );
  const remainderMinutes = totalMinutes - usedMinutes;
  const remainderTagId = state.config?.defaultTagId;
  const next: PreviewAllocation[] =
    remainderMinutes > 0
      ? [
          ...explicit,
          {
            id: nextAllocationId(item.id, allocations),
            mode,
            value:
              mode === 'percentage'
                ? formatPercentage(remainderMinutes, totalMinutes)
                : formatDurationMinutes(remainderMinutes),
            durationMinutes: remainderMinutes,
            duration: formatDurationMinutes(remainderMinutes),
            ...(remainderTagId === undefined ? {} : { tagId: remainderTagId }),
            isRemainder: true,
          },
        ]
      : explicit;
  return updateItemAllocations(state, itemId, () => next);
}

export function removeAllocation(
  state: OperationData,
  itemId: string,
  allocationId: string,
): OperationData {
  const { item, allocation } = requireEditableAllocation(
    state,
    itemId,
    allocationId,
  );
  const allocations = item.allocations ?? [];
  if (allocations.length <= 1 || allocation.isRemainder)
    throw new Error('A marcação de saldo não pode ser removida.');
  const totalMinutes = allocationTotalMinutes(state, item);
  const explicit = allocations.filter(
    (candidate) => candidate.id !== allocationId && !candidate.isRemainder,
  );
  const remainderMinutes =
    totalMinutes -
    explicit.reduce((total, current) => total + current.durationMinutes, 0);
  const remainderTagId = state.config?.defaultTagId;
  const remainderMode =
    allocations.find((candidate) => candidate.isRemainder)?.mode ??
    allocation.mode;
  return updateItemAllocations(state, itemId, () => [
    ...explicit,
    {
      id:
        allocations.find((candidate) => candidate.isRemainder)?.id ??
        nextAllocationId(item.id, allocations),
      mode: remainderMode,
      value:
        remainderMode === 'percentage'
          ? formatPercentage(remainderMinutes, totalMinutes)
          : formatDurationMinutes(remainderMinutes),
      durationMinutes: remainderMinutes,
      duration: formatDurationMinutes(remainderMinutes),
      ...(remainderTagId === undefined ? {} : { tagId: remainderTagId }),
      isRemainder: true,
    },
  ]);
}

export function applyTemplateToItem(
  state: OperationData,
  itemId: string,
  template: MarkingTemplate,
  basis: TemplateApplicationBasis,
  overflowStrategy: TemplateOverflowStrategy,
): OperationData {
  requirePhase(state, 'preview');
  const item = state.items.find(
    (candidate) => candidate.id === itemId && isEditablePreviewItem(candidate),
  );
  if (!item || item.result !== undefined)
    throw new Error('Dia indisponível para aplicar um template.');
  const totalMinutes = allocationTotalMinutes(state, item);
  const calendarAllocations = (item.allocations ?? []).filter(
    (allocation) => allocation.provenance?.kind === 'calendar',
  );
  const calendarMinutes = calendarAllocations.reduce(
    (total, allocation) => total + allocation.durationMinutes,
    0,
  );
  const availableMinutes = totalMinutes - calendarMinutes;
  if (availableMinutes <= 0)
    throw new Error(
      'Não há saldo disponível para aplicar um template após as marcações do Google Calendar.',
    );
  const defaultTagId = state.config?.defaultTagId;
  const templateAllocations = withAllocationIds(
    item.id,
    applyMarkingTemplate(
      template,
      availableMinutes,
      basis,
      overflowStrategy,
      defaultTagId,
    ),
  );
  const allocations = [...calendarAllocations, ...templateAllocations];
  return {
    ...state,
    items: state.items.map((candidate) => {
      if (candidate.id !== itemId) return candidate;
      const {
        appliedRuleId: previousRuleId,
        appliedRuleName: previousRuleName,
        ...withoutRule
      } = candidate;
      void previousRuleId;
      void previousRuleName;
      return {
        ...withoutRule,
        allocations,
        appliedTemplateIds: [template.id],
        decision: 'selected' as const,
        ...(templateAllocations[0]?.tagId === undefined
          ? {}
          : { tagId: templateAllocations[0].tagId }),
      };
    }),
    message: `Template ${template.name} aplicado a ${formatBrazilianDate(item.date)} por ${basis === 'percentage' ? 'percentual' : 'duração original'}.`,
  };
}

export function prepareSelectedQueue(state: OperationData): OperationData {
  requirePhase(state, 'preview');
  const queue = state.items
    .filter(
      (item) => isEditablePreviewItem(item) && item.decision === 'selected',
    )
    .flatMap(
      (item) =>
        item.allocations?.map((allocation) => allocation.id) ?? [item.id],
    );
  if (queue.length === 0) throw new Error('Selecione ao menos um item.');
  return {
    ...state,
    items: state.items.map((item) =>
      item.decision === 'refused' ? { ...item, result: 'skipped' } : item,
    ),
    queue,
    queueIndex: 0,
    writeProgress: {
      status: 'running',
      completedItems: 0,
      totalItems: queue.length,
      detail: `Preparando ${String(queue.length)} apontamento(s) para envio ao Channel.`,
    },
    message: `Preparando ${String(queue.length)} apontamento(s) para envio ao Channel.`,
  };
}

export function prepareItemQueue(
  state: OperationData,
  itemId: string,
): OperationData {
  requirePhase(state, 'preview');
  const item = state.items.find(
    (candidate) =>
      candidate.id === itemId &&
      isEditablePreviewItem(candidate) &&
      candidate.result === undefined,
  );
  if (!item) throw new Error('Este dia não está disponível para envio.');
  const queue = item.allocations
    ?.filter((allocation) => allocation.result === undefined)
    .map((allocation) => allocation.id) ?? [item.id];
  if (queue.length === 0)
    throw new Error('Este dia não possui marcações pendentes.');
  return {
    ...state,
    items: state.items.map((candidate) =>
      candidate.id === itemId
        ? { ...candidate, decision: 'selected' as const }
        : candidate,
    ),
    queue,
    queueIndex: 0,
    writeProgress: {
      status: 'running',
      completedItems: 0,
      totalItems: queue.length,
      currentDate: item.date,
      detail: `Preparando ${formatPortugueseQuantity(queue.length, 'marcação', 'marcações')} de ${formatBrazilianDate(item.date)} para envio ao Channel.`,
    },
    message: `Preparando as marcações de ${formatBrazilianDate(item.date)} para envio ao Channel.`,
  };
}

export async function reconcileItemWrite(
  written: OperationData,
  itemId: string,
  adapters: CoordinatorAdapters,
): Promise<OperationData> {
  const writtenItem = written.items.find((item) => item.id === itemId);
  try {
    const refreshed = await captureAndCompareOperation(written, adapters);
    const writtenByDate = new Map(
      written.items.map((item) => [item.date, item]),
    );
    const items = refreshed.items.map((item) => {
      const previous = writtenByDate.get(item.date);
      return previous?.result === undefined
        ? item
        : { ...item, result: previous.result };
    });
    const hasPendingDays = items.some(
      (item) => isEditablePreviewItem(item) && item.result === undefined,
    );
    return {
      ...refreshed,
      phase: hasPendingDays ? 'preview' : 'completed',
      items,
      queue: [],
      queueIndex: 0,
      ...(written.writeProgress === undefined
        ? {}
        : { writeProgress: written.writeProgress }),
      message: `Marcações de ${writtenItem ? formatBrazilianDate(writtenItem.date) : 'este dia'} enviadas e prévia atualizada.`,
    };
  } catch {
    return {
      ...written,
      phase: 'preview',
      queue: [],
      queueIndex: 0,
      message: `As marcações de ${writtenItem ? formatBrazilianDate(writtenItem.date) : 'este dia'} foram enviadas, mas a prévia não pôde ser atualizada. Capture e compare novamente.`,
    };
  }
}

export function completeDryRun(state: OperationData): OperationData {
  requirePhase(state, 'preview');
  return {
    ...state,
    phase: 'dry-run',
    items: state.items.map((item) =>
      isEditablePreviewItem(item) && item.result === undefined
        ? { ...item, result: 'skipped' }
        : item,
    ),
    message: 'Dry-run concluído. Nenhuma escrita ou submissão foi executada.',
  };
}

export async function fillCurrentQueueItem(
  state: OperationData,
  adapters: CoordinatorAdapters,
): Promise<OperationData> {
  if (
    !state.targetTab ||
    !state.config ||
    !state.sourceRows ||
    !state.resolvedPeriod
  ) {
    throw new Error('Estado de preenchimento incompleto.');
  }
  if (state.queueIndex >= state.queue.length) {
    return {
      ...state,
      phase: 'completed',
      message: 'Todos os apontamentos selecionados foram processados.',
    };
  }
  const itemId = state.queue[state.queueIndex];
  if (itemId === undefined) throw new Error('Posição inválida na fila.');
  const queued = queuedAllocation(state, itemId);
  if (!queued) throw new Error('Item da fila não está mais disponível.');
  const { item, allocation } = queued;
  const record = {
    date: item.date,
    durationMinutes: allocation.durationMinutes,
  };

  let currentTargetRows = state.targetRows ?? [];
  if (state.queueIndex > 0) {
    const reread = await adapters.readTarget(state.targetTab.id, {
      startDate: formatBrazilianDate(state.resolvedPeriod.start),
      endDate: formatBrazilianDate(state.resolvedPeriod.end),
    });
    if (!reread.ok) {
      return itemResult(
        state,
        itemId,
        'failed',
        'Não foi possível revalidar o extrato; nenhum novo campo foi alterado.',
      );
    }
    currentTargetRows = comparableRows(reread);
  }
  const existing = aggregateRowsByDate(currentTargetRows).get(record.date);
  const existingMinutes = existing?.durationMinutes ?? 0;
  const expectedExistingMinutes = confirmedMinutesBefore(
    state,
    item.date,
    itemId,
  );
  if (
    existingMinutes ===
    expectedExistingMinutes + allocation.durationMinutes
  ) {
    return itemResult(
      { ...state, targetRows: currentTargetRows },
      itemId,
      'already-correct',
      'Esta marcação já está contabilizada no extrato. Revise e avance.',
      existing?.duration,
      existing,
    );
  }
  if (existingMinutes !== expectedExistingMinutes)
    return itemResult(
      { ...state, targetRows: currentTargetRows },
      itemId,
      'validation-error',
      'O total do dia mudou no Channel; nenhum novo campo foi alterado.',
      existing?.duration,
      existing,
    );

  const tag = state.config.tags?.find(
    (candidate) => candidate.id === allocation.tagId,
  );
  const ragItem = findRagItem(allocation.ragCatalogId, allocation.ragItemId);
  const assignment: ChannelAssignment = (() => {
    if (ragItem?.kind === 'AD_HOC') {
      return {
        ...assignAdHoc(record, {
          client: ragItem.channel.client,
          operationNature: ragItem.channel.operationNature,
          activityType: ragItem.channel.activityType,
          comments: ragItem.comment ?? ragItem.event,
        }),
        expectedExistingMinutes,
      };
    }
    if (ragItem?.kind === 'PROJECT') {
      const needsTag =
        ragItem.channel.projectSource === 'TAG' ||
        ragItem.channel.activitySource === 'TAG';
      if (needsTag && !tag)
        throw new Error('Escolha uma TAG para completar este item RAG.');
      return {
        ...assignExpertProject(record, {
          project: ragItem.channel.project ?? tag?.project ?? '',
          activity: ragItem.channel.activity ?? tag?.activity ?? '',
          activityType: ragItem.channel.activityType,
          task: ragItem.channel.task,
          comments: ragItem.comment ?? ragItem.event,
        }),
        expectedExistingMinutes,
      };
    }
    return {
      ...assignExpertProject(
        record,
        tag
          ? {
              project: tag.project,
              activity: tag.activity,
              activityType: tag.activityType ?? 'Nenhum',
              task: tag.task ?? 'Nenhum',
              comments: tag.comments ?? '',
            }
          : state.config,
      ),
      expectedExistingMinutes,
    };
  })();
  const result = await adapters.writeTarget(state, assignment);
  const recognized =
    result.status === 'filled' || result.status === 'already-correct';
  return {
    ...state,
    items: state.items.map((candidate) =>
      candidate.id === item.id
        ? {
            ...candidate,
            ...(candidate.allocations === undefined
              ? {}
              : {
                  allocations: candidate.allocations.map((current) =>
                    current.id === itemId
                      ? { ...current, result: result.status }
                      : current,
                  ),
                }),
            ...(allAllocationsRecognized(
              candidate.allocations,
              itemId,
              result.status,
            )
              ? { result: result.status }
              : {}),
            ...(recognized
              ? {
                  ...(allAllocationsRecognized(
                    candidate.allocations,
                    itemId,
                    result.status,
                  )
                    ? {
                        status: 'equal' as const,
                        channelDuration: formatDurationMinutes(
                          expectedExistingMinutes + allocation.durationMinutes,
                        ),
                        channelProject:
                          (candidate.allocations?.length ?? 1) > 1
                            ? 'Múltiplas TAGs'
                            : assignment.kind === 'PROJETOS'
                              ? assignment.project
                              : `Avulso · ${assignment.client}`,
                        channelActivity:
                          (candidate.allocations?.length ?? 1) > 1
                            ? `${String(candidate.allocations?.length ?? 1)} marcações`
                            : assignment.kind === 'PROJETOS'
                              ? assignment.activity
                              : assignment.operationNature,
                      }
                    : {}),
                }
              : {}),
          }
        : candidate,
    ),
    phase: recognized ? 'waiting-review' : 'partial',
    message: recognized
      ? 'Apontamento confirmado pelo Channel.'
      : channelWriteFailureMessage(result.code),
  };
}

export async function fillSelectedQueue(
  initial: OperationData,
  adapters: CoordinatorAdapters,
): Promise<OperationData> {
  let current = initial;
  while (current.queueIndex < current.queue.length) {
    const itemId = current.queue[current.queueIndex];
    if (itemId === undefined) throw new Error('Posição inválida na fila.');
    const position = current.queueIndex + 1;
    const queued = queuedAllocation(current, itemId);
    if (!queued) throw new Error('Marcação da fila não está disponível.');
    const itemDate = queued.item.date;
    let progress: WriteProgress = {
      status: 'running',
      completedItems: current.queueIndex,
      totalItems: current.queue.length,
      currentDate: itemDate,
      detail: `Revalidando ${formatBrazilianDate(itemDate)} no Channel (${String(position)} de ${String(current.queue.length)})…`,
    };
    current = { ...current, writeProgress: progress, message: progress.detail };
    await adapters.reportWriteProgress?.(current, progress);
    const written = await fillCurrentQueueItem(current, adapters);
    if (written.phase === 'partial') {
      progress = {
        ...progress,
        status: 'failed',
        detail: `Envio interrompido em ${formatBrazilianDate(itemDate)}: ${written.message ?? 'o Channel não confirmou o apontamento.'}`,
      };
      const failed = { ...written, writeProgress: progress };
      await adapters.reportWriteProgress?.(failed, progress);
      return failed;
    }
    progress = {
      status: 'running',
      completedItems: position,
      totalItems: current.queue.length,
      currentDate: itemDate,
      detail: `${formatBrazilianDate(itemDate)} enviado e confirmado (${String(position)} de ${String(current.queue.length)}).`,
    };
    const confirmed = {
      ...written,
      writeProgress: progress,
      message: progress.detail,
    };
    await adapters.reportWriteProgress?.(confirmed, progress);
    current = advanceQueue(confirmed);
  }
  const completed = await fillCurrentQueueItem(current, adapters);
  const progress: WriteProgress = {
    status: 'done',
    completedItems: current.queue.length,
    totalItems: current.queue.length,
    detail: `${String(current.queue.length)} de ${String(current.queue.length)} apontamento(s) enviado(s) e confirmado(s) pelo Channel.`,
  };
  const result = {
    ...completed,
    writeProgress: progress,
    message: progress.detail,
  };
  await adapters.reportWriteProgress?.(result, progress);
  return result;
}

export function advanceQueue(state: OperationData): OperationData {
  if (state.phase !== 'waiting-review' && state.phase !== 'partial') {
    throw new Error('A fila não está aguardando revisão.');
  }
  return { ...state, queueIndex: state.queueIndex + 1 };
}

export function cancelOperation(state: OperationData): OperationData {
  return {
    ...state,
    phase: 'cancelled',
    pendingRole: undefined,
    inFlight: undefined,
    items: state.items.map((item) =>
      isEditablePreviewItem(item) && item.result === undefined
        ? { ...item, result: 'skipped' }
        : item,
    ),
    message: 'Operação cancelada. Nenhum novo item será preenchido.',
  };
}

function inferDefaultTagFromLastChannelMarking(
  config: OperationConfig,
  result: Extract<InjectedChannelReadResult, { ok: true }>,
): OperationConfig {
  if (
    config.defaultTagId !== undefined &&
    config.tags?.some((tag) => tag.id === config.defaultTagId)
  )
    return config;

  let latest:
    | {
        readonly date: string;
        readonly project: string;
        readonly activity: string;
      }
    | undefined;
  for (const row of result.rows) {
    for (const marking of row.markings ?? []) {
      const project = marking.project?.trim();
      const activity = marking.activity?.trim();
      if (!project || !activity) continue;
      if (latest === undefined || row.date >= latest.date)
        latest = { date: row.date, project, activity };
    }
  }
  if (!latest) return config;

  const tag: ChannelTag = {
    id: crypto.randomUUID(),
    name: `${latest.project} — ${latest.activity}`,
    projectId: '',
    project: latest.project,
    activityId: '',
    activity: latest.activity,
    activityType: 'Nenhum',
    task: 'Nenhum',
  };
  return {
    ...config,
    project: tag.project,
    activity: tag.activity,
    activityType: tag.activityType ?? 'Nenhum',
    task: tag.task ?? 'Nenhum',
    tags: [...(config.tags ?? []), tag],
    defaultTagId: tag.id,
    ...(config.googleCalendar === undefined
      ? {}
      : {
          googleCalendar: assignDefaultTagToContextualRagRules(
            config.googleCalendar,
            tag.id,
          ),
        }),
  };
}

function comparableRows(
  result: Extract<InjectedChannelReadResult, { ok: true }>,
): readonly ComparableWorkRecord[] {
  return result.rows.map((row) => ({
    date: civilDate(row.date),
    duration: row.duration,
    durationMinutes: row.durationMinutes,
    ...(row.project === undefined ? {} : { project: row.project }),
    ...(row.activity === undefined ? {} : { activity: row.activity }),
  }));
}

function collectChannelMarkingsByDate(
  result: Extract<InjectedChannelReadResult, { ok: true }>,
): ReadonlyMap<CivilDate, NonNullable<PreviewItem['channelMarkings']>> {
  const byDate = new Map<
    CivilDate,
    NonNullable<PreviewItem['channelMarkings']>[number][]
  >();
  for (const row of result.rows) {
    const date = civilDate(row.date);
    const existing = byDate.get(date) ?? [];
    const knownIds = new Set(existing.map((marking) => marking.id));
    for (const marking of row.markings ?? []) {
      if (knownIds.has(marking.id)) continue;
      knownIds.add(marking.id);
      existing.push({
        id: marking.id,
        duration: marking.duration,
        durationMinutes: marking.durationMinutes,
        ...(marking.project === undefined ? {} : { project: marking.project }),
        ...(marking.activity === undefined
          ? {}
          : { activity: marking.activity }),
        canDelete: marking.canDelete,
      });
    }
    byDate.set(date, existing);
  }
  return byDate;
}

function itemResult(
  state: OperationData,
  itemId: string,
  result: NonNullable<PreviewItem['result']>,
  message: string,
  channelDuration?: string,
  channelRecord?: ComparableWorkRecord,
): OperationData {
  return {
    ...state,
    items: state.items.map((item) =>
      item.id === itemId || item.allocations?.some((item) => item.id === itemId)
        ? {
            ...item,
            ...(item.allocations === undefined
              ? {}
              : {
                  allocations: item.allocations.map((allocation) =>
                    allocation.id === itemId
                      ? { ...allocation, result }
                      : allocation,
                  ),
                }),
            ...(allAllocationsRecognized(item.allocations, itemId, result)
              ? { result }
              : result === 'already-correct'
                ? {}
                : { result }),
            ...(result === 'already-correct'
              ? {
                  ...(allAllocationsRecognized(item.allocations, itemId, result)
                    ? { status: 'equal' as const }
                    : {}),
                  ...(channelDuration === undefined ? {} : { channelDuration }),
                  ...(channelRecord?.project === undefined
                    ? {}
                    : { channelProject: channelRecord.project }),
                  ...(channelRecord?.activity === undefined
                    ? {}
                    : { channelActivity: channelRecord.activity }),
                }
              : result === 'validation-error'
                ? {
                    status: 'divergent' as const,
                    ...(channelDuration === undefined
                      ? {}
                      : { channelDuration }),
                    ...(channelRecord?.project === undefined
                      ? {}
                      : { channelProject: channelRecord.project }),
                    ...(channelRecord?.activity === undefined
                      ? {}
                      : { channelActivity: channelRecord.activity }),
                  }
                : {}),
          }
        : item,
    ),
    phase: result === 'already-correct' ? 'waiting-review' : 'partial',
    message,
  };
}

function aggregateRowsByDate(
  rows: readonly ComparableWorkRecord[],
): ReadonlyMap<CivilDate, ComparableWorkRecord> {
  const result = new Map<CivilDate, ComparableWorkRecord>();
  for (const row of rows) {
    const previous = result.get(row.date);
    const durationMinutes =
      (previous?.durationMinutes ?? 0) + row.durationMinutes;
    result.set(row.date, {
      ...row,
      durationMinutes,
      duration: formatDurationMinutes(durationMinutes),
    });
  }
  return result;
}

function requireEditableAllocation(
  state: OperationData,
  itemId: string,
  allocationId: string,
) {
  requirePhase(state, 'preview');
  const item = state.items.find(
    (candidate) => candidate.id === itemId && isEditablePreviewItem(candidate),
  );
  const allocation = item?.allocations?.find(
    (candidate) => candidate.id === allocationId,
  );
  if (!item || !allocation || allocation.result !== undefined)
    throw new Error('Marcação indisponível para edição.');
  return { item, allocation };
}

function isEditablePreviewItem(item: PreviewItem): boolean {
  return item.status === 'missing' || item.editingBalanceMinutes !== undefined;
}

function allocationTotalMinutes(
  state: OperationData,
  item: PreviewItem,
): number {
  return item.editingBalanceMinutes ?? sourceMinutes(state, item.date);
}

function updateItemAllocations(
  state: OperationData,
  itemId: string,
  update: (
    allocations: NonNullable<PreviewItem['allocations']>,
  ) => NonNullable<PreviewItem['allocations']>,
): OperationData {
  return {
    ...state,
    items: state.items.map((item) =>
      item.id === itemId
        ? { ...item, allocations: update(item.allocations ?? []) }
        : item,
    ),
  };
}

function sourceMinutes(state: OperationData, date: CivilDate): number {
  const minutes = state.sourceRows?.find(
    (row) => row.date === date,
  )?.durationMinutes;
  if (minutes === undefined || minutes <= 0)
    throw new Error('Total diário indisponível para divisão.');
  return minutes;
}

function allocationMinutes(
  mode: 'percentage' | 'duration',
  value: string,
  totalMinutes: number,
): number {
  let minutes: number;
  if (mode === 'percentage') {
    const percentage = Number(value.replace(',', '.'));
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100)
      throw new Error('Informe um percentual maior que 0 e de até 100%.');
    minutes = Math.round((totalMinutes * percentage) / 100);
  } else {
    try {
      minutes = parseDurationMinutes(value);
    } catch {
      throw new Error('Informe a duração no formato HH:MM.');
    }
  }
  if (minutes <= 0)
    throw new Error('A marcação deve ter duração mínima de 00:01.');
  return minutes;
}

function normalizeAllocationValue(
  mode: 'percentage' | 'duration',
  value: string,
): string {
  return mode === 'percentage'
    ? String(Number(value.replace(',', '.')))
    : formatDurationMinutes(parseDurationMinutes(value));
}

function formatPercentage(minutes: number, totalMinutes: number): string {
  return String(Number(((minutes * 100) / totalMinutes).toFixed(2)));
}

function nextAllocationId(
  itemId: string,
  allocations: NonNullable<PreviewItem['allocations']>,
): string {
  let suffix = 2;
  while (
    allocations.some(
      (allocation) => allocation.id === `${itemId}::${String(suffix)}`,
    )
  )
    suffix += 1;
  return `${itemId}::${String(suffix)}`;
}

function withAllocationIds(
  itemId: string,
  drafts: readonly TemplateAllocationDraft[],
): readonly PreviewAllocation[] {
  return drafts.map((draft, index) => ({
    id: index === 0 ? itemId : `${itemId}::${String(index + 1)}`,
    ...draft,
  }));
}

function queuedAllocation(state: OperationData, allocationId: string) {
  for (const item of state.items) {
    const allocation = item.allocations?.find(
      (candidate) => candidate.id === allocationId,
    );
    if (allocation) return { item, allocation };
    if (item.id === allocationId) {
      const source = state.sourceRows?.find((row) => row.date === item.date);
      if (source)
        return {
          item,
          allocation: {
            id: item.id,
            mode: 'percentage' as const,
            value: '100',
            durationMinutes: source.durationMinutes,
            duration: source.duration,
            ...(item.tagId === undefined ? {} : { tagId: item.tagId }),
            isRemainder: true,
            ...(item.result === undefined ? {} : { result: item.result }),
          },
        };
    }
  }
  return undefined;
}

function confirmedMinutesBefore(
  state: OperationData,
  date: CivilDate,
  allocationId: string,
): number {
  const index = state.queue.indexOf(allocationId);
  const current = queuedAllocation(state, allocationId);
  const sourceTotal = current ? sourceMinutes(state, current.item.date) : 0;
  const initialChannelMinutes = current?.item.editingBalanceMinutes
    ? sourceTotal - current.item.editingBalanceMinutes
    : 0;
  return state.queue.slice(0, Math.max(0, index)).reduce((total, id) => {
    const queued = queuedAllocation(state, id);
    return queued?.item.date === date &&
      (queued.allocation.result === 'filled' ||
        queued.allocation.result === 'already-correct')
      ? total + queued.allocation.durationMinutes
      : total;
  }, initialChannelMinutes);
}

function allAllocationsRecognized(
  allocations: PreviewItem['allocations'],
  currentId: string,
  currentResult: NonNullable<PreviewItem['result']>,
): boolean {
  return (
    allocations?.every((allocation) => {
      const result =
        allocation.id === currentId ? currentResult : allocation.result;
      return result === 'filled' || result === 'already-correct';
    }) ?? true
  );
}

function requirePhase(
  state: OperationData,
  phase: OperationData['phase'],
): void {
  if (state.phase !== phase) {
    throw new Error(`Ação indisponível no estado ${state.phase}.`);
  }
}
