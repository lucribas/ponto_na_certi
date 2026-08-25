import {
  civilDate,
  defaultPeriod,
  formatDurationMinutes,
  formatBrazilianDate,
  monthPeriod,
  parseDurationMinutes,
  rangePeriod,
} from '../domain';
import type { PunchOverride } from '../domain';
import type {
  OperationConfig,
  PublicOperationState,
  SystemProgress,
  TabRole,
} from '../application/types';
import { isStaleOperationState } from '../application/types';
import {
  applyRagCatalogCsvImport,
  createRagItem,
  deleteRagItem,
  editRagItem,
  exportRagCatalogCsv,
  findRagItem,
  getOriginalRagCatalog,
  getOriginalRagCatalogs,
  getRagCatalogOverrides,
  getRagItemState,
  previewRagCatalogCsvImport,
  ragCatalogs,
  restoreAllRagCatalogs,
  restoreRagCatalog,
  restoreRagItem,
  setRagCatalogOverrides,
  type RagCatalog,
  type RagImportPreview,
  type RagItem,
  type RagItemInput,
  type RagItemKind,
  type RagItemState,
} from '../application/rag';
import {
  assignDefaultTagToContextualRagRules,
  automaticRagRule,
  isContextualRagCalendarRule,
  isImportedRagCalendarRule,
  reassignContextualRagRulesTag,
  renameUnmodifiedAutomaticRagRule,
  restoreImportedRagCalendarRule,
} from '../application/google-calendar';
import {
  countRagReferences,
  reassignRagReferences,
  removeRagReferences,
  type RagTarget,
} from '../application/rag-integrity';
import {
  createMarkingTemplate,
  describeTemplateRule,
  totalTemplateDuration,
} from '../application/marking-templates';
import {
  defaultExtensionSettings,
  loadExtensionSettings,
  resolveChannelTagInCatalog,
  saveExtensionSettings,
  type ChannelCatalogProject,
  type CalendarEventField,
  type ChannelTag,
  type ExtensionSettings,
  type GoogleCalendarRule,
  type MarkingTemplate,
  type RuleTemplateShare,
  type TemplateApplicationRule,
  type Weekday,
} from '../application/settings';
import type { IncomingMessage, UiResponse } from '../messaging/messages';
import { toSafeDiagnostic } from '../shared/diagnostics';
import {
  formatPortugueseQuantity,
  inflectPortuguese,
} from '../shared/portuguese';
import {
  calendarCaptureEnabled,
  GOOGLE_CALENDAR_API_ORIGIN,
  GOOGLE_CALENDAR_WEB_ORIGIN,
  requestGoogleCalendarApiAccess,
  requestGoogleCalendarTabAccess,
} from '../sites/google-calendar';
import { LOGIN_PERMISSION_ORIGINS } from '../sites/login';

// A única conversão DOM fica concentrada nesta fronteira; cada chamada informa o tipo nativo esperado.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const byId = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Elemento ausente: ${id}`);
  return value as T;
};

let state: PublicOperationState | undefined;
let requestPending = false;
let loginPermissionPending = false;
let transientMessage: string | undefined;
let settings: ExtensionSettings = defaultExtensionSettings();
let catalogPending = false;
let tagEditorMessage = '';
let editingTagId: string | undefined;
let loginMonitorPending = false;
let loginCompletionObserved = false;
let deletingMarkingId: string | undefined;
let templateManagerMessage = '';
let templateSaveEditorItemId: string | undefined;
let editingTemplateId: string | undefined;
let templateEntryCounter = 0;
let ruleShareCounter = 0;
let calendarPending = false;
let calendarManagerMessage = '';
let editingCalendarRuleId: string | undefined;
let tagRagCopyOpen = false;
let punchAlertPending = false;
let punchAlertMessage = '';
let ragUpdatePending = false;
let ragUpdateMessage = '';
let editingRagItemId: string | undefined;
let ragEditorOpen = false;
let ragEditorInitialValue = '';
let ragItemEditorMessage = '';
let ragImportPreview: RagImportPreview | undefined;
let ragSelectedCatalogId = '';
let ragDeleteTarget: RagTarget | undefined;

function adoptState(
  next: PublicOperationState,
  allowOperationChange = false,
): boolean {
  const current = state;
  if (current !== undefined) {
    if (current.operationId !== next.operationId && !allowOperationChange)
      return false;
    if (isStaleOperationState(current, next)) return false;
  }
  state = next;
  return true;
}

function useSettings(loaded: ExtensionSettings): void {
  settings = loaded;
  setRagCatalogOverrides(loaded.ragCatalogOverrides);
}

function logPanelFailure(messageType: string, error: unknown): void {
  console.error('[PontoNaCerti][Panel]', {
    status: 'failed',
    messageType,
    ...toSafeDiagnostic(error, 'ui'),
  });
}

async function send(message: IncomingMessage): Promise<void> {
  const isCancellation =
    message.type === 'CANCEL_OPERATION' ||
    message.type === 'STOP_CURRENT_ACTION';
  if (requestPending && !isCancellation)
    throw new Error('Aguarde a ação atual terminar.');
  const ownsPending = !requestPending;
  if (ownsPending) requestPending = true;
  render();
  try {
    const response: UiResponse = await chrome.runtime.sendMessage(message);
    if (!response.ok) throw new Error(response.message ?? response.code);
    adoptState(response.state, message.type === 'START_OPERATION');
    transientMessage = undefined;
  } finally {
    if (ownsPending) requestPending = false;
    render();
  }
}

async function refresh(): Promise<void> {
  const requestedOperationId = state?.operationId;
  const response: UiResponse = await chrome.runtime.sendMessage({
    type: 'GET_STATE',
  });
  if (!response.ok) throw new Error(response.message ?? response.code);
  if (
    requestedOperationId !== undefined &&
    state?.operationId !== requestedOperationId
  )
    return;
  adoptState(response.state, true);
  render();
}

async function discoverOpenTabs(): Promise<void> {
  if (state === undefined) return;
  try {
    await send({
      type: 'DISCOVER_OPEN_TABS',
      operationId: state.operationId,
    });
  } catch (error: unknown) {
    logPanelFailure('DISCOVER_OPEN_TABS', error);
  }
}

function operationId(): string {
  if (state === undefined) throw new Error('Operação não iniciada.');
  return state.operationId;
}

function readConfig(): OperationConfig {
  const defaultTag = settings.tags.find(
    (tag) => tag.id === settings.defaultTagId,
  );
  const kind = byId<HTMLSelectElement>('period-kind').value;
  const period =
    kind === 'month'
      ? monthPeriod(byId<HTMLInputElement>('month').value)
      : kind === 'range'
        ? rangePeriod(
            civilDate(byId<HTMLInputElement>('start').value),
            civilDate(byId<HTMLInputElement>('end').value),
          )
        : defaultPeriod();
  return {
    project: defaultTag?.project ?? '',
    activity: defaultTag?.activity ?? '',
    activityType: defaultTag?.activityType?.trim() || 'Nenhum',
    task: defaultTag?.task?.trim() || 'Nenhum',
    period,
    overrides: parseOverrides(byId<HTMLTextAreaElement>('overrides').value),
    tags: settings.tags,
    ...(defaultTag === undefined ? {} : { defaultTagId: defaultTag.id }),
    markingTemplates: settings.markingTemplates,
    templateRules: settings.templateRules,
    googleCalendar: settings.googleCalendar,
  };
}

function parseOverrides(value: string): readonly PunchOverride[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [dateValue, timesValue] = line.split('=', 2);
      if (!dateValue || !timesValue)
        throw new Error(`Override inválido: ${line}`);
      return {
        date: civilDate(dateValue.trim()),
        times: timesValue.split(',').map((time) => time.trim()),
      };
    });
}

