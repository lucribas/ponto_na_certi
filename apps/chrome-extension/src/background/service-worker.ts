import { loadOperationData, saveOperationData } from '../application/storage';
import { setRagCatalogOverrides } from '../application/rag';
import {
  loadExtensionSettings,
  resolveChannelTagInCatalog,
  saveExtensionSettings,
  type ChannelCatalog,
  type ChannelTag,
  type GoogleCalendarInfo,
} from '../application/settings';
import {
  evaluatePunchAlert,
  isLunchMonitoringTime,
} from '../application/punch-alerts';
import {
  emptyOperation,
  publicState,
  type CaptureProgress,
  type LoginPreparation,
  type LoginSiteStatus,
  type OperationData,
  type RegisteredTab,
  type TabConnectionIssue,
  type TabConnectionIssueReason,
  type TabRole,
  type WriteProgress,
} from '../application/types';
import { civilDate, rangePeriod, resolvePeriod, type Clock } from '../domain';
import notificationIconUrl from '../../assets/ponto_na_certi_logo.png?url';
import type { IncomingMessage, UiResponse } from '../messaging/messages';
import {
  assertCurrentOperation,
  assertExtensionSender,
  isIncomingMessage,
} from '../messaging/validation';
import { toSafeDiagnostic } from '../shared/diagnostics';
import { captureAhgora, ChromeSourceScriptRunner } from '../sites/source';
import {
  ChromeGoogleCalendarTabClient,
  ChromeGoogleCalendarClient,
  calendarCaptureEnabled,
  removeGoogleCalendarTabAccess,
} from '../sites/google-calendar';
import {
  executeChannelCatalog,
  executeChannelDelete,
  executeChannelFill,
  executeChannelRead,
} from '../sites/target';
import {
  EXISTING_LOGIN_TAB_AUTH_TIMEOUT_MS,
  LOGIN_PERMISSION_ORIGINS,
  LOGIN_SITES,
  isLoginSiteUrl,
  isLoginWorkPageUrl,
  probeLoginDocument,
  rankLoginTabCandidates,
  shouldOpenFreshLoginTab,
  submitAutofilledLogin,
  type LoginSiteDefinition,
} from '../sites/login';
import {
  advanceQueue,
  applyTemplateToItem,
  cancelOperation,
  captureAndCompareOperation,
  completeDryRun,
  decideItem,
  editDivergentItem,
  fillCurrentQueueItem,
  fillSelectedQueue,
  prepareItemQueue,
  prepareSelectedQueue,
  reconcileCompletedWrite,
  reconcileItemWrite,
  removeAllocation,
  setAllocationRag,
  setAllocationTag,
  selectItemTag,
  selectRemainingItems,
  updateAllocation,
  type CoordinatorAdapters,
} from './coordinator';
import {
  OperationBusyError,
  OperationDisplayError,
  OperationEffectLock,
  type OperationStateStore,
} from './operation-lock';
import { executeValidatedChannelFill } from './validated-write';
import {
  CancellationRegistry,
  createCancellationAwareHandler,
} from './cancellation';

class OperationalError extends Error {}

interface LoginTabSelection {
  readonly tab: chrome.tabs.Tab;
  readonly reusedExistingTab: boolean;
}

interface LoginSitePreparationResult {
  readonly tabId?: number;
  readonly status: LoginSiteStatus;
}

const effectLock = new OperationEffectLock();
const cancellationRegistry = new CancellationRegistry();
const googleCalendarClient = new ChromeGoogleCalendarClient();
const googleCalendarTabClient = new ChromeGoogleCalendarTabClient();
let loginProgressWrites: Promise<void> = Promise.resolve();
let tabLifecycleWrites: Promise<void> = Promise.resolve();
const activeLoginAttempts = new Set<number>();
const PUNCH_ALERT_ALARM = 'ahgora-punch-alert-check';
const PUNCH_ALERT_NOTIFICATION = 'ahgora-punch-alert';
const PUNCH_ALERT_STATE_KEY = 'punchAlertRuntimeState';
const OFFSCREEN_AUDIO_PATH = 'src/offscreen/audio.html';
let punchAlertCheckPending = false;
let creatingOffscreenDocument: Promise<void> | undefined;
let notificationListenersRegistered = false;
const operationStore: OperationStateStore = {
  load: loadOperationData,
  save: saveOperationData,
};
async function refreshRagCatalogs(): Promise<void> {
  const settings = await loadExtensionSettings();
  setRagCatalogOverrides(settings.ragCatalogOverrides);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.extensionSettings !== undefined)
    void refreshRagCatalogs();
});

async function configureSidePanel(): Promise<void> {
  // O listener da action precisa observar o gesto para registrar `activeTab`.
  // Ele próprio abre o painel; o comportamento automático poderia consumir o clique.
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
}

async function configureExtension(): Promise<void> {
  await configureSidePanel();
  await syncPunchAlertAlarm();
}

chrome.runtime.onInstalled.addListener(() => void configureExtension());
chrome.runtime.onStartup.addListener(() => void configureExtension());
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.extensionSettings !== undefined)
    void syncPunchAlertAlarm();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PUNCH_ALERT_ALARM)
    void checkPunchAlerts(new Date(alarm.scheduledTime));
});
registerNotificationListeners();
chrome.permissions.onAdded.addListener((permissions) => {
  if (permissions.permissions?.includes('notifications'))
    registerNotificationListeners();
});
void syncPunchAlertAlarm();

chrome.action.onClicked.addListener((tab) => {
  void registerGestureAndOpen(tab).catch(() => updateBadge('!'));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueueTabLifecycleUpdate(() => invalidateTab(tabId, 'closed'));
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url !== undefined) {
    enqueueTabLifecycleUpdate(() =>
      invalidateChangedOrigin(tabId, changeInfo.url ?? ''),
    );
  }
  if (changeInfo.url !== undefined || changeInfo.status === 'complete') {
    void resumePreparedLogin(tabId).catch((error: unknown) => {
      console.warn('[PontoNaCerti][LoginResume]', {
        status: 'failed',
        tabId,
        reason: error instanceof Error ? error.message : 'unknown-error',
      });
    });
  }
});

async function registerGestureAndOpen(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id !== undefined) await chrome.sidePanel.open({ tabId: tab.id });
  const state = await loadOperationData();
  if (
    state === undefined ||
    state.pendingRole === undefined ||
    tab.id === undefined ||
    tab.url === undefined
  )
    return;
  const origin = pageOrigin(tab.url);
  const binding: RegisteredTab = { id: tab.id, origin };
  const remainingIssues = clearTabConnectionIssues(state, [state.pendingRole]);
  const next: OperationData =
    state.pendingRole === 'source'
      ? {
          ...state,
          revision: state.revision + 1,
          sourceTab: binding,
          pendingRole: undefined,
          tabConnectionIssues: remainingIssues,
          message:
            'Aba Ahgora registrada. O acesso será revalidado na captura.',
        }
      : {
          ...state,
          revision: state.revision + 1,
          targetTab: binding,
          pendingRole: undefined,
          tabConnectionIssues: remainingIssues,
          message:
            'Aba Channel registrada. O acesso será revalidado na captura.',
        };
  await saveOperationData(next);
  console.info('[PontoNaCerti][TabRegistration]', {
    status: 'ok',
    role: state.pendingRole,
    tabId: tab.id,
    origin,
  });
  await updateBadge(next.sourceTab && next.targetTab ? '' : '1');
}

const handleMessage = createCancellationAwareHandler(
  cancellationRegistry,
  (sender: chrome.runtime.MessageSender) =>
    assertExtensionSender(sender, chrome.runtime.id),
  processMessage,
);

