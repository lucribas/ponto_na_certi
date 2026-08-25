import type {
  OperationConfig,
  PublicOperationState,
  TabRole,
} from '../application/types';
import type { ChannelCatalog, MarkingTemplate } from '../application/settings';
import type {
  TemplateApplicationBasis,
  TemplateOverflowStrategy,
} from '../application/marking-templates';

export type { TabRole } from '../application/types';

export type IncomingMessage =
  | { readonly type: 'GET_STATE' }
  | { readonly type: 'START_OPERATION'; readonly operationId: string }
  | { readonly type: 'FETCH_CHANNEL_CATALOG'; readonly operationId: string }
  | { readonly type: 'CONNECT_GOOGLE_CALENDAR'; readonly operationId: string }
  | {
      readonly type: 'TEST_PUNCH_ALERT';
      readonly operationId: string;
      readonly checkAt?: string;
    }
  | {
      readonly type: 'DISCONNECT_GOOGLE_CALENDAR';
      readonly operationId: string;
    }
  | { readonly type: 'CHECK_LOGIN_STATUS'; readonly operationId: string }
  | { readonly type: 'DISCOVER_OPEN_TABS'; readonly operationId: string }
  | {
      readonly type: 'OPEN_LOGIN_PAGES';
      readonly operationId: string;
      readonly autoSubmit: boolean;
    }
  | {
      readonly type: 'SET_PENDING_ROLE';
      readonly operationId: string;
      readonly role: TabRole;
    }
  | {
      readonly type: 'REGISTER_ACTIVE_TAB';
      readonly operationId: string;
      readonly role: TabRole;
    }
  | {
      readonly type: 'CAPTURE_AND_COMPARE';
      readonly operationId: string;
      readonly config: OperationConfig;
    }
  | { readonly type: 'CAPTURE_SOURCE'; readonly operationId: string }
  | {
      readonly type: 'SHOW_PREVIEW';
      readonly operationId: string;
      readonly dryRun: boolean;
    }
  | {
      readonly type: 'SET_ITEM_DECISION';
      readonly operationId: string;
      readonly itemId: string;
      readonly decision: 'selected' | 'refused';
    }
  | {
      readonly type: 'SET_ITEM_TAG';
      readonly operationId: string;
      readonly itemId: string;
      readonly tagId: string;
    }
  | {
      readonly type: 'UPDATE_ALLOCATION';
      readonly operationId: string;
      readonly itemId: string;
      readonly allocationId: string;
      readonly mode: 'percentage' | 'duration';
      readonly value: string;
    }
  | {
      readonly type: 'SET_ALLOCATION_TAG';
      readonly operationId: string;
      readonly itemId: string;
      readonly allocationId: string;
      readonly tagId: string;
      readonly useTagSource?: boolean;
    }
  | {
      readonly type: 'SET_ALLOCATION_RAG';
      readonly operationId: string;
      readonly itemId: string;
      readonly allocationId: string;
      readonly catalogId: string;
      readonly ragItemId: string;
    }
  | {
      readonly type: 'REMOVE_ALLOCATION';
      readonly operationId: string;
      readonly itemId: string;
      readonly allocationId: string;
    }
  | {
      readonly type: 'APPLY_MARKING_TEMPLATE';
      readonly operationId: string;
      readonly itemId: string;
      readonly template: MarkingTemplate;
      readonly basis: TemplateApplicationBasis;
      readonly overflowStrategy: TemplateOverflowStrategy;
    }
  | {
      readonly type: 'DELETE_CHANNEL_MARKING';
      readonly operationId: string;
      readonly itemId: string;
      readonly markingId: string;
    }
  | {
      readonly type: 'EDIT_DIVERGENT_ITEM';
      readonly operationId: string;
      readonly itemId: string;
    }
  | { readonly type: 'SELECT_REMAINING'; readonly operationId: string }
  | { readonly type: 'RUN_DRY_RUN'; readonly operationId: string }
  | {
      readonly type: 'APPLY_ITEM';
      readonly operationId: string;
      readonly itemId: string;
    }
  | { readonly type: 'APPLY_SELECTED'; readonly operationId: string }
  | { readonly type: 'ADVANCE_QUEUE'; readonly operationId: string }
  | {
      readonly type: 'STOP_CURRENT_ACTION';
      readonly operationId: string;
      readonly action: 'login' | 'capture' | 'write';
    }
  | { readonly type: 'CANCEL_OPERATION'; readonly operationId: string };

export type OutgoingMessage =
  | {
      readonly type: 'FILL_TARGET';
      readonly operationId: string;
      readonly itemId: string;
    }
  | {
      readonly type: 'OPERATION_STATE';
      readonly operationId: string;
      readonly phase: string;
    }
  | {
      readonly type: 'OPERATION_ERROR';
      readonly operationId: string;
      readonly code: string;
    };

export type UiResponse =
  | {
      readonly ok: true;
      readonly state: PublicOperationState;
      readonly catalog?: ChannelCatalog;
    }
  | { readonly ok: false; readonly code: string; readonly message?: string };