function currentMonthValue(now: Date = new Date()): string {
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function resetCapturePeriodToCurrentMonth(): void {
  byId<HTMLSelectElement>('period-kind').value = 'month';
  byId<HTMLInputElement>('month').value = currentMonthValue();
  byId('month-field').hidden = false;
  byId('start-field').hidden = true;
  byId('end-field').hidden = true;
}

async function startNewOperation(): Promise<void> {
  await act({
    type: 'START_OPERATION',
    operationId: crypto.randomUUID(),
  });
  resetCapturePeriodToCurrentMonth();
}

function render(): void {
  if (state === undefined) return;
  const busy =
    requestPending ||
    loginPermissionPending ||
    catalogPending ||
    state.inFlight !== undefined;
  document
    .querySelectorAll<HTMLButtonElement>('button')
    .forEach(
      (button) =>
        (button.disabled =
          busy &&
          !button.classList.contains('dialog-close') &&
          !button.classList.contains('global-control')),
    );
  byId<HTMLButtonElement>('cancel').disabled =
    state.phase === 'cancelled' ||
    state.phase === 'completed' ||
    state.phase === 'dry-run';
  renderConfig();
  renderSettings();
  renderTemplateManager();
  renderConnectionAlert();
  renderLoginPreparation();
  renderFlowOverview();
  renderCaptureProgress();
  renderWriteProgress();
  renderTab('source', state.sourceTab?.id, state.pendingRole);
  renderTab('target', state.targetTab?.id, state.pendingRole);
  const bothRegistered = Boolean(state.sourceTab && state.targetTab);
  const allConnected = bothRegistered && settings.googleCalendar.connected;
  const loginAttempted =
    state.loginPreparation !== undefined &&
    (state.loginPreparation.ahgora !== 'idle' ||
      state.loginPreparation.channel !== 'idle');
  byId<HTMLElement>('manual-registration').hidden =
    !loginAttempted || bothRegistered;
  byId<HTMLElement>('registration-hint').textContent = bothRegistered
    ? 'Abas registradas automaticamente pela permissão opcional concedida na etapa anterior.'
    : 'Se alguma aba não foi registrada automaticamente, escolha Registrar, vá até ela e clique no ícone da extensão.';
  byId<HTMLButtonElement>('apply').disabled =
    busy || !allConnected || !state.canApply;
  byId<HTMLButtonElement>('capture').disabled = busy || !allConnected;
  const advance = byId<HTMLButtonElement>('advance');
  advance.disabled = busy || !allConnected;
  advance.hidden =
    state.inFlight !== undefined ||
    (state.phase !== 'waiting-review' && state.phase !== 'partial');
  const currentItemId = state.queue[state.queueIndex];
  const currentResult = state.items
    .flatMap((item) => item.allocations ?? [])
    .find((allocation) => allocation.id === currentItemId)?.result;
  advance.textContent =
    currentResult === 'filled'
      ? 'Continuar após confirmação'
      : currentResult === 'already-correct'
        ? 'Item já correto — avançar'
        : 'Ignorar falha e avançar';
  renderPreviewActions(advance);
  renderPreviewStatus();
  byId<HTMLOutputElement>('operation-status').textContent =
    transientMessage ?? state.message ?? phaseLabel(state.phase);
  byId<HTMLElement>('totals').textContent =
    `${String(state.items.length)} itens · ${String(state.selectedCount)} selecionados`;
  byId<HTMLOutputElement>('total-captured').textContent = totalLabel(
    state.capturedMinutes,
    state.capturedCount,
    'registro',
  );
  byId<HTMLOutputElement>('total-review').textContent = totalLabel(
    state.reviewMinutes,
    state.reviewCount,
    'item',
  );
  byId<HTMLOutputElement>('total-selected').textContent = totalLabel(
    state.selectedMinutes,
    state.selectedCount,
    'item',
  );
  byId<HTMLElement>('effective-period').textContent = state.resolvedPeriod
    ? `Período efetivo: ${formatBrazilianDate(state.resolvedPeriod.start)} a ${formatBrazilianDate(state.resolvedPeriod.end)}`
    : '';
  renderPreview();
}

function renderPreviewActions(advance: HTMLButtonElement): void {
  if (!state) return;
  const hasSelectableRemaining =
    state.phase === 'preview' &&
    state.items.some(
      (item) =>
        item.status === 'missing' &&
        item.decision === 'pending' &&
        item.result === undefined,
    );
  const selectedSendable = state.items.some(
    (item) =>
      itemIsEditable(item) &&
      item.decision === 'selected' &&
      item.result === undefined,
  );
  const showSendAction = state.phase === 'preview' && selectedSendable;
  byId<HTMLButtonElement>('select-remaining').hidden = !hasSelectableRemaining;
  byId<HTMLButtonElement>('apply').hidden = !showSendAction;
  const showCancel =
    selectedSendable &&
    state.phase !== 'cancelled' &&
    state.phase !== 'completed' &&
    state.phase !== 'dry-run';
  byId<HTMLButtonElement>('cancel').hidden = !showCancel;
  byId<HTMLElement>('review-actions').hidden = !hasSelectableRemaining;
  byId<HTMLElement>('send-actions').hidden =
    !showSendAction && !showCancel && advance.hidden;
  byId<HTMLElement>('send-warning').hidden = !showSendAction;
}

function renderPreviewStatus(): void {
  if (!state) return;
  const currentState = state;
  const output = byId<HTMLOutputElement>('preview-status');
  const confirmed = currentState.items.filter(
    (item) => item.result === 'filled' || item.result === 'already-correct',
  ).length;
  const allocationResults = currentState.items.flatMap(
    (item) => item.allocations?.map((allocation) => allocation.result) ?? [],
  );
  const confirmedMarkings = allocationResults.filter(
    (result) => result === 'filled' || result === 'already-correct',
  ).length;
  const errors = allocationResults.filter(
    (result) =>
      result === 'failed' ||
      result === 'not-found' ||
      result === 'validation-error',
  ).length;
  const sending = currentState.inFlight === 'apply';
  const allQueuedConfirmed =
    currentState.queue.length > 0 &&
    currentState.queue.every((itemId) => {
      const result = currentState.items
        .flatMap((item) => item.allocations ?? [])
        .find((allocation) => allocation.id === itemId)?.result;
      return result === 'filled' || result === 'already-correct';
    });
  output.hidden =
    !sending &&
    confirmed === 0 &&
    errors === 0 &&
    currentState.phase !== 'completed' &&
    currentState.phase !== 'partial';
  output.classList.toggle(
    'success',
    errors === 0 && confirmed > 0 && (!sending || allQueuedConfirmed),
  );
  output.classList.toggle(
    'error',
    errors > 0 || currentState.phase === 'partial',
  );
  output.classList.toggle('running', sending && !allQueuedConfirmed);
  output.textContent =
    errors > 0 || currentState.phase === 'partial'
      ? `Envio interrompido: ${formatPortugueseQuantity(confirmedMarkings, 'marcação', 'marcações')} ${inflectPortuguese(confirmedMarkings, 'confirmada', 'confirmadas')} e ${String(errors)} com erro. Revise as linhas em vermelho.`
      : allQueuedConfirmed
        ? `Envio concluído com sucesso: ${formatPortugueseQuantity(confirmedMarkings, 'marcação', 'marcações')} ${inflectPortuguese(confirmedMarkings, 'confirmada', 'confirmadas')} pelo Channel em ${formatPortugueseQuantity(confirmed, 'dia', 'dias')}.`
        : sending
          ? (currentState.writeProgress?.detail ??
            `Enviando ao Channel: ${formatPortugueseQuantity(confirmedMarkings, 'marcação', 'marcações')} ${inflectPortuguese(confirmedMarkings, 'confirmada', 'confirmadas')}…`)
          : confirmed > 0 || currentState.phase === 'completed'
            ? `Envio concluído com sucesso: ${formatPortugueseQuantity(confirmedMarkings, 'marcação', 'marcações')} ${inflectPortuguese(confirmedMarkings, 'confirmada', 'confirmadas')} pelo Channel.`
            : '';
}

function renderLoginPreparation(): void {
  const preparation = state?.loginPreparation;
  const connectionIssues = state?.tabConnectionIssues ?? [];
  renderLoginStatus(
    'source',
    preparation?.ahgora ?? 'idle',
    preparation?.ahgoraDetail ?? 'A página do Ahgora ainda não foi aberta.',
  );
  renderLoginStatus(
    'target',
    preparation?.channel ?? 'idle',
    preparation?.channelDetail ?? 'A página do Channel ainda não foi aberta.',
  );
  const denied = preparation?.permissionDenied === true;
  const loginPending =
    preparation?.ahgora === 'awaiting-user' ||
    preparation?.ahgora === 'submitted' ||
    preparation?.channel === 'awaiting-user' ||
    preparation?.channel === 'submitted';
  byId<HTMLButtonElement>('open-logins').textContent =
    connectionIssues.length > 0
      ? 'Reconectar abas necessárias'
      : denied
        ? 'Permitir acesso e tentar novamente'
        : loginPending
          ? 'Verificar logins novamente'
          : 'Detectar abas ou abrir logins';
  byId<HTMLElement>('login-permission-hint').textContent = preparation
    ? denied
      ? 'A permissão aos hosts do Ahgora, Channel e Google Calendar é necessária para detectar e conectar as páginas automaticamente. Clique no botão acima para solicitá-la novamente.'
      : !preparation.autoSubmit &&
          (preparation.ahgora !== 'idle' || preparation.channel !== 'idle')
        ? 'Sem acesso opcional: conclua o login manualmente nas páginas abertas.'
        : ''
    : '';
  const connected = Boolean(
    state?.sourceTab && state.targetTab && settings.googleCalendar.connected,
  );
  const loginCard = byId<HTMLDetailsElement>('login-card');
  if (connectionIssues.length > 0) loginCard.open = true;
  if (connected && !loginCompletionObserved) loginCard.open = false;
  if (!connected && loginCompletionObserved) loginCard.open = true;
  loginCompletionObserved = connected;
  const summary = byId<HTMLOutputElement>('login-summary');
  summary.textContent = connected ? 'Concluído' : 'Pendente';
  summary.classList.toggle('ready', connected);
  const loginRunning =
    preparation?.autoSubmit === true &&
    ([preparation.ahgora, preparation.channel] as const).some(
      (status) =>
        status === 'opening' ||
        status === 'submitted' ||
        status === 'awaiting-user',
    );
  const stop = byId<HTMLButtonElement>('stop-login');
  stop.hidden = !loginRunning;
  stop.disabled = !loginRunning;
}

function renderConnectionAlert(): void {
  if (!state) return;
  const alert = byId<HTMLElement>('connection-alert');
  const issues = state.tabConnectionIssues ?? [];
  alert.hidden = issues.length === 0;
  if (issues.length === 0) return;

  const sourceIssue = issues.find((issue) => issue.role === 'source');
  const targetIssue = issues.find((issue) => issue.role === 'target');
  const output = byId<HTMLElement>('connection-alert-message');
  if (sourceIssue && targetIssue) {
    output.textContent =
      'As abas do Ahgora e do Channel não estão mais conectadas. Reconecte-as antes de capturar ou enviar marcações.';
  } else {
    const issue = sourceIssue ?? targetIssue;
    const name = issue?.role === 'source' ? 'Ahgora' : 'Channel';
    const event =
      issue?.reason === 'origin-changed'
        ? 'saiu da página registrada'
        : 'foi fechada';
    output.textContent = `A aba do ${name} ${event}. Reconecte-a antes de capturar ou enviar marcações.`;
  }
}

function renderFlowOverview(): void {
  if (!state) return;
  const connected = Boolean(
    state.sourceTab && state.targetTab && settings.googleCalendar.connected,
  );
  renderWorkflowAvailability(connected);
  const captured =
    state.sourceRows !== undefined && state.phase !== 'capturing';
  const reviewed =
    state.selectedCount > 0 ||
    state.phase === 'dry-run' ||
    state.phase === 'waiting-review' ||
    state.phase === 'partial' ||
    state.phase === 'completed';
  const sent = state.phase === 'completed';
  // TAGs são opcionais antes da primeira captura: o Channel pode fornecer a
  // referência inicial automaticamente.
  const completed = [connected, true, captured, reviewed, sent];
  const currentIndex = completed.findIndex((value) => !value);
  const ids = [
    'flow-login',
    'flow-rules',
    'flow-capture',
    'flow-review',
    'flow-send',
  ] as const;
  ids.forEach((id, index) => {
    const item = byId<HTMLElement>(id);
    const link = item.querySelector<HTMLAnchorElement>('a');
    item.classList.toggle('done', completed[index] === true);
    item.classList.toggle('current', index === currentIndex);
    if (index === currentIndex) link?.setAttribute('aria-current', 'step');
    else link?.removeAttribute('aria-current');
  });
}

function renderWorkflowAvailability(connected: boolean): void {
  for (const cardId of ['capture-card', 'review-card', 'send-card'] as const) {
    const card = byId<HTMLDetailsElement>(cardId);
    card.inert = !connected;
    if (connected) card.removeAttribute('aria-disabled');
    else card.setAttribute('aria-disabled', 'true');
    if (!connected) card.open = false;
    const summary = card.querySelector<HTMLElement>(':scope > summary');
    if (summary)
      summary.title = connected
        ? ''
        : 'Conclua a conexão com Ahgora, Channel e Google Calendar para liberar esta etapa.';

    const link = document.querySelector<HTMLAnchorElement>(
      `.flow-overview a[aria-controls="${cardId}"]`,
    );
    if (link) {
      if (connected) link.removeAttribute('aria-disabled');
      else link.setAttribute('aria-disabled', 'true');
      link.tabIndex = connected ? 0 : -1;
      link.title = connected
        ? ''
        : 'Conclua a etapa 1 para liberar esta etapa.';
    }
  }
}

function renderLoginStatus(
  role: 'source' | 'target',
  status: NonNullable<PublicOperationState['loginPreparation']>[
    'ahgora' | 'channel'],
  detail: string,
): void {
  const output = byId<HTMLOutputElement>(`login-${role}-state`);
  const connectionLost = state?.tabConnectionIssues?.some(
    (issue) => issue.role === role,
  );
  output.textContent = connectionLost
    ? 'Reconexão necessária'
    : {
        idle: 'Não aberto',
        opening: 'Abrindo…',
        'awaiting-user': 'Aguardando login',
        submitted: 'Login acionado',
        ready: 'Página de trabalho aberta',
        failed: 'Falha ao abrir',
        stopped: 'Interrompido',
      }[status];
  const bar = byId<HTMLProgressElement>(`login-${role}-progress`);
  if (status === 'opening' || status === 'submitted')
    bar.removeAttribute('value');
  else
    bar.value =
      status === 'ready' || status === 'failed' || status === 'stopped'
        ? 100
        : status === 'awaiting-user'
          ? 50
          : 0;
  bar.classList.toggle('failed', status === 'failed');
  bar.classList.toggle('stopped', status === 'stopped');
  byId<HTMLElement>(`login-${role}-detail`).textContent = detail;
}

function renderCaptureProgress(): void {
  const progress = state?.captureProgress;
  const calendarUsageEnabled =
    settings.googleCalendar.enabled ?? settings.googleCalendar.connected;
  const calendarReady = calendarCaptureEnabled(settings.googleCalendar);
  renderSystemProgress(
    'ahgora',
    progress?.ahgora ?? {
      status: 'waiting',
      detail: 'A captura ainda não começou.',
    },
  );
  renderSystemProgress(
    'channel',
    progress?.channel ?? {
      status: 'waiting',
      detail: 'A consulta ainda não começou.',
    },
  );
  renderSystemProgress(
    'calendar',
    calendarReady
      ? (progress?.calendar ?? {
          status: 'waiting',
          detail: 'A captura ainda não começou.',
        })
      : {
          status: 'waiting',
          detail: !calendarUsageEnabled
            ? 'Uso do Google Calendar desativado.'
            : !settings.googleCalendar.connected
              ? 'Google Calendar ativado, mas ainda não conectado.'
              : settings.googleCalendar.selectedCalendarIds.length === 0
                ? 'Selecione ao menos um calendário para consultar.'
                : 'Ative ao menos uma regra do Google Calendar.',
        },
  );
  if (!calendarReady)
    byId<HTMLOutputElement>('calendar-progress-state').textContent =
      calendarUsageEnabled ? 'Configuração pendente' : 'Desativado';
  renderSystemProgress(
    'comparison',
    progress?.comparison ?? {
      status: 'waiting',
      detail: 'Aguardando a conclusão das capturas.',
    },
  );
  const running = state?.inFlight === 'capture';
  const stop = byId<HTMLButtonElement>('stop-capture');
  stop.hidden = !running;
  stop.disabled = !running;
}

function renderWriteProgress(): void {
  const progress = state?.writeProgress;
  const bar = byId<HTMLProgressElement>('write-progress');
  const completed = progress?.completedItems ?? 0;
  const total = progress?.totalItems ?? 0;
  bar.value = total > 0 ? Math.round((completed / total) * 100) : 0;
  bar.classList.toggle('failed', progress?.status === 'failed');
  bar.classList.toggle('stopped', progress?.status === 'stopped');
  byId<HTMLOutputElement>('write-progress-state').textContent = progress
    ? progress.status === 'done'
      ? 'Concluído'
      : progress.status === 'failed'
        ? `Interrompido · ${String(completed)} de ${String(total)}`
        : progress.status === 'stopped'
          ? `Parado · ${String(completed)} de ${String(total)}`
          : `${String(completed)} de ${String(total)}`
    : 'Aguardando';
  byId<HTMLElement>('write-progress-detail').textContent =
    progress?.detail ?? 'Selecione os dias que deseja enviar.';
  const running =
    (state?.inFlight === 'apply' || state?.inFlight === 'advance') &&
    progress?.status === 'running';
  const stop = byId<HTMLButtonElement>('stop-write');
  stop.hidden = !running;
  stop.disabled = !running;
}

function renderSystemProgress(
  system: 'ahgora' | 'channel' | 'calendar' | 'comparison',
  progress: SystemProgress,
): void {
  const bar = byId<HTMLProgressElement>(`${system}-progress`);
  if (progress.status === 'running') bar.removeAttribute('value');
  else
    bar.value =
      progress.status === 'done' ||
      progress.status === 'failed' ||
      progress.status === 'stopped'
        ? 100
        : 0;
  bar.classList.toggle('failed', progress.status === 'failed');
  bar.classList.toggle('stopped', progress.status === 'stopped');
  byId<HTMLOutputElement>(`${system}-progress-state`).textContent = {
    waiting: 'Aguardando',
    running: 'Em andamento',
    done: 'Concluído',
    failed: 'Falhou',
    stopped: 'Interrompido',
  }[progress.status];
  byId<HTMLElement>(`${system}-progress-detail`).textContent = progress.detail;
}

function totalLabel(
  minutes: number,
  count: number,
  unit: 'item' | 'registro',
): string {
  const label = count === 1 ? unit : unit === 'item' ? 'itens' : 'registros';
  return `${formatDurationMinutes(minutes)} · ${String(count)} ${label}`;
}

function renderSettings(): void {
  const uiBusy =
    requestPending ||
    loginPermissionPending ||
    catalogPending ||
    state?.inFlight !== undefined;
  const ragUpdateAllowed =
    !uiBusy &&
    (state === undefined ||
      state.phase === 'setup' ||
      state.phase === 'completed' ||
      state.phase === 'cancelled');
  if (
    editingTagId !== undefined &&
    !settings.tags.some(({ id }) => id === editingTagId)
  )
    editingTagId = undefined;
  const editingTag = settings.tags.find(({ id }) => id === editingTagId);
  byId<HTMLElement>('tag-editor-title').textContent = editingTag
    ? 'Editar TAG'
    : 'Criar nova TAG';
  byId<HTMLButtonElement>('save-tag').textContent = editingTag
    ? 'Salvar alterações'
    : 'Salvar TAG';
  byId<HTMLButtonElement>('cancel-tag-edit').hidden = editingTag === undefined;
  document.documentElement.style.setProperty(
    '--font-scale',
    String(settings.fontScale),
  );
  document.documentElement.dataset.theme = settings.theme;
  const darkTheme = settings.theme === 'dark';
  const themeToggle = byId<HTMLButtonElement>('theme-toggle');
  themeToggle.setAttribute('aria-pressed', String(darkTheme));
  themeToggle.setAttribute(
    'aria-label',
    darkTheme ? 'Ativar tema claro' : 'Ativar tema escuro',
  );
  byId<HTMLElement>('theme-label').textContent = darkTheme ? 'Claro' : 'Escuro';
  byId<HTMLOutputElement>('font-scale').textContent =
    `${String(Math.round(settings.fontScale * 100))}%`;
  renderPunchAlertSettings(uiBusy);
  byId<HTMLButtonElement>('font-decrease').disabled =
    uiBusy || settings.fontScale <= 0.8;
  byId<HTMLButtonElement>('font-increase').disabled =
    uiBusy || settings.fontScale >= 1.4;
  byId<HTMLOutputElement>('config-summary').textContent =
    `${String(settings.tags.length)} ${settings.tags.length === 1 ? 'TAG' : 'TAGs'}`;
  renderRagCatalogManager(ragUpdateAllowed);

  const catalog = settings.catalog;
  byId<HTMLElement>('catalog-status').textContent = catalog
    ? `${String(catalog.projects.length)} projeto(s), ${String(catalog.projects.reduce((total, project) => total + project.activities.length, 0))} atividade(s) · atualizado em ${new Date(catalog.fetchedAt).toLocaleString('pt-BR')}`
    : 'Cache ainda não consultado.';
  byId<HTMLButtonElement>('fetch-catalog').textContent = catalogPending
    ? 'Consultando Channel…'
    : catalog
      ? 'Atualizar cache'
      : 'Obter do Channel';
  const projectSelect = byId<HTMLSelectElement>('tag-project');
  const previousProjectId = projectSelect.value;
  const projectPlaceholder = document.createElement('option');
  projectPlaceholder.value = '';
  projectPlaceholder.textContent = catalog
    ? 'Escolha um projeto'
    : 'Obtenha o catálogo do Channel';
  projectSelect.replaceChildren(
    projectPlaceholder,
    ...(catalog?.projects ?? []).map((project) => {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.label;
      return option;
    }),
  );
  projectSelect.disabled =
    uiBusy || catalog === undefined || catalog.projects.length === 0;
  if (catalog?.projects.some((project) => project.id === previousProjectId))
    projectSelect.value = previousProjectId;
  byId<HTMLOutputElement>('tag-editor-status').textContent = tagEditorMessage;
  renderTagRagCopyAssistant(uiBusy);

  const list = byId<HTMLElement>('tag-list');
  if (settings.tags.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent =
      'Nenhuma TAG salva. Obtenha o catálogo e crie a primeira.';
    list.replaceChildren(empty);
    return;
  }
  const disabled = uiBusy;
  list.replaceChildren(
    ...settings.tags.map((tag) => {
      const card = document.createElement('article');
      card.className = 'tag-card';
      card.setAttribute('role', 'listitem');
      const content = document.createElement('div');
      const heading = document.createElement('strong');
      heading.className = 'tag-chip';
      heading.textContent = tag.name;
      const detail = document.createElement('p');
      detail.className = 'meta';
      detail.textContent = `${tag.project} · ${tag.activity} · Tipo: ${tag.activityType ?? 'Nenhum'} · Tarefa: ${tag.task ?? 'Nenhum'}`;
      content.append(heading, detail);
      if (tag.comments) {
        const comments = document.createElement('p');
        comments.className = 'meta';
        comments.textContent = `Observações: ${tag.comments}`;
        content.append(comments);
      }
      const defaultLabel = document.createElement('label');
      defaultLabel.className = 'tag-default';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'default-tag';
      radio.value = tag.id;
      radio.checked = tag.id === settings.defaultTagId;
      radio.disabled = disabled;
      radio.addEventListener('change', () => void setDefaultTag(tag.id));
      defaultLabel.append(radio, document.createTextNode('Padrão'));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'tag-remove';
      remove.textContent = 'Excluir';
      remove.disabled = disabled;
      remove.setAttribute('aria-label', `Excluir TAG ${tag.name}`);
      remove.addEventListener('click', () => void removeTag(tag.id));
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'tag-edit';
      edit.textContent = 'Editar';
      edit.disabled = disabled;
      edit.setAttribute('aria-label', `Editar TAG ${tag.name}`);
      edit.addEventListener('click', () => editTag(tag.id));
      card.append(content, defaultLabel, edit, remove);
      return card;
    }),
  );
}

function renderPunchAlertSettings(uiBusy: boolean): void {
  const alerts = settings.punchAlerts;
  const checkbox = byId<HTMLInputElement>('punch-alert-enabled');
  checkbox.checked = alerts.enabled;
  checkbox.disabled = uiBusy || punchAlertPending;
  checkbox.setAttribute('aria-checked', String(alerts.enabled));
  byId<HTMLElement>('lunch-monitor-description').textContent = alerts.enabled
    ? 'Ativo · verificações às 12:30, 13:00, 13:30 e 14:00.'
    : 'Desativado · alertas às 12:30, 13:00, 13:30 e 14:00.';
  const status = byId<HTMLOutputElement>('punch-alert-inline-status');
  status.hidden = punchAlertMessage.length === 0;
  status.textContent = punchAlertMessage;
}

function selectedRagCatalog(): RagCatalog | undefined {
  return ragCatalogs.find((catalog) => catalog.id === ragSelectedCatalogId);
}

function ragKindLabel(kind: RagItemKind): string {
  return kind === 'PROJECT'
    ? 'Projeto'
    : kind === 'AD_HOC'
      ? 'Avulso'
      : 'Não apontar';
}

function ragStateLabel(itemState: RagItemState): string {
  return itemState === 'original'
    ? 'Original'
    : itemState === 'modified'
      ? 'Alterado'
      : 'Criado';
}

function ragItemDestination(item: RagItem): string {
  if (item.kind === 'SKIP') return 'Não gerar apontamento no Channel';
  if (item.kind === 'AD_HOC')
    return `Avulso · ${item.channel.client || 'Cliente não informado'} · ${item.channel.operationNature || 'Natureza não informada'} · ${item.channel.activityType || 'Tipo não informado'}`;
  const project =
    item.channel.projectSource === 'TAG'
      ? 'Projeto da TAG escolhida ao apontar'
      : (item.channel.project ?? 'Projeto não informado');
  const activity =
    item.channel.activitySource === 'TAG'
      ? 'Atividade da TAG escolhida ao apontar'
      : (item.channel.activity ?? 'Atividade não informada');
  return `Projeto · ${project} · ${activity} · ${item.channel.activityType || 'Tipo não informado'} · ${item.channel.task || 'Tarefa não informada'}`;
}

function renderRagCatalogManager(allowed: boolean): void {
  const itemCount = ragCatalogs.reduce(
    (total, catalog) => total + catalog.itemCount,
    0,
  );
  byId<HTMLElement>('rag-catalog-status').textContent =
    settings.ragCatalogOverrides.length === 0
      ? `${String(ragCatalogs.length)} fonte(s), ${String(itemCount)} apontamento(s) · dados originais da extensão.`
      : `${String(ragCatalogs.length)} fonte(s), ${String(itemCount)} apontamento(s) · atualizado em ${new Date(settings.ragCatalogUpdatedAt ?? '').toLocaleString('pt-BR')}.`;
  byId<HTMLOutputElement>('rag-update-status').textContent = ragUpdateMessage;
  byId<HTMLDialogElement>('rag-catalog-manager-dialog').setAttribute(
    'aria-busy',
    String(ragUpdatePending),
  );

  if (!ragCatalogs.some(({ id }) => id === ragSelectedCatalogId))
    ragSelectedCatalogId = ragCatalogs[0]?.id ?? '';
  const source = byId<HTMLSelectElement>('rag-update-source');
  source.replaceChildren(
    ...ragCatalogs.map((catalog) => new Option(catalog.name, catalog.id)),
  );
  source.value = ragSelectedCatalogId;
  source.disabled = !allowed || ragUpdatePending;

  const pending = !allowed || ragUpdatePending;
  byId<HTMLButtonElement>('create-rag-item').disabled = pending;
  byId<HTMLButtonElement>('export-rag-catalog').disabled =
    ragSelectedCatalogId === '';
  byId<HTMLButtonElement>('restore-rag-catalog').disabled =
    pending ||
    !getRagCatalogOverrides().some(({ id }) => id === ragSelectedCatalogId);
  byId<HTMLButtonElement>('restore-rag-catalogs').disabled =
    pending || getRagCatalogOverrides().length === 0;
  byId<HTMLInputElement>('rag-update-file').disabled = pending;
  byId<HTMLSelectElement>('rag-import-mode').disabled = pending;
  const previewButton = byId<HTMLButtonElement>('update-rag-catalog');
  previewButton.disabled = pending;
  previewButton.textContent = ragUpdatePending
    ? 'Validando CSV…'
    : 'Gerar prévia';
  byId<HTMLButtonElement>('apply-rag-import').disabled =
    pending || !ragImportPreview?.canApply;
  byId<HTMLButtonElement>('save-rag-item').disabled = pending;
  byId<HTMLButtonElement>('reassign-delete-rag-item').disabled = pending;
  renderRagItemEditor();
  renderRagItems(allowed);
  renderRagDeletePanel();
  renderRagImportPreview();
}

function renderRagDeletePanel(): void {
  const panel = byId<HTMLElement>('rag-delete-panel');
  const item = findRagItem(ragDeleteTarget?.catalogId, ragDeleteTarget?.itemId);
  panel.hidden = !ragDeleteTarget || !item;
  if (!ragDeleteTarget || !item) return;
  const references = countRagReferences(settings, [ragDeleteTarget]);
  byId<HTMLElement>('rag-delete-summary').textContent =
    `“${item.event}” é usado por ${String(references.calendarRules)} regra(s) do Calendar e ${String(references.templateEntries)} entrada(s) de template. Escolha outro item válido para manter todas as referências.`;
  const replacement = byId<HTMLSelectElement>('rag-delete-replacement');
  const previous = replacement.value;
  replacement.replaceChildren(
    ...ragCatalogs.flatMap((catalog) =>
      catalog.items
        .filter(
          (candidate) =>
            candidate.kind !== 'SKIP' &&
            !(
              candidate.id === ragDeleteTarget?.itemId &&
              catalog.id === ragDeleteTarget.catalogId
            ),
        )
        .map(
          (candidate) =>
            new Option(
              `${catalog.name} · ${candidate.event}`,
              `${encodeURIComponent(catalog.id)}|${encodeURIComponent(candidate.id)}`,
            ),
        ),
    ),
  );
  if ([...replacement.options].some(({ value }) => value === previous))
    replacement.value = previous;
  byId<HTMLButtonElement>('reassign-delete-rag-item').disabled =
    ragUpdatePending || replacement.options.length === 0;
}

function renderRagItems(allowed = true): void {
  const catalog = selectedRagCatalog();
  const list = byId<HTMLElement>('rag-item-list');
  const normalizedSearch = normalizeUiSearch(
    byId<HTMLInputElement>('rag-item-search').value,
  );
  const kindFilter = byId<HTMLSelectElement>('rag-item-kind-filter').value;
  const stateFilter = byId<HTMLSelectElement>('rag-item-state-filter').value;
  const items = (catalog?.items ?? []).filter((item) => {
    const itemState = getRagItemState(catalog?.id ?? '', item.id);
    return (
      (kindFilter === 'all' || item.kind === kindFilter) &&
      (stateFilter === 'all' || itemState === stateFilter) &&
      (!normalizedSearch ||
        normalizeUiSearch(
          `${item.group} ${item.event} ${ragItemDestination(item)}`,
        ).includes(normalizedSearch))
    );
  });
  byId<HTMLElement>('rag-item-count').textContent = catalog
    ? `${String(items.length)} de ${String(catalog.itemCount)} item(ns) em ${catalog.name}.`
    : 'Nenhuma fonte disponível.';
  list.replaceChildren(
    ...items.map((item) => {
      const itemState =
        getRagItemState(catalog?.id ?? '', item.id) ?? 'original';
      const card = document.createElement('article');
      card.className = 'rag-item-card';
      card.setAttribute('role', 'listitem');
      card.dataset.ragItemId = item.id;
      const content = document.createElement('div');
      content.className = 'rag-item-content';
      const heading = document.createElement('div');
      heading.className = 'rag-item-heading';
      const title = document.createElement('strong');
      title.textContent = item.event;
      const badges = document.createElement('span');
      badges.className = 'rag-item-badges';
      const kind = document.createElement('span');
      kind.className = `rag-badge kind-${item.kind.toLocaleLowerCase('pt-BR')}`;
      kind.textContent = ragKindLabel(item.kind);
      const stateBadge = document.createElement('span');
      stateBadge.className = `rag-badge state-${itemState}`;
      stateBadge.textContent = ragStateLabel(itemState);
      badges.append(kind, stateBadge);
      heading.append(title, badges);
      const group = document.createElement('p');
      group.className = 'rag-item-group';
      group.textContent = item.group;
      const destination = document.createElement('p');
      destination.className = 'rag-item-destination';
      destination.textContent = ragItemDestination(item);
      content.append(heading, group, destination);
      if (item.warnings.length > 0) {
        const warnings = document.createElement('ul');
        warnings.className = 'rag-item-warnings';
        for (const warning of item.warnings) {
          const warningItem = document.createElement('li');
          warningItem.textContent = warning;
          warnings.append(warningItem);
        }
        content.append(warnings);
      }
      const actions = document.createElement('div');
      actions.className = 'rag-item-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.dataset.ragAction = 'edit';
      edit.textContent = 'Editar';
      edit.setAttribute('aria-label', `Editar item RAG ${item.event}`);
      edit.disabled = !allowed || ragUpdatePending;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger';
      remove.dataset.ragAction = 'delete';
      remove.textContent = 'Excluir';
      remove.setAttribute('aria-label', `Excluir item RAG ${item.event}`);
      remove.disabled = !allowed || ragUpdatePending;
      actions.append(edit, remove);
      if (itemState !== 'original') {
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.dataset.ragAction = 'restore';
        restore.textContent = 'Restaurar';
        restore.setAttribute('aria-label', `Restaurar item RAG ${item.event}`);
        restore.disabled = !allowed || ragUpdatePending;
        actions.append(restore);
      }
      card.append(content, actions);
      return card;
    }),
  );
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'rag-empty-state';
    empty.textContent = 'Nenhum item corresponde aos filtros.';
    list.append(empty);
  }
}

function ragEditorValue(): string {
  return JSON.stringify({
    group: byId<HTMLInputElement>('rag-item-group').value,
    event: byId<HTMLInputElement>('rag-item-event').value,
    kind: byId<HTMLSelectElement>('rag-item-kind').value,
    duration: byId<HTMLInputElement>('rag-item-duration').value,
    comment: byId<HTMLTextAreaElement>('rag-item-comment').value,
    projectSource: byId<HTMLSelectElement>('rag-project-source').value,
    project: byId<HTMLInputElement>('rag-project').value,
    activitySource: byId<HTMLSelectElement>('rag-activity-source').value,
    activity: byId<HTMLInputElement>('rag-activity').value,
    projectActivityType: byId<HTMLInputElement>('rag-project-activity-type')
      .value,
    task: byId<HTMLInputElement>('rag-task').value,
    client: byId<HTMLInputElement>('rag-client').value,
    operationNature: byId<HTMLInputElement>('rag-operation-nature').value,
    adHocActivityType: byId<HTMLInputElement>('rag-ad-hoc-activity-type').value,
    createCalendarRule: byId<HTMLInputElement>('rag-create-calendar-rule')
      .checked,
  });
}

function ragEditorIsDirty(): boolean {
  return ragEditorOpen && ragEditorValue() !== ragEditorInitialValue;
}

function confirmDiscardRagDraft(): boolean {
  return (
    !ragEditorIsDirty() ||
    globalThis.confirm('Descartar as alterações não salvas deste item RAG?')
  );
}

function clearRagEditor(): void {
  editingRagItemId = undefined;
  ragEditorOpen = false;
  ragEditorInitialValue = '';
  ragItemEditorMessage = '';
  for (const field of byId<HTMLElement>('rag-item-editor').querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement
  >('input, textarea'))
    field.value = '';
  byId<HTMLSelectElement>('rag-item-kind').value = 'PROJECT';
  byId<HTMLSelectElement>('rag-project-source').value = 'FIXED';
  byId<HTMLSelectElement>('rag-activity-source').value = 'FIXED';
  byId<HTMLInputElement>('rag-create-calendar-rule').checked = false;
}

function restoreRagEditorOriginFocus(itemId?: string): void {
  globalThis.requestAnimationFrame(() => {
    const itemCard = itemId
      ? [
          ...byId<HTMLElement>('rag-item-list').querySelectorAll<HTMLElement>(
            '[data-rag-item-id]',
          ),
        ].find((candidate) => candidate.dataset.ragItemId === itemId)
      : undefined;
    const target =
      itemCard?.querySelector<HTMLButtonElement>('[data-rag-action="edit"]') ??
      byId<HTMLButtonElement>('create-rag-item');
    target.focus({ preventScroll: true });
  });
}

function openRagItemEditor(item?: RagItem): void {
  editingRagItemId = item?.id;
  ragEditorOpen = true;
  ragItemEditorMessage = '';
  byId<HTMLInputElement>('rag-item-group').value = item?.group ?? '';
  byId<HTMLInputElement>('rag-item-event').value = item?.event ?? '';
  byId<HTMLSelectElement>('rag-item-kind').value = item?.kind ?? 'PROJECT';
  byId<HTMLInputElement>('rag-item-duration').value = item?.durationHint ?? '';
  byId<HTMLTextAreaElement>('rag-item-comment').value = item?.comment ?? '';
  byId<HTMLSelectElement>('rag-project-source').value =
    item?.kind === 'PROJECT' ? item.channel.projectSource : 'FIXED';
  byId<HTMLInputElement>('rag-project').value =
    item?.kind === 'PROJECT' ? (item.channel.project ?? '') : '';
  byId<HTMLSelectElement>('rag-activity-source').value =
    item?.kind === 'PROJECT' ? item.channel.activitySource : 'FIXED';
  byId<HTMLInputElement>('rag-activity').value =
    item?.kind === 'PROJECT' ? (item.channel.activity ?? '') : '';
  byId<HTMLInputElement>('rag-project-activity-type').value =
    item?.kind === 'PROJECT' ? item.channel.activityType : '';
  byId<HTMLInputElement>('rag-task').value =
    item?.kind === 'PROJECT' ? item.channel.task : '';
  byId<HTMLInputElement>('rag-client').value =
    item?.kind === 'AD_HOC' ? item.channel.client : '';
  byId<HTMLInputElement>('rag-operation-nature').value =
    item?.kind === 'AD_HOC' ? item.channel.operationNature : '';
  byId<HTMLInputElement>('rag-ad-hoc-activity-type').value =
    item?.kind === 'AD_HOC' ? item.channel.activityType : '';
  byId<HTMLInputElement>('rag-create-calendar-rule').checked = false;
  renderRagItemEditor();
  ragEditorInitialValue = ragEditorValue();
  byId<HTMLInputElement>('rag-item-group').focus();
}