async function processMessage(message: IncomingMessage): Promise<UiResponse> {
  if (
    message.type === 'CAPTURE_AND_COMPARE' ||
    message.type === 'SET_ALLOCATION_RAG' ||
    message.type === 'APPLY_SELECTED' ||
    message.type === 'ADVANCE_QUEUE'
  )
    await refreshRagCatalogs();
  if (message.type === 'GET_STATE') {
    const state = await loadOperationData();
    return state ? success(state) : { ok: false, code: 'NO_ACTIVE_OPERATION' };
  }
  if (message.type === 'START_OPERATION') {
    const previous = await loadOperationData();
    const empty = emptyOperation(message.operationId);
    const connectionsReady = Boolean(previous?.sourceTab && previous.targetTab);
    const state: OperationData = connectionsReady
      ? {
          ...empty,
          sourceTab: previous?.sourceTab,
          targetTab: previous?.targetTab,
          loginPreparation: previous?.loginPreparation ?? {
            ahgora: 'ready',
            channel: 'ready',
            ahgoraDetail: 'Conexão preservada da operação anterior.',
            channelDetail: 'Conexão preservada da operação anterior.',
            autoSubmit: false,
          },
          message:
            'Nova operação iniciada com as conexões Ahgora e Channel preservadas.',
        }
      : empty;
    const preservedState: OperationData = previous?.calendarTab
      ? { ...state, calendarTab: previous.calendarTab }
      : state;
    await saveOperationData(preservedState);
    cancellationRegistry.resetAfterOperationStarted();
    return success(preservedState);
  }

  const state = await loadOperationData();
  if (state === undefined) return { ok: false, code: 'NO_ACTIVE_OPERATION' };
  assertCurrentOperation(message, state.operationId);

  if (message.type === 'STOP_CURRENT_ACTION') {
    const stopped = stopCurrentAction(state, message.action);
    await saveOperationData(stopped);
    return success(stopped);
  }

  if (message.type === 'CHECK_LOGIN_STATUS') {
    return success(await monitorPreparedLogins(state));
  }

  if (message.type === 'DISCOVER_OPEN_TABS') {
    return success(await discoverOpenAuthenticatedTabs(state));
  }

  if (message.type === 'TEST_PUNCH_ALERT') {
    if (message.checkAt !== undefined) {
      await checkPunchAlerts(new Date(message.checkAt));
      return success(state);
    }
    await showPunchAlertNotification(
      'Alerta de batidas ativado',
      'Este é um teste do som e da notificação do sistema operacional.',
      true,
    );
    return success(state);
  }

  if (message.type === 'FETCH_CHANNEL_CATALOG') {
    if (!state.targetTab)
      throw new OperationalError('Conecte a aba Channel antes de consultar.');
    await assertTabBinding(state.targetTab);
    const result = await executeChannelCatalog(state.targetTab.id);
    if (!result.ok)
      throw new OperationalError(
        `Não foi possível obter projetos e atividades do Channel: ${result.code}.`,
      );
    const catalog: ChannelCatalog = {
      fetchedAt: new Date().toISOString(),
      projects: result.projects,
    };
    const settings = await loadExtensionSettings();
    await saveExtensionSettings({ ...settings, catalog });
    const latest = await loadOperationData();
    if (
      latest?.operationId !== state.operationId ||
      latest.revision !== state.revision
    )
      throw new OperationalError('A operação mudou durante a consulta.');
    const committed: OperationData = {
      ...latest,
      revision: latest.revision + 1,
      message: `${String(catalog.projects.length)} projeto(s) e ${String(catalog.projects.reduce((total, project) => total + project.activities.length, 0))} atividade(s) armazenados no cache local.`,
    };
    await saveOperationData(committed);
    return success(committed, catalog);
  }

  if (message.type === 'CONNECT_GOOGLE_CALENDAR') {
    const settings = await loadExtensionSettings();
    const tabMode = settings.googleCalendar.accessMode === 'tab';
    let calendarTab = state.calendarTab;
    if (tabMode && calendarTab === undefined) {
      calendarTab = await findOpenGoogleCalendarTab();
      if (calendarTab === undefined) {
        const opened = await chrome.tabs.create({
          url: 'https://calendar.google.com/calendar/u/0/r',
          active: true,
        });
        if (opened.id === undefined || opened.url === undefined)
          throw new OperationalError(
            'Não foi possível abrir uma aba do Google Calendar.',
          );
        const waiting: OperationData = {
          ...state,
          revision: state.revision + 1,
          calendarTab: { id: opened.id, origin: pageOrigin(opened.url) },
          message:
            'Aba do Google Calendar aberta. Conclua o login e clique em Conectar pela aba novamente.',
        };
        await saveOperationData(waiting);
        return success(waiting);
      }
    }
    if (calendarTab) await assertTabBinding(calendarTab);
    let connected: {
      readonly email?: string;
      readonly calendars: readonly GoogleCalendarInfo[];
    };
    if (tabMode) {
      if (!calendarTab)
        throw new OperationalError(
          'Abra uma aba do Google Calendar e tente conectar novamente.',
        );
      connected = await googleCalendarTabClient.connect(calendarTab.id);
    } else {
      connected = await googleCalendarClient.connect();
    }
    await saveExtensionSettings({
      ...settings,
      googleCalendar: {
        ...settings.googleCalendar,
        accessMode: tabMode ? 'tab' : 'oauth',
        connected: true,
        calendars: connected.calendars,
        selectedCalendarIds:
          settings.googleCalendar.selectedCalendarIds.length > 0
            ? settings.googleCalendar.selectedCalendarIds.filter((id) =>
                connected.calendars.some((calendar) => calendar.id === id),
              )
            : connected.calendars.some((calendar) => calendar.primary)
              ? connected.calendars
                  .filter((calendar) => calendar.primary)
                  .map((calendar) => calendar.id)
              : connected.calendars.map((calendar) => calendar.id),
        ...(connected.email ? { accountEmail: connected.email } : {}),
        lastSyncedAt: new Date().toISOString(),
      },
    });
    const committed: OperationData = {
      ...state,
      revision: state.revision + 1,
      ...(calendarTab ? { calendarTab } : {}),
      message: `Google Calendar conectado ${tabMode ? 'pela aba autenticada' : 'via OAuth'} · ${String(connected.calendars.length)} calendário(s) disponível(is).`,
    };
    await saveOperationData(committed);
    return success(committed);
  }

  if (message.type === 'DISCONNECT_GOOGLE_CALENDAR') {
    const settings = await loadExtensionSettings();
    const tabMode = settings.googleCalendar.accessMode === 'tab';
    if (tabMode) await removeGoogleCalendarTabAccess();
    else await googleCalendarClient.disconnect();
    const {
      accountEmail: previousAccountEmail,
      lastSyncedAt: previousLastSyncedAt,
      ...calendarWithoutSession
    } = settings.googleCalendar;
    void previousAccountEmail;
    void previousLastSyncedAt;
    await saveExtensionSettings({
      ...settings,
      googleCalendar: {
        ...calendarWithoutSession,
        connected: false,
        calendars: [],
        selectedCalendarIds: [],
      },
    });
    const committed: OperationData = {
      ...state,
      revision: state.revision + 1,
      ...(tabMode ? { calendarTab: undefined } : {}),
      message: `Google Calendar desconectado. As regras locais foram preservadas${tabMode ? ' e a sessão da aba não foi alterada' : ''}.`,
    };
    await saveOperationData(committed);
    return success(committed);
  }

  if (message.type === 'OPEN_LOGIN_PAGES') {
    if (state.inFlight !== undefined)
      throw new OperationalError('Aguarde a ação atual terminar ou cancele.');
    cancellationRegistry.clear(state.operationId);
    return success(await openLoginPages(state, message.autoSubmit));
  }

  if (message.type === 'CANCEL_OPERATION') {
    const committed = {
      ...cancelOperation(state),
      revision: state.revision + 1,
    };
    await saveOperationData(committed);
    await updateBadge('!');
    return success(committed);
  }

  if (message.type === 'CAPTURE_AND_COMPARE') {
    const settings = await loadExtensionSettings();
    if (
      !state.sourceTab ||
      !state.targetTab ||
      !settings.googleCalendar.connected
    )
      throw new OperationalError(
        'Conecte Ahgora, Channel e Google Calendar antes de capturar e comparar.',
      );
    cancellationRegistry.clear(state.operationId);
    const prepared: OperationData = {
      ...state,
      config: message.config,
      phase: 'capturing',
      captureProgress: {
        ahgora: {
          status: 'running',
          detail: 'Preparando a consulta autenticada do Ahgora…',
        },
        channel: {
          status: 'running',
          detail: 'Preparando a consulta autenticada do Channel…',
        },
        calendar: calendarCaptureEnabled(message.config.googleCalendar)
          ? {
              status: 'running',
              detail: 'Preparando a consulta do Google Calendar…',
            }
          : {
              status: 'done',
              detail: 'Conexão Google Calendar desabilitada.',
            },
        comparison: {
          status: 'waiting',
          detail: 'Aguardando Ahgora, Channel e Google Calendar.',
        },
      },
      message:
        'Captura paralela iniciada. Acompanhe Ahgora, Channel e Google Calendar separadamente.',
    };
    return runEffect(prepared, 'capture', async (locked) => {
      await assertRegisteredTabs(locked);
      const captured = await captureAndCompareOperation(
        locked,
        coordinatorAdapters(
          (progress) => persistCaptureProgress(locked, progress),
          undefined,
          locked,
        ),
      );
      const result = await persistInferredDefaultTag(message.config, captured);
      await updateBadge(
        String(
          Math.min(
            result.items.filter((item) => item.status === 'missing').length,
            99,
          ),
        ),
      );
      return result;
    });
  }
  if (message.type === 'DELETE_CHANNEL_MARKING') {
    const item = state.items.find(
      (candidate) => candidate.id === message.itemId,
    );
    const marking = item?.channelMarkings?.find(
      (candidate) => candidate.id === message.markingId,
    );
    if (!item || !marking)
      throw new OperationalError(
        'A marcação não pertence mais à prévia. Capture e compare novamente.',
      );
    if (!marking.canDelete)
      throw new OperationalError(
        'O Channel não permite excluir esta marcação.',
      );
    const prepared: OperationData = {
      ...state,
      message: `Excluindo a marcação ${marking.duration} de ${formatDateForMessage(item.date)} no Channel…`,
    };
    return runEffect(prepared, 'delete', async (locked) => {
      await assertRegisteredTabs(locked);
      if (!locked.targetTab)
        throw new Error('A aba Channel não está registrada.');
      const deleted = await executeChannelDelete(locked.targetTab.id, {
        id: marking.id,
        date: item.date,
      });
      if (!deleted.ok)
        throw new Error(channelDeleteFailureMessage(deleted.code));
      let refreshed: OperationData;
      try {
        refreshed = await captureAndCompareOperation(
          locked,
          coordinatorAdapters(),
        );
      } catch {
        throw new Error(
          'A marcação foi excluída do Channel, mas não foi possível atualizar a prévia. Capture e compare novamente.',
        );
      }
      await updateBadge(
        String(
          Math.min(
            refreshed.items.filter(
              (candidate) => candidate.status === 'missing',
            ).length,
            99,
          ),
        ),
      );
      return {
        ...refreshed,
        message: `Marcação ${marking.duration} de ${formatDateForMessage(item.date)} excluída do Channel e prévia atualizada.`,
      };
    });
  }
  if (message.type === 'APPLY_SELECTED') {
    cancellationRegistry.clear(state.operationId);
    return runEffect(prepareSelectedQueue(state), 'apply', async (locked) => {
      await assertRegisteredTabs(locked);
      const written = await fillSelectedQueue(
        locked,
        coordinatorAdapters(undefined, (progressState, progress) =>
          persistWriteProgress(locked, progressState, progress),
        ),
      );
      const result =
        written.phase === 'completed'
          ? await reconcileCompletedWrite(written, coordinatorAdapters())
          : written;
      await updateQueueBadge(result);
      return result;
    });
  }
  if (message.type === 'APPLY_ITEM') {
    cancellationRegistry.clear(state.operationId);
    return runEffect(
      prepareItemQueue(state, message.itemId),
      'apply',
      async (locked) => {
        await assertRegisteredTabs(locked);
        const written = await fillSelectedQueue(
          locked,
          coordinatorAdapters(undefined, (progressState, progress) =>
            persistWriteProgress(locked, progressState, progress),
          ),
        );
        const result =
          written.phase === 'completed'
            ? await reconcileItemWrite(
                written,
                message.itemId,
                coordinatorAdapters(),
              )
            : written;
        await updateQueueBadge(result);
        return result;
      },
    );
  }
  if (message.type === 'ADVANCE_QUEUE') {
    return runEffect(advanceQueue(state), 'advance', async (locked) => {
      await assertRegisteredTabs(locked);
      const result = await fillCurrentQueueItem(locked, coordinatorAdapters());
      await updateQueueBadge(result);
      return result;
    });
  }
  if (state.inFlight !== undefined) {
    throw new OperationalError('Aguarde a ação atual terminar ou cancele.');
  }

  let next: OperationData;
  switch (message.type) {
    case 'SET_PENDING_ROLE':
    case 'REGISTER_ACTIVE_TAB':
      next = {
        ...state,
        pendingRole: message.role,
        message: `Vá até a aba ${message.role === 'source' ? 'Ahgora' : 'Channel'} e clique no ícone da extensão.`,
      };
      break;
    case 'SET_ITEM_DECISION':
      next = decideItem(state, message.itemId, message.decision);
      break;
    case 'EDIT_DIVERGENT_ITEM':
      next = editDivergentItem(state, message.itemId);
      break;
    case 'SET_ITEM_TAG':
      next = selectItemTag(state, message.itemId, message.tagId);
      break;
    case 'SET_ALLOCATION_TAG':
      next = setAllocationTag(
        state,
        message.itemId,
        message.allocationId,
        message.tagId,
        message.useTagSource,
      );
      break;
    case 'SET_ALLOCATION_RAG':
      next = setAllocationRag(
        state,
        message.itemId,
        message.allocationId,
        message.catalogId,
        message.ragItemId,
      );
      break;
    case 'UPDATE_ALLOCATION':
      next = updateAllocation(
        state,
        message.itemId,
        message.allocationId,
        message.mode,
        message.value,
      );
      break;
    case 'REMOVE_ALLOCATION':
      next = removeAllocation(state, message.itemId, message.allocationId);
      break;
    case 'APPLY_MARKING_TEMPLATE':
      next = applyTemplateToItem(
        state,
        message.itemId,
        message.template,
        message.basis,
        message.overflowStrategy,
      );
      break;
    case 'SELECT_REMAINING':
      next = selectRemainingItems(state);
      break;
    case 'RUN_DRY_RUN':
      next = completeDryRun(state);
      await updateBadge('✓');
      break;
    case 'CAPTURE_SOURCE':
    case 'SHOW_PREVIEW':
      return { ok: false, code: 'LEGACY_COMMAND_NOT_AVAILABLE' };
  }
  const current = await loadOperationData();
  if (
    current?.operationId !== state.operationId ||
    current.revision !== state.revision
  ) {
    throw new OperationalError(
      'A operação mudou enquanto esta ação era executada; o resultado antigo foi descartado.',
    );
  }
  const committed = { ...next, revision: state.revision + 1 };
  await saveOperationData(committed);
  return success(committed);
}

