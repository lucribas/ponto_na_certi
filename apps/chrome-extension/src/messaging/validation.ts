import type { IncomingMessage, TabRole } from './messages';
import { BoundaryValidationError } from '../shared/errors';

type UnknownRecord = Record<string, unknown>;

const MESSAGE_TYPES = new Set<IncomingMessage['type']>([
  'GET_STATE',
  'START_OPERATION',
  'FETCH_CHANNEL_CATALOG',
  'CONNECT_GOOGLE_CALENDAR',
  'TEST_PUNCH_ALERT',
  'DISCONNECT_GOOGLE_CALENDAR',
  'CHECK_LOGIN_STATUS',
  'DISCOVER_OPEN_TABS',
  'OPEN_LOGIN_PAGES',
  'SET_PENDING_ROLE',
  'REGISTER_ACTIVE_TAB',
  'CAPTURE_AND_COMPARE',
  'CAPTURE_SOURCE',
  'SHOW_PREVIEW',
  'SET_ITEM_DECISION',
  'SET_ITEM_TAG',
  'UPDATE_ALLOCATION',
  'SET_ALLOCATION_TAG',
  'SET_ALLOCATION_RAG',
  'REMOVE_ALLOCATION',
  'APPLY_MARKING_TEMPLATE',
  'DELETE_CHANNEL_MARKING',
  'EDIT_DIVERGENT_ITEM',
  'SELECT_REMAINING',
  'RUN_DRY_RUN',
  'APPLY_ITEM',
  'APPLY_SELECTED',
  'ADVANCE_QUEUE',
  'STOP_CURRENT_ACTION',
  'CANCEL_OPERATION',
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOperationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isTabRole(value: unknown): value is TabRole {
  return value === 'source' || value === 'target';
}

export function isIncomingMessage(value: unknown): value is IncomingMessage {
  if (
    !isRecord(value) ||
    !MESSAGE_TYPES.has(value.type as IncomingMessage['type'])
  )
    return false;
  if (value.type === 'GET_STATE') return true;
  if (!isOperationId(value.operationId)) return false;
  switch (value.type) {
    case 'OPEN_LOGIN_PAGES':
      return typeof value.autoSubmit === 'boolean';
    case 'SET_PENDING_ROLE':
    case 'REGISTER_ACTIVE_TAB':
      return isTabRole(value.role);
    case 'CAPTURE_AND_COMPARE':
      return isRecord(value.config);
    case 'SHOW_PREVIEW':
      return typeof value.dryRun === 'boolean';
    case 'SET_ITEM_DECISION':
      return (
        isOperationId(value.itemId) &&
        (value.decision === 'selected' || value.decision === 'refused')
      );
    case 'SET_ITEM_TAG':
      return isOperationId(value.itemId) && isOperationId(value.tagId);
    case 'UPDATE_ALLOCATION':
      return (
        isOperationId(value.itemId) &&
        isOperationId(value.allocationId) &&
        (value.mode === 'percentage' || value.mode === 'duration') &&
        typeof value.value === 'string' &&
        value.value.length > 0 &&
        value.value.length <= 16
      );
    case 'SET_ALLOCATION_TAG':
      return (
        isOperationId(value.itemId) &&
        isOperationId(value.allocationId) &&
        isOperationId(value.tagId) &&
        (value.useTagSource === undefined ||
          typeof value.useTagSource === 'boolean')
      );
    case 'SET_ALLOCATION_RAG':
      return (
        isOperationId(value.itemId) &&
        isOperationId(value.allocationId) &&
        isOperationId(value.catalogId) &&
        isOperationId(value.ragItemId)
      );
    case 'REMOVE_ALLOCATION':
      return isOperationId(value.itemId) && isOperationId(value.allocationId);
    case 'APPLY_MARKING_TEMPLATE':
      return (
        isOperationId(value.itemId) &&
        isRecord(value.template) &&
        isOperationId(value.template.id) &&
        typeof value.template.name === 'string' &&
        Array.isArray(value.template.entries) &&
        (value.basis === 'percentage' || value.basis === 'duration') &&
        (value.overflowStrategy === 'reject' ||
          value.overflowStrategy === 'scale')
      );
    case 'DELETE_CHANNEL_MARKING':
      return isOperationId(value.itemId) && isOperationId(value.markingId);
    case 'EDIT_DIVERGENT_ITEM':
      return isOperationId(value.itemId);
    case 'APPLY_ITEM':
      return isOperationId(value.itemId);
    case 'STOP_CURRENT_ACTION':
      return (
        value.action === 'login' ||
        value.action === 'capture' ||
        value.action === 'write'
      );
    case 'START_OPERATION':
    case 'FETCH_CHANNEL_CATALOG':
    case 'CONNECT_GOOGLE_CALENDAR':
    case 'DISCONNECT_GOOGLE_CALENDAR':
    case 'CHECK_LOGIN_STATUS':
    case 'DISCOVER_OPEN_TABS':
    case 'CAPTURE_SOURCE':
    case 'SELECT_REMAINING':
    case 'RUN_DRY_RUN':
    case 'APPLY_SELECTED':
    case 'ADVANCE_QUEUE':
    case 'CANCEL_OPERATION':
      return true;
    case 'TEST_PUNCH_ALERT':
      return (
        value.checkAt === undefined ||
        (typeof value.checkAt === 'string' &&
          value.checkAt.length <= 32 &&
          !Number.isNaN(Date.parse(value.checkAt)))
      );
    default:
      return false;
  }
}

export function assertCurrentOperation(
  message: Exclude<IncomingMessage, { type: 'GET_STATE' }>,
  currentOperationId: string,
): void {
  if (message.operationId !== currentOperationId) {
    throw new BoundaryValidationError('Mensagem de uma operação antiga.');
  }
}

export interface ExpectedContentSender {
  readonly tabId: number;
  readonly frameId: number;
  readonly origin: string;
}

export function assertExtensionSender(
  sender: chrome.runtime.MessageSender,
  extensionId: string,
): void {
  if (sender.id !== extensionId) {
    throw new BoundaryValidationError('Remetente da interface incompatível.');
  }
  // O Chrome omite `url` para algumas páginas internas (inclusive side panel
  // em Chromium headless). O ID próprio + ausência de aba ainda distingue a UI
  // dos content scripts; não há externally_connectable no manifesto.
  if (sender.url === undefined) {
    if (sender.tab !== undefined) {
      throw new BoundaryValidationError('Remetente da interface incompatível.');
    }
    return;
  }
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    throw new BoundaryValidationError('URL da interface inválida.');
  }
  if (url.protocol !== 'chrome-extension:' || url.host !== extensionId) {
    throw new BoundaryValidationError('Origem da interface incompatível.');
  }
}

export function assertContentSender(
  sender: chrome.runtime.MessageSender,
  expected: ExpectedContentSender,
): void {
  if (
    sender.tab?.id !== expected.tabId ||
    sender.frameId !== expected.frameId ||
    sender.url === undefined
  ) {
    throw new BoundaryValidationError('Remetente de conteúdo incompatível.');
  }
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    throw new BoundaryValidationError('URL do remetente inválida.');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.origin !== expected.origin
  ) {
    throw new BoundaryValidationError('Origem do remetente incompatível.');
  }
}