function renderRagItemEditor(): void {
  const editor = byId<HTMLElement>('rag-item-editor');
  editor.hidden = !ragEditorOpen;
  byId<HTMLElement>('rag-browser').hidden = ragEditorOpen;
  if (!ragEditorOpen) return;
  const kind = byId<HTMLSelectElement>('rag-item-kind').value as RagItemKind;
  const projectSource = byId<HTMLSelectElement>('rag-project-source').value;
  const activitySource = byId<HTMLSelectElement>('rag-activity-source').value;
  byId<HTMLElement>('rag-project-fields').hidden = kind !== 'PROJECT';
  byId<HTMLElement>('rag-ad-hoc-fields').hidden = kind !== 'AD_HOC';
  byId<HTMLElement>('rag-project-value-field').hidden = projectSource === 'TAG';
  byId<HTMLElement>('rag-activity-value-field').hidden =
    activitySource === 'TAG';
  byId<HTMLElement>('rag-create-calendar-rule-field').hidden =
    editingRagItemId !== undefined ||
    ragSelectedCatalogId !== 'reunioes-rag' ||
    kind === 'SKIP';
  byId<HTMLElement>('rag-item-editor-title').textContent = editingRagItemId
    ? 'Editar item'
    : 'Criar item';
  byId<HTMLOutputElement>('rag-item-editor-status').textContent =
    ragItemEditorMessage;
  const preview = byId<HTMLElement>('rag-item-destination-preview');
  if (kind === 'SKIP') preview.textContent = 'Destino: não apontar no Channel.';
  else if (kind === 'AD_HOC')
    preview.textContent = `Destino: Avulso · ${byId<HTMLInputElement>('rag-client').value || 'cliente'} · ${byId<HTMLInputElement>('rag-operation-nature').value || 'natureza'} · ${byId<HTMLInputElement>('rag-ad-hoc-activity-type').value || 'tipo de atividade'}`;
  else
    preview.textContent = `Destino: Projeto · ${projectSource === 'TAG' ? 'projeto da TAG escolhida ao apontar' : byId<HTMLInputElement>('rag-project').value || 'projeto'} · ${activitySource === 'TAG' ? 'atividade da TAG escolhida ao apontar' : byId<HTMLInputElement>('rag-activity').value || 'atividade'} · ${byId<HTMLInputElement>('rag-project-activity-type').value || 'tipo de atividade'} · ${byId<HTMLInputElement>('rag-task').value || 'tarefa'}`;
}

function ragItemInputFromEditor(): RagItemInput {
  const base = {
    group: byId<HTMLInputElement>('rag-item-group').value,
    event: byId<HTMLInputElement>('rag-item-event').value,
    durationHint: byId<HTMLInputElement>('rag-item-duration').value || null,
    comment: byId<HTMLTextAreaElement>('rag-item-comment').value || null,
  };
  const kind = byId<HTMLSelectElement>('rag-item-kind').value as RagItemKind;
  if (kind === 'SKIP') return { ...base, kind, channel: null };
  if (kind === 'AD_HOC')
    return {
      ...base,
      kind,
      channel: {
        client: byId<HTMLInputElement>('rag-client').value,
        operationNature: byId<HTMLInputElement>('rag-operation-nature').value,
        activityType: byId<HTMLInputElement>('rag-ad-hoc-activity-type').value,
      },
    };
  const projectSource = byId<HTMLSelectElement>('rag-project-source').value as
    'FIXED' | 'TAG';
  const activitySource = byId<HTMLSelectElement>('rag-activity-source')
    .value as 'FIXED' | 'TAG';
  return {
    ...base,
    kind,
    channel: {
      project:
        projectSource === 'TAG'
          ? null
          : byId<HTMLInputElement>('rag-project').value,
      activityType: byId<HTMLInputElement>('rag-project-activity-type').value,
      activity:
        activitySource === 'TAG'
          ? null
          : byId<HTMLInputElement>('rag-activity').value,
      task: byId<HTMLInputElement>('rag-task').value,
      projectSource,
      activitySource,
    },
  };
}

function renderRagImportPreview(): void {
  const section = byId<HTMLElement>('rag-import-preview');
  section.hidden = ragImportPreview === undefined;
  if (!ragImportPreview) return;
  const counts = ragImportPreview.counts;
  byId<HTMLElement>('rag-import-counts').textContent =
    `${String(counts.new)} novo(s) · ${String(counts.updated)} alterado(s) · ${String(counts.unchanged)} inalterado(s) · ${String(counts.removed)} removido(s) · ${String(counts.errors)} erro(s) · ${String(counts.duplicates)} duplicado(s).`;
  byId<HTMLElement>('rag-import-result').textContent =
    ragImportPreview.mode === 'merge'
      ? `Resultado: ${String(ragImportPreview.catalog.itemCount)} item(ns). Itens ausentes no arquivo serão mantidos.`
      : `Resultado: ${String(ragImportPreview.catalog.itemCount)} item(ns). A fonte atual será substituída por esta prévia.`;
  const issues = [...ragImportPreview.errors, ...ragImportPreview.duplicates];
  byId<HTMLUListElement>('rag-import-issues').replaceChildren(
    ...issues.slice(0, 8).map((issue) => {
      const item = document.createElement('li');
      item.textContent = `${issue.row > 0 ? `Linha ${String(issue.row)}: ` : ''}${issue.message}`;
      return item;
    }),
  );
}

interface RagMutationResult<T> {
  readonly result: T;
  readonly settings?: ExtensionSettings;
}

/** Catálogo e consumidores RAG são persistidos como uma única configuração. */
async function runRagMutation<T>(
  message: string,
  mutate: () => RagMutationResult<T>,
): Promise<T> {
  const previousOverrides = getRagCatalogOverrides();
  const previousSettings = settings;
  try {
    const mutation = mutate();
    const overrides = getRagCatalogOverrides();
    const base = mutation.settings ?? settings;
    const { ragCatalogUpdatedAt: previousUpdate, ...withoutUpdate } = base;
    void previousUpdate;
    const nextSettings: ExtensionSettings = {
      ...withoutUpdate,
      ragCatalogOverrides: overrides,
      ...(overrides.length > 0
        ? { ragCatalogUpdatedAt: new Date().toISOString() }
        : {}),
    };
    await saveExtensionSettings(nextSettings);
    settings = nextSettings;
    ragUpdateMessage = message;
    tagRagCopyOpen = false;
    return mutation.result;
  } catch (error) {
    setRagCatalogOverrides(previousOverrides);
    settings = previousSettings;
    throw error;
  }
}

function disappearingTargets(
  current: readonly RagItem[],
  next: readonly RagItem[],
  catalogId: string,
): RagTarget[] {
  const nextIds = new Set(next.map(({ id }) => id));
  return current
    .filter(({ id }) => !nextIds.has(id))
    .map(({ id }) => ({ catalogId, itemId: id }));
}

function confirmDestructiveRagChange(
  action: string,
  targets: readonly RagTarget[],
): ExtensionSettings | undefined {
  if (targets.length === 0) return settings;
  const references = countRagReferences(settings, targets);
  const referenceDetail =
    references.total === 0
      ? 'Nenhuma regra ou template usa esses itens.'
      : `${String(references.calendarRules)} regra(s) do Calendar e ${String(references.templateEntries)} entrada(s) de template serão removidas junto, sem deixar referências quebradas.`;
  if (
    !globalThis.confirm(
      `${action} fará ${String(targets.length)} item(ns) desaparecer(em). ${referenceDetail}\n\nConfirmar esta alteração destrutiva?`,
    )
  )
    return undefined;
  return removeRagReferences(settings, targets);
}

type TagRagCopyResolution =
  | {
      readonly ok: true;
      readonly item: Extract<RagItem, { kind: 'PROJECT' }>;
      readonly project: ChannelCatalogProject;
      readonly activity: ChannelCatalogProject['activities'][number];
    }
  | {
      readonly ok: false;
      readonly item?: RagItem;
      readonly message: string;
    };

function tagRagCopyIncompatibility(item: RagItem): string | undefined {
  if (item.kind === 'AD_HOC')
    return 'Apontamento avulso; não pode virar uma TAG de projeto.';
  if (item.kind === 'SKIP') return 'Item configurado para não apontar.';
  if (
    item.channel.projectSource === 'TAG' ||
    item.channel.activitySource === 'TAG'
  )
    return 'Depende de uma TAG existente.';
  if (!item.channel.project || !item.channel.activity)
    return 'Projeto ou atividade não informado no RAG.';
  return undefined;
}

function tagRagCopyOptionSuffix(item: RagItem): string {
  const incompatibility = tagRagCopyIncompatibility(item);
  if (incompatibility) return incompatibility;
  return 'Projeto compatível';
}

function appendTagRagCopyOptions(
  select: HTMLSelectElement,
  catalog: RagCatalog,
  query: string,
  selectedId: string | undefined,
): void {
  const normalizedQuery = normalizeUiSearch(query);
  const matching = catalog.items.filter(
    (item) =>
      item.id === selectedId ||
      !normalizedQuery ||
      normalizeUiSearch(
        `${item.group} ${item.event} ${JSON.stringify(item.channel)}`,
      ).includes(normalizedQuery),
  );
  const groups = new Map<string, RagItem[]>();
  for (const item of matching) {
    const values = groups.get(item.group) ?? [];
    values.push(item);
    groups.set(item.group, values);
  }
  select.replaceChildren();
  for (const [group, items] of groups) {
    const optionGroup = document.createElement('optgroup');
    optionGroup.label = group;
    for (const item of items) {
      const option = new Option(
        `${item.event} — ${tagRagCopyOptionSuffix(item)}`,
        item.id,
      );
      option.disabled = tagRagCopyIncompatibility(item) !== undefined;
      option.selected = item.id === selectedId;
      optionGroup.append(option);
    }
    select.append(optionGroup);
  }
  if (matching.length === 0)
    select.append(new Option('Nenhum item encontrado', '', true, true));
}

function resolveTagRagCopySelection(): TagRagCopyResolution {
  const item = findRagItem(
    byId<HTMLSelectElement>('tag-rag-copy-source').value,
    byId<HTMLSelectElement>('tag-rag-copy-item').value,
  );
  if (!item) return { ok: false, message: 'Escolha um item RAG para copiar.' };
  const incompatibility = tagRagCopyIncompatibility(item);
  if (incompatibility) return { ok: false, item, message: incompatibility };
  if (item.kind !== 'PROJECT')
    return { ok: false, item, message: 'Este item não representa um projeto.' };
  if (!settings.catalog)
    return {
      ok: false,
      item,
      message:
        'Obtenha os projetos e atividades do Channel antes de copiar este item.',
    };
  const projectLabel = item.channel.project;
  const activityLabel = item.channel.activity;
  if (!projectLabel || !activityLabel)
    return {
      ok: false,
      item,
      message: 'O item não possui projeto e atividade fixos.',
    };
  const projects = settings.catalog.projects.filter(
    (project) =>
      normalizeUiSearch(project.label) === normalizeUiSearch(projectLabel),
  );
  if (projects.length !== 1)
    return {
      ok: false,
      item,
      message:
        projects.length === 0
          ? `O projeto “${projectLabel}” não foi encontrado no cache do Channel. Atualize o cache ou escolha-o manualmente.`
          : `O projeto “${projectLabel}” possui mais de uma correspondência. Escolha-o manualmente.`,
    };
  const project = projects[0];
  if (!project) return { ok: false, item, message: 'Projeto indisponível.' };
  const activities = project.activities.filter(
    (activity) =>
      normalizeUiSearch(activity.label) === normalizeUiSearch(activityLabel),
  );
  if (activities.length !== 1)
    return {
      ok: false,
      item,
      message:
        activities.length === 0
          ? `A atividade “${activityLabel}” não foi encontrada em “${projectLabel}”. Atualize o cache ou escolha-a manualmente.`
          : `A atividade “${activityLabel}” possui mais de uma correspondência. Escolha-a manualmente.`,
    };
  const activity = activities[0];
  return activity
    ? { ok: true, item, project, activity }
    : { ok: false, item, message: 'Atividade indisponível.' };
}

function renderTagRagCopyPreview(resolution: TagRagCopyResolution): void {
  const preview = byId<HTMLElement>('tag-rag-copy-preview');
  preview.className = `tag-rag-copy-preview ${resolution.ok ? 'ready' : 'attention'}`;
  if (!resolution.ok) {
    preview.replaceChildren(document.createTextNode(resolution.message));
    return;
  }
  const heading = document.createElement('strong');
  heading.textContent = resolution.item.event;
  const destination = document.createElement('p');
  destination.textContent = `Projeto: ${resolution.project.label} · Atividade: ${resolution.activity.label}`;
  const advanced = document.createElement('p');
  advanced.textContent = `Tipo: ${resolution.item.channel.activityType || 'Nenhum'} · Tarefa: ${resolution.item.channel.task || 'Nenhum'} · Observações: ${resolution.item.comment ?? resolution.item.event}`;
  preview.replaceChildren(heading, destination, advanced);
}

function renderTagRagCopyAssistant(busy: boolean, resetItem = false): void {
  const toggle = byId<HTMLButtonElement>('toggle-tag-rag-copy');
  const panel = byId<HTMLElement>('tag-rag-copy-panel');
  toggle.disabled = busy;
  toggle.setAttribute('aria-expanded', String(tagRagCopyOpen));
  toggle.textContent = tagRagCopyOpen
    ? 'Fechar cópia do RAG'
    : 'Copiar de item RAG…';
  panel.hidden = !tagRagCopyOpen;
  if (!tagRagCopyOpen) return;

  const source = byId<HTMLSelectElement>('tag-rag-copy-source');
  const previousSource = source.value;
  source.replaceChildren(
    ...ragCatalogs.map((catalog) => new Option(catalog.name, catalog.id)),
  );
  source.value = ragCatalogs.some((catalog) => catalog.id === previousSource)
    ? previousSource
    : (ragCatalogs[0]?.id ?? '');
  source.disabled = busy || ragCatalogs.length === 0;

  const filter = byId<HTMLInputElement>('tag-rag-copy-filter');
  const itemSelect = byId<HTMLSelectElement>('tag-rag-copy-item');
  const catalog = ragCatalogs.find((entry) => entry.id === source.value);
  const previousItemId = resetItem ? undefined : itemSelect.value;
  const normalizedFilter = normalizeUiSearch(filter.value);
  const matchesFilter = (item: RagItem): boolean =>
    !normalizedFilter ||
    normalizeUiSearch(
      `${item.group} ${item.event} ${JSON.stringify(item.channel)}`,
    ).includes(normalizedFilter);
  const selectedItemId = catalog?.items.some(
    (item) =>
      item.id === previousItemId &&
      matchesFilter(item) &&
      tagRagCopyIncompatibility(item) === undefined,
  )
    ? previousItemId
    : catalog?.items.find(
        (item) =>
          matchesFilter(item) && tagRagCopyIncompatibility(item) === undefined,
      )?.id;
  if (catalog)
    appendTagRagCopyOptions(itemSelect, catalog, filter.value, selectedItemId);
  else itemSelect.replaceChildren(new Option('Nenhuma fonte disponível', ''));
  if (selectedItemId) itemSelect.value = selectedItemId;
  filter.disabled = busy || !catalog;
  itemSelect.disabled = busy || !catalog || !selectedItemId;
  source.onchange = () => renderTagRagCopyAssistant(false, true);
  filter.oninput = () => renderTagRagCopyAssistant(false);
  itemSelect.onchange = () => renderTagRagCopyAssistant(false);

  const resolution = resolveTagRagCopySelection();
  renderTagRagCopyPreview(resolution);
  byId<HTMLButtonElement>('apply-tag-rag-copy').disabled =
    busy || !resolution.ok;
}

function renderTemplateManager(): void {
  const busy =
    requestPending ||
    loginPermissionPending ||
    catalogPending ||
    state?.inFlight !== undefined;
  const templates = settings.markingTemplates;
  const rules = settings.templateRules;
  if (
    editingTemplateId !== undefined &&
    editingTemplateId !== '' &&
    !templates.some((template) => template.id === editingTemplateId)
  )
    closeTemplateEditor();
  const templateEditor = byId<HTMLElement>('template-editor');
  templateEditor.hidden = editingTemplateId === undefined;
  byId<HTMLButtonElement>('create-template').hidden =
    editingTemplateId !== undefined;
  byId<HTMLElement>('template-editor-title').textContent =
    editingTemplateId === '' ? 'Criar template' : 'Editar template';
  byId<HTMLButtonElement>('save-template').textContent =
    editingTemplateId === '' ? 'Salvar template' : 'Salvar alterações';
  byId<HTMLButtonElement>('add-template-entry').disabled = busy;
  byId<HTMLButtonElement>('save-template').disabled = busy;
  const activeRuleCount = rules.filter((rule) => rule.enabled).length;
  byId<HTMLOutputElement>('template-manager-summary').textContent =
    `${String(templates.length)} ${templates.length === 1 ? 'template' : 'templates'} · ${String(activeRuleCount)} ${activeRuleCount === 1 ? 'regra ativa' : 'regras ativas'}`;
  byId<HTMLOutputElement>('template-manager-status').textContent =
    templateManagerMessage;

  const templateList = byId<HTMLElement>('template-list');
  if (templates.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent =
      'Nenhum template salvo. Crie um aqui ou salve a distribuição de um dia na etapa de revisão.';
    templateList.replaceChildren(empty);
  } else {
    templateList.replaceChildren(
      ...templates.map((template) => {
        const item = document.createElement('article');
        item.className = 'manager-item';
        item.setAttribute('role', 'listitem');
        const content = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = template.name;
        const summary = document.createElement('p');
        summary.className = 'meta';
        summary.textContent = `${formatPortugueseQuantity(template.entries.length, 'marcação', 'marcações')} · dia original ${formatDurationMinutes(template.sourceDurationMinutes)} · ${template.entries.map(templateEntrySummary).join(' + ')}`;
        content.append(name, summary);
        const actions = document.createElement('div');
        actions.className = 'manager-item-actions';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.textContent = 'Editar';
        edit.disabled = busy;
        edit.setAttribute('aria-label', `Editar template ${template.name}`);
        edit.addEventListener('click', () => editMarkingTemplate(template.id));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Excluir';
        remove.className = 'danger';
        remove.disabled = busy;
        remove.setAttribute('aria-label', `Excluir template ${template.name}`);
        remove.addEventListener(
          'click',
          () => void removeMarkingTemplate(template.id),
        );
        actions.append(edit, remove);
        item.append(content, actions);
        return item;
      }),
    );
  }

  const ruleList = byId<HTMLElement>('rule-list');
  if (rules.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Nenhuma regra automática salva.';
    ruleList.replaceChildren(empty);
  } else {
    ruleList.replaceChildren(
      ...rules.map((rule) => {
        const item = document.createElement('article');
        item.className = 'manager-item';
        item.setAttribute('role', 'listitem');
        const content = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = rule.name;
        const recurrence = document.createElement('p');
        recurrence.className = 'meta';
        recurrence.textContent = describeTemplateRule(rule);
        const composition = document.createElement('p');
        composition.className = 'meta';
        composition.textContent = rule.templates
          .map((share) => {
            const template = templates.find(
              (candidate) => candidate.id === share.templateId,
            );
            return `${template?.name ?? 'Template removido'} ${String(share.percentage)}%`;
          })
          .join(' + ');
        content.append(name, recurrence, composition);
        const actions = document.createElement('div');
        actions.className = 'manager-item-actions';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.textContent = rule.enabled ? 'Desativar' : 'Ativar';
        toggle.disabled = busy;
        toggle.setAttribute('aria-pressed', String(rule.enabled));
        toggle.addEventListener(
          'click',
          () => void toggleTemplateRule(rule.id),
        );
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Excluir';
        remove.className = 'danger';
        remove.disabled = busy;
        remove.addEventListener(
          'click',
          () => void removeTemplateRule(rule.id),
        );
        actions.append(toggle, remove);
        item.append(content, actions);
        return item;
      }),
    );
  }

  renderRuleTemplateOptions();
  byId<HTMLButtonElement>('add-rule-template').disabled =
    busy || templates.length === 0;
  byId<HTMLButtonElement>('save-rule').disabled =
    busy || templates.length === 0;
  if (
    templates.length > 0 &&
    byId<HTMLElement>('rule-template-shares').childElementCount === 0
  )
    addRuleTemplateShare(templates[0]?.id, 100);
  updateRuleShareTotal();
  renderCalendarManager(busy);
}

function renderCalendarManager(busy: boolean): void {
  const calendar = settings.googleCalendar;
  const tabMode = calendar.accessMode === 'tab';
  if (
    editingCalendarRuleId !== undefined &&
    !calendar.rules.some((rule) => rule.id === editingCalendarRuleId)
  )
    editingCalendarRuleId = undefined;
  const editingRule = calendar.rules.find(
    (rule) => rule.id === editingCalendarRuleId,
  );
  byId<HTMLButtonElement>('save-calendar-rule').textContent = editingRule
    ? 'Salvar alterações'
    : 'Salvar regra do Calendar';
  byId<HTMLButtonElement>('cancel-calendar-rule-edit').hidden = !editingRule;
  const oauthConfigured = Boolean(
    chrome.runtime.getManifest().oauth2?.client_id.trim(),
  );
  const connection = byId<HTMLElement>('calendar-connection-status');
  connection.textContent =
    !tabMode && !oauthConfigured
      ? 'Integração indisponível: configure GOOGLE_OAUTH_CLIENT_ID durante o build.'
      : calendar.connected
        ? `${calendar.accountEmail ?? (tabMode ? 'Aba autenticada conectada' : 'Conta conectada')} · ${String(calendar.calendars.length)} calendário(s)${calendar.lastSyncedAt ? ` · atualizado em ${new Date(calendar.lastSyncedAt).toLocaleString('pt-BR')}` : ''}`
        : tabMode
          ? 'Aba não conectada. A extensão fará um GET de exportação usando a sessão da página.'
          : 'Conta não conectada. A extensão solicitará acesso somente leitura.';
  const connectLabel = calendarPending
    ? 'Aguarde…'
    : calendar.connected
      ? 'Atualizar calendários'
      : tabMode
        ? 'Conectar pela aba'
        : 'Conectar Google Calendar API';
  const connect = byId<HTMLButtonElement>('calendar-connect');
  connect.textContent = connectLabel;
  connect.disabled = busy || calendarPending || (!tabMode && !oauthConfigured);
  const tabAccessMode = byId<HTMLInputElement>('login-calendar-access-tab');
  const oauthAccessMode = byId<HTMLInputElement>('login-calendar-access-oauth');
  tabAccessMode.checked = tabMode;
  oauthAccessMode.checked = !tabMode;
  tabAccessMode.disabled = busy || calendarPending;
  oauthAccessMode.disabled = busy || calendarPending;
  byId<HTMLElement>('calendar-api-access-note').hidden = tabMode;
  const loginState = byId<HTMLOutputElement>('login-calendar-state');
  loginState.textContent = calendarPending
    ? 'Conectando…'
    : calendar.connected
      ? 'Conectado'
      : 'Não conectado';
  const loginProgress = byId<HTMLProgressElement>('login-calendar-progress');
  if (calendarPending) loginProgress.removeAttribute('value');
  else loginProgress.value = calendar.connected ? 100 : 0;
  byId<HTMLElement>('login-calendar-detail').textContent = calendarPending
    ? `Conectando ${tabMode ? 'pela aba autenticada' : 'via Google Calendar API'}…`
    : calendar.connected
      ? `${calendar.accountEmail ?? (tabMode ? 'Aba autenticada' : 'Conta Google')} · ${String(calendar.calendars.length)} calendário(s) disponível(is).`
      : tabMode
        ? 'Aba não conectada. Use o botão principal para detectar ou abrir o Google Calendar.'
        : 'Conta não conectada. Use o botão principal para autorizar a Google Calendar API.';

  const calendars = byId<HTMLElement>('calendar-list');
  calendars.replaceChildren(
    ...(calendar.calendars.length === 0
      ? [
          Object.assign(document.createElement('li'), {
            className: 'calendar-list-empty hint',
            textContent:
              'Conecte uma conta para escolher os calendários consultados.',
          }),
        ]
      : calendar.calendars.map((entry) => {
          const item = document.createElement('li');
          item.className = 'calendar-choice-item';
          const label = document.createElement('label');
          label.className = 'calendar-choice';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = calendar.selectedCalendarIds.includes(entry.id);
          checkbox.disabled = busy || calendarPending;
          checkbox.addEventListener(
            'change',
            () => void setCalendarSelected(entry.id, checkbox.checked),
          );
          label.append(
            checkbox,
            document.createTextNode(
              `${entry.name}${entry.primary ? ' · principal' : ''}`,
            ),
          );
          item.append(label);
          return item;
        })),
  );

  const sourceSelect = byId<HTMLSelectElement>('calendar-rule-source');
  const previousSource = sourceSelect.value || 'tags';
  sourceSelect.replaceChildren(
    new Option('Minhas TAGs', 'tags'),
    ...ragCatalogs.map((catalog) => new Option(catalog.name, catalog.id)),
  );
  sourceSelect.value = ragCatalogs.some(
    (catalog) => catalog.id === previousSource,
  )
    ? previousSource
    : 'tags';
  sourceSelect.disabled = busy;
  sourceSelect.onchange = () => renderCalendarRuleDestination(busy, true);
  renderCalendarRuleDestination(busy);
  const ruleCalendars = byId<HTMLElement>('calendar-rule-calendars');
  const selectableCalendars = calendar.calendars.filter((entry) =>
    calendar.selectedCalendarIds.includes(entry.id),
  );
  ruleCalendars.replaceChildren(
    ...(selectableCalendars.length === 0
      ? [
          Object.assign(document.createElement('li'), {
            className: 'calendar-list-empty hint',
            textContent: 'Selecione ao menos um calendário acima.',
          }),
        ]
      : selectableCalendars.map((entry) => {
          const item = document.createElement('li');
          item.className = 'calendar-choice-item';
          const label = document.createElement('label');
          label.className = 'calendar-choice';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.value = entry.id;
          checkbox.checked = true;
          checkbox.disabled = busy;
          label.append(checkbox, document.createTextNode(entry.name));
          item.append(label);
          return item;
        })),
  );
  byId<HTMLOutputElement>('calendar-manager-status').textContent =
    calendarManagerMessage;

  const list = byId<HTMLElement>('calendar-rule-list');
  if (calendar.rules.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Nenhuma regra de evento → marcação salva.';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(
    ...calendar.rules.map((rule, index) => {
      const item = document.createElement('article');
      item.className = 'manager-item';
      item.setAttribute('role', 'listitem');
      const content = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = `${String(index + 1)}. ${rule.name}`;
      const tag = settings.tags.find((entry) => entry.id === rule.tagId);
      const ragItem = findRagItem(rule.ragCatalogId, rule.ragItemId);
      const detail = document.createElement('p');
      detail.className = 'meta';
      const calendarNames = rule.calendarIds
        .map((id) => calendar.calendars.find((entry) => entry.id === id)?.name)
        .filter(Boolean)
        .join(', ');
      const destination =
        ragItem?.event ??
        tag?.name ??
        (rule.ragCatalogId ? 'Marcação removida' : 'TAG removida');
      detail.textContent = `${rule.matchMode === 'all' ? 'Todas' : 'Qualquer'}: ${rule.phrases.join(' · ')} · ${calendarNames || 'todos os selecionados'} → ${destination}`;
      content.append(name, detail);
      const actions = document.createElement('div');
      actions.className = 'manager-item-actions';
      const up = actionButton('↑', `Mover ${rule.name} para cima`, () =>
        moveCalendarRule(rule.id, -1),
      );
      up.disabled = busy || index === 0;
      const down = actionButton('↓', `Mover ${rule.name} para baixo`, () =>
        moveCalendarRule(rule.id, 1),
      );
      down.disabled = busy || index === calendar.rules.length - 1;
      const toggle = actionButton(
        rule.enabled ? 'Desativar' : 'Ativar',
        '',
        () => toggleCalendarRule(rule.id),
      );
      toggle.disabled = busy;
      const edit = actionButton('Editar', `Editar regra ${rule.name}`, () =>
        editCalendarRule(rule.id),
      );
      edit.disabled = busy;
      const restore = isImportedRagCalendarRule(rule)
        ? actionButton('Restaurar', `Restaurar regra RAG ${rule.name}`, () =>
            restoreCalendarRule(rule.id),
          )
        : undefined;
      if (restore) restore.disabled = busy;
      const remove = actionButton('Excluir', `Excluir regra ${rule.name}`, () =>
        removeCalendarRule(rule.id),
      );
      remove.className = 'danger';
      remove.disabled = busy;
      actions.append(up, down, toggle, edit);
      if (restore) actions.append(restore);
      actions.append(remove);
      item.append(content, actions);
      return item;
    }),
  );
}