async function persistInferredDefaultTag(
  requestedConfig: NonNullable<OperationData['config']>,
  captured: OperationData,
): Promise<OperationData> {
  const capturedConfig = captured.config;
  const defaultTagId = capturedConfig?.defaultTagId;
  if (!capturedConfig || defaultTagId === undefined) return captured;
  const inferredDefault = !requestedConfig.tags?.some(
    (tag) => tag.id === defaultTagId,
  );
  const inferred = capturedConfig.tags?.find((tag) => tag.id === defaultTagId);
  if (!inferred) return captured;

  const settings = await loadExtensionSettings();
  const repairedSettingsTags = settings.tags.map((tag) =>
    enrichTagFromCatalog(tag, settings.catalog),
  );
  const operationTags = (capturedConfig.tags ?? []).map((candidate) =>
    enrichTagFromCatalog(candidate, settings.catalog),
  );
  const resolvedDefault = operationTags.find(
    (candidate) => candidate.id === defaultTagId,
  );
  const tags = inferredDefault
    ? [
        ...repairedSettingsTags.filter(
          (candidate) => candidate.id !== defaultTagId,
        ),
        ...(resolvedDefault ? [resolvedDefault] : []),
      ]
    : repairedSettingsTags;
  await saveExtensionSettings({
    ...settings,
    tags,
    ...(inferredDefault ? { defaultTagId } : {}),
    googleCalendar: capturedConfig.googleCalendar ?? settings.googleCalendar,
  });
  return {
    ...captured,
    config: { ...capturedConfig, tags: operationTags },
  };
}

function enrichTagFromCatalog(
  tag: ChannelTag,
  catalog?: ChannelCatalog,
): ChannelTag {
  const resolution = resolveChannelTagInCatalog(tag, catalog);
  if (!resolution) return tag;
  return {
    ...tag,
    projectId: resolution.project.id,
    project: resolution.project.label,
    activityId: resolution.activity.id,
    activity: resolution.activity.label,
    name: `${resolution.project.label} — ${resolution.activity.label}`,
  };
}

function formatDateForMessage(date: string): string {
  const [year, month, day] = date.split('-');
  return year && month && day ? `${day}/${month}/${year}` : date;
}

function channelDeleteFailureMessage(code: string): string {
  return (
    (
      {
        'login-required': 'Conclua o login do Channel e tente novamente.',
        'marking-not-found':
          'A marcação não existe mais no Channel. Capture e compare novamente.',
        'marking-delete-not-permitted':
          'O Channel não permite excluir esta marcação.',
        'delete-not-confirmed':
          'O Channel recebeu a exclusão, mas ainda mantém a marcação. Capture e compare antes de tentar novamente.',
        'channel-participant-unavailable':
          'O Channel não informou o participante necessário para confirmar a exclusão.',
        'channel-delete-api-unavailable':
          'A API de exclusão não está disponível na aba Channel registrada.',
      } as Readonly<Record<string, string>>
    )[code] ?? `Não foi possível excluir a marcação no Channel: ${code}.`
  );
}

