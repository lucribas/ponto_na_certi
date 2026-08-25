import type { OutgoingMessage } from '../messaging/messages';
import { OperationTransitionError } from '../shared/errors';

export type OperationPhase =
  | 'detecting'
  | 'captured'
  | 'validated'
  | 'preview'
  | 'filling'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type ItemDecision =
  'pending' | 'selected' | 'refused' | 'filled' | 'failed';

export interface OperationItem {
  readonly id: string;
  readonly decision: ItemDecision;
}

export interface OperationState {
  readonly operationId: string;
  readonly phase: OperationPhase;
  readonly mode: 'review' | 'dry-run';
  readonly items: readonly OperationItem[];
}

export type OperationEvent =
  | { readonly type: 'SOURCE_CAPTURED' }
  | { readonly type: 'VALIDATION_COMPLETED' }
  | {
      readonly type: 'PREVIEW_READY';
      readonly itemIds: readonly string[];
      readonly dryRun: boolean;
    }
  | {
      readonly type: 'SET_ITEM_DECISION';
      readonly itemId: string;
      readonly decision: 'selected' | 'refused';
    }
  | { readonly type: 'SELECT_REMAINING' }
  | { readonly type: 'APPLY_SELECTED' }
  | {
      readonly type: 'ITEM_RESULT';
      readonly itemId: string;
      readonly ok: boolean;
    }
  | { readonly type: 'CANCEL' }
  | { readonly type: 'FAIL' };

export type OperationEffect =
  | OutgoingMessage
  | { readonly type: 'REPORT_READY'; readonly operationId: string }
  | { readonly type: 'OPERATION_CANCELLED'; readonly operationId: string };

export interface TransitionResult {
  readonly state: OperationState;
  readonly effects: readonly OperationEffect[];
}

export function createOperation(operationId: string): OperationState {
  return { operationId, phase: 'detecting', mode: 'review', items: [] };
}

function requirePhase(state: OperationState, phase: OperationPhase): void {
  if (state.phase !== phase) {
    throw new OperationTransitionError(
      `Transição inválida a partir de ${state.phase}.`,
    );
  }
}

function updateDecision(
  items: readonly OperationItem[],
  itemId: string,
  decision: ItemDecision,
): readonly OperationItem[] {
  const targetIndex = items.findIndex((item) => item.id === itemId);
  if (targetIndex < 0) throw new OperationTransitionError('Item desconhecido.');
  return items.map((item, index) =>
    index === targetIndex ? { ...item, decision } : item,
  );
}

export function transition(
  state: OperationState,
  event: OperationEvent,
): TransitionResult {
  if (event.type === 'CANCEL') {
    if (state.phase === 'completed' || state.phase === 'cancelled') {
      throw new OperationTransitionError('Operação já encerrada.');
    }
    return {
      state: { ...state, phase: 'cancelled' },
      effects: [
        { type: 'OPERATION_CANCELLED', operationId: state.operationId },
      ],
    };
  }
  if (event.type === 'FAIL') {
    return { state: { ...state, phase: 'failed' }, effects: [] };
  }

  switch (event.type) {
    case 'SOURCE_CAPTURED':
      requirePhase(state, 'detecting');
      return { state: { ...state, phase: 'captured' }, effects: [] };
    case 'VALIDATION_COMPLETED':
      requirePhase(state, 'captured');
      return { state: { ...state, phase: 'validated' }, effects: [] };
    case 'PREVIEW_READY': {
      requirePhase(state, 'validated');
      const nextState: OperationState = {
        ...state,
        phase: 'preview',
        mode: event.dryRun ? 'dry-run' : 'review',
        items: event.itemIds.map((id) => ({ id, decision: 'pending' })),
      };
      return {
        state: nextState,
        effects: event.dryRun
          ? [{ type: 'REPORT_READY', operationId: state.operationId }]
          : [],
      };
    }
    case 'SET_ITEM_DECISION':
      requirePhase(state, 'preview');
      if (state.mode === 'dry-run') {
        throw new OperationTransitionError(
          'Dry-run não permite selecionar itens.',
        );
      }
      return {
        state: {
          ...state,
          items: updateDecision(state.items, event.itemId, event.decision),
        },
        effects: [],
      };
    case 'SELECT_REMAINING':
      requirePhase(state, 'preview');
      if (state.mode === 'dry-run') {
        throw new OperationTransitionError(
          'Dry-run não permite selecionar itens.',
        );
      }
      return {
        state: {
          ...state,
          items: state.items.map((item) =>
            item.decision === 'pending'
              ? { ...item, decision: 'selected' }
              : item,
          ),
        },
        effects: [],
      };
    case 'APPLY_SELECTED': {
      requirePhase(state, 'preview');
      if (state.mode === 'dry-run') {
        throw new OperationTransitionError(
          'Dry-run não permite preenchimento.',
        );
      }
      const selected = state.items.filter(
        (item) => item.decision === 'selected',
      );
      if (selected.length === 0) {
        throw new OperationTransitionError('Selecione ao menos um item.');
      }
      return {
        state: { ...state, phase: 'filling' },
        effects: selected.map((item) => ({
          type: 'FILL_TARGET',
          operationId: state.operationId,
          itemId: item.id,
        })),
      };
    }
    case 'ITEM_RESULT': {
      requirePhase(state, 'filling');
      const items = updateDecision(
        state.items,
        event.itemId,
        event.ok ? 'filled' : 'failed',
      );
      const isDone = items.every(
        (item) => item.decision !== 'selected' && item.decision !== 'pending',
      );
      return {
        state: { ...state, phase: isDone ? 'completed' : 'filling', items },
        effects: [],
      };
    }
  }
}