function renderCalendarRuleDestination(
  busy: boolean,
  resetSelection = false,
): void {
  const sourceId = byId<HTMLSelectElement>('calendar-rule-source').value;
  const container = byId<HTMLElement>('calendar-rule-destination');
  const previousTagId = resetSelection
    ? undefined
    : container.querySelector<HTMLSelectElement>(
        '#calendar-rule-tag, #calendar-rule-context-tag',
      )?.value;
  const previousItemId = resetSelection
    ? undefined
    : container.querySelector<HTMLSelectElement>('#calendar-rule-rag-item')
        ?.value;
  const previousFilter = resetSelection
    ? ''
    : (container.querySelector<HTMLInputElement>('#calendar-rule-rag-filter')
        ?.value ?? '');
  container.replaceChildren();

  if (sourceId === 'tags') {
    const label = document.createElement('label');
    label.textContent = 'TAG';
    const select = document.createElement('select');
    select.id = 'calendar-rule-tag';
    select.append(...settings.tags.map((tag) => new Option(tag.name, tag.id)));
    const selectedTagId = settings.tags.some((tag) => tag.id === previousTagId)
      ? previousTagId
      : settings.defaultTagId;
    if (selectedTagId) select.value = selectedTagId;
    select.disabled = busy || settings.tags.length === 0;
    select.onchange = () => renderCalendarRuleDestination(busy);
    label.append(select);
    const destination = document.createElement('p');
    destination.className = 'allocation-destination';
    destination.textContent = ragDestinationLabel(
      undefined,
      settings.tags.find((tag) => tag.id === select.value),
    );
    container.append(label, destination);
    byId<HTMLButtonElement>('save-calendar-rule').disabled =
      busy || !select.value;
    return;
  }

  const catalog = ragCatalogs.find((entry) => entry.id === sourceId);
  const firstItem = catalog?.items.find((item) => item.kind !== 'SKIP');
  if (!catalog || !firstItem) {
    const unavailable = document.createElement('p');
    unavailable.className = 'hint';
    unavailable.textContent = 'Esta origem não possui itens disponíveis.';
    container.append(unavailable);
    byId<HTMLButtonElement>('save-calendar-rule').disabled = true;
    return;
  }

  const filterLabel = document.createElement('label');
  filterLabel.textContent = 'Filtrar opções';
  const filter = document.createElement('input');
  filter.id = 'calendar-rule-rag-filter';
  filter.type = 'search';
  filter.placeholder = 'Nome, grupo ou destino';
  filter.value = previousFilter;
  filter.disabled = busy;
  filterLabel.append(filter);

  const itemLabel = document.createElement('label');
  itemLabel.textContent = 'Marcação';
  const itemSelect = document.createElement('select');
  itemSelect.id = 'calendar-rule-rag-item';
  itemSelect.disabled = busy;
  const selectedItemId = catalog.items.some(
    (item) => item.id === previousItemId && item.kind !== 'SKIP',
  )
    ? previousItemId
    : firstItem.id;
  appendRagOptions(
    itemSelect,
    catalog,
    normalizeUiSearch(previousFilter),
    selectedItemId,
  );
  itemSelect.value = selectedItemId ?? firstItem.id;
  itemSelect.onchange = () => renderCalendarRuleDestination(busy);
  filter.oninput = () => {
    const currentItemId = itemSelect.value;
    itemSelect.replaceChildren();
    appendRagOptions(
      itemSelect,
      catalog,
      normalizeUiSearch(filter.value),
      currentItemId,
    );
    itemSelect.value = currentItemId;
  };
  itemLabel.append(itemSelect);
  container.append(filterLabel, itemLabel);

  const selectedItem = findRagItem(catalog.id, itemSelect.value);
  const needsTag =
    selectedItem?.kind === 'PROJECT' &&
    (selectedItem.channel.projectSource === 'TAG' ||
      selectedItem.channel.activitySource === 'TAG');
  let contextualTag: ChannelTag | undefined;
  if (needsTag) {
    const tagLabel = document.createElement('label');
    tagLabel.textContent = 'TAG que fornecerá o projeto e/ou a atividade';
    const tagSelect = document.createElement('select');
    tagSelect.id = 'calendar-rule-context-tag';
    tagSelect.append(
      ...settings.tags.map((tag) => new Option(tag.name, tag.id)),
    );
    const selectedTagId = settings.tags.some((tag) => tag.id === previousTagId)
      ? previousTagId
      : settings.defaultTagId;
    if (selectedTagId) tagSelect.value = selectedTagId;
    tagSelect.disabled = busy || settings.tags.length === 0;
    tagSelect.onchange = () => renderCalendarRuleDestination(busy);
    contextualTag = settings.tags.find((tag) => tag.id === tagSelect.value);
    tagLabel.append(tagSelect);
    container.append(tagLabel);
  }
  const destination = document.createElement('p');
  destination.className = 'allocation-destination';
  destination.textContent = ragDestinationLabel(selectedItem, contextualTag);
  container.append(destination);
  byId<HTMLButtonElement>('save-calendar-rule').disabled =
    busy ||
    !selectedItem ||
    selectedItem.kind === 'SKIP' ||
    (needsTag && contextualTag === undefined);
}

function actionButton(
  text: string,
  label: string,
  action: () => Promise<void> | void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  if (label) button.setAttribute('aria-label', label);
  button.addEventListener('click', () => void action());
  return button;
}

async function connectCalendar(): Promise<void> {
  if (calendarPending) return;
  calendarPending = true;
  render();
  try {
    const tabMode = settings.googleCalendar.accessMode === 'tab';
    const apiAccessGranted = tabMode
      ? await requestGoogleCalendarTabAccess()
      : await requestGoogleCalendarApiAccess();
    if (!apiAccessGranted)
      throw new Error(
        tabMode
          ? 'O acesso à aba do Google Calendar foi recusado. Permita o host exato para usar a sessão da página.'
          : 'O acesso à API do Google Calendar foi recusado. Permita o acesso para conectar sua conta.',
      );
    await send({
      type: 'CONNECT_GOOGLE_CALENDAR',
      operationId: operationId(),
    });
    useSettings(await loadExtensionSettings());
    calendarManagerMessage = settings.googleCalendar.connected
      ? 'Conexão atualizada. Escolha os calendários e crie uma regra.'
      : (state?.message ?? 'Não foi possível conectar o Google Calendar.');
  } catch (error) {
    calendarManagerMessage =
      error instanceof Error ? error.message : 'Não foi possível conectar.';
  } finally {
    calendarPending = false;
    render();
  }
}

async function setCalendarAccessMode(useTab: boolean): Promise<void> {
  if (
    calendarPending ||
    settings.googleCalendar.accessMode === (useTab ? 'tab' : 'oauth')
  )
    return;
  const {
    accountEmail: previousAccountEmail,
    lastSyncedAt: previousLastSyncedAt,
    ...calendarWithoutSession
  } = settings.googleCalendar;
  void previousAccountEmail;
  void previousLastSyncedAt;
  settings = {
    ...settings,
    googleCalendar: {
      ...calendarWithoutSession,
      accessMode: useTab ? 'tab' : 'oauth',
      connected: false,
      calendars: [],
      selectedCalendarIds: [],
    },
  };
  await saveExtensionSettings(settings);
  calendarManagerMessage = useTab
    ? 'Modo aba selecionado. Abra uma sessão do Google Calendar e conecte novamente.'
    : 'Modo Google Calendar API selecionado. Conecte novamente.';
  render();
}

async function setCalendarSelected(
  id: string,
  selected: boolean,
): Promise<void> {
  const current = settings.googleCalendar.selectedCalendarIds;
  settings = {
    ...settings,
    googleCalendar: {
      ...settings.googleCalendar,
      selectedCalendarIds: selected
        ? [...new Set([...current, id])]
        : current.filter((entry) => entry !== id),
    },
  };
  await saveExtensionSettings(settings);
  render();
}

function resetCalendarRuleEditor(): void {
  byId<HTMLInputElement>('calendar-rule-name').value = '';
  byId<HTMLTextAreaElement>('calendar-rule-phrases').value = '';
  byId<HTMLSelectElement>('calendar-rule-mode').value = 'all';
  document
    .querySelectorAll<HTMLInputElement>('.calendar-fields input')
    .forEach((input) => (input.checked = input.value !== 'location'));
  byId<HTMLTextAreaElement>('calendar-rule-excluded').value = '';
  byId<HTMLInputElement>('calendar-ignore-cancelled').checked = true;
  byId<HTMLInputElement>('calendar-ignore-declined').checked = true;
  byId<HTMLInputElement>('calendar-ignore-all-day').checked = true;
  byId<HTMLInputElement>('calendar-busy-only').checked = true;
  byId<HTMLInputElement>('calendar-rule-enabled').checked = true;
  const advanced = byId<HTMLTextAreaElement>('calendar-rule-excluded').closest(
    'details',
  );
  if (advanced) advanced.open = false;
  byId<HTMLSelectElement>('calendar-rule-source').value = 'tags';
  renderCalendarRuleDestination(false, true);
  document
    .querySelectorAll<HTMLInputElement>('#calendar-rule-calendars input')
    .forEach((input) => (input.checked = true));
}

function editCalendarRule(ruleId: string): void {
  const rule = settings.googleCalendar.rules.find(
    (candidate) => candidate.id === ruleId,
  );
  if (!rule) return;
  editingCalendarRuleId = rule.id;
  calendarManagerMessage = `Editando regra ${rule.name}.`;
  render();

  byId<HTMLInputElement>('calendar-rule-name').value = rule.name;
  byId<HTMLTextAreaElement>('calendar-rule-phrases').value =
    rule.phrases.join('\n');
  byId<HTMLSelectElement>('calendar-rule-mode').value = rule.matchMode;
  document
    .querySelectorAll<HTMLInputElement>('.calendar-fields input')
    .forEach(
      (input) =>
        (input.checked = rule.fields.includes(
          input.value as CalendarEventField,
        )),
    );
  byId<HTMLTextAreaElement>('calendar-rule-excluded').value =
    rule.excludedPhrases.join('\n');
  byId<HTMLInputElement>('calendar-ignore-cancelled').checked =
    rule.ignoreCancelled;
  byId<HTMLInputElement>('calendar-ignore-declined').checked =
    rule.ignoreDeclined;
  byId<HTMLInputElement>('calendar-ignore-all-day').checked = rule.ignoreAllDay;
  byId<HTMLInputElement>('calendar-busy-only').checked = rule.busyOnly;
  byId<HTMLInputElement>('calendar-rule-enabled').checked = rule.enabled;
  const advanced = byId<HTMLTextAreaElement>('calendar-rule-excluded').closest(
    'details',
  );
  if (advanced) advanced.open = rule.excludedPhrases.length > 0;

  const source = byId<HTMLSelectElement>('calendar-rule-source');
  source.value = rule.ragCatalogId ?? 'tags';
  renderCalendarRuleDestination(false, true);
  if (rule.ragCatalogId) {
    const item = document.querySelector<HTMLSelectElement>(
      '#calendar-rule-rag-item',
    );
    if (item && rule.ragItemId) {
      item.value = rule.ragItemId;
      renderCalendarRuleDestination(false);
    }
    const contextTag = document.querySelector<HTMLSelectElement>(
      '#calendar-rule-context-tag',
    );
    if (contextTag && rule.tagId) contextTag.value = rule.tagId;
  } else {
    const tag = document.querySelector<HTMLSelectElement>('#calendar-rule-tag');
    if (tag && rule.tagId) tag.value = rule.tagId;
  }
  document
    .querySelectorAll<HTMLInputElement>('#calendar-rule-calendars input')
    .forEach(
      (input) =>
        (input.checked =
          rule.calendarIds.length === 0 ||
          rule.calendarIds.includes(input.value)),
    );
  byId<HTMLInputElement>('calendar-rule-name').focus();
}

function cancelCalendarRuleEditing(): void {
  if (editingCalendarRuleId === undefined) return;
  editingCalendarRuleId = undefined;
  resetCalendarRuleEditor();
  calendarManagerMessage = 'Edição da regra cancelada.';
  render();
}

async function restoreCalendarRule(ruleId: string): Promise<void> {
  const current = settings.googleCalendar.rules.find(
    (rule) => rule.id === ruleId,
  );
  if (!current || !isImportedRagCalendarRule(current)) return;
  if (
    !globalThis.confirm(
      `Restaurar “${current.name}” para a configuração original do RAG?`,
    )
  )
    return;
  const restored = restoreImportedRagCalendarRule(
    current,
    settings.defaultTagId,
  );
  if (!restored) {
    calendarManagerMessage = 'O item original não está mais disponível no RAG.';
    render();
    return;
  }
  settings = {
    ...settings,
    googleCalendar: {
      ...settings.googleCalendar,
      rules: settings.googleCalendar.rules.map((rule) =>
        rule.id === ruleId ? { ...restored, id: ruleId } : rule,
      ),
    },
  };
  await saveExtensionSettings(settings);
  if (editingCalendarRuleId === ruleId) {
    editingCalendarRuleId = undefined;
    resetCalendarRuleEditor();
  }
  calendarManagerMessage = `Regra RAG ${restored.name} restaurada.`;
  render();
}

async function saveCalendarRule(): Promise<void> {
  try {
    const name = byId<HTMLInputElement>('calendar-rule-name').value.trim();
    const phrases = readTextLines('calendar-rule-phrases');
    const fields = [
      ...document.querySelectorAll<HTMLInputElement>(
        '.calendar-fields input:checked',
      ),
    ].map((input) => input.value as CalendarEventField);
    const sourceId = byId<HTMLSelectElement>('calendar-rule-source').value;
    const tagId =
      sourceId === 'tags'
        ? byId<HTMLSelectElement>('calendar-rule-tag').value
        : document.querySelector<HTMLSelectElement>(
            '#calendar-rule-context-tag',
          )?.value;
    const ragCatalogId = sourceId === 'tags' ? undefined : sourceId;
    const ragItemId =
      sourceId === 'tags'
        ? undefined
        : byId<HTMLSelectElement>('calendar-rule-rag-item').value;
    const ragItem = findRagItem(ragCatalogId, ragItemId);
    const calendarIds = [
      ...document.querySelectorAll<HTMLInputElement>(
        '#calendar-rule-calendars input:checked',
      ),
    ].map((input) => input.value);
    if (!name) throw new Error('Informe um nome para a regra do Calendar.');
    if (
      settings.googleCalendar.rules.some(
        (rule) =>
          rule.id !== editingCalendarRuleId &&
          rule.name.toLocaleLowerCase('pt-BR') ===
            name.toLocaleLowerCase('pt-BR'),
      )
    )
      throw new Error('Já existe uma regra do Calendar com este nome.');
    if (phrases.length === 0)
      throw new Error('Informe ao menos uma frase para procurar.');
    if (fields.length === 0)
      throw new Error('Escolha ao menos um campo do evento.');
    if (sourceId === 'tags' && !tagId)
      throw new Error('Escolha uma TAG para a marcação.');
    if (sourceId !== 'tags' && (!ragItem || ragItem.kind === 'SKIP'))
      throw new Error('Escolha um item válido da fonte.');
    if (
      ragItem?.kind === 'PROJECT' &&
      (ragItem.channel.projectSource === 'TAG' ||
        ragItem.channel.activitySource === 'TAG') &&
      !tagId
    )
      throw new Error(
        'Escolha uma TAG salva para fornecer o projeto e/ou a atividade deste item.',
      );
    if (calendarIds.length === 0)
      throw new Error('Escolha ao menos um calendário para a regra.');
    const rule: GoogleCalendarRule = {
      id: editingCalendarRuleId ?? crypto.randomUUID(),
      name,
      enabled: byId<HTMLInputElement>('calendar-rule-enabled').checked,
      calendarIds,
      fields,
      matchMode: byId<HTMLSelectElement>('calendar-rule-mode').value as
        'all' | 'any',
      phrases,
      excludedPhrases: readTextLines('calendar-rule-excluded'),
      ...(tagId ? { tagId } : {}),
      ...(ragCatalogId ? { ragCatalogId } : {}),
      ...(ragItemId ? { ragItemId } : {}),
      ignoreCancelled: byId<HTMLInputElement>('calendar-ignore-cancelled')
        .checked,
      ignoreDeclined: byId<HTMLInputElement>('calendar-ignore-declined')
        .checked,
      ignoreAllDay: byId<HTMLInputElement>('calendar-ignore-all-day').checked,
      busyOnly: byId<HTMLInputElement>('calendar-busy-only').checked,
    };
    const wasEditing = editingCalendarRuleId !== undefined;
    settings = {
      ...settings,
      googleCalendar: {
        ...settings.googleCalendar,
        rules: wasEditing
          ? settings.googleCalendar.rules.map((current) =>
              current.id === editingCalendarRuleId ? rule : current,
            )
          : [...settings.googleCalendar.rules, rule],
      },
    };
    await saveExtensionSettings(settings);
    editingCalendarRuleId = undefined;
    resetCalendarRuleEditor();
    calendarManagerMessage = wasEditing
      ? `Regra ${name} atualizada.`
      : `Regra ${name} salva.`;
  } catch (error) {
    calendarManagerMessage =
      error instanceof Error ? error.message : 'Não foi possível salvar.';
  }
  render();
}