async function discoverOpenAuthenticatedTabs(
  state: OperationData,
): Promise<OperationData> {
  if (state.sourceTab && state.targetTab) return state;
  const permissionGranted = await chrome.permissions.contains({
    origins: [...LOGIN_PERMISSION_ORIGINS],
  });
  if (!permissionGranted) return state;

  const [discoveredSource, discoveredTarget] = await Promise.all([
    state.sourceTab
      ? Promise.resolve(undefined)
      : findAuthenticatedWorkTab(LOGIN_SITES[0]),
    state.targetTab
      ? Promise.resolve(undefined)
      : findAuthenticatedWorkTab(LOGIN_SITES[1]),
  ]);
  if (!discoveredSource && !discoveredTarget) return state;

  const latest = await loadOperationData();
  if (latest?.operationId !== state.operationId)
    throw new OperationalError('A operação foi substituída.');
  const sourceTab = latest.sourceTab ?? discoveredSource;
  const targetTab = latest.targetTab ?? discoveredTarget;
  const discoveredRoles = [
    ...(!latest.sourceTab && discoveredSource ? (['source'] as const) : []),
    ...(!latest.targetTab && discoveredTarget ? (['target'] as const) : []),
  ] satisfies readonly TabRole[];
  if (discoveredRoles.length === 0) return latest;

  const previous = latest.loginPreparation;
  const loginPreparation: LoginPreparation = {
    ahgora: sourceTab ? 'ready' : (previous?.ahgora ?? 'idle'),
    channel: targetTab ? 'ready' : (previous?.channel ?? 'idle'),
    ahgoraDetail: sourceTab
      ? 'Aba do Ahgora já aberta e autenticada; conexão automática concluída.'
      : (previous?.ahgoraDetail ?? 'A página do Ahgora ainda não foi aberta.'),
    channelDetail: targetTab
      ? 'Aba do Channel já aberta e autenticada; conexão automática concluída.'
      : (previous?.channelDetail ??
        'A página do Channel ainda não foi aberta.'),
    autoSubmit: true,
    permissionDenied: false,
    ...(sourceTab === undefined ? {} : { sourceTabId: sourceTab.id }),
    ...(targetTab === undefined ? {} : { targetTabId: targetTab.id }),
  };
  const next: OperationData = {
    ...latest,
    revision: latest.revision + 1,
    ...(sourceTab === undefined ? {} : { sourceTab }),
    ...(targetTab === undefined ? {} : { targetTab }),
    loginPreparation,
    tabConnectionIssues: clearTabConnectionIssues(latest, discoveredRoles),
    message:
      sourceTab && targetTab
        ? 'Abas já abertas do Ahgora e Channel detectadas e conectadas automaticamente.'
        : `A aba já aberta do ${sourceTab ? 'Ahgora' : 'Channel'} foi detectada e conectada automaticamente.`,
  };
  await saveOperationData(next);
  await updateBadge(sourceTab && targetTab ? '' : '1');
  console.info('[PontoNaCerti][OpenTabDiscovery]', {
    status: sourceTab && targetTab ? 'complete' : 'partial',
    sourceTabId: discoveredSource?.id,
    targetTabId: discoveredTarget?.id,
  });
  return next;
}

async function findOpenGoogleCalendarTab(): Promise<RegisteredTab | undefined> {
  const tabs = await chrome.tabs.query({
    url: ['https://calendar.google.com/*'],
  });
  const candidate = [...tabs]
    .filter(
      (tab): tab is chrome.tabs.Tab & { id: number; url: string } =>
        tab.id !== undefined && tab.url !== undefined,
    )
    .sort(
      (left, right) =>
        Number(right.active) - Number(left.active) ||
        right.lastAccessed - left.lastAccessed,
    )[0];
  return candidate
    ? { id: candidate.id, origin: pageOrigin(candidate.url) }
    : undefined;
}

async function findAuthenticatedWorkTab(
  site: LoginSiteDefinition,
): Promise<RegisteredTab | undefined> {
  const candidates = rankLoginTabCandidates(
    await chrome.tabs.query({ url: [...site.tabPatterns] }),
    site,
  );
  for (const tab of candidates) {
    if (
      tab.id === undefined ||
      tab.url === undefined ||
      !isLoginWorkPageUrl(site, tab.url)
    )
      continue;
    try {
      const [probe] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: probeLoginDocument,
        args: [site.formSelector, site.workSelector],
      });
      if (
        probe?.result?.ready &&
        !probe.result.formVisible &&
        (probe.result.workMarkerPresent || tab.status === 'complete')
      )
        return { id: tab.id, origin: pageOrigin(tab.url) };
    } catch {
      // Outra candidata ainda pode estar carregada e autenticada.
    }
  }
  return undefined;
}

async function openLoginPages(
  state: OperationData,
  autoSubmit: boolean,
): Promise<OperationData> {
  assertActionNotStopped(state.operationId);
  let current = await commitLoginPreparation(
    state,
    {
      ahgora: 'opening',
      channel: 'opening',
      ahgoraDetail: 'Abrindo ou reutilizando a página de login do Ahgora…',
      channelDetail: 'Abrindo ou reutilizando a página de login do Channel…',
      autoSubmit,
      permissionDenied: !autoSubmit,
      ...(state.loginPreparation?.sourceTabId === undefined
        ? {}
        : { sourceTabId: state.loginPreparation.sourceTabId }),
      ...(state.loginPreparation?.targetTabId === undefined
        ? {}
        : { targetTabId: state.loginPreparation.targetTabId }),
    },
    'Abrindo as páginas de autenticação…',
  );
  const [sourceResult, targetResult] = await Promise.allSettled([
    getOrCreateLoginTab(state.loginPreparation?.sourceTabId, LOGIN_SITES[0]),
    getOrCreateLoginTab(state.loginPreparation?.targetTabId, LOGIN_SITES[1]),
  ] as const);
  const sourceSelection =
    sourceResult.status === 'fulfilled' ? sourceResult.value : undefined;
  const targetSelection =
    targetResult.status === 'fulfilled' ? targetResult.value : undefined;
  const sourceTabId = sourceSelection?.tab.id;
  const targetTabId = targetSelection?.tab.id;
  assertActionNotStopped(state.operationId);
  current = await commitLoginPreparation(
    current,
    {
      ahgora: sourceTabId === undefined ? 'failed' : 'awaiting-user',
      channel: targetTabId === undefined ? 'failed' : 'awaiting-user',
      ahgoraDetail:
        sourceTabId === undefined
          ? 'Não foi possível abrir a página do Ahgora.'
          : autoSubmit
            ? sourceSelection?.reusedExistingTab
              ? 'Aba existente encontrada; aguardando autenticação por até 10 segundos…'
              : 'Nova aba aberta; aguardando o formulário e o preenchimento automático…'
            : 'Permissão recusada. Faça login manualmente ou tente concedê-la novamente.',
      channelDetail:
        targetTabId === undefined
          ? 'Não foi possível abrir a página do Channel.'
          : autoSubmit
            ? targetSelection?.reusedExistingTab
              ? 'Aba existente encontrada; aguardando autenticação por até 10 segundos…'
              : 'Nova aba aberta; aguardando o formulário e o preenchimento automático…'
            : 'Permissão recusada. Faça login manualmente ou tente concedê-la novamente.',
      autoSubmit,
      permissionDenied: !autoSubmit,
      ...(sourceTabId === undefined ? {} : { sourceTabId }),
      ...(targetTabId === undefined ? {} : { targetTabId }),
    },
    autoSubmit
      ? 'Páginas abertas. Aguardando o preenchimento automático para tentar o login…'
      : 'A permissão foi recusada. Ela é necessária para detectar e concluir os logins automaticamente; conceda-a na nova tentativa ou faça o processo manual.',
  );
  if (!autoSubmit) return current;
  assertActionNotStopped(state.operationId);

  const [sourcePreparation, targetPreparation] = await Promise.all([
    sourceSelection === undefined
      ? Promise.resolve<LoginSitePreparationResult>({ status: 'failed' })
      : authenticateLoginTab(
          LOGIN_SITES[0],
          sourceSelection,
          state.operationId,
        ),
    targetSelection === undefined
      ? Promise.resolve<LoginSitePreparationResult>({ status: 'failed' })
      : authenticateLoginTab(
          LOGIN_SITES[1],
          targetSelection,
          state.operationId,
        ),
  ]);
  assertActionNotStopped(state.operationId);
  const ahgora = sourcePreparation.status;
  const channel = targetPreparation.status;
  const preparedSourceTabId = sourcePreparation.tabId;
  const preparedTargetTabId = targetPreparation.tabId;
  const ready = ahgora === 'ready' && channel === 'ready';
  const latestProgress = await loadOperationData();
  const latestPreparation =
    latestProgress?.operationId === state.operationId
      ? latestProgress.loginPreparation
      : undefined;
  const prepared = await commitLoginPreparation(
    current,
    {
      ahgora,
      channel,
      ahgoraDetail:
        latestPreparation?.ahgoraDetail ?? loginDetail('Ahgora', ahgora),
      channelDetail:
        latestPreparation?.channelDetail ?? loginDetail('Channel', channel),
      autoSubmit,
      permissionDenied: false,
      ...(preparedSourceTabId === undefined
        ? {}
        : { sourceTabId: preparedSourceTabId }),
      ...(preparedTargetTabId === undefined
        ? {}
        : { targetTabId: preparedTargetTabId }),
    },
    ready
      ? 'Logins detectados e páginas de trabalho abertas. Conectando as abas automaticamente…'
      : 'Uma ou mais sessões ainda não foram confirmadas. Conclua o login indicado e tente novamente.',
  );
  return registerPreparedTabs(prepared);
}

