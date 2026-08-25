import type {
  CivilDate,
  ComparableWorkRecord,
  PeriodRequest,
  PunchOverride,
  ResolvedPeriod,
} from '../domain';
import type {
  ChannelTag,
  MarkingTemplate,
  TemplateApplicationRule,
  GoogleCalendarSettings,
} from './settings';

export type TabRole = 'source' | 'target';
export type TabConnectionIssueReason = 'closed' | 'origin-changed';

export interface TabConnectionIssue {
  readonly role: TabRole;
  readonly reason: TabConnectionIssueReason;
}

export interface RegisteredTab {
  readonly id: number;
  readonly origin: string;
}

export type SystemProgressStatus =
  'waiting' | 'running' | 'done' | 'failed' | 'stopped';

export interface SystemProgress {
  readonly status: SystemProgressStatus;
  readonly detail: string;
}

export interface CaptureProgress {
  readonly ahgora: SystemProgress;
  readonly channel: SystemProgress;
  readonly calendar?: SystemProgress;
  /** Barreira final que compõe os dias somente após todas as leituras. */
  readonly comparison?: SystemProgress;
}

export type LoginSiteStatus =
  | 'idle'
  | 'opening'
  | 'awaiting-user'
  | 'submitted'
  | 'ready'
  | 'failed'
  | 'stopped';

export interface LoginPreparation {
  readonly ahgora: LoginSiteStatus;
  readonly channel: LoginSiteStatus;
  readonly ahgoraDetail: string;
  readonly channelDetail: string;
  readonly autoSubmit: boolean;
  readonly permissionDenied?: boolean;
  readonly sourceTabId?: number | undefined;
  readonly targetTabId?: number | undefined;
}

export type WriteProgressStatus =
  'idle' | 'running' | 'done' | 'failed' | 'stopped';

export interface WriteProgress {
  readonly status: WriteProgressStatus;
  readonly completedItems: number;
  readonly totalItems: number;
  readonly currentDate?: CivilDate;
  readonly detail: string;
}

export interface OperationConfig {
  readonly project: string;
  readonly activity: string;
  readonly activityType: string;
  readonly task: string;
  readonly period: PeriodRequest;
  readonly overrides: readonly PunchOverride[];
  readonly tags?: readonly ChannelTag[];
  readonly defaultTagId?: string;
  readonly markingTemplates?: readonly MarkingTemplate[];
  readonly templateRules?: readonly TemplateApplicationRule[];
  readonly googleCalendar?: GoogleCalendarSettings;
}

export type PreviewStatus = 'missing' | 'equal' | 'divergent' | 'blocked';
export type ItemDecision = 'pending' | 'selected' | 'refused';
export type FillResultStatus =
  | 'filled'
  | 'already-correct'
  | 'skipped'
  | 'not-found'
  | 'validation-error'
  | 'failed';

export type AllocationMode = 'percentage' | 'duration';

export interface PreviewAllocation {
  readonly id: string;
  readonly mode: AllocationMode;
  /** Valor editável no modo escolhido: percentual decimal ou duração HH:MM. */
  readonly value: string;
  readonly durationMinutes: number;
  readonly duration: string;
  readonly tagId?: string;
  readonly ragCatalogId?: string;
  readonly ragItemId?: string;
  readonly isRemainder: boolean;
  readonly result?: FillResultStatus;
  readonly provenance?: AllocationProvenance;
}

export type AllocationProvenance =
  | {
      readonly kind: 'calendar';
      readonly eventId: string;
      readonly eventTitle: string;
      readonly start: string;
      readonly end: string;
      readonly ruleId: string;
      readonly ruleName: string;
      readonly matchedPhrases: readonly string[];
    }
  | {
      readonly kind: 'weekly-rule';
      readonly ruleId: string;
      readonly ruleName: string;
    }
  | { readonly kind: 'default' };

export interface ChannelMarking {
  readonly id: string;
  readonly duration: string;
  readonly durationMinutes: number;
  readonly project?: string;
  readonly activity?: string;
  readonly canDelete: boolean;
}

export interface PreviewItem {
  readonly id: string;
  readonly date: CivilDate;
  readonly ahgoraDuration: string;
  readonly channelDuration?: string;
  readonly channelProject?: string;
  readonly channelActivity?: string;
  readonly channelMarkings?: readonly ChannelMarking[];
  /** Saldo Ahgora − Channel que pode receber novas marcações neste card divergente. */
  readonly editingBalanceMinutes?: number;
  readonly tagId?: string;
  readonly allocations?: readonly PreviewAllocation[];
  readonly appliedTemplateIds?: readonly string[];
  readonly appliedRuleId?: string;
  readonly appliedRuleName?: string;
  readonly status: PreviewStatus;
  readonly decision: ItemDecision;
  readonly warning?: string;
  readonly result?: FillResultStatus;
}