function readTextLines(id: string): string[] {
  return byId<HTMLTextAreaElement>(id)
    .value.split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

async function updateCalendarRules(
  rules: readonly GoogleCalendarRule[],
  message: string,
): Promise<void> {
  settings = {
    ...settings,
    googleCalendar: { ...settings.googleCalendar, rules },
  };
  await saveExtensionSettings(settings);
  calendarManagerMessage = message;
  render();
}

async function toggleCalendarRule(ruleId: string): Promise<void> {
  await updateCalendarRules(
    settings.googleCalendar.rules.map((rule) =>
      rule.id === ruleId ? { ...rule, enabled: !rule.enabled } : rule,
    ),
    'Estado da regra atualizado.',
  );
}

async function removeCalendarRule(ruleId: string): Promise<void> {
  if (editingCalendarRuleId === ruleId) {
    editingCalendarRuleId = undefined;
    resetCalendarRuleEditor();
  }
  await updateCalendarRules(
    settings.googleCalendar.rules.filter((rule) => rule.id !== ruleId),
    'Regra do Calendar excluída.',
  );
}

async function moveCalendarRule(
  ruleId: string,
  direction: -1 | 1,
): Promise<void> {
  const rules = [...settings.googleCalendar.rules];
  const from = rules.findIndex((rule) => rule.id === ruleId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= rules.length) return;
  const [rule] = rules.splice(from, 1);
  if (!rule) return;
  rules.splice(to, 0, rule);
  await updateCalendarRules(rules, 'Prioridade das regras atualizada.');
}

function templateEntrySummary(
  entry: MarkingTemplate['entries'][number],
): string {
  const tag = settings.tags.find((candidate) => candidate.id === entry.tagId);
  const rag = findRagItem(entry.ragCatalogId, entry.ragItemId);
  const destination = rag?.event ?? tag?.name ?? 'Destino indisponível';
  return `${String(Number(entry.percentage.toFixed(2)))}% (${formatDurationMinutes(entry.durationMinutes)}) ${destination}`;
}

function templateDestinationValue(
  entry: MarkingTemplate['entries'][number],
): string {
  return entry.ragCatalogId && entry.ragItemId
    ? `rag|${encodeURIComponent(entry.ragCatalogId)}|${encodeURIComponent(entry.ragItemId)}`
    : `tag|${encodeURIComponent(entry.tagId ?? '')}`;
}

function parseTemplateDestination(
  value: string,
):
  | { kind: 'tag'; tagId: string }
  | { kind: 'rag'; catalogId: string; itemId: string }
  | undefined {
  const [kind, first = '', second = ''] = value.split('|');
  if (kind === 'tag' && first)
    return { kind, tagId: decodeURIComponent(first) };
  if (kind === 'rag' && first && second)
    return {
      kind,
      catalogId: decodeURIComponent(first),
      itemId: decodeURIComponent(second),
    };
  return undefined;
}

function appendTemplateDestinationOptions(
  select: HTMLSelectElement,
  selectedValue?: string,
): void {
  const tags = document.createElement('optgroup');
  tags.label = 'Minhas TAGs';
  tags.append(
    ...settings.tags.map(
      (tag) => new Option(tag.name, `tag|${encodeURIComponent(tag.id)}`),
    ),
  );
  select.append(tags);
  for (const catalog of ragCatalogs) {
    const group = document.createElement('optgroup');
    group.label = catalog.name;
    group.append(
      ...catalog.items
        .filter((item) => item.kind !== 'SKIP')
        .map(
          (item) =>
            new Option(
              item.event,
              `rag|${encodeURIComponent(catalog.id)}|${encodeURIComponent(item.id)}`,
            ),
        ),
    );
    if (group.childElementCount > 0) select.append(group);
  }
  if (
    selectedValue &&
    select.querySelector(`option[value="${CSS.escape(selectedValue)}"]`)
  )
    select.value = selectedValue;
}

function syncTemplateEntryContext(
  row: HTMLElement,
  preferredTagId?: string,
): void {
  const destination = row.querySelector<HTMLSelectElement>(
    '.template-entry-destination',
  );
  const contextLabel = row.querySelector<HTMLElement>(
    '.template-entry-context-label',
  );
  const context = row.querySelector<HTMLSelectElement>(
    '.template-entry-context',
  );
  if (!destination || !contextLabel || !context) return;
  const parsed = parseTemplateDestination(destination.value);
  const ragItem =
    parsed?.kind === 'rag'
      ? findRagItem(parsed.catalogId, parsed.itemId)
      : undefined;
  const needsContext =
    ragItem?.kind === 'PROJECT' &&
    (ragItem.channel.projectSource === 'TAG' ||
      ragItem.channel.activitySource === 'TAG');
  const previous = preferredTagId ?? context.value;
  context.replaceChildren(
    ...settings.tags.map((tag) => new Option(tag.name, tag.id)),
  );
  const selected = settings.tags.some((tag) => tag.id === previous)
    ? previous
    : settings.defaultTagId;
  if (selected) context.value = selected;
  contextLabel.hidden = !needsContext;
  context.disabled = !needsContext || settings.tags.length === 0;
}

function updateTemplateEntryTotal(): void {
  const durations = [
    ...document.querySelectorAll<HTMLInputElement>(
      '#template-entry-list .template-entry-duration',
    ),
  ];
  let total = 0;
  let valid = durations.length > 0;
  for (const duration of durations) {
    try {
      const minutes = parseDurationMinutes(duration.value.trim());
      if (minutes <= 0) valid = false;
      total += Math.max(0, minutes);
    } catch {
      valid = false;
    }
  }
  let sourceMinutes: number | undefined;
  try {
    sourceMinutes = parseDurationMinutes(
      byId<HTMLInputElement>('template-source-duration').value.trim(),
    );
    if (sourceMinutes <= 0) valid = false;
  } catch {
    valid = false;
  }
  const output = byId<HTMLOutputElement>('template-entry-total');
  output.textContent = `Total: ${formatDurationMinutes(total)}${sourceMinutes === undefined ? '' : ` de ${formatDurationMinutes(sourceMinutes)}`}`;
  const matches = valid && total === sourceMinutes;
  output.classList.toggle('valid', matches);
  output.classList.toggle('invalid', !matches);
}

function addTemplateEntryRow(entry?: MarkingTemplate['entries'][number]): void {
  templateEntryCounter += 1;
  const row = document.createElement('div');
  row.className = 'template-entry-row';
  row.dataset.entryId = entry?.id ?? `draft-${String(templateEntryCounter)}`;

  const destinationLabel = document.createElement('label');
  destinationLabel.textContent = 'Destino da marcação';
  const destination = document.createElement('select');
  destination.className = 'template-entry-destination';
  appendTemplateDestinationOptions(
    destination,
    entry ? templateDestinationValue(entry) : undefined,
  );
  destinationLabel.append(destination);

  const contextLabel = document.createElement('label');
  contextLabel.className = 'template-entry-context-label';
  contextLabel.textContent = 'TAG que fornece projeto/atividade';
  const context = document.createElement('select');
  context.className = 'template-entry-context';
  contextLabel.append(context);

  const durationLabel = document.createElement('label');
  durationLabel.textContent = 'Duração (HH:MM)';
  const duration = document.createElement('input');
  duration.className = 'template-entry-duration';
  duration.inputMode = 'numeric';
  duration.placeholder = '08:00';
  duration.value = entry ? formatDurationMinutes(entry.durationMinutes) : '';
  durationLabel.append(duration);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Remover';
  remove.setAttribute('aria-label', 'Remover marcação do template');
  remove.addEventListener('click', () => {
    row.remove();
    updateTemplateEntryTotal();
  });
  destination.addEventListener('change', () => syncTemplateEntryContext(row));
  duration.addEventListener('input', updateTemplateEntryTotal);
  row.append(destinationLabel, contextLabel, durationLabel, remove);
  byId<HTMLElement>('template-entry-list').append(row);
  syncTemplateEntryContext(row, entry?.tagId);
  updateTemplateEntryTotal();
}

function closeTemplateEditor(): void {
  editingTemplateId = undefined;
  byId<HTMLInputElement>('template-name').value = '';
  byId<HTMLInputElement>('template-source-duration').value = '';
  byId<HTMLElement>('template-entry-list').replaceChildren();
  updateTemplateEntryTotal();
}

function createTemplateEditor(): void {
  editingTemplateId = '';
  templateManagerMessage = 'Criando um novo template.';
  render();
  byId<HTMLInputElement>('template-name').value = '';
  byId<HTMLInputElement>('template-source-duration').value = '08:00';
  byId<HTMLElement>('template-entry-list').replaceChildren();
  addTemplateEntryRow();
  byId<HTMLInputElement>('template-name').focus();
}

function editMarkingTemplate(templateId: string): void {
  const template = settings.markingTemplates.find(
    (candidate) => candidate.id === templateId,
  );
  if (!template) return;
  editingTemplateId = template.id;
  templateManagerMessage = `Editando template ${template.name}.`;
  render();
  byId<HTMLInputElement>('template-name').value = template.name;
  byId<HTMLInputElement>('template-source-duration').value =
    formatDurationMinutes(template.sourceDurationMinutes);
  byId<HTMLElement>('template-entry-list').replaceChildren();
  template.entries.forEach((entry) => addTemplateEntryRow(entry));
  byId<HTMLInputElement>('template-name').focus();
}

function cancelTemplateEditing(): void {
  if (editingTemplateId === undefined) return;
  closeTemplateEditor();
  templateManagerMessage = 'Edição do template cancelada.';
  render();
}

async function saveTemplateFromEditor(): Promise<void> {
  try {
    const name = byId<HTMLInputElement>('template-name').value.trim();
    if (!name) throw new Error('Informe um nome para o template.');
    if (
      settings.markingTemplates.some(
        (template) =>
          template.id !== editingTemplateId &&
          template.name.toLocaleLowerCase('pt-BR') ===
            name.toLocaleLowerCase('pt-BR'),
      )
    )
      throw new Error('Já existe um template com este nome.');
    const sourceDurationMinutes = parseDurationMinutes(
      byId<HTMLInputElement>('template-source-duration').value.trim(),
    );
    if (sourceDurationMinutes <= 0)
      throw new Error('Informe uma duração original positiva.');
    const rows = [
      ...document.querySelectorAll<HTMLElement>('.template-entry-row'),
    ];
    if (rows.length === 0)
      throw new Error('Adicione ao menos uma marcação ao template.');
    const templateId = editingTemplateId || crypto.randomUUID();
    const entries = rows.map((row, index) => {
      const destination = row.querySelector<HTMLSelectElement>(
        '.template-entry-destination',
      );
      const durationInput = row.querySelector<HTMLInputElement>(
        '.template-entry-duration',
      );
      if (!destination || !durationInput)
        throw new Error('Marcação incompleta no template.');
      const parsed = parseTemplateDestination(destination.value);
      if (!parsed) throw new Error('Escolha o destino de cada marcação.');
      const durationMinutes = parseDurationMinutes(durationInput.value.trim());
      if (durationMinutes <= 0)
        throw new Error('As durações das marcações devem ser positivas.');
      const entryId = row.dataset.entryId?.startsWith('draft-')
        ? `${templateId}::${String(index + 1)}`
        : (row.dataset.entryId ?? `${templateId}::${String(index + 1)}`);
      const percentage = Number(
        ((durationMinutes * 100) / sourceDurationMinutes).toFixed(4),
      );
      if (parsed.kind === 'tag') {
        if (!settings.tags.some((tag) => tag.id === parsed.tagId))
          throw new Error('Uma das TAGs do template não está disponível.');
        return {
          id: entryId,
          tagId: parsed.tagId,
          percentage,
          durationMinutes,
        };
      }
      const ragItem = findRagItem(parsed.catalogId, parsed.itemId);
      if (!ragItem || ragItem.kind === 'SKIP')
        throw new Error('Um dos itens RAG não está disponível.');
      const needsContext =
        ragItem.kind === 'PROJECT' &&
        (ragItem.channel.projectSource === 'TAG' ||
          ragItem.channel.activitySource === 'TAG');
      const contextualTagId = row.querySelector<HTMLSelectElement>(
        '.template-entry-context',
      )?.value;
      if (needsContext && !contextualTagId)
        throw new Error(
          'Escolha uma TAG salva para fornecer o projeto e/ou a atividade do item RAG.',
        );
      return {
        id: entryId,
        ...(needsContext && contextualTagId ? { tagId: contextualTagId } : {}),
        ragCatalogId: parsed.catalogId,
        ragItemId: parsed.itemId,
        percentage,
        durationMinutes,
      };
    });
    const total = entries.reduce(
      (sum, entry) => sum + entry.durationMinutes,
      0,
    );
    if (total !== sourceDurationMinutes)
      throw new Error(
        `As marcações devem totalizar ${formatDurationMinutes(sourceDurationMinutes)}. Total atual: ${formatDurationMinutes(total)}.`,
      );
    const existing = settings.markingTemplates.find(
      (template) => template.id === editingTemplateId,
    );
    const template: MarkingTemplate = {
      id: templateId,
      name,
      sourceDurationMinutes,
      entries,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    const wasEditing = existing !== undefined;
    settings = {
      ...settings,
      markingTemplates: wasEditing
        ? settings.markingTemplates.map((current) =>
            current.id === template.id ? template : current,
          )
        : [...settings.markingTemplates, template],
    };
    await saveExtensionSettings(settings);
    closeTemplateEditor();
    templateManagerMessage = wasEditing
      ? `Template ${name} atualizado.`
      : `Template ${name} criado.`;
    render();
  } catch (error) {
    templateManagerMessage =
      error instanceof Error
        ? error.message
        : 'Não foi possível salvar o template.';
    render();
  }
}

function addRuleTemplateShare(
  selectedTemplateId?: string,
  percentage = 0,
): void {
  const container = byId<HTMLElement>('rule-template-shares');
  const row = document.createElement('div');
  row.className = 'rule-template-share';
  row.dataset.rowId = String(++ruleShareCounter);
  const templateLabel = document.createElement('label');
  templateLabel.textContent = 'Template';
  const select = document.createElement('select');
  select.className = 'rule-template-select';
  templateLabel.append(select);
  const shareLabel = document.createElement('label');
  shareLabel.textContent = 'Participação (%)';
  const share = document.createElement('input');
  share.className = 'rule-template-percentage';
  share.type = 'number';
  share.min = '0.01';
  share.max = '100';
  share.step = '0.01';
  share.value = String(percentage);
  shareLabel.append(share);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Remover';
  remove.setAttribute('aria-label', 'Remover template da composição');
  remove.addEventListener('click', () => {
    row.remove();
    updateRuleShareTotal();
  });
  share.addEventListener('input', updateRuleShareTotal);
  row.append(templateLabel, shareLabel, remove);
  container.append(row);
  renderRuleTemplateOptions();
  if (selectedTemplateId) select.value = selectedTemplateId;
  updateRuleShareTotal();
}

function renderRuleTemplateOptions(): void {
  document
    .querySelectorAll<HTMLSelectElement>('.rule-template-select')
    .forEach((select) => {
      const previous = select.value;
      select.replaceChildren(
        ...settings.markingTemplates.map(
          (template) => new Option(template.name, template.id),
        ),
      );
      if (
        settings.markingTemplates.some((template) => template.id === previous)
      )
        select.value = previous;
    });
}

function updateRuleShareTotal(): void {
  const total = [
    ...document.querySelectorAll<HTMLInputElement>('.rule-template-percentage'),
  ].reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  const output = byId<HTMLOutputElement>('rule-share-total');
  output.textContent = `Total: ${String(Number(total.toFixed(2)))}%`;
  output.classList.toggle('valid', Math.abs(total - 100) < 0.001);
  output.classList.toggle('invalid', Math.abs(total - 100) >= 0.001);
}

function readRuleTemplateShares(): readonly RuleTemplateShare[] {
  const rows = [
    ...document.querySelectorAll<HTMLElement>('.rule-template-share'),
  ];
  const shares = rows.map((row) => ({
    templateId: row.querySelector<HTMLSelectElement>('select')?.value ?? '',
    percentage: Number(
      row.querySelector<HTMLInputElement>('input[type="number"]')?.value ?? 0,
    ),
  }));
  if (shares.length === 0) throw new Error('Adicione ao menos um template.');
  if (shares.some((share) => !share.templateId || share.percentage <= 0))
    throw new Error('Escolha os templates e informe participações positivas.');
  if (new Set(shares.map((share) => share.templateId)).size !== shares.length)
    throw new Error('Use cada template apenas uma vez na composição.');
  const total = shares.reduce((sum, share) => sum + share.percentage, 0);
  if (Math.abs(total - 100) >= 0.001)
    throw new Error('A participação dos templates precisa totalizar 100%.');
  return shares;
}

async function saveTemplateRule(): Promise<void> {
  try {
    const name = byId<HTMLInputElement>('rule-name').value.trim();
    if (!name) throw new Error('Informe um nome para a regra.');
    const repeatEveryWeeks = Number(byId<HTMLInputElement>('rule-every').value);
    if (
      !Number.isInteger(repeatEveryWeeks) ||
      repeatEveryWeeks < 1 ||
      repeatEveryWeeks > 52
    )
      throw new Error('A repetição deve estar entre 1 e 52 semanas.');
    const weekdays = [
      ...document.querySelectorAll<HTMLInputElement>(
        '#template-manager-dialog .weekday-picker input:checked',
      ),
    ].map((input) => Number(input.value) as Weekday);
    if (weekdays.length === 0)
      throw new Error('Escolha ao menos um dia da semana.');
    const startsOn = civilDate(byId<HTMLInputElement>('rule-start').value);
    const endKind =
      document.querySelector<HTMLInputElement>('input[name="rule-end"]:checked')
        ?.value ?? 'never';
    const ends: TemplateApplicationRule['ends'] =
      endKind === 'on'
        ? {
            kind: 'on',
            date: civilDate(byId<HTMLInputElement>('rule-end-date').value),
          }
        : endKind === 'after'
          ? {
              kind: 'after',
              occurrences: Number(
                byId<HTMLInputElement>('rule-end-count').value,
              ),
            }
          : { kind: 'never' };
    if (ends.kind === 'on' && ends.date < startsOn)
      throw new Error('A data final não pode ser anterior à inicial.');
    if (
      ends.kind === 'after' &&
      (!Number.isInteger(ends.occurrences) ||
        ends.occurrences < 1 ||
        ends.occurrences > 730)
    )
      throw new Error('Informe de 1 a 730 ocorrências.');
    const rule: TemplateApplicationRule = {
      id: crypto.randomUUID(),
      name,
      enabled: byId<HTMLInputElement>('rule-enabled').checked,
      repeatEveryWeeks,
      weekdays,
      startsOn,
      ends,
      templates: readRuleTemplateShares(),
    };
    settings = {
      ...settings,
      templateRules: [...settings.templateRules, rule],
    };
    await saveExtensionSettings(settings);
    resetRuleEditor();
    templateManagerMessage = `Regra ${name} salva.`;
    render();
  } catch (error) {
    templateManagerMessage =
      error instanceof Error
        ? error.message
        : 'Não foi possível salvar a regra.';
    render();
  }
}

function resetRuleEditor(): void {
  byId<HTMLInputElement>('rule-name').value = '';
  byId<HTMLInputElement>('rule-every').value = '1';
  document
    .querySelectorAll<HTMLInputElement>(
      '#template-manager-dialog .weekday-picker input',
    )
    .forEach((input) => (input.checked = false));
  byId<HTMLInputElement>('rule-start').value = currentDateValue();
  const never = document.querySelector<HTMLInputElement>(
    'input[name="rule-end"][value="never"]',
  );
  if (never) never.checked = true;
  syncRuleEndControls();
  byId<HTMLInputElement>('rule-enabled').checked = true;
  byId<HTMLElement>('rule-template-shares').replaceChildren();
  if (settings.markingTemplates[0])
    addRuleTemplateShare(settings.markingTemplates[0].id, 100);
}

async function removeMarkingTemplate(templateId: string): Promise<void> {
  const template = settings.markingTemplates.find(
    (candidate) => candidate.id === templateId,
  );
  if (!template) return;
  if (
    settings.templateRules.some((rule) =>
      rule.templates.some((share) => share.templateId === templateId),
    )
  ) {
    templateManagerMessage =
      'Este template está sendo usado por uma regra. Exclua ou ajuste a regra primeiro.';
    render();
    return;
  }
  settings = {
    ...settings,
    markingTemplates: settings.markingTemplates.filter(
      (candidate) => candidate.id !== templateId,
    ),
  };
  await saveExtensionSettings(settings);
  if (editingTemplateId === templateId) closeTemplateEditor();
  templateManagerMessage = `Template ${template.name} excluído.`;
  render();
}

async function toggleTemplateRule(ruleId: string): Promise<void> {
  settings = {
    ...settings,
    templateRules: settings.templateRules.map((rule) =>
      rule.id === ruleId ? { ...rule, enabled: !rule.enabled } : rule,
    ),
  };
  await saveExtensionSettings(settings);
  templateManagerMessage = 'Estado da regra atualizado.';
  render();
}

async function removeTemplateRule(ruleId: string): Promise<void> {
  settings = {
    ...settings,
    templateRules: settings.templateRules.filter((rule) => rule.id !== ruleId),
  };
  await saveExtensionSettings(settings);
  templateManagerMessage = 'Regra excluída.';
  render();
}

function syncRuleEndControls(): void {
  const value =
    document.querySelector<HTMLInputElement>('input[name="rule-end"]:checked')
      ?.value ?? 'never';
  byId<HTMLInputElement>('rule-end-date').disabled = value !== 'on';
  byId<HTMLInputElement>('rule-end-count').disabled = value !== 'after';
}

function currentDateValue(now = new Date()): string {
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function selectedCatalogProject(): ChannelCatalogProject | undefined {
  const projectId = byId<HTMLSelectElement>('tag-project').value;
  return settings.catalog?.projects.find((project) => project.id === projectId);
}

function renderActivityOptions(): void {
  const project = selectedCatalogProject();
  const select = byId<HTMLSelectElement>('tag-activity');
  const previous = select.value;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = project
    ? 'Escolha uma atividade'
    : 'Escolha primeiro um projeto';
  select.replaceChildren(
    placeholder,
    ...(project?.activities ?? []).map((activity) => {
      const option = document.createElement('option');
      option.value = activity.id;
      option.textContent = activity.label;
      return option;
    }),
  );
  select.disabled = project === undefined;
  if (project?.activities.some((activity) => activity.id === previous))
    select.value = previous;
  renderAutomaticTagName();
}

function renderAutomaticTagName(): void {
  const project = selectedCatalogProject();
  const activity = project?.activities.find(
    (candidate) =>
      candidate.id === byId<HTMLSelectElement>('tag-activity').value,
  );
  byId<HTMLInputElement>('tag-name').value =
    project && activity ? `${project.label} — ${activity.label}` : '';
}

function renderConfig(): void {
  const config = state?.config;
  if (!config) return;
  const kind = config.period.kind;
  byId<HTMLSelectElement>('period-kind').value = kind;
  byId('month-field').hidden = kind !== 'month';
  byId('start-field').hidden = kind !== 'range';
  byId('end-field').hidden = kind !== 'range';
  if (kind === 'month')
    byId<HTMLInputElement>('month').value = config.period.month;
  if (kind === 'range') {
    byId<HTMLInputElement>('start').value = config.period.start;
    byId<HTMLInputElement>('end').value = config.period.end;
  }
  byId<HTMLTextAreaElement>('overrides').value = config.overrides
    .map((override) => `${override.date}=${override.times.join(',')}`)
    .join('\n');
}

function renderTab(
  role: TabRole,
  tabId: number | undefined,
  pending: TabRole | undefined,
): void {
  const output = byId<HTMLOutputElement>(`${role}-state`);
  output.textContent =
    tabId === undefined
      ? pending === role
        ? 'Clique no ícone nesta aba'
        : 'Não registrado'
      : `Registrado · aba ${String(tabId)}`;
  output.classList.toggle('ready', tabId !== undefined);
  byId<HTMLButtonElement>(`register-${role}`).hidden = tabId !== undefined;
}

function renderPreview(): void {
  const container = byId<HTMLElement>('preview');
  container.replaceChildren(
    ...(state?.items ?? []).map((item) => {
      const row = document.createElement('article');
      row.className = `item ${itemVisualClass(item)}`;
      row.setAttribute('role', 'listitem');
      const body = document.createElement('div');
      body.className = 'item-body';
      const title = document.createElement('p');
      title.className = 'item-title';
      title.textContent = `${formatBrazilianDate(item.date)} · Ahgora ${item.ahgoraDuration}`;
      const meta = document.createElement('p');
      meta.className = 'meta';
      const displayStatus =
        item.result === 'filled' || item.result === 'already-correct'
          ? 'equal'
          : item.status;
      const displayedStatus =
        item.editingBalanceMinutes === undefined
          ? statusLabel(displayStatus)
          : `Editando saldo restante de ${formatDurationMinutes(item.editingBalanceMinutes)}`;
      meta.textContent = `${displayedStatus}${item.channelDuration ? ` · Channel ${item.channelDuration}` : ''}${item.result ? ` · ${resultLabel(item.result)}` : ''}${item.warning ? ` · ${item.warning}` : ''}`;
      body.append(title, meta);
      if (item.appliedRuleName) {
        const appliedRule = document.createElement('span');
        appliedRule.className = 'applied-rule';
        appliedRule.textContent = `Aplicado automaticamente · ${item.appliedRuleName}`;
        body.append(appliedRule);
      }
      if (
        (item.channelMarkings?.length ?? 0) === 0 &&
        (item.channelProject || item.channelActivity)
      ) {
        const channelAssignment = document.createElement('p');
        channelAssignment.className = 'assignment-meta';
        channelAssignment.textContent = `Channel · Projeto: ${item.channelProject ?? 'não informado'} · Atividade: ${item.channelActivity ?? 'não informada'}`;
        body.append(channelAssignment);
      }
      if ((item.channelMarkings?.length ?? 0) > 0) {
        const markings = document.createElement('div');
        markings.className = 'channel-marking-list';
        markings.setAttribute(
          'aria-label',
          `Marcações existentes no Channel em ${formatBrazilianDate(item.date)}`,
        );
        markings.append(
          ...(item.channelMarkings ?? []).map((marking, index) => {
            const existing = document.createElement('div');
            existing.className = 'channel-marking';
            const details = document.createElement('div');
            const heading = document.createElement('strong');
            heading.textContent = `Marcação ${String(index + 1)} · ${marking.duration}`;
            const assignment = document.createElement('p');
            assignment.className = 'meta';
            assignment.textContent = `Projeto: ${marking.project ?? 'não informado'} · Atividade: ${marking.activity ?? 'não informada'}`;
            details.append(heading, assignment);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'channel-marking-delete';
            remove.textContent =
              deletingMarkingId === marking.id ? 'Excluindo…' : 'Excluir';
            remove.disabled =
              !marking.canDelete ||
              requestPending ||
              state?.inFlight !== undefined;
            remove.setAttribute(
              'aria-label',
              `Excluir marcação ${marking.duration} de ${item.date} no Channel`,
            );
            if (!marking.canDelete)
              remove.title = 'O Channel não permite excluir esta marcação.';
            remove.addEventListener(
              'click',
              () => void deleteChannelMarking(item.id, marking.id),
            );
            existing.append(details, remove);
            return existing;
          }),
        );
        body.append(markings);
      }
      if (
        item.status === 'divergent' &&
        item.editingBalanceMinutes === undefined &&
        item.result === undefined &&
        hasPositiveChannelBalance(item)
      ) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'edit-divergent';
        edit.textContent = 'Editar';
        edit.disabled =
          requestPending ||
          state?.inFlight !== undefined ||
          state?.phase !== 'preview';
        edit.setAttribute(
          'aria-label',
          `Editar saldo restante de ${item.date}`,
        );
        edit.addEventListener(
          'click',
          () =>
            void act({
              type: 'EDIT_DIVERGENT_ITEM',
              operationId: operationId(),
              itemId: item.id,
            }),
        );
        body.append(edit);
      }
      if (!itemIsEditable(item) || item.result !== undefined) {
        row.classList.add('readonly');
        row.append(body);
        return row;
      }
      const tags = [...(state?.config?.tags ?? [])].sort((left, right) =>
        left.id === state?.config?.defaultTagId
          ? -1
          : right.id === state?.config?.defaultTagId
            ? 1
            : left.name.localeCompare(right.name, 'pt-BR'),
      );
      const allocations = item.allocations ?? [];
      const editable =
        !requestPending &&
        state?.inFlight === undefined &&
        state?.phase === 'preview';
      const templateApplication = createTemplateApplicationEditor(
        item,
        editable,
      );
      const allocationList = document.createElement('div');
      allocationList.className = 'allocation-list';
      allocationList.setAttribute(
        'aria-label',
        `Marcações de ${formatBrazilianDate(item.date)}`,
      );
      allocationList.append(
        ...allocations.map((allocation, index) => {
          const marking = document.createElement('fieldset');
          marking.className = 'allocation';
          const legend = document.createElement('legend');
          legend.textContent = `Marcação ${String(index + 1)}`;
          if (allocation.isRemainder) {
            const remainder = document.createElement('span');
            remainder.className = 'remainder-badge';
            remainder.textContent =
              index === 0 ? 'Total do dia' : 'Saldo restante';
            legend.append(' ', remainder);
          }

          const selectedRagItem = findRagItem(
            allocation.ragCatalogId,
            allocation.ragItemId,
          );

          const sourceLabel = document.createElement('label');
          sourceLabel.textContent = 'Origem da marcação';
          const sourceSelect = document.createElement('select');
          sourceSelect.className = 'allocation-source-select';
          sourceSelect.append(new Option('Minhas TAGs', 'tags'));
          sourceSelect.append(
            ...ragCatalogs.map(
              (catalog) => new Option(catalog.name, catalog.id),
            ),
          );
          sourceSelect.value = allocation.ragCatalogId ?? 'tags';
          sourceSelect.disabled = !editable;
          sourceSelect.setAttribute(
            'aria-label',
            `Origem da marcação ${String(index + 1)} para ${item.date}`,
          );
          sourceSelect.addEventListener('change', () => {
            if (sourceSelect.value === 'tags') {
              const tagId =
                allocation.tagId ?? state?.config?.defaultTagId ?? tags[0]?.id;
              if (tagId)
                void act({
                  type: 'SET_ALLOCATION_TAG',
                  operationId: operationId(),
                  itemId: item.id,
                  allocationId: allocation.id,
                  tagId,
                  useTagSource: true,
                });
              return;
            }
            const catalog = ragCatalogs.find(
              (candidate) => candidate.id === sourceSelect.value,
            );
            const first = catalog?.items.find(
              (candidate) => candidate.kind !== 'SKIP',
            );
            if (catalog && first)
              void act({
                type: 'SET_ALLOCATION_RAG',
                operationId: operationId(),
                itemId: item.id,
                allocationId: allocation.id,
                catalogId: catalog.id,
                ragItemId: first.id,
              });
          });
          sourceLabel.append(sourceSelect);

          const ragPicker = document.createElement('div');
          ragPicker.className = 'rag-picker';
          const selectedCatalog = ragCatalogs.find(
            (catalog) => catalog.id === allocation.ragCatalogId,
          );
          if (selectedCatalog) {
            ragPicker.append(
              createRagItemCombobox({
                catalog: selectedCatalog,
                selectedItemId: allocation.ragItemId,
                disabled: !editable,
                id: `allocation-rag-${item.id}-${allocation.id}`,
                ariaLabel: `marcação ${String(index + 1)} para ${item.date}`,
                onSelect: (ragItemId) =>
                  void act({
                    type: 'SET_ALLOCATION_RAG',
                    operationId: operationId(),
                    itemId: item.id,
                    allocationId: allocation.id,
                    catalogId: selectedCatalog.id,
                    ragItemId,
                  }),
              }),
            );
          }

          const needsTag =
            !selectedRagItem ||
            (selectedRagItem.kind === 'PROJECT' &&
              (selectedRagItem.channel.projectSource === 'TAG' ||
                selectedRagItem.channel.activitySource === 'TAG'));
          const tagLabel = document.createElement('label');
          tagLabel.textContent = selectedRagItem
            ? 'TAG que fornece projeto/atividade'
            : 'TAG';
          const tagSelect = document.createElement('select');
          tagSelect.className = 'allocation-tag-select';
          tagSelect.setAttribute(
            'aria-label',
            `TAG da marcação ${String(index + 1)} para ${item.date}`,
          );
          if (tags.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'Nenhuma TAG configurada';
            tagSelect.append(option);
          } else {
            tagSelect.append(
              ...tags.map((tag) => {
                const option = document.createElement('option');
                option.value = tag.id;
                option.textContent = `${tag.name} — ${tag.project} · ${tag.activity}`;
                option.selected =
                  tag.id === (allocation.tagId ?? state?.config?.defaultTagId);
                return option;
              }),
            );
          }
          tagSelect.disabled = !editable || tags.length === 0;
          tagSelect.addEventListener(
            'change',
            () =>
              void act({
                type: 'SET_ALLOCATION_TAG',
                operationId: operationId(),
                itemId: item.id,
                allocationId: allocation.id,
                tagId: tagSelect.value,
              }),
          );
          tagLabel.append(tagSelect);

          const destination = document.createElement('p');
          destination.className = 'allocation-destination';
          destination.textContent = ragDestinationLabel(
            selectedRagItem,
            tags.find(
              (tag) =>
                tag.id === (allocation.tagId ?? state?.config?.defaultTagId),
            ),
          );

          const amountGroup = document.createElement('div');
          amountGroup.className = 'allocation-amount';
          const calendarLocked = allocation.provenance?.kind === 'calendar';
          const modeControl = document.createElement('div');
          modeControl.className = 'allocation-mode-control';
          modeControl.setAttribute('role', 'radiogroup');
          const modeTitle = document.createElement('span');
          modeTitle.className = 'allocation-mode-title';
          modeTitle.id = `allocation-mode-title-${allocation.id}`;
          modeTitle.textContent = 'Dividir por';
          modeControl.setAttribute('aria-labelledby', modeTitle.id);
          const modeOptions = document.createElement('div');
          modeOptions.className = 'allocation-mode-options';
          const modeRadios = (
            [
              ['percentage', 'Percentual'],
              ['duration', 'Duração'],
            ] as const
          ).map(([mode, label]) => {
            const option = document.createElement('label');
            option.className = 'allocation-mode-option';
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = `allocation-mode-${allocation.id}`;
            radio.value = mode;
            radio.checked = allocation.mode === mode;
            radio.disabled = !editable || calendarLocked;
            const text = document.createElement('span');
            text.textContent = label;
            option.append(radio, text);
            modeOptions.append(option);
            return radio;
          });
          modeControl.append(modeTitle, modeOptions);

          const valueLabel = document.createElement('label');
          valueLabel.textContent =
            allocation.mode === 'percentage'
              ? 'Percentual (%)'
              : 'Duração (HH:MM)';
          const valueInput = document.createElement('input');
          valueInput.value = allocation.value;
          valueInput.inputMode =
            allocation.mode === 'percentage' ? 'decimal' : 'numeric';
          valueInput.placeholder =
            allocation.mode === 'percentage' ? '100' : '08:00';
          valueInput.setAttribute(
            'aria-label',
            `${valueLabel.textContent} da marcação ${String(index + 1)} para ${item.date}`,
          );
          valueInput.disabled = !editable || calendarLocked;
          valueLabel.append(valueInput);

          const percentageMode = allocation.mode === 'percentage';
          const totalMinutes = parseDurationMinutes(
            itemAllocationDuration(item),
          );
          const otherExplicitMinutes = allocations.reduce(
            (total, candidate) =>
              candidate.id !== allocation.id && !candidate.isRemainder
                ? total + candidate.durationMinutes
                : total,
            0,
          );
          const availableDurationMinutes = Math.max(
            0,
            totalMinutes - otherExplicitMinutes,
          );
          const sliderMaximum = percentageMode ? 100 : availableDurationMinutes;
          const sliderValue = percentageMode
            ? Number(allocation.value)
            : allocation.durationMinutes;
          const valueSlider = document.createElement('input');
          const sliderEditor = document.createElement('div');
          sliderEditor.className = `allocation-value-slider ${percentageMode ? 'percentage' : 'duration'}`;
          valueSlider.type = 'range';
          valueSlider.min = '0';
          valueSlider.max = String(sliderMaximum);
          valueSlider.step = percentageMode ? '0.1' : '1';
          valueSlider.value = String(
            Number.isFinite(sliderValue)
              ? Math.min(sliderMaximum, Math.max(0, sliderValue))
              : 0,
          );
          valueSlider.disabled = !editable || calendarLocked;
          valueSlider.setAttribute(
            'aria-valuetext',
            percentageMode
              ? `${valueSlider.value}%`
              : formatDurationMinutes(Number(valueSlider.value)),
          );
          valueSlider.setAttribute(
            'aria-label',
            percentageMode
              ? `Ajustar percentual da marcação ${String(index + 1)} para ${item.date}`
              : `Ajustar duração da marcação ${String(index + 1)} para ${item.date}`,
          );
          const tickList = document.createElement('datalist');
          tickList.id = `allocation-value-ticks-${allocation.id}`;
          valueSlider.setAttribute('list', tickList.id);
          const sliderTicks = percentageMode
            ? Array.from({ length: 11 }, (_, index) => index * 10)
            : durationSliderTickValues(sliderMaximum);
          for (const value of sliderTicks) {
            const tick = document.createElement('option');
            tick.value = String(value);
            tickList.append(tick);
          }
          sliderEditor.append(valueSlider, tickList);
          if (percentageMode) {
            const tickMarks = document.createElement('div');
            tickMarks.className = 'allocation-slider-ticks';
            tickMarks.setAttribute('aria-hidden', 'true');
            tickMarks.append(
              ...sliderTicks.map(() => document.createElement('span')),
            );
            const scaleLabels = document.createElement('div');
            scaleLabels.className = 'allocation-slider-labels';
            scaleLabels.setAttribute('aria-hidden', 'true');
            for (const value of ['0%', '25%', '50%', '75%', '100%']) {
              const scaleLabel = document.createElement('span');
              scaleLabel.textContent = value;
              scaleLabels.append(scaleLabel);
            }
            sliderEditor.append(tickMarks, scaleLabels);
          } else {
            const durationScale = document.createElement('div');
            durationScale.className = 'allocation-duration-scale';
            durationScale.setAttribute('aria-hidden', 'true');
            for (const value of sliderTicks) {
              const tick = document.createElement('span');
              tick.className = 'allocation-duration-tick';
              tick.style.setProperty(
                '--tick-position',
                `${String(sliderMaximum > 0 ? (value * 100) / sliderMaximum : 0)}%`,
              );
              tick.textContent = formatDurationMinutes(value);
              durationScale.append(tick);
            }
            sliderEditor.append(durationScale);
          }

          const update = (
            mode: 'percentage' | 'duration',
            value: string,
          ): void => {
            void act({
              type: 'UPDATE_ALLOCATION',
              operationId: operationId(),
              itemId: item.id,
              allocationId: allocation.id,
              mode,
              value,
            });
          };
          for (const radio of modeRadios)
            radio.addEventListener('change', () => {
              if (!radio.checked) return;
              const mode = radio.value as 'percentage' | 'duration';
              update(
                mode,
                mode === 'percentage'
                  ? allocationPercentage(
                      allocation.durationMinutes,
                      itemAllocationDuration(item),
                    )
                  : allocation.duration,
              );
            });
          valueInput.addEventListener('change', () =>
            update(allocation.mode, valueInput.value.trim()),
          );
          valueInput.addEventListener('input', () => {
            try {
              const typedValue = percentageMode
                ? Number(valueInput.value)
                : parseDurationMinutes(valueInput.value.trim());
              if (Number.isFinite(typedValue))
                valueSlider.value = String(
                  Math.min(sliderMaximum, Math.max(0, typedValue)),
                );
              valueSlider.setAttribute(
                'aria-valuetext',
                percentageMode
                  ? `${valueSlider.value}%`
                  : formatDurationMinutes(Number(valueSlider.value)),
              );
            } catch {
              // Mantém o slider estável enquanto a duração digitada está incompleta.
            }
          });
          valueSlider.addEventListener('input', () => {
            valueInput.value = percentageMode
              ? valueSlider.value
              : formatDurationMinutes(Number(valueSlider.value));
            valueSlider.setAttribute(
              'aria-valuetext',
              percentageMode ? `${valueSlider.value}%` : valueInput.value,
            );
          });
          valueSlider.addEventListener('change', () =>
            update(allocation.mode, valueInput.value),
          );
          amountGroup.append(modeControl, valueLabel);
          amountGroup.append(sliderEditor);

          const effective = document.createElement('output');
          effective.className = 'allocation-effective';
          effective.setAttribute('role', 'status');
          effective.setAttribute('aria-atomic', 'true');
          effective.textContent = `${allocation.duration} · ${allocationPercentage(allocation.durationMinutes, itemAllocationDuration(item))}% ${item.editingBalanceMinutes === undefined ? 'do dia' : 'do saldo'}`;

          marking.append(legend, sourceLabel);
          if (selectedCatalog) marking.append(ragPicker);
          if (needsTag) marking.append(tagLabel);
          marking.append(destination, amountGroup, effective);
          if (allocation.provenance?.kind === 'calendar') {
            const origin = document.createElement('p');
            origin.className = 'allocation-provenance';
            const start = new Date(allocation.provenance.start);
            const end = new Date(allocation.provenance.end);
            origin.textContent = `${allocation.provenance.eventTitle} · ${start.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}–${end.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · Regra “${allocation.provenance.ruleName}” · encontrou ${allocation.provenance.matchedPhrases.map((phrase) => `“${phrase}”`).join(' e ')}`;
            marking.append(origin);
          }
          if (!allocation.isRemainder && allocations.length > 1) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'allocation-remove';
            remove.textContent = 'Remover marcação';
            remove.disabled = !editable;
            remove.addEventListener(
              'click',
              () =>
                void act({
                  type: 'REMOVE_ALLOCATION',
                  operationId: operationId(),
                  itemId: item.id,
                  allocationId: allocation.id,
                }),
            );
            marking.append(remove);
          }
          if (allocation.result) {
            const result = document.createElement('span');
            result.className = 'allocation-result';
            result.textContent = resultLabel(allocation.result);
            marking.append(result);
          }
          return marking;
        }),
      );
      const balance = document.createElement('output');
      balance.className = 'allocation-balance';
      balance.setAttribute('role', 'status');
      balance.setAttribute('aria-live', 'polite');
      balance.setAttribute('aria-atomic', 'true');
      const allocationDuration = itemAllocationDuration(item);
      balance.textContent = `${formatPortugueseQuantity(allocations.length, 'marcação', 'marcações')} · ${item.editingBalanceMinutes === undefined ? 'Total' : 'Saldo'} ${allocationDuration} · Distribuído ${allocationDuration} · Falta 00:00`;
      if (templateApplication) body.append(templateApplication);
      body.append(
        allocationList,
        balance,
        createTemplateSaveEditor(item, editable),
      );
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.decision === 'selected';
      checkbox.disabled =
        tags.length === 0 ||
        requestPending ||
        state?.inFlight !== undefined ||
        state?.phase !== 'preview';
      checkbox.setAttribute('aria-label', `Selecionar ${item.date}`);
      checkbox.addEventListener(
        'change',
        () =>
          void act({
            type: 'SET_ITEM_DECISION',
            operationId: operationId(),
            itemId: item.id,
            decision: checkbox.checked ? 'selected' : 'refused',
          }),
      );
      row.append(checkbox, body);
      return row;
    }),
  );
}

function createTemplateApplicationEditor(
  item: PublicOperationState['items'][number],
  editable: boolean,
): HTMLElement | undefined {
  if (settings.markingTemplates.length === 0) return undefined;
  const section = document.createElement('section');
  section.className = 'template-application';
  section.setAttribute(
    'aria-label',
    `Aplicar template em ${formatBrazilianDate(item.date)}`,
  );
  const heading = document.createElement('strong');
  heading.textContent = 'Usar um template salvo';
  const controls = document.createElement('div');
  controls.className = 'template-application-controls';
  const templateLabel = document.createElement('label');
  templateLabel.textContent = 'Template';
  const templateSelect = document.createElement('select');
  templateSelect.append(
    ...settings.markingTemplates.map(
      (template) => new Option(template.name, template.id),
    ),
  );
  if (
    item.appliedTemplateIds?.[0] &&
    settings.markingTemplates.some(
      (template) => template.id === item.appliedTemplateIds?.[0],
    )
  )
    templateSelect.value = item.appliedTemplateIds[0];
  templateSelect.disabled = !editable;
  templateLabel.append(templateSelect);
  const basisLabel = document.createElement('label');
  basisLabel.textContent = 'Aplicar usando';
  const basisSelect = document.createElement('select');
  basisSelect.append(
    new Option('Percentuais (adaptar ao dia)', 'percentage'),
    new Option('Horas originais', 'duration'),
  );
  basisSelect.disabled = !editable;
  basisLabel.append(basisSelect);
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.textContent = 'Aplicar';
  apply.disabled = !editable;
  const feedback = document.createElement('p');
  feedback.className = 'template-overflow';
  feedback.hidden = true;
  const updateFeedback = (): void => {
    const template = settings.markingTemplates.find(
      (candidate) => candidate.id === templateSelect.value,
    );
    if (!template) return;
    const dayMinutes = parseDurationMinutes(itemAllocationDuration(item));
    const originalMinutes = totalTemplateDuration(template);
    const overflow =
      basisSelect.value === 'duration' && originalMinutes > dayMinutes;
    const remainder =
      basisSelect.value === 'duration' && originalMinutes < dayMinutes;
    feedback.hidden = !overflow && !remainder;
    feedback.textContent = overflow
      ? `As horas originais excedem o dia em ${formatDurationMinutes(originalMinutes - dayMinutes)}. Ao aplicar, as marcações serão reduzidas proporcionalmente para caber.`
      : remainder
        ? `As horas originais deixam ${formatDurationMinutes(dayMinutes - originalMinutes)} livres; esse saldo será criado com a TAG padrão.`
        : '';
    apply.textContent = overflow ? 'Ajustar e aplicar' : 'Aplicar';
  };
  templateSelect.addEventListener('change', updateFeedback);
  basisSelect.addEventListener('change', updateFeedback);
  apply.addEventListener('click', () => {
    const template = settings.markingTemplates.find(
      (candidate) => candidate.id === templateSelect.value,
    );
    if (!template) return;
    const dayMinutes = parseDurationMinutes(itemAllocationDuration(item));
    const overflow =
      basisSelect.value === 'duration' &&
      totalTemplateDuration(template) > dayMinutes;
    void act({
      type: 'APPLY_MARKING_TEMPLATE',
      operationId: operationId(),
      itemId: item.id,
      template,
      basis: basisSelect.value === 'duration' ? 'duration' : 'percentage',
      overflowStrategy: overflow ? 'scale' : 'reject',
    });
  });
  controls.append(templateLabel, basisLabel, apply);
  section.append(heading, controls, feedback);
  updateFeedback();
  return section;
}

function createTemplateSaveEditor(
  item: PublicOperationState['items'][number],
  editable: boolean,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'template-save';
  if (templateSaveEditorItemId !== item.id) {
    const actions = document.createElement('div');
    actions.className = 'item-editor-actions';
    const sendDay = document.createElement('button');
    sendDay.type = 'button';
    sendDay.className = 'primary';
    sendDay.textContent = 'Enviar este dia';
    sendDay.disabled = !editable || (item.allocations?.length ?? 0) === 0;
    sendDay.setAttribute(
      'aria-label',
      `Enviar marcações de ${item.date} ao Channel`,
    );
    sendDay.addEventListener(
      'click',
      () =>
        void act({
          type: 'APPLY_ITEM',
          operationId: operationId(),
          itemId: item.id,
        }),
    );
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'Salvar como template…';
    open.disabled = !editable || (item.allocations?.length ?? 0) === 0;
    open.setAttribute(
      'aria-label',
      `Salvar marcações de ${item.date} como template`,
    );
    open.addEventListener('click', () => {
      templateSaveEditorItemId = item.id;
      render();
    });
    actions.append(sendDay, open);
    section.append(actions);
    return section;
  }
  const help = document.createElement('p');
  help.className = 'hint';
  help.textContent =
    'Serão salvos os percentuais e as horas atuais de todas as marcações deste dia.';
  const controls = document.createElement('div');
  controls.className = 'template-save-controls';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Nome do template';
  const name = document.createElement('input');
  name.maxLength = 80;
  name.value = `Distribuição de ${formatBrazilianDate(item.date)}`;
  nameLabel.append(name);
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary';
  save.textContent = 'Salvar template';
  save.disabled = !editable;
  save.addEventListener(
    'click',
    () => void saveMarkingTemplate(item, name.value),
  );
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancelar';
  cancel.addEventListener('click', () => {
    templateSaveEditorItemId = undefined;
    render();
  });
  controls.append(nameLabel, save, cancel);
  section.append(help, controls);
  return section;
}

async function saveMarkingTemplate(
  item: PublicOperationState['items'][number],
  name: string,
): Promise<void> {
  try {
    if (
      settings.markingTemplates.some(
        (template) =>
          template.name.toLocaleLowerCase('pt-BR') ===
          name.trim().toLocaleLowerCase('pt-BR'),
      )
    )
      throw new Error('Já existe um template com este nome.');
    const template = createMarkingTemplate(
      crypto.randomUUID(),
      name,
      itemAllocationDuration(item),
      item.allocations ?? [],
      new Date().toISOString(),
    );
    settings = {
      ...settings,
      markingTemplates: [...settings.markingTemplates, template],
    };
    await saveExtensionSettings(settings);
    templateSaveEditorItemId = undefined;
    templateManagerMessage = `Template ${template.name} salvo com percentuais e horas originais.`;
    render();
  } catch (error) {
    transientMessage =
      error instanceof Error
        ? error.message
        : 'Não foi possível salvar o template.';
    render();
  }
}

async function deleteChannelMarking(
  itemId: string,
  markingId: string,
): Promise<void> {
  deletingMarkingId = markingId;
  render();
  try {
    await act({
      type: 'DELETE_CHANNEL_MARKING',
      operationId: operationId(),
      itemId,
      markingId,
    });
  } finally {
    deletingMarkingId = undefined;
    render();
  }
}

function normalizeUiSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ')
    .trim();
}