async function registerPreparedTabs(
  state: OperationData,
): Promise<OperationData> {
  assertActionNotStopped(state.operationId);
  const preparation = state.loginPreparation;
  if (!preparation?.autoSubmit) return state;
  const permissionGranted = await chrome.permissions.contains({
    origins: [...LOGIN_PERMISSION_ORIGINS],
  });
  if (!permissionGranted) return state;
  const sourceTab =
    preparation.ahgora === 'ready' && preparation.sourceTabId !== undefined
      ? {
          id: preparation.sourceTabId,
          origin: new URL(LOGIN_SITES[0].destinationUrl).origin,
        }
      : undefined;
  const targetTab =
    preparation.channel === 'ready' && preparation.targetTabId !== undefined
      ? {
          id: preparation.targetTabId,
          origin: new URL(LOGIN_SITES[1].destinationUrl).origin,
        }
      : undefined;
  if (!sourceTab && !targetTab) return state;
  const latest = await loadOperationData();
  if (latest?.operationId !== state.operationId)
    throw new OperationalError('A operação foi substituída.');
  const next: OperationData = {
    ...latest,
    revision: latest.revision + 1,
    ...(sourceTab === undefined ? {} : { sourceTab }),
    ...(targetTab === undefined ? {} : { targetTab }),
    tabConnectionIssues: clearTabConnectionIssues(latest, [
      ...(sourceTab === undefined ? [] : (['source'] as const)),
      ...(targetTab === undefined ? [] : (['target'] as const)),
    ]),
    message:
      sourceTab && targetTab
        ? 'Logins e registro automático concluídos. Configure a operação.'
        : 'Uma aba foi registrada automaticamente. Use o registro manual somente na aba pendente.',
  };
  await saveOperationData(next);
  console.info('[PontoNaCerti][AutomaticTabRegistration]', {
    status: sourceTab && targetTab ? 'complete' : 'partial',
    sourceRegistered: sourceTab !== undefined,
    targetRegistered: targetTab !== undefined,
  });
  await updateBadge(sourceTab && targetTab ? '' : '1');
  return next;
}

async function commitLoginPreparation(
  expected: OperationData,
  loginPreparation: LoginPreparation,
  message: string,
): Promise<OperationData> {
  assertActionNotStopped(expected.operationId);
  const latest = await loadOperationData();
  if (latest?.operationId !== expected.operationId)
    throw new OperationalError('A operação foi substituída.');
  const next: OperationData = {
    ...latest,
    revision: latest.revision + 1,
    loginPreparation,
    message,
  };
  await saveOperationData(next);
  return next;
}

async function authenticateLoginTab(
  site: LoginSiteDefinition,
  selection: LoginTabSelection,
  operationId: string,
): Promise<LoginSitePreparationResult> {
  const tabId = selection.tab.id;
  if (tabId === undefined) return { status: 'failed' };
  const status = await attemptAutomaticLogin(
    site,
    tabId,
    operationId,
    selection.reusedExistingTab
      ? EXISTING_LOGIN_TAB_AUTH_TIMEOUT_MS
      : undefined,
  );
  if (!shouldOpenFreshLoginTab(selection.reusedExistingTab, status === 'ready'))
    return { tabId, status };

  assertActionNotStopped(operationId);
  await reportLoginProgress(
    operationId,
    site.role,
    'opening',
    'A sessão da aba existente não foi confirmada em 10 segundos; abrindo uma nova aba…',
  );
  try {
    const freshTab = await chrome.tabs.create({ url: site.loginUrl });
    if (freshTab.id === undefined) {
      await reportLoginProgress(
        operationId,
        site.role,
        'failed',
        'A aba existente expirou e não foi possível abrir uma nova aba.',
      );
      return { tabId, status: 'failed' };
    }
    await reportLoginProgress(
      operationId,
      site.role,
      'opening',
      'Nova aba aberta após a sessão anterior não responder; aguardando autenticação…',
      freshTab.id,
    );
    return {
      tabId: freshTab.id,
      status: await attemptAutomaticLogin(site, freshTab.id, operationId),
    };
  } catch (error: unknown) {
    console.warn('[PontoNaCerti][LoginPreparation]', {
      status: 'fresh-tab-failed',
      role: site.role,
      code: error instanceof Error ? error.name : 'UnknownError',
    });
    await reportLoginProgress(
      operationId,
      site.role,
      'failed',
      'A aba existente expirou e não foi possível abrir uma nova aba.',
    );
    return { tabId, status: 'failed' };
  }
}

async function attemptAutomaticLogin(
  site: LoginSiteDefinition,
  tabId: number,
  operationId: string,
  totalTimeoutMs?: number,
): Promise<LoginSiteStatus> {
  assertActionNotStopped(operationId);
  if (activeLoginAttempts.has(tabId)) return 'submitted';
  activeLoginAttempts.add(tabId);
  const deadline =
    totalTimeoutMs === undefined ? undefined : Date.now() + totalTimeoutMs;
  try {
    await reportLoginProgress(
      operationId,
      site.role,
      'opening',
      'Carregando o formulário e aguardando o preenchimento automático…',
    );
    await waitForTabReady(tabId, loginStageTimeout(deadline, 15_000));
    assertActionNotStopped(operationId);
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: submitAutofilledLogin,
      args: [
        {
          formSelector: site.formSelector,
          usernameSelector: site.usernameSelector,
          passwordSelector: site.passwordSelector,
          timeoutMs: loginStageTimeout(deadline, 15_000),
          loginPathnames: [new URL(site.loginUrl).pathname],
        },
      ],
    });
    if (execution?.result === 'not-filled') {
      await reportLoginProgress(
        operationId,
        site.role,
        'awaiting-user',
        'O gerenciador de senhas ainda não preencheu os campos. Preencha-os e tente novamente.',
      );
      return 'awaiting-user';
    }
    if (execution?.result === 'submitted') {
      await reportLoginProgress(
        operationId,
        site.role,
        'submitted',
        'Login enviado; confirmando a sessão…',
      );
      const authenticated = await waitForLoginCompletion(
        site,
        tabId,
        loginStageTimeout(deadline, 15_000),
      );
      assertActionNotStopped(operationId);
      if (!authenticated) {
        await reportLoginProgress(
          operationId,
          site.role,
          'submitted',
          'O formulário foi enviado, mas a navegação ainda não confirmou o login.',
        );
        return 'submitted';
      }
    }
    if (execution?.result === 'already-authenticated') {
      await reportLoginProgress(
        operationId,
        site.role,
        'submitted',
        'Sessão detectada; carregando e confirmando a página de trabalho…',
      );
    }
    const confirmed = await openAndConfirmWorkPage(
      site,
      tabId,
      loginStageTimeout(deadline, 12_000),
    );
    assertActionNotStopped(operationId);
    if (!confirmed) {
      await reportLoginProgress(
        operationId,
        site.role,
        'awaiting-user',
        'A página de trabalho retornou ao login. Confira as credenciais e tente novamente.',
      );
      return 'awaiting-user';
    }
    await reportLoginProgress(
      operationId,
      site.role,
      'ready',
      'Login confirmado; página de trabalho aberta.',
    );
    return 'ready';
  } catch (error: unknown) {
    console.warn('[PontoNaCerti][LoginPreparation]', {
      status: 'manual-required',
      role: site.role,
      code: error instanceof Error ? error.name : 'UnknownError',
      reason: error instanceof Error ? error.message : 'unknown-error',
    });
    await reportLoginProgress(
      operationId,
      site.role,
      'awaiting-user',
      'Não foi possível confirmar automaticamente. Conclua o login e tente novamente.',
    );
    return 'awaiting-user';
  } finally {
    activeLoginAttempts.delete(tabId);
  }
}

async function resumePreparedLogin(
  tabId: number,
  passive = false,
): Promise<void> {
  if (activeLoginAttempts.has(tabId)) return;
  const state = await loadOperationData();
  const preparation = state?.loginPreparation;
  if (!state || !preparation?.autoSubmit) return;
  const role =
    preparation.sourceTabId === tabId
      ? 'source'
      : preparation.targetTabId === tabId
        ? 'target'
        : undefined;
  if (role === undefined) return;
  const status = role === 'source' ? preparation.ahgora : preparation.channel;
  if (
    status === 'ready' ||
    status === 'failed' ||
    status === 'idle' ||
    status === 'stopped'
  )
    return;
  const permissionGranted = await chrome.permissions.contains({
    origins: [...LOGIN_PERMISSION_ORIGINS],
  });
  if (!permissionGranted) return;

  const site = role === 'source' ? LOGIN_SITES[0] : LOGIN_SITES[1];
  if (passive) {
    try {
      const [probe] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: probeLoginDocument,
        args: [site.formSelector],
      });
      if (!probe?.result?.ready || probe.result.formVisible) return;
    } catch {
      return;
    }
  }
  const result = await attemptAutomaticLogin(site, tabId, state.operationId);
  const latest = await loadOperationData();
  if (latest?.operationId !== state.operationId || !latest.loginPreparation)
    return;
  const nextPreparation: LoginPreparation = {
    ...latest.loginPreparation,
    ...(role === 'source'
      ? {
          ahgora: result,
          ahgoraDetail:
            result === 'ready'
              ? 'Login do Ahgora detectado automaticamente; página de trabalho aberta.'
              : latest.loginPreparation.ahgoraDetail,
        }
      : {
          channel: result,
          channelDetail:
            result === 'ready'
              ? 'Login do Channel detectado automaticamente; página de trabalho aberta.'
              : latest.loginPreparation.channelDetail,
        }),
  };
  const updated = await commitLoginPreparation(
    latest,
    nextPreparation,
    result === 'ready'
      ? `Login do ${role === 'source' ? 'Ahgora' : 'Channel'} detectado. Conectando a aba automaticamente…`
      : (latest.message ?? 'Aguardando a conclusão do login.'),
  );
  if (result === 'ready') await registerPreparedTabs(updated);
}