export interface OperationData {
  readonly version: 1;
  readonly revision: number;
  readonly operationId: string;
  readonly phase:
    | 'setup'
    | 'capturing'
    | 'preview'
    | 'dry-run'
    | 'waiting-review'
    | 'partial'
    | 'completed'
    | 'cancelled'
    | 'failed';
  readonly pendingRole?: TabRole | undefined;
  readonly inFlight?: 'capture' | 'apply' | 'advance' | 'delete' | undefined;
  readonly sourceTab?: RegisteredTab | undefined;
  readonly targetTab?: RegisteredTab | undefined;
  /** Aba usada somente quando o Calendar está no modo de sessão web. */
  readonly calendarTab?: RegisteredTab | undefined;
  readonly tabConnectionIssues?: readonly TabConnectionIssue[] | undefined;
  readonly loginPreparation?: LoginPreparation;
  readonly captureProgress?: CaptureProgress;
  readonly writeProgress?: WriteProgress;
  readonly config?: OperationConfig;
  readonly resolvedPeriod?: ResolvedPeriod;
  readonly sourceRows?: readonly ComparableWorkRecord[];
  readonly targetRows?: readonly ComparableWorkRecord[];
  readonly items: readonly PreviewItem[];
  readonly queue: readonly string[];
  readonly queueIndex: number;
  readonly message?: string;
}

export interface PublicOperationState extends OperationData {
  readonly canApply: boolean;
  readonly capturedMinutes: number;
  readonly capturedCount: number;
  readonly reviewMinutes: number;
  readonly reviewCount: number;
  readonly selectedMinutes: number;
  readonly selectedCount: number;
}

export interface OperationTotals {
  readonly capturedMinutes: number;
  readonly capturedCount: number;
  readonly reviewMinutes: number;
  readonly reviewCount: number;
  readonly selectedMinutes: number;
  readonly selectedCount: number;
}

export function emptyOperation(operationId: string): OperationData {
  return {
    version: 1,
    revision: 0,
    operationId,
    phase: 'setup',
    items: [],
    queue: [],
    queueIndex: 0,
    loginPreparation: {
      ahgora: 'idle',
      channel: 'idle',
      ahgoraDetail: 'A página do Ahgora ainda não foi aberta.',
      channelDetail: 'A página do Channel ainda não foi aberta.',
      autoSubmit: false,
    },
  };
}

export function publicState(state: OperationData): PublicOperationState {
  const totals = operationTotals(state);
  return {
    ...state,
    ...totals,
    canApply: state.phase === 'preview' && totals.selectedCount > 0,
  };
}

/** Impede respostas assíncronas antigas de regredirem o estado exibido. */
export function isStaleOperationState(
  current: OperationData,
  next: OperationData,
): boolean {
  if (current.operationId !== next.operationId) return false;
  if (next.revision !== current.revision)
    return next.revision < current.revision;

  const statusRank = (
    status: SystemProgressStatus | WriteProgressStatus | undefined,
  ): number =>
    status === undefined || status === 'waiting' || status === 'idle'
      ? 0
      : status === 'running'
        ? 1
        : 2;
  const captureRank = (value: OperationData): number =>
    statusRank(value.captureProgress?.ahgora.status) +
    statusRank(value.captureProgress?.channel.status) +
    statusRank(value.captureProgress?.calendar?.status) +
    statusRank(value.captureProgress?.comparison?.status);
  if (captureRank(next) < captureRank(current)) return true;

  const writeRank = (value: OperationData): number =>
    (value.writeProgress?.completedItems ?? 0) * 10 +
    statusRank(value.writeProgress?.status);
  return writeRank(next) < writeRank(current);
}

export function operationTotals(state: OperationData): OperationTotals {
  const sourceByDate = new Map(
    (state.sourceRows ?? []).map((record) => [record.date, record]),
  );
  const reviewable = state.items.flatMap((item) => {
    const minutes = sourceByDate.get(item.date)?.durationMinutes;
    return (item.status === 'missing' ||
      item.editingBalanceMinutes !== undefined) &&
      item.result === undefined &&
      minutes !== undefined &&
      minutes > 0
      ? [{ item, minutes: item.editingBalanceMinutes ?? minutes }]
      : [];
  });
  const selected = reviewable.filter(
    ({ item }) => item.decision === 'selected',
  );
  return {
    capturedMinutes: (state.sourceRows ?? []).reduce(
      (total, record) => total + record.durationMinutes,
      0,
    ),
    capturedCount: state.sourceRows?.length ?? 0,
    reviewMinutes: reviewable.reduce(
      (total, { minutes }) => total + minutes,
      0,
    ),
    reviewCount: reviewable.length,
    selectedMinutes: selected.reduce(
      (total, { minutes }) => total + minutes,
      0,
    ),
    selectedCount: selected.length,
  };
}