function ragItemChoiceLabel(item: RagItem): string {
  const kind =
    item.kind === 'PROJECT'
      ? 'Projeto'
      : item.kind === 'AD_HOC'
        ? 'Avulso'
        : 'Não apontar';
  return `${item.event} — ${kind}`;
}

function createRagItemCombobox(options: {
  readonly catalog: RagCatalog;
  readonly selectedItemId: string | undefined;
  readonly disabled: boolean;
  readonly id: string;
  readonly ariaLabel: string;
  readonly onSelect: (itemId: string) => void;
}): HTMLElement {
  const field = document.createElement('div');
  field.className = 'allocation-rag-field';
  const label = document.createElement('span');
  label.className = 'allocation-rag-label';
  label.id = `${options.id}-label`;
  label.textContent = 'Marcação';

  const combobox = document.createElement('div');
  combobox.className = 'allocation-rag-combobox';
  const control = document.createElement('div');
  control.className = 'allocation-rag-control';
  const input = document.createElement('input');
  input.id = `${options.id}-input`;
  input.type = 'search';
  input.placeholder = 'Selecione ou digite para filtrar';
  input.autocomplete = 'off';
  input.disabled = options.disabled;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', `${options.id}-listbox`);
  input.setAttribute('aria-labelledby', label.id);
  input.setAttribute('aria-label', options.ariaLabel);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'allocation-rag-toggle';
  toggle.textContent = '▾';
  toggle.disabled = options.disabled;
  toggle.setAttribute('aria-label', `Abrir opções de ${options.ariaLabel}`);
  toggle.setAttribute('aria-controls', `${options.id}-listbox`);
  toggle.setAttribute('aria-expanded', 'false');

  const listbox = document.createElement('div');
  listbox.id = `${options.id}-listbox`;
  listbox.className = 'allocation-rag-listbox';
  listbox.setAttribute('role', 'listbox');
  listbox.setAttribute('aria-labelledby', label.id);
  listbox.hidden = true;

  const selectedItem = options.catalog.items.find(
    (item) => item.id === options.selectedItemId,
  );
  input.value = selectedItem ? ragItemChoiceLabel(selectedItem) : '';
  let activeIndex = -1;
  let visibleItems: RagItem[] = [];

  const close = (restoreSelection: boolean): void => {
    listbox.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    toggle.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
    if (restoreSelection)
      input.value = selectedItem ? ragItemChoiceLabel(selectedItem) : '';
  };

  const choose = (item: RagItem): void => {
    if (item.kind === 'SKIP') return;
    input.value = ragItemChoiceLabel(item);
    close(false);
    if (item.id !== options.selectedItemId) options.onSelect(item.id);
  };

  const setActive = (nextIndex: number, direction: 1 | -1): void => {
    const choices = [
      ...listbox.querySelectorAll<HTMLElement>('[role="option"]'),
    ];
    for (const choice of choices) choice.classList.remove('active');
    if (visibleItems.length === 0) {
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    let candidate = nextIndex;
    for (let checked = 0; checked < visibleItems.length; checked += 1) {
      candidate = (candidate + visibleItems.length) % visibleItems.length;
      if (visibleItems[candidate]?.kind !== 'SKIP') break;
      candidate += direction;
    }
    const active = choices[candidate];
    if (!active || visibleItems[candidate]?.kind === 'SKIP') return;
    activeIndex = candidate;
    active.classList.add('active');
    input.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  };

  const renderOptions = (query: string): void => {
    const normalizedQuery = normalizeUiSearch(query);
    visibleItems = options.catalog.items.filter((item) =>
      normalizeUiSearch(
        `${item.group} ${item.event} ${JSON.stringify(item.channel)}`,
      ).includes(normalizedQuery),
    );
    listbox.replaceChildren();
    if (visibleItems.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'allocation-rag-empty';
      empty.textContent = 'Nenhum item encontrado.';
      listbox.append(empty);
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    let previousGroup = '';
    for (const [index, item] of visibleItems.entries()) {
      if (item.group !== previousGroup) {
        const group = document.createElement('p');
        group.className = 'allocation-rag-group';
        group.textContent = item.group;
        listbox.append(group);
        previousGroup = item.group;
      }
      const choice = document.createElement('button');
      choice.id = `${options.id}-option-${String(index)}`;
      choice.type = 'button';
      choice.className = 'allocation-rag-option';
      choice.setAttribute('role', 'option');
      choice.setAttribute(
        'aria-selected',
        String(item.id === options.selectedItemId),
      );
      choice.disabled = item.kind === 'SKIP';
      const name = document.createElement('span');
      name.textContent = ragItemChoiceLabel(item);
      choice.append(name);
      choice.addEventListener('pointerdown', (event) => event.preventDefault());
      choice.addEventListener('click', () => choose(item));
      listbox.append(choice);
    }
    activeIndex = -1;
    input.removeAttribute('aria-activedescendant');
  };

  const open = (query = ''): void => {
    if (options.disabled) return;
    renderOptions(query);
    listbox.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-expanded', 'true');
  };

  input.addEventListener('focus', () => {
    open();
    input.select();
  });
  input.addEventListener('input', () => open(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      if (event.key === 'Enter' && !listbox.hidden && activeIndex >= 0) {
        event.preventDefault();
        const activeItem = visibleItems[activeIndex];
        if (activeItem) choose(activeItem);
      }
      return;
    }
    event.preventDefault();
    if (listbox.hidden) open();
    setActive(
      activeIndex < 0
        ? event.key === 'ArrowDown'
          ? 0
          : visibleItems.length - 1
        : activeIndex + (event.key === 'ArrowDown' ? 1 : -1),
      event.key === 'ArrowDown' ? 1 : -1,
    );
  });
  toggle.addEventListener('click', () => {
    if (listbox.hidden) {
      input.focus();
      open();
    } else close(true);
  });
  combobox.addEventListener('focusout', () => {
    globalThis.requestAnimationFrame(() => {
      if (!combobox.contains(document.activeElement)) close(true);
    });
  });

  control.append(input, toggle);
  combobox.append(control, listbox);
  field.append(label, combobox);
  return field;
}

function appendRagOptions(
  select: HTMLSelectElement,
  catalog: RagCatalog,
  normalizedQuery: string,
  selectedId: string | undefined,
): void {
  const matching = catalog.items.filter((item) => {
    if (item.id === selectedId) return true;
    if (!normalizedQuery) return true;
    return normalizeUiSearch(
      `${item.group} ${item.event} ${JSON.stringify(item.channel)}`,
    ).includes(normalizedQuery);
  });
  const groups = new Map<string, RagItem[]>();
  for (const item of matching) {
    const values = groups.get(item.group) ?? [];
    values.push(item);
    groups.set(item.group, values);
  }
  for (const [group, items] of groups) {
    const optionGroup = document.createElement('optgroup');
    optionGroup.label = group;
    for (const item of items) {
      const option = new Option(
        `${item.event} — ${item.kind === 'PROJECT' ? 'Projeto' : item.kind === 'AD_HOC' ? 'Avulso' : 'Não apontar'}`,
        item.id,
      );
      option.disabled = item.kind === 'SKIP';
      option.selected = item.id === selectedId;
      optionGroup.append(option);
    }
    select.append(optionGroup);
  }
  if (matching.length === 0)
    select.append(new Option('Nenhum item encontrado', '', true, true));
}

function ragDestinationLabel(
  item: RagItem | undefined,
  tag: ChannelTag | undefined,
): string {
  if (!item)
    return tag
      ? `Destino: Projeto · ${tag.project} · ${tag.activity}`
      : 'Destino: selecione uma TAG válida.';
  if (item.kind === 'SKIP') return 'Destino: não apontar no Channel.';
  if (item.kind === 'AD_HOC')
    return `Destino: Avulso · ${item.channel.client} · ${item.channel.operationNature} · ${item.channel.activityType}`;
  return `Destino: Projeto · ${item.channel.project ?? tag?.project ?? 'TAG pendente'} · ${item.channel.activity ?? tag?.activity ?? 'TAG pendente'}`;
}

function allocationPercentage(minutes: number, totalDuration: string): string {
  const [hours = '0', minutePart = '0'] = totalDuration.split(':');
  const totalMinutes = Number(hours) * 60 + Number(minutePart);
  return totalMinutes > 0
    ? String(Number(((minutes * 100) / totalMinutes).toFixed(2)))
    : '0';
}

function durationSliderTickValues(maximumMinutes: number): readonly number[] {
  if (maximumMinutes <= 0) return [0];
  const intervals = [10, 30, 60, 120, 240, 480] as const;
  const interval =
    intervals.find(
      (candidate) => Math.ceil(maximumMinutes / candidate) <= 10,
    ) ?? 960;
  const values: number[] = [];
  for (let value = 0; value < maximumMinutes; value += interval)
    values.push(value);
  const previous = values.at(-1);
  if (
    previous !== undefined &&
    previous > 0 &&
    maximumMinutes - previous < interval * 0.6
  )
    values.pop();
  values.push(maximumMinutes);
  return values;
}

function itemIsEditable(item: PublicOperationState['items'][number]): boolean {
  return item.status === 'missing' || item.editingBalanceMinutes !== undefined;
}

function itemAllocationDuration(
  item: PublicOperationState['items'][number],
): string {
  return item.editingBalanceMinutes === undefined
    ? item.ahgoraDuration
    : formatDurationMinutes(item.editingBalanceMinutes);
}

function hasPositiveChannelBalance(
  item: PublicOperationState['items'][number],
): boolean {
  if (item.channelDuration === undefined) return false;
  try {
    return (
      parseDurationMinutes(item.ahgoraDuration) >
      parseDurationMinutes(item.channelDuration)
    );
  } catch {
    return false;
  }
}

function itemVisualClass(item: PublicOperationState['items'][number]): string {
  if (item.editingBalanceMinutes !== undefined) return 'status-updatable';
  if (item.status === 'divergent') return 'status-divergent';
  if (
    item.status === 'blocked' ||
    item.result === 'failed' ||
    item.result === 'not-found' ||
    item.result === 'validation-error'
  )
    return 'status-error';
  if (
    item.status === 'equal' ||
    item.result === 'filled' ||
    item.result === 'already-correct'
  )
    return 'status-success';
  if (item.result === undefined) return 'status-updatable';
  return 'status-neutral';
}

function phaseLabel(phase: PublicOperationState['phase']): string {
  return (
    {
      setup: 'Registre as duas abas e configure a operação.',
      capturing: 'Capturando e comparando…',
      preview:
        'Prévia pronta. Revise os templates aplicados e os itens selecionados.',
      'dry-run': 'Dry-run concluído. Nenhuma página foi alterada.',
      'waiting-review': 'Apontamento confirmado pelo Channel.',
      partial:
        'Fila parcial. Revise o resultado e avance quando o formulário estiver pronto.',
      completed: 'Fila enviada e confirmada pelo Channel.',
      cancelled: 'Operação cancelada. Resultados anteriores foram preservados.',
      failed:
        'A operação falhou. Revise a mensagem e registre novamente a aba se necessário.',
    } satisfies Record<PublicOperationState['phase'], string>
  )[phase];
}
function statusLabel(status: string): string {
  return (
    (
      {
        missing: 'Novo',
        equal: 'Já igual',
        divergent: 'Divergente — não será alterado',
        blocked: 'Bloqueado',
      } as Record<string, string>
    )[status] ?? status
  );
}
function resultLabel(result: string): string {
  return (
    (
      {
        filled: 'Enviado e confirmado',
        'already-correct': 'Já correto',
        skipped: 'Ignorado',
        'not-found': 'Não encontrado',
        'validation-error': 'Validação falhou',
        failed: 'Falhou',
      } as Record<string, string>
    )[result] ?? result
  );
}

async function act(message: IncomingMessage): Promise<void> {
  try {
    await send(message);
  } catch (error) {
    if (state?.message?.toLocaleLowerCase('pt-BR').includes('interrompid')) {
      transientMessage = undefined;
      render();
      return;
    }
    transientMessage =
      error instanceof Error ? error.message : 'Falha inesperada.';
    logPanelFailure(message.type, error);
    render();
  }
}

async function captureFromUi(): Promise<void> {
  try {
    await send({
      type: 'CAPTURE_AND_COMPARE',
      operationId: operationId(),
      config: readConfig(),
    });
    if (state?.sourceRows !== undefined && state.inFlight === undefined) {
      const reviewCard = byId<HTMLDetailsElement>('review-card');
      reviewCard.open = true;
      globalThis.requestAnimationFrame(() =>
        reviewCard
          .querySelector<HTMLElement>(':scope > summary')
          ?.focus({ preventScroll: true }),
      );
    }
  } catch (error) {
    if (state?.message?.toLocaleLowerCase('pt-BR').includes('interrompid')) {
      transientMessage = undefined;
      render();
      return;
    }
    transientMessage =
      error instanceof Error ? error.message : 'Configuração inválida.';
    logPanelFailure('CAPTURE_AND_COMPARE', error);
    render();
  }
}

function openManagementDialog(dialogId: string, titleId: string): void {
  const dialog = byId<HTMLDialogElement>(dialogId);
  if (dialog.open) return;
  dialog.showModal();
  globalThis.requestAnimationFrame(() => {
    byId<HTMLElement>(titleId).focus({ preventScroll: true });
  });
}

function closeManagementDialog(dialogId: string): void {
  const dialog = byId<HTMLDialogElement>(dialogId);
  if (dialog.open) dialog.close();
}

function openTagManagementDialog(): void {
  openManagementDialog('config-dialog', 'config-dialog-title');
  void fetchCatalog();
}

const workflowCards = [
  ...document.querySelectorAll<HTMLDetailsElement>(
    'details.workflow-card.collapsible-card',
  ),
];
const workflowStepLinks = [
  ...document.querySelectorAll<HTMLAnchorElement>(
    '.flow-overview a[aria-controls]',
  ),
];

function syncWorkflowStepLinks(): void {
  for (const link of workflowStepLinks) {
    const cardId = link.getAttribute('aria-controls');
    const card = cardId
      ? (document.getElementById(cardId) as HTMLDetailsElement | null)
      : null;
    link.setAttribute('aria-expanded', String(card?.open === true));
  }
}

for (const card of workflowCards) {
  card.addEventListener(
    'click',
    (event) => {
      if (!card.inert) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true },
  );
  card.addEventListener('toggle', () => {
    if (card.open && card.inert) {
      card.open = false;
      syncWorkflowStepLinks();
      return;
    }
    if (card.open) {
      for (const other of workflowCards) {
        if (other !== card) other.open = false;
      }
    }
    syncWorkflowStepLinks();
  });
}
for (const link of workflowStepLinks) {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    if (link.getAttribute('aria-disabled') === 'true') return;
    const cardId = link.getAttribute('aria-controls');
    const card = cardId
      ? (document.getElementById(cardId) as HTMLDetailsElement | null)
      : null;
    if (!card) return;
    for (const other of workflowCards) other.open = other === card;
    syncWorkflowStepLinks();
    globalThis.requestAnimationFrame(() => {
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      card
        .querySelector<HTMLElement>(':scope > summary')
        ?.focus({ preventScroll: true });
    });
  });
}
syncWorkflowStepLinks();