async function monitorPreparedLogins(
  state: OperationData,
): Promise<OperationData> {
  const preparation = state.loginPreparation;
  if (!preparation?.autoSubmit) return state;
  const pendingTabIds = [
    preparation.ahgora === 'ready' ? undefined : preparation.sourceTabId,
    preparation.channel === 'ready' ? undefined : preparation.targetTabId,
  ];
  for (const tabId of pendingTabIds) {
    if (tabId !== undefined) await resumePreparedLogin(tabId, true);
  }
  const latest = await loadOperationData();
  return latest?.operationId === state.operationId ? latest : state;
}

async function openAndConfirmWorkPage(
  site: LoginSiteDefinition,
  tabId: number,
  timeoutMs = 12_000,
): Promise<boolean> {
  await chrome.tabs.update(tabId, { url: site.destinationUrl });
  const destination = new URL(site.destinationUrl);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url) {
        const current = new URL(tab.url);
        if (
          current.origin === destination.origin &&
          current.pathname === destination.pathname
        ) {
          const [probe] = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: probeLoginDocument,
            args: [site.formSelector, site.workSelector],
          });
          if (
            probe?.result?.ready &&
            !probe.result.formVisible &&
            (probe.result.workMarkerPresent || tab.status === 'complete')
          )
            return true;
        }
      }
    } catch {
      // A navegação substitui o documento; tente novamente no próximo ciclo.
    }
    await delay(100);
  }
  return false;
}

async function getOrCreateLoginTab(
  existingTabId: number | undefined,
  site: LoginSiteDefinition,
): Promise<LoginTabSelection> {
  if (existingTabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(existingTabId);
      if (tab.url === undefined || isLoginSiteUrl(site, tab.url)) {
        const activated = await chrome.tabs.update(existingTabId, {
          active: true,
        });
        return { tab: activated ?? tab, reusedExistingTab: true };
      }
    } catch {
      // A aba anterior foi fechada; uma nova será criada abaixo.
    }
  }
  const candidates = rankLoginTabCandidates(
    await chrome.tabs.query({ url: [...site.tabPatterns] }),
    site,
    existingTabId,
  );
  const reusable = candidates[0];
  if (reusable?.id !== undefined) {
    const activated = await chrome.tabs.update(reusable.id, { active: true });
    return {
      tab: activated ?? reusable,
      reusedExistingTab: true,
    };
  }
  return {
    tab: await chrome.tabs.create({ url: site.loginUrl }),
    reusedExistingTab: false,
  };
}

function loginDetail(siteName: string, status: LoginSiteStatus): string {
  return {
    idle: `${siteName} ainda não foi aberto.`,
    opening: `Carregando ${siteName}…`,
    'awaiting-user': `Aguardando a conclusão manual do login no ${siteName}.`,
    submitted: `Login enviado ao ${siteName}; a sessão ainda não foi confirmada.`,
    ready: `Login do ${siteName} confirmado; página de trabalho aberta.`,
    failed: `Não foi possível abrir ${siteName}.`,
    stopped: `Login do ${siteName} interrompido pelo usuário.`,
  }[status];
}

async function reportLoginProgress(
  operationId: string,
  role: LoginSiteDefinition['role'],
  status: LoginSiteStatus,
  detail: string,
  tabId?: number,
): Promise<void> {
  if (cancellationRegistry.isRequested(operationId)) return;
  const write = loginProgressWrites.then(async () => {
    if (cancellationRegistry.isRequested(operationId)) return;
    const current = await loadOperationData();
    if (current?.operationId !== operationId || !current.loginPreparation)
      return;
    const loginPreparation: LoginPreparation = {
      ...current.loginPreparation,
      ...(role === 'source'
        ? {
            ahgora: status,
            ahgoraDetail: detail,
            ...(tabId === undefined ? {} : { sourceTabId: tabId }),
          }
        : {
            channel: status,
            channelDetail: detail,
            ...(tabId === undefined ? {} : { targetTabId: tabId }),
          }),
    };
    await saveOperationData({
      ...current,
      revision: current.revision + 1,
      loginPreparation,
      message: detail,
    });
  });
  loginProgressWrites = write.catch(() => undefined);
  await write;
}

function loginStageTimeout(
  deadline: number | undefined,
  defaultTimeoutMs: number,
): number {
  if (deadline === undefined) return defaultTimeoutMs;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('login-attempt-timeout');
  return remaining;
}

async function waitForTabReady(tabId: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    try {
      const [probe] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => document.readyState !== 'loading',
      });
      if (probe?.result) return;
    } catch {
      // O documento pode estar sendo substituído durante o redirecionamento.
    }
    await delay(100);
  }
  throw new Error('tab-load-timeout');
}

async function waitForLoginCompletion(
  site: LoginSiteDefinition,
  tabId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const [probe] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: probeLoginDocument,
        args: [site.formSelector],
      });
      if (probe?.result?.ready && !probe.result.formVisible) return true;
    } catch {
      // Durante a navegação o frame pode ficar temporariamente indisponível.
    }
    await delay(100);
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function assertActionNotStopped(operationId: string): void {
  if (cancellationRegistry.isRequested(operationId))
    throw new OperationalError('Ação interrompida pelo usuário.');
}

function stopCurrentAction(
  state: OperationData,
  action: 'login' | 'capture' | 'write',
): OperationData {
  const stopSystem = (progress: CaptureProgress['ahgora']) =>
    progress.status === 'running' || progress.status === 'waiting'
      ? {
          ...progress,
          status: 'stopped' as const,
          detail: 'Interrompido pelo usuário.',
        }
      : progress;
  const preparation = state.loginPreparation;
  const loginPreparation =
    action === 'login' && preparation
      ? {
          ...preparation,
          ahgora:
            preparation.ahgora === 'ready'
              ? ('ready' as const)
              : ('stopped' as const),
          channel:
            preparation.channel === 'ready'
              ? ('ready' as const)
              : ('stopped' as const),
          ahgoraDetail:
            preparation.ahgora === 'ready'
              ? preparation.ahgoraDetail
              : 'Login interrompido pelo usuário.',
          channelDetail:
            preparation.channel === 'ready'
              ? preparation.channelDetail
              : 'Login interrompido pelo usuário.',
          autoSubmit: false,
        }
      : preparation;
  return {
    ...state,
    revision: state.revision + 1,
    inFlight: undefined,
    ...(loginPreparation === undefined ? {} : { loginPreparation }),
    ...(action === 'capture' && state.captureProgress
      ? {
          captureProgress: {
            ahgora: stopSystem(state.captureProgress.ahgora),
            channel: stopSystem(state.captureProgress.channel),
            ...(state.captureProgress.calendar === undefined
              ? {}
              : { calendar: stopSystem(state.captureProgress.calendar) }),
            ...(state.captureProgress.comparison === undefined
              ? {}
              : {
                  comparison: stopSystem(state.captureProgress.comparison),
                }),
          },
        }
      : {}),
    ...(action === 'write' && state.writeProgress
      ? {
          writeProgress: {
            ...state.writeProgress,
            status: 'stopped' as const,
            detail:
              'Envio interrompido. Capture e compare novamente antes de retomar.',
          },
        }
      : {}),
    phase:
      action === 'capture'
        ? 'setup'
        : action === 'write'
          ? 'failed'
          : state.phase,
    message:
      action === 'login'
        ? 'Login interrompido pelo usuário.'
        : action === 'capture'
          ? 'Captura interrompida pelo usuário.'
          : 'Envio interrompido. Capture e compare novamente para reconciliar o Channel.',
  };
}

async function runEffect(
  state: OperationData,
  kind: NonNullable<OperationData['inFlight']>,
  effect: (locked: OperationData) => Promise<OperationData>,
): Promise<UiResponse> {
  try {
    const result = await effectLock.run(
      state,
      kind,
      operationStore,
      async (locked) => {
        try {
          return await effect(locked);
        } catch (error) {
          if (error instanceof Error)
            throw new OperationDisplayError(error.message);
          throw error;
        }
      },
    );
    return success(result);
  } catch (error) {
    if (error instanceof OperationBusyError || error instanceof Error) {
      throw new OperationalError(error.message);
    }
    throw error;
  }
}

function coordinatorAdapters(
  reportCaptureProgress?: (progress: CaptureProgress) => Promise<void>,
  reportWriteProgress?: (
    state: OperationData,
    progress: WriteProgress,
  ) => Promise<void>,
  calendarState?: OperationData,
): CoordinatorAdapters {
  const today = browserClock().today();
  return {
    today,
    captureSource: (tabId, period) =>
      captureAhgora(new ChromeSourceScriptRunner(), {
        tabId,
        today,
        period,
      }),
    captureCalendar: (period, calendarIds) => {
      if (calendarState?.config?.googleCalendar?.accessMode === 'tab') {
        if (!calendarState.calendarTab)
          throw new OperationalError(
            'Conecte novamente a aba do Google Calendar antes da captura.',
          );
        return googleCalendarTabClient.listEvents(
          calendarState.calendarTab.id,
          period,
          calendarIds,
        );
      }
      return googleCalendarClient.listEvents(period, calendarIds);
    },
    readTarget: executeChannelRead,
    cancellationRequested: (operationId) =>
      cancellationRegistry.isRequested(operationId),
    writeTarget: (state, assignment) =>
      executeValidatedChannelFill(state, assignment, {
        validateTab: assertTabBinding,
        loadState: loadOperationData,
        cancellationRequested: (operationId) =>
          cancellationRegistry.isRequested(operationId),
        dispatchFill: executeChannelFill,
      }),
    ...(reportCaptureProgress === undefined ? {} : { reportCaptureProgress }),
    ...(reportWriteProgress === undefined ? {} : { reportWriteProgress }),
  };
}

async function persistWriteProgress(
  expected: OperationData,
  progressState: OperationData,
  progress: WriteProgress,
): Promise<void> {
  const current = await loadOperationData();
  if (
    current?.operationId !== expected.operationId ||
    current.revision !== expected.revision ||
    current.inFlight !== 'apply'
  )
    return;
  await saveOperationData({
    ...current,
    phase: progressState.phase,
    items: progressState.items,
    queue: progressState.queue,
    queueIndex: progressState.queueIndex,
    ...(progressState.targetRows === undefined
      ? {}
      : { targetRows: progressState.targetRows }),
    writeProgress: progress,
    message: progressState.message ?? progress.detail,
  });
}

async function persistCaptureProgress(
  expected: OperationData,
  progress: CaptureProgress,
): Promise<void> {
  const current = await loadOperationData();
  if (
    current?.operationId !== expected.operationId ||
    current.revision !== expected.revision ||
    current.inFlight !== 'capture'
  )
    return;
  const active =
    progress.ahgora.status === 'running'
      ? progress.ahgora.detail
      : progress.channel.status === 'running'
        ? progress.channel.detail
        : progress.calendar?.status === 'running'
          ? progress.calendar.detail
          : progress.calendar?.status === 'failed'
            ? progress.calendar.detail
            : progress.comparison?.status === 'running'
              ? progress.comparison.detail
              : progress.comparison?.status === 'failed'
                ? progress.comparison.detail
                : progress.channel.status === 'failed'
                  ? progress.channel.detail
                  : 'Captura e consulta concluídas; preparando a prévia.';
  await saveOperationData({
    ...current,
    captureProgress: progress,
    message: active,
  });
}

async function assertRegisteredTabs(state: OperationData): Promise<void> {
  if (!state.sourceTab || !state.targetTab) {
    throw new OperationalError('Registre as duas abas novamente.');
  }
  await assertTabBinding(state.sourceTab);
  await assertTabBinding(state.targetTab);
  if (
    calendarCaptureEnabled(state.config?.googleCalendar) &&
    state.config?.googleCalendar?.accessMode === 'tab'
  ) {
    if (!state.calendarTab)
      throw new OperationalError(
        'Conecte novamente a aba do Google Calendar antes da captura.',
      );
    await assertTabBinding(state.calendarTab);
  }
}

async function updateQueueBadge(state: OperationData): Promise<void> {
  if (state.phase === 'completed') {
    await updateBadge('✓');
    return;
  }
  if (state.phase !== 'waiting-review') {
    await updateBadge('!');
    return;
  }
  await updateBadge(
    String(Math.min(state.queue.length - state.queueIndex - 1, 99)),
  );
}

async function assertTabBinding(binding: RegisteredTab): Promise<void> {
  const tab = await chrome.tabs.get(binding.id);
  if (!tab.url || pageOrigin(tab.url) !== binding.origin)
    throw new OperationalError(
      'A aba navegou ou perdeu a origem registrada. Registre-a novamente.',
    );
}

interface PunchAlertRuntimeState {
  readonly lastNotificationSignature?: string;
}

async function syncPunchAlertAlarm(): Promise<void> {
  try {
    const { punchAlerts } = await loadExtensionSettings();
    if (!punchAlerts.enabled) {
      await chrome.alarms.clear(PUNCH_ALERT_ALARM);
      await chrome.storage.local.remove(PUNCH_ALERT_STATE_KEY);
      if (await chrome.permissions.contains({ permissions: ['notifications'] }))
        await optionalNotificationsApi()?.clear(PUNCH_ALERT_NOTIFICATION);
      return;
    }
    const alarm = await chrome.alarms.get(PUNCH_ALERT_ALARM);
    if (alarm?.periodInMinutes !== 30) {
      await chrome.alarms.clear(PUNCH_ALERT_ALARM);
      await chrome.alarms.create(PUNCH_ALERT_ALARM, {
        when: nextLunchMonitorCheck().getTime(),
        periodInMinutes: 30,
      });
    }
  } catch (error: unknown) {
    console.warn('[PontoNaCerti][PunchAlertAlarm]', {
      status: 'failed',
      reason: error instanceof Error ? error.message : 'unknown-error',
    });
  }
}

async function checkPunchAlerts(checkAt: Date): Promise<void> {
  if (punchAlertCheckPending) return;
  punchAlertCheckPending = true;
  try {
    const settings = await loadExtensionSettings();
    if (!settings.punchAlerts.enabled) return;
    const currentTime = `${String(checkAt.getHours()).padStart(2, '0')}:${String(checkAt.getMinutes()).padStart(2, '0')}`;
    if (!isLunchMonitoringTime(currentTime)) return;
    const date = localCivilDate(checkAt);
    if (date !== localCivilDate(new Date())) return;
    if (
      !(await chrome.permissions.contains({ permissions: ['notifications'] }))
    )
      return;

    const operation = await loadOperationData();
    if (operation?.inFlight !== undefined) return;
    const sourceTab = await findAhgoraTab(operation?.sourceTab);
    if (sourceTab === undefined) return;

    const captured = await captureAhgora(new ChromeSourceScriptRunner(), {
      tabId: sourceTab.id,
      today: date,
      period: resolvePeriod(rangePeriod(date, date), { today: () => date }),
      timeoutMs: 20_000,
    });
    if (!captured.ok) {
      console.info('[PontoNaCerti][PunchAlertCheck]', {
        status: 'skipped',
        reason: captured.error.code,
      });
      return;
    }

    const day = captured.days.find((candidate) => candidate.date === date);
    const decision = evaluatePunchAlert({
      date,
      currentTime,
      punchTimes: day?.times ?? [],
      enabled: settings.punchAlerts.enabled,
    });
    const runtime = (await chrome.storage.local.get(PUNCH_ALERT_STATE_KEY))[
      PUNCH_ALERT_STATE_KEY
    ] as PunchAlertRuntimeState | undefined;
    if (!decision) {
      if (runtime?.lastNotificationSignature !== undefined) {
        await chrome.storage.local.remove(PUNCH_ALERT_STATE_KEY);
        await optionalNotificationsApi()?.clear(PUNCH_ALERT_NOTIFICATION);
      }
      return;
    }
    if (runtime?.lastNotificationSignature === decision.signature) return;

    await showPunchAlertNotification(decision.title, decision.message, true);
    await chrome.storage.local.set({
      [PUNCH_ALERT_STATE_KEY]: {
        lastNotificationSignature: decision.signature,
      } satisfies PunchAlertRuntimeState,
    });
  } catch (error: unknown) {
    console.info('[PontoNaCerti][PunchAlertCheck]', {
      status: 'skipped',
      reason: error instanceof Error ? error.message : 'unknown-error',
    });
  } finally {
    punchAlertCheckPending = false;
  }
}

function nextLunchMonitorCheck(now = new Date()): Date {
  for (const [hour, minute] of [
    [12, 30],
    [13, 0],
    [13, 30],
    [14, 0],
  ] as const) {
    const candidate = new Date(now);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(12, 30, 0, 0);
  return tomorrow;
}

async function showPunchAlertNotification(
  title: string,
  message: string,
  soundEnabled: boolean,
): Promise<void> {
  if (
    !(await chrome.permissions.contains({ permissions: ['notifications'] }))
  ) {
    throw new OperationalError(
      'Autorize as notificações do sistema operacional para usar os alertas.',
    );
  }
  const notifications = optionalNotificationsApi();
  if (notifications === undefined)
    throw new OperationalError(
      'As notificações não estão disponíveis neste navegador.',
    );
  await notifications.create(PUNCH_ALERT_NOTIFICATION, {
    type: 'basic',
    iconUrl: notificationIconUrl,
    title,
    message,
    buttons: [{ title: 'Abrir Ahgora' }],
    priority: 2,
    requireInteraction: true,
  });
  if (soundEnabled) await playPunchAlertSound();
}

async function playPunchAlertSound(): Promise<void> {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_AUDIO_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [documentUrl],
  });
  if (contexts.length === 0) {
    creatingOffscreenDocument ??= chrome.offscreen.createDocument({
      url: OFFSCREEN_AUDIO_PATH,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Reproduzir o som opcional do alerta de batidas.',
    });
    try {
      await creatingOffscreenDocument;
    } finally {
      creatingOffscreenDocument = undefined;
    }
  }
  await chrome.runtime
    .sendMessage({ type: 'PLAY_PUNCH_ALERT_SOUND' })
    .catch(() => undefined);
}