byId('new-operation').addEventListener('click', () => void startNewOperation());
byId('theme-toggle').addEventListener('click', () => void toggleTheme());
byId('open-help-dialog').addEventListener('click', () =>
  openManagementDialog('help-dialog', 'help-dialog-title'),
);
byId('open-settings-dialog').addEventListener('click', () =>
  openManagementDialog('settings-dialog', 'settings-dialog-title'),
);
byId('open-support-dialog').addEventListener('click', () =>
  openManagementDialog('support-dialog', 'support-dialog-title'),
);
byId('open-config-dialog').addEventListener('click', openTagManagementDialog);
byId('open-template-manager-dialog').addEventListener('click', () =>
  openManagementDialog(
    'template-manager-dialog',
    'template-manager-dialog-title',
  ),
);
byId('open-calendar-manager-dialog').addEventListener('click', () =>
  openManagementDialog(
    'calendar-manager-dialog',
    'calendar-manager-dialog-title',
  ),
);
byId('open-rag-catalog-manager-dialog').addEventListener('click', () =>
  openManagementDialog(
    'rag-catalog-manager-dialog',
    'rag-catalog-manager-dialog-title',
  ),
);
document
  .querySelectorAll<HTMLButtonElement>('[data-close-dialog]')
  .forEach((button) =>
    button.addEventListener('click', () => {
      const dialogId = button.dataset.closeDialog;
      if (
        dialogId === 'rag-catalog-manager-dialog' &&
        !confirmDiscardRagDraft()
      )
        return;
      if (dialogId !== undefined) {
        if (dialogId === 'rag-catalog-manager-dialog') clearRagEditor();
        closeManagementDialog(dialogId);
      }
    }),
  );
byId<HTMLDialogElement>('rag-catalog-manager-dialog').addEventListener(
  'cancel',
  (event) => {
    if (!confirmDiscardRagDraft()) event.preventDefault();
    else clearRagEditor();
  },
);
byId('fetch-catalog').addEventListener('click', () => void fetchCatalog());
byId('update-rag-catalog').addEventListener(
  'click',
  () => void updateRagCatalog(),
);
byId('restore-rag-catalogs').addEventListener(
  'click',
  () => void restoreRagCatalogs(),
);
byId('restore-rag-catalog').addEventListener(
  'click',
  () => void restoreSelectedRagCatalog(),
);
byId('export-rag-catalog').addEventListener('click', exportSelectedRagCatalog);
byId('apply-rag-import').addEventListener('click', () => void applyRagImport());
byId<HTMLSelectElement>('rag-update-source').addEventListener(
  'change',
  (event) => {
    const source = event.currentTarget as HTMLSelectElement;
    if (!confirmDiscardRagDraft()) {
      source.value = ragSelectedCatalogId;
      return;
    }
    clearRagEditor();
    ragSelectedCatalogId = source.value;
    ragDeleteTarget = undefined;
    ragImportPreview = undefined;
    byId<HTMLInputElement>('rag-update-file').value = '';
    ragUpdateMessage = '';
    render();
  },
);
for (const id of [
  'rag-item-search',
  'rag-item-kind-filter',
  'rag-item-state-filter',
] as const)
  byId(id).addEventListener('input', () => renderRagItems());
byId('create-rag-item').addEventListener('click', () => {
  if (confirmDiscardRagDraft()) openRagItemEditor();
});
byId('save-rag-item').addEventListener(
  'click',
  () => void saveRagItemFromEditor(),
);
byId('reassign-delete-rag-item').addEventListener(
  'click',
  () => void reassignAndDeleteRagItem(),
);
byId('cancel-delete-rag-item').addEventListener('click', () => {
  ragDeleteTarget = undefined;
  render();
});
byId('cancel-rag-item-edit').addEventListener('click', () => {
  if (!confirmDiscardRagDraft()) return;
  const editedItemId = editingRagItemId;
  clearRagEditor();
  render();
  restoreRagEditorOriginFocus(editedItemId);
});
for (const id of [
  'rag-item-group',
  'rag-item-event',
  'rag-item-kind',
  'rag-item-duration',
  'rag-item-comment',
  'rag-project-source',
  'rag-project',
  'rag-activity-source',
  'rag-activity',
  'rag-project-activity-type',
  'rag-task',
  'rag-client',
  'rag-operation-nature',
  'rag-ad-hoc-activity-type',
] as const)
  byId(id).addEventListener('input', renderRagItemEditor);
byId('rag-item-list').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    'button[data-rag-action]',
  );
  const card = button?.closest<HTMLElement>('[data-rag-item-id]');
  const catalog = selectedRagCatalog();
  const item = catalog?.items.find(
    (candidate) => candidate.id === card?.dataset.ragItemId,
  );
  if (!button || !catalog || !item) return;
  if (button.dataset.ragAction === 'edit') {
    if (confirmDiscardRagDraft()) openRagItemEditor(item);
    return;
  }
  if (button.dataset.ragAction === 'delete')
    void deleteSelectedRagItem(catalog, item);
  if (button.dataset.ragAction === 'restore')
    void restoreSelectedRagItem(catalog, item);
});
for (const id of ['rag-update-file', 'rag-import-mode'] as const)
  byId(id).addEventListener('change', () => {
    ragImportPreview = undefined;
    ragUpdateMessage = '';
    renderRagImportPreview();
  });
byId('tag-project').addEventListener('change', () => renderActivityOptions());
byId('tag-activity').addEventListener('change', () => renderAutomaticTagName());
byId('toggle-tag-rag-copy').addEventListener('click', () => {
  tagRagCopyOpen = !tagRagCopyOpen;
  renderTagRagCopyAssistant(false);
});
byId('apply-tag-rag-copy').addEventListener('click', () => applyTagRagCopy());
byId('save-tag').addEventListener('click', () => void saveTagFromEditor());
byId('cancel-tag-edit').addEventListener('click', () => cancelTagEditing());
byId('create-template').addEventListener('click', () => createTemplateEditor());
byId('add-template-entry').addEventListener('click', () =>
  addTemplateEntryRow(),
);
byId('template-source-duration').addEventListener(
  'input',
  updateTemplateEntryTotal,
);
byId('save-template').addEventListener(
  'click',
  () => void saveTemplateFromEditor(),
);
byId('cancel-template-edit').addEventListener('click', () =>
  cancelTemplateEditing(),
);
byId('add-rule-template').addEventListener('click', () =>
  addRuleTemplateShare(settings.markingTemplates[0]?.id, 0),
);
byId('save-rule').addEventListener('click', () => void saveTemplateRule());
byId('calendar-connect').addEventListener(
  'click',
  () => void connectCalendar(),
);
for (const id of [
  'login-calendar-access-tab',
  'login-calendar-access-oauth',
] as const)
  byId(id).addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    if (input.checked) void setCalendarAccessMode(input.value === 'tab');
  });
byId('save-calendar-rule').addEventListener(
  'click',
  () => void saveCalendarRule(),
);
byId('cancel-calendar-rule-edit').addEventListener('click', () =>
  cancelCalendarRuleEditing(),
);
document
  .querySelectorAll<HTMLInputElement>('input[name="rule-end"]')
  .forEach((input) => input.addEventListener('change', syncRuleEndControls));
byId('font-decrease').addEventListener('click', () => void adjustFont(-0.1));
byId('font-increase').addEventListener('click', () => void adjustFont(0.1));
byId('punch-alert-enabled').addEventListener(
  'change',
  (event) =>
    void togglePunchAlertMonitoring(
      (event.currentTarget as HTMLInputElement).checked,
    ),
);
byId('open-logins').addEventListener('click', () => void openLoginPages());
byId('reconnect-tabs').addEventListener('click', () => void openLoginPages());
for (const [id, action] of [
  ['stop-login', 'login'],
  ['stop-capture', 'capture'],
  ['stop-write', 'write'],
] as const)
  byId(id).addEventListener(
    'click',
    () =>
      void act({
        type: 'STOP_CURRENT_ACTION',
        operationId: operationId(),
        action,
      }),
  );
byId('register-source').addEventListener('click', () => void registerAhgora());
byId('register-target').addEventListener(
  'click',
  () =>
    void act({
      type: 'SET_PENDING_ROLE',
      operationId: operationId(),
      role: 'target',
    }),
);
byId('capture').addEventListener('click', () => void captureFromUi());
byId('select-remaining').addEventListener(
  'click',
  () => void act({ type: 'SELECT_REMAINING', operationId: operationId() }),
);
byId('apply').addEventListener(
  'click',
  () => void act({ type: 'APPLY_SELECTED', operationId: operationId() }),
);
byId('advance').addEventListener(
  'click',
  () => void act({ type: 'ADVANCE_QUEUE', operationId: operationId() }),
);
byId('cancel').addEventListener(
  'click',
  () => void act({ type: 'CANCEL_OPERATION', operationId: operationId() }),
);
byId<HTMLSelectElement>('period-kind').addEventListener('change', (event) => {
  const kind = (event.currentTarget as HTMLSelectElement).value;
  byId('month-field').hidden = kind !== 'month';
  byId('start-field').hidden = kind !== 'range';
  byId('end-field').hidden = kind !== 'range';
});
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'session') void refresh();
  if (area === 'local')
    void loadExtensionSettings().then((loaded) => {
      useSettings(loaded);
      render();
    });
});

async function fetchCatalog(): Promise<void> {
  if (catalogPending) return;
  catalogPending = true;
  tagEditorMessage = '';
  render();
  try {
    const response: UiResponse = await chrome.runtime.sendMessage({
      type: 'FETCH_CHANNEL_CATALOG',
      operationId: operationId(),
    });
    if (!response.ok) throw new Error(response.message ?? response.code);
    adoptState(response.state);
    useSettings(await loadExtensionSettings());
    tagEditorMessage = `${String(settings.catalog?.projects.length ?? 0)} projeto(s) disponíveis para criar TAGs.`;
    renderActivityOptions();
  } catch (error) {
    tagEditorMessage =
      error instanceof Error
        ? error.message
        : 'Não foi possível atualizar o catálogo.';
    logPanelFailure('FETCH_CHANNEL_CATALOG', error);
  } finally {
    catalogPending = false;
    render();
  }
}