async function focusAhgoraTab(): Promise<void> {
  const operation = await loadOperationData();
  const binding = await findAhgoraTab(operation?.sourceTab);
  if (binding === undefined) return;
  const tab = await chrome.tabs.update(binding.id, { active: true });
  if (tab === undefined) return;
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function findAhgoraTab(
  preferred?: RegisteredTab,
): Promise<RegisteredTab | undefined> {
  if (preferred !== undefined) {
    try {
      await assertTabBinding(preferred);
      return preferred;
    } catch {
      // A busca abaixo recupera o monitor após reinício ou troca da aba.
    }
  }
  const tabs = await chrome.tabs.query({
    url: ['https://app.ahgora.com.br/*', 'https://www.ahgora.com.br/*'],
  });
  const tab =
    tabs.find((candidate) => candidate.url?.startsWith('https://app.')) ??
    tabs[0];
  if (tab?.id === undefined || tab.url === undefined) return undefined;
  return { id: tab.id, origin: pageOrigin(tab.url) };
}

function optionalNotificationsApi(): typeof chrome.notifications | undefined {
  return (
    chrome as unknown as {
      readonly notifications?: typeof chrome.notifications;
    }
  ).notifications;
}

function registerNotificationListeners(): void {
  const notifications = optionalNotificationsApi();
  if (notifications === undefined || notificationListenersRegistered) return;
  notifications.onClicked.addListener((notificationId) => {
    if (notificationId === PUNCH_ALERT_NOTIFICATION) void focusAhgoraTab();
  });
  notifications.onButtonClicked.addListener((notificationId) => {
    if (notificationId === PUNCH_ALERT_NOTIFICATION) void focusAhgoraTab();
  });
  notificationListenersRegistered = true;
}

function localCivilDate(now: Date): ReturnType<typeof civilDate> {
  return civilDate(
    `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
  );
}

function pageOrigin(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new OperationalError(
      'A action deve ser usada em uma página HTTP(S).',
    );
  return parsed.origin;
}

function browserClock(): Clock {
  return {
    today: () => localCivilDate(new Date()),
  };
}

function enqueueTabLifecycleUpdate(update: () => Promise<void>): void {
  tabLifecycleWrites = tabLifecycleWrites
    .then(update)
    .catch((error: unknown) => {
      console.warn('[PontoNaCerti][TabLifecycle]', {
        status: 'failed',
        reason: error instanceof Error ? error.message : 'unknown-error',
      });
    });
}

async function invalidateTab(
  tabId: number,
  reason: TabConnectionIssueReason,
): Promise<void> {
  const state = await loadOperationData();
  if (!state) return;
  if (state.calendarTab?.id === tabId) {
    await invalidateGoogleCalendarTab(state, reason);
    return;
  }
  const roles = [
    ...(state.sourceTab?.id === tabId ? (['source'] as const) : []),
    ...(state.targetTab?.id === tabId ? (['target'] as const) : []),
  ] satisfies readonly TabRole[];
  if (roles.length === 0) return;

  const issues = [
    ...(state.tabConnectionIssues ?? []).filter(
      (issue) => !roles.includes(issue.role),
    ),
    ...roles.map((role): TabConnectionIssue => ({ role, reason })),
  ];
  const sourceLost = roles.includes('source');
  const targetLost = roles.includes('target');
  const loginPreparation: LoginPreparation | undefined =
    state.loginPreparation === undefined
      ? undefined
      : {
          ...state.loginPreparation,
          ...(sourceLost
            ? {
                ahgora: 'failed' as const,
                ahgoraDetail: tabConnectionDetail('source', reason),
                sourceTabId: undefined,
              }
            : {}),
          ...(targetLost
            ? {
                channel: 'failed' as const,
                channelDetail: tabConnectionDetail('target', reason),
                targetTabId: undefined,
              }
            : {}),
        };
  const next: OperationData = {
    ...state,
    revision: state.revision + 1,
    ...(sourceLost ? { sourceTab: undefined } : {}),
    ...(targetLost ? { targetTab: undefined } : {}),
    tabConnectionIssues: issues,
    ...(loginPreparation === undefined ? {} : { loginPreparation }),
    message: tabConnectionMessage(roles, reason),
  };
  await saveOperationData(next);
  await updateBadge('!');
}

async function invalidateChangedOrigin(
  tabId: number,
  url: string,
): Promise<void> {
  const state = await loadOperationData();
  if (!state) return;
  const binding =
    state.sourceTab?.id === tabId
      ? state.sourceTab
      : state.targetTab?.id === tabId
        ? state.targetTab
        : state.calendarTab?.id === tabId
          ? state.calendarTab
          : undefined;
  if (!binding) return;
  try {
    if (pageOrigin(url) === binding.origin) return;
  } catch {
    /* invalidate below */
  }
  await invalidateTab(tabId, 'origin-changed');
}

async function invalidateGoogleCalendarTab(
  state: OperationData,
  reason: TabConnectionIssueReason,
): Promise<void> {
  const settings = await loadExtensionSettings();
  if (
    settings.googleCalendar.accessMode === 'tab' &&
    settings.googleCalendar.connected
  )
    await saveExtensionSettings({
      ...settings,
      googleCalendar: { ...settings.googleCalendar, connected: false },
    });
  const next: OperationData = {
    ...state,
    revision: state.revision + 1,
    calendarTab: undefined,
    message:
      reason === 'closed'
        ? 'A aba do Google Calendar foi fechada. Conecte-a novamente para consultar eventos.'
        : 'A aba registrada saiu do Google Calendar. Conecte-a novamente para consultar eventos.',
  };
  await saveOperationData(next);
  await updateBadge('!');
}

function clearTabConnectionIssues(
  state: OperationData,
  roles: readonly TabRole[],
): readonly TabConnectionIssue[] | undefined {
  const remaining = (state.tabConnectionIssues ?? []).filter(
    (issue) => !roles.includes(issue.role),
  );
  return remaining.length === 0 ? undefined : remaining;
}

function tabConnectionDetail(
  role: TabRole,
  reason: TabConnectionIssueReason,
): string {
  const name = role === 'source' ? 'Ahgora' : 'Channel';
  return reason === 'closed'
    ? `A aba do ${name} foi fechada. Reconecte-a para continuar.`
    : `A aba do ${name} saiu da origem registrada. Volte à página correta e reconecte-a.`;
}

function tabConnectionMessage(
  roles: readonly TabRole[],
  reason: TabConnectionIssueReason,
): string {
  const names = roles.map((role) => (role === 'source' ? 'Ahgora' : 'Channel'));
  const subject =
    names.length === 2
      ? 'As abas do Ahgora e Channel'
      : `A aba do ${names.join('')}`;
  const event =
    names.length === 2
      ? reason === 'closed'
        ? 'foram fechadas'
        : 'mudaram de origem'
      : reason === 'closed'
        ? 'foi fechada'
        : 'mudou de origem';
  return `${subject} ${event}. Reconecte ${names.length === 2 ? 'as abas' : 'a aba'} para continuar usando a extensão.`;
}

async function updateBadge(text: string): Promise<void> {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({
    color: text === '!' ? '#9a3030' : '#075d8c',
  });
  await chrome.action.setTitle({
    title:
      text === '!'
        ? 'Ponto na Certi: atenção necessária'
        : text === '✓'
          ? 'Ponto na Certi: operação concluída'
          : text === ''
            ? 'Abrir Ponto na Certi'
            : `Ponto na Certi: ${text} item(ns) pendente(s)`,
  });
}

function success(state: OperationData, catalog?: ChannelCatalog): UiResponse {
  return {
    ok: true,
    state: publicState(state),
    ...(catalog === undefined ? {} : { catalog }),
  };
}

chrome.runtime.onMessage.addListener(
  (candidate: unknown, sender, sendResponse) => {
    if (isPunchAlertSoundMessage(candidate)) return false;
    if (!isIncomingMessage(candidate)) {
      sendResponse({ ok: false, code: 'INVALID_MESSAGE' });
      return false;
    }
    void handleMessage(candidate, sender)
      .then(sendResponse)
      .catch((error: unknown) => {
        const diagnostic = toSafeDiagnostic(error, 'background');
        console.error('[PontoNaCerti][Background]', {
          status: 'failed',
          messageType: candidate.type,
          ...diagnostic,
          message:
            error instanceof OperationalError
              ? error.message
              : 'Falha inesperada.',
        });
        sendResponse({
          ok: false,
          ...diagnostic,
          message:
            error instanceof OperationalError
              ? error.message
              : 'Falha inesperada. Registre novamente as abas e tente outra vez.',
        });
      });
    return true;
  },
);

function isPunchAlertSoundMessage(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).type === 'PLAY_PUNCH_ALERT_SOUND'
  );
}