async function updateRagCatalog(): Promise<void> {
  if (ragUpdatePending) return;
  const file = byId<HTMLInputElement>('rag-update-file').files?.[0];
  if (!file) {
    ragUpdateMessage = 'Escolha o arquivo CSV exportado da fonte RAG.';
    render();
    return;
  }
  ragUpdatePending = true;
  ragUpdateMessage = '';
  render();
  try {
    ragImportPreview = previewRagCatalogCsvImport(
      ragSelectedCatalogId,
      await file.text(),
      byId<HTMLSelectElement>('rag-import-mode').value as 'merge' | 'replace',
    );
    ragUpdateMessage = ragImportPreview.canApply
      ? 'Prévia pronta. Revise as contagens antes de aplicar.'
      : 'A prévia contém erros ou duplicados e não pode ser aplicada.';
  } catch (error) {
    ragImportPreview = undefined;
    ragUpdateMessage =
      error instanceof Error
        ? error.message
        : 'Não foi possível validar os apontamentos RAG.';
  } finally {
    ragUpdatePending = false;
    render();
  }
}

async function applyRagImport(): Promise<void> {
  const preview = ragImportPreview;
  if (!preview?.canApply || ragUpdatePending) return;
  if (!confirmDiscardRagDraft()) return;
  const current = ragCatalogs.find(({ id }) => id === preview.catalogId);
  const targets = disappearingTargets(
    current?.items ?? [],
    preview.catalog.items,
    preview.catalogId,
  );
  const nextSettings =
    preview.mode === 'replace'
      ? confirmDestructiveRagChange('Substituir esta fonte', targets)
      : settings;
  if (!nextSettings) return;
  ragUpdatePending = true;
  render();
  try {
    await runRagMutation(
      `${current?.name ?? preview.catalog.name}: ${String(preview.catalog.itemCount)} apontamento(s) importados.`,
      () => {
        const applied = applyRagCatalogCsvImport(preview);
        return { result: applied, settings: nextSettings };
      },
    );
    ragImportPreview = undefined;
    byId<HTMLInputElement>('rag-update-file').value = '';
    clearRagEditor();
  } catch (error) {
    ragUpdateMessage =
      error instanceof Error
        ? error.message
        : 'Não foi possível aplicar a importação RAG.';
  } finally {
    ragUpdatePending = false;
    render();
  }
}

function exportSelectedRagCatalog(): void {
  const catalog = selectedRagCatalog();
  if (!catalog) return;
  const blob = new Blob([exportRagCatalogCsv(catalog.id)], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${catalog.id}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
  ragUpdateMessage = `${catalog.name} exportado em CSV.`;
  render();
}

async function saveRagItemFromEditor(): Promise<void> {
  if (ragUpdatePending) return;
  const catalog = selectedRagCatalog();
  if (!catalog) return;
  ragUpdatePending = true;
  ragItemEditorMessage = '';
  const editedItemId = editingRagItemId;
  render();
  try {
    const input = ragItemInputFromEditor();
    await runRagMutation(
      editingRagItemId ? 'Item RAG atualizado.' : 'Item RAG criado.',
      () => {
        const previousItem = editingRagItemId
          ? findRagItem(catalog.id, editingRagItemId)
          : undefined;
        const snapshot = editingRagItemId
          ? editRagItem(catalog.id, editingRagItemId, input)
          : createRagItem(catalog.id, input);
        const savedItem = editingRagItemId
          ? findRagItem(catalog.id, editingRagItemId)
          : snapshot.items.at(-1);
        let nextSettings = settings;
        if (
          previousItem &&
          savedItem &&
          previousItem.event !== savedItem.event &&
          catalog.id === 'reunioes-rag'
        ) {
          nextSettings = {
            ...nextSettings,
            googleCalendar: {
              ...nextSettings.googleCalendar,
              rules: nextSettings.googleCalendar.rules.map((rule) =>
                renameUnmodifiedAutomaticRagRule(
                  rule,
                  previousItem,
                  savedItem.event,
                  nextSettings.defaultTagId,
                ),
              ),
            },
          };
        } else if (
          !editingRagItemId &&
          savedItem &&
          savedItem.kind !== 'SKIP' &&
          catalog.id === 'reunioes-rag' &&
          byId<HTMLInputElement>('rag-create-calendar-rule').checked
        ) {
          nextSettings = {
            ...nextSettings,
            googleCalendar: {
              ...nextSettings.googleCalendar,
              rules: [
                ...nextSettings.googleCalendar.rules,
                automaticRagRule(
                  catalog.id,
                  savedItem,
                  nextSettings.defaultTagId,
                ),
              ],
            },
          };
        }
        return { result: snapshot, settings: nextSettings };
      },
    );
    clearRagEditor();
    restoreRagEditorOriginFocus(editedItemId);
  } catch (error) {
    ragItemEditorMessage =
      error instanceof Error
        ? error.message
        : 'Não foi possível salvar o item.';
  } finally {
    ragUpdatePending = false;
    render();
  }
}

async function deleteSelectedRagItem(
  catalog: RagCatalog,
  item: RagItem,
): Promise<void> {
  const target = { catalogId: catalog.id, itemId: item.id };
  const references = countRagReferences(settings, [target]);
  if (references.total > 0) {
    ragDeleteTarget = target;
    render();
    byId<HTMLSelectElement>('rag-delete-replacement').focus();
    return;
  }
  if (
    !globalThis.confirm(
      `Excluir o item RAG “${item.event}” da fonte ${catalog.name}?`,
    )
  )
    return;
  ragUpdatePending = true;
  render();
  try {
    await runRagMutation('Item RAG excluído.', () => ({
      result: deleteRagItem(catalog.id, item.id),
    }));
  } catch (error) {
    ragUpdateMessage =
      error instanceof Error
        ? error.message
        : 'Não foi possível excluir o item.';
  } finally {
    ragUpdatePending = false;
    render();
  }
}

async function reassignAndDeleteRagItem(): Promise<void> {
  const target = ragDeleteTarget;
  if (!target || ragUpdatePending) return;
  const [encodedCatalogId, encodedItemId] = byId<HTMLSelectElement>(
    'rag-delete-replacement',
  ).value.split('|');
  const replacement = {
    catalogId: decodeURIComponent(encodedCatalogId ?? ''),
    itemId: decodeURIComponent(encodedItemId ?? ''),
  };
  const replacementItem = findRagItem(
    replacement.catalogId,
    replacement.itemId,
  );
  if (!replacementItem || replacementItem.kind === 'SKIP') return;
  ragUpdatePending = true;
  render();
  try {
    await runRagMutation(
      'Referências reatribuídas e item RAG excluído.',
      () => ({
        result: deleteRagItem(target.catalogId, target.itemId),
        settings: reassignRagReferences(settings, target, replacement),
      }),
    );
    ragDeleteTarget = undefined;
  } catch (error) {
    ragUpdateMessage =
      error instanceof Error
        ? error.message
        : 'Não foi possível reatribuir e excluir o item.';
  } finally {
    ragUpdatePending = false;
    render();
  }
}

async function restoreSelectedRagItem(
  catalog: RagCatalog,
  item: RagItem,
): Promise<void> {
  const targets =
    getRagItemState(catalog.id, item.id) === 'created'
      ? [{ catalogId: catalog.id, itemId: item.id }]
      : [];
  const nextSettings = confirmDestructiveRagChange(
    'Restaurar este item criado',
    targets,
  );
  if (!nextSettings) return;
  ragUpdatePending = true;
  render();
  try {
    await runRagMutation('Item RAG restaurado.', () => ({
      result: restoreRagItem(catalog.id, item.id),
      settings: nextSettings,
    }));
  } catch (error) {
    ragUpdateMessage =
      error instanceof Error
        ? error.message
        : 'Não foi possível restaurar o item.';
  } finally {
    ragUpdatePending = false;
    render();
  }
}

async function restoreSelectedRagCatalog(): Promise<void> {
  const catalog = selectedRagCatalog();
  if (!catalog) return;
  if (!confirmDiscardRagDraft()) return;
  const original = getOriginalRagCatalog(catalog.id);
  const targets = disappearingTargets(
    catalog.items,
    original.items,
    catalog.id,
  );
  const nextSettings = confirmDestructiveRagChange(
    `Restaurar a fonte ${catalog.name}`,
    targets,
  );
  if (!nextSettings) return;
  if (
    targets.length === 0 &&
    !globalThis.confirm(
      `Restaurar a fonte ${catalog.name} para os dados originais desta versão?`,
    )
  )
    return;
  ragUpdatePending = true;
  render();
  try {
    await runRagMutation(`${catalog.name} restaurada.`, () => ({
      result: restoreRagCatalog(catalog.id),
      settings: nextSettings,
    }));
    ragImportPreview = undefined;
    clearRagEditor();
  } finally {
    ragUpdatePending = false;
    render();
  }
}

async function restoreRagCatalogs(): Promise<void> {
  if (!confirmDiscardRagDraft()) return;
  const originals = new Map(
    getOriginalRagCatalogs().map((catalog) => [catalog.id, catalog]),
  );
  const targets = ragCatalogs.flatMap((catalog) =>
    disappearingTargets(
      catalog.items,
      originals.get(catalog.id)?.items ?? [],
      catalog.id,
    ),
  );
  const nextSettings = confirmDestructiveRagChange(
    'Restaurar todos os catálogos RAG',
    targets,
  );
  if (!nextSettings) return;
  if (
    targets.length === 0 &&
    !globalThis.confirm(
      'Restaurar todos os catálogos RAG originais desta versão da extensão?',
    )
  )
    return;
  ragUpdatePending = true;
  render();
  try {
    await runRagMutation('Catálogos RAG originais restaurados.', () => ({
      result: restoreAllRagCatalogs(),
      settings: nextSettings,
    }));
    ragImportPreview = undefined;
    clearRagEditor();
  } finally {
    ragUpdatePending = false;
    render();
  }
}

function tagEditorHasContent(): boolean {
  return (
    byId<HTMLSelectElement>('tag-project').value !== '' ||
    byId<HTMLSelectElement>('tag-activity').value !== '' ||
    !['', 'Nenhum'].includes(
      byId<HTMLInputElement>('activity-type').value.trim(),
    ) ||
    !['', 'Nenhum'].includes(byId<HTMLInputElement>('task').value.trim()) ||
    byId<HTMLTextAreaElement>('tag-comments').value.trim() !== ''
  );
}

function applyTagRagCopy(): void {
  const resolution = resolveTagRagCopySelection();
  if (!resolution.ok) {
    renderTagRagCopyPreview(resolution);
    return;
  }
  if (
    tagEditorHasContent() &&
    !globalThis.confirm(
      'Copiar este item substituirá projeto, atividade e opções avançadas já preenchidos. Continuar?',
    )
  )
    return;

  byId<HTMLSelectElement>('tag-project').value = resolution.project.id;
  renderActivityOptions();
  byId<HTMLSelectElement>('tag-activity').value = resolution.activity.id;
  renderAutomaticTagName();
  byId<HTMLInputElement>('activity-type').value =
    resolution.item.channel.activityType || 'Nenhum';
  byId<HTMLInputElement>('task').value =
    resolution.item.channel.task || 'Nenhum';
  byId<HTMLTextAreaElement>('tag-comments').value =
    resolution.item.comment ?? resolution.item.event;
  byId<HTMLDetailsElement>('tag-advanced-options').open = true;
  tagRagCopyOpen = false;
  tagEditorMessage = `Campos copiados de “${resolution.item.event}”. Revise antes de salvar.`;
  byId<HTMLOutputElement>('tag-editor-status').textContent = tagEditorMessage;
  renderTagRagCopyAssistant(false);
  byId<HTMLButtonElement>('save-tag').focus();
}

function clearTagEditorFields(): void {
  byId<HTMLInputElement>('tag-name').value = '';
  byId<HTMLSelectElement>('tag-project').value = '';
  byId<HTMLInputElement>('tag-default').checked = false;
  byId<HTMLInputElement>('activity-type').value = 'Nenhum';
  byId<HTMLInputElement>('task').value = 'Nenhum';
  byId<HTMLTextAreaElement>('tag-comments').value = '';
  byId<HTMLDetailsElement>('tag-advanced-options').open = false;
  tagRagCopyOpen = false;
  renderActivityOptions();
}

function editTag(tagId: string): void {
  const tag = settings.tags.find(({ id }) => id === tagId);
  const resolution = tag
    ? resolveChannelTagInCatalog(tag, settings.catalog)
    : undefined;
  if (!tag || !resolution) {
    tagEditorMessage =
      'Atualize o cache do Channel antes de editar esta TAG; o projeto ou a atividade não está mais disponível.';
    render();
    return;
  }

  editingTagId = tag.id;
  tagRagCopyOpen = false;
  tagEditorMessage = `Editando TAG ${tag.name}.`;
  render();
  byId<HTMLSelectElement>('tag-project').value = resolution.project.id;
  renderActivityOptions();
  byId<HTMLSelectElement>('tag-activity').value = resolution.activity.id;
  renderAutomaticTagName();
  byId<HTMLInputElement>('tag-default').checked =
    tag.id === settings.defaultTagId;
  byId<HTMLInputElement>('activity-type').value =
    tag.activityType?.trim() || 'Nenhum';
  byId<HTMLInputElement>('task').value = tag.task?.trim() || 'Nenhum';
  byId<HTMLTextAreaElement>('tag-comments').value = tag.comments ?? '';
  byId<HTMLDetailsElement>('tag-advanced-options').open = true;
  byId<HTMLSelectElement>('tag-project').focus();
}

function cancelTagEditing(): void {
  if (editingTagId === undefined) return;
  editingTagId = undefined;
  clearTagEditorFields();
  tagEditorMessage = 'Edição cancelada.';
  render();
  byId<HTMLSelectElement>('tag-project').focus();
}

async function saveTagFromEditor(): Promise<void> {
  try {
    const project = selectedCatalogProject();
    if (!project)
      throw new Error('Escolha um projeto disponível no cache do Channel.');
    const activityId = byId<HTMLSelectElement>('tag-activity').value;
    const activity = project.activities.find(
      (candidate) => candidate.id === activityId,
    );
    if (!activity) throw new Error('Escolha uma atividade permitida.');
    const name = `${project.label} — ${activity.label}`;
    if (
      settings.tags.some(
        (tag) =>
          tag.id !== editingTagId &&
          tag.name.toLocaleLowerCase('pt-BR') ===
            name.toLocaleLowerCase('pt-BR'),
      )
    )
      throw new Error('Já existe uma TAG para este projeto e atividade.');
    const tag: ChannelTag = {
      id: editingTagId ?? crypto.randomUUID(),
      name,
      projectId: project.id,
      project: project.label,
      activityId: activity.id,
      activity: activity.label,
      activityType:
        byId<HTMLInputElement>('activity-type').value.trim() || 'Nenhum',
      task: byId<HTMLInputElement>('task').value.trim() || 'Nenhum',
      comments: byId<HTMLTextAreaElement>('tag-comments').value.trim(),
    };
    const makeDefault =
      byId<HTMLInputElement>('tag-default').checked ||
      settings.tags.length === 0;
    const tags = editingTagId
      ? settings.tags.map((current) =>
          current.id === editingTagId ? tag : current,
        )
      : [...settings.tags, tag];
    const wasEditing = editingTagId !== undefined;
    settings = {
      ...settings,
      tags,
      ...(makeDefault ? { defaultTagId: tag.id } : {}),
      ...(makeDefault
        ? {
            googleCalendar: assignDefaultTagToContextualRagRules(
              settings.googleCalendar,
              tag.id,
            ),
          }
        : {}),
    };
    await saveExtensionSettings(settings);
    editingTagId = undefined;
    clearTagEditorFields();
    tagEditorMessage = wasEditing
      ? `TAG ${name} atualizada.`
      : `TAG ${name} salva.`;
    render();
  } catch (error) {
    tagEditorMessage =
      error instanceof Error ? error.message : 'Não foi possível salvar a TAG.';
    render();
  }
}

async function setDefaultTag(tagId: string): Promise<void> {
  settings = {
    ...settings,
    defaultTagId: tagId,
    googleCalendar: assignDefaultTagToContextualRagRules(
      settings.googleCalendar,
      tagId,
    ),
  };
  await saveExtensionSettings(settings);
  tagEditorMessage = 'TAG padrão atualizada.';
  render();
}

async function removeTag(tagId: string): Promise<void> {
  if (
    settings.markingTemplates.some((template) =>
      template.entries.some((entry) => entry.tagId === tagId),
    )
  ) {
    tagEditorMessage =
      'Esta TAG está sendo usada por um template. Exclua o template antes de remover a TAG.';
    render();
    return;
  }
  const calendarRules = settings.googleCalendar.rules.filter(
    (rule) => rule.tagId === tagId,
  );
  const contextualCalendarRules = calendarRules.filter(
    isContextualRagCalendarRule,
  );
  if (contextualCalendarRules.length !== calendarRules.length) {
    tagEditorMessage =
      'Esta TAG está sendo usada diretamente por uma regra do Google Calendar. Ajuste essa regra antes de remover a TAG.';
    render();
    return;
  }
  const tags = settings.tags.filter((tag) => tag.id !== tagId);
  const defaultTagId =
    settings.defaultTagId === tagId ? tags[0]?.id : settings.defaultTagId;
  const googleCalendar = reassignContextualRagRulesTag(
    settings.googleCalendar,
    tagId,
    defaultTagId,
  );
  const { defaultTagId: previousDefault, ...withoutDefault } = settings;
  void previousDefault;
  settings =
    defaultTagId === undefined
      ? { ...withoutDefault, tags, googleCalendar }
      : { ...withoutDefault, tags, defaultTagId, googleCalendar };
  await saveExtensionSettings(settings);
  if (editingTagId === tagId) {
    editingTagId = undefined;
    clearTagEditorFields();
  }
  tagEditorMessage =
    contextualCalendarRules.length === 0
      ? 'TAG excluída.'
      : defaultTagId === undefined
        ? `TAG excluída. ${String(contextualCalendarRules.length)} regra(s) contextual(is) do Google Calendar ficaram aguardando uma nova TAG padrão.`
        : `TAG excluída. ${String(contextualCalendarRules.length)} regra(s) contextual(is) do Google Calendar foram transferidas para a nova TAG padrão.`;
  render();
}

async function adjustFont(delta: number): Promise<void> {
  const fontScale = Math.min(
    1.4,
    Math.max(0.8, Math.round((settings.fontScale + delta) * 10) / 10),
  );
  settings = { ...settings, fontScale, fontScaleCustomized: true };
  await saveExtensionSettings(settings);
  render();
}

async function toggleTheme(): Promise<void> {
  settings = {
    ...settings,
    theme: settings.theme === 'dark' ? 'light' : 'dark',
  };
  await saveExtensionSettings(settings);
  render();
}

async function togglePunchAlertMonitoring(enabled: boolean): Promise<void> {
  if (punchAlertPending) return;
  const previousPunchAlerts = settings.punchAlerts;
  punchAlertPending = true;
  punchAlertMessage = enabled
    ? 'Ativando monitoramento…'
    : 'Desativando monitoramento…';
  settings = { ...settings, punchAlerts: { enabled } };
  render();
  try {
    if (enabled && !(await requestNotificationPermission())) {
      throw new Error(
        'Permita notificações para ativar o monitoramento do almoço.',
      );
    }
    await saveExtensionSettings(settings);
    punchAlertMessage = enabled
      ? 'Ativo: verificações às 12:30, 13:00, 13:30 e 14:00.'
      : 'Monitoramento do almoço desativado.';
  } catch (error: unknown) {
    settings = { ...settings, punchAlerts: previousPunchAlerts };
    punchAlertMessage =
      error instanceof Error ? error.message : 'Não foi possível alterar.';
  } finally {
    punchAlertPending = false;
    render();
  }
}

async function requestNotificationPermission(): Promise<boolean> {
  if (await chrome.permissions.contains({ permissions: ['notifications'] }))
    return true;
  return chrome.permissions.request({ permissions: ['notifications'] });
}

async function registerAhgora(): Promise<void> {
  try {
    await send({
      type: 'SET_PENDING_ROLE',
      operationId: operationId(),
      role: 'source',
    });
  } catch (error) {
    transientMessage =
      error instanceof Error
        ? error.message
        : 'Não foi possível solicitar acesso ao espelho Ahgora.';
    logPanelFailure('REGISTER_AHGORA', error);
    render();
  }
}

async function openLoginPages(): Promise<void> {
  if (loginPermissionPending) return;
  loginPermissionPending = true;
  calendarPending = true;
  render();
  let autoSubmit = false;
  let calendarAccessGranted = false;
  const tabMode = settings.googleCalendar.accessMode === 'tab';
  const calendarOrigin = tabMode
    ? GOOGLE_CALENDAR_WEB_ORIGIN
    : GOOGLE_CALENDAR_API_ORIGIN;
  try {
    await chrome.permissions.request({
      origins: [...LOGIN_PERMISSION_ORIGINS, calendarOrigin],
    });
    [autoSubmit, calendarAccessGranted] = await Promise.all([
      chrome.permissions.contains({ origins: [...LOGIN_PERMISSION_ORIGINS] }),
      chrome.permissions.contains({ origins: [calendarOrigin] }),
    ]);
  } catch (error: unknown) {
    logPanelFailure('REQUEST_LOGIN_PERMISSION', error);
  }
  if (calendarAccessGranted || tabMode) {
    try {
      await send({
        type: 'CONNECT_GOOGLE_CALENDAR',
        operationId: operationId(),
      });
      useSettings(await loadExtensionSettings());
    } catch (error: unknown) {
      calendarManagerMessage =
        error instanceof Error
          ? error.message
          : 'Não foi possível conectar o Google Calendar.';
      logPanelFailure('CONNECT_GOOGLE_CALENDAR', error);
    }
  }
  calendarPending = false;
  loginPermissionPending = false;
  await act({
    type: 'OPEN_LOGIN_PAGES',
    operationId: operationId(),
    autoSubmit,
  });
  useSettings(await loadExtensionSettings());
  render();
}

async function monitorLoginStatus(): Promise<void> {
  const preparation = state?.loginPreparation;
  const pending =
    preparation?.autoSubmit === true &&
    (preparation.ahgora === 'opening' ||
      preparation.ahgora === 'awaiting-user' ||
      preparation.ahgora === 'submitted' ||
      preparation.channel === 'opening' ||
      preparation.channel === 'awaiting-user' ||
      preparation.channel === 'submitted');
  if (
    !pending ||
    !state ||
    loginMonitorPending ||
    requestPending ||
    loginPermissionPending
  )
    return;
  loginMonitorPending = true;
  const monitoredOperationId = state.operationId;
  try {
    const response: UiResponse = await chrome.runtime.sendMessage({
      type: 'CHECK_LOGIN_STATUS',
      operationId: monitoredOperationId,
    });
    if (
      response.ok &&
      response.state.operationId === monitoredOperationId &&
      state.operationId === monitoredOperationId
    ) {
      if (adoptState(response.state)) render();
    }
  } catch (error: unknown) {
    logPanelFailure('CHECK_LOGIN_STATUS', error);
  } finally {
    loginMonitorPending = false;
  }
}

globalThis.setInterval(() => void monitorLoginStatus(), 1_500);

resetCapturePeriodToCurrentMonth();
byId<HTMLElement>('extension-version').textContent =
  `v${chrome.runtime.getManifest().version}`;
byId<HTMLInputElement>('rule-start').value = currentDateValue();
syncRuleEndControls();
void (async () => {
  useSettings(await loadExtensionSettings());
  await refresh().catch(() => undefined);
  if (state === undefined)
    await send({ type: 'START_OPERATION', operationId: crypto.randomUUID() });
  await discoverOpenTabs();
})();
