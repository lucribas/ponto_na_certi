import { describe, expect, it } from 'vitest';

import {
  createOperation,
  transition,
  type OperationState,
} from '../../../src/background/operation-machine';

function validatedOperation(): OperationState {
  const created = createOperation('operation-1');
  const captured = transition(created, { type: 'SOURCE_CAPTURED' }).state;
  return transition(captured, { type: 'VALIDATION_COMPLETED' }).state;
}

describe('operation state machine', () => {
  it('keeps dry-run structurally separated from target writes and submit', () => {
    const preview = transition(validatedOperation(), {
      type: 'PREVIEW_READY',
      itemIds: ['synthetic-1', 'synthetic-2'],
      dryRun: true,
    });

    expect(preview.state).toMatchObject({ phase: 'preview', mode: 'dry-run' });
    expect(preview.effects).toEqual([
      { type: 'REPORT_READY', operationId: 'operation-1' },
    ]);
    expect(
      preview.effects.some((effect) => effect.type === 'FILL_TARGET'),
    ).toBe(false);
    expect(JSON.stringify(preview.effects)).not.toContain('SUBMIT');
    expect(() =>
      transition(preview.state, { type: 'SELECT_REMAINING' }),
    ).toThrow(/Dry-run/);
    expect(() => transition(preview.state, { type: 'APPLY_SELECTED' })).toThrow(
      /Dry-run/,
    );
  });

  it('starts with no selection and emits writes only for explicitly selected items', () => {
    let state = transition(validatedOperation(), {
      type: 'PREVIEW_READY',
      itemIds: ['synthetic-1', 'synthetic-2'],
      dryRun: false,
    }).state;

    expect(state.items.every((item) => item.decision === 'pending')).toBe(true);
    expect(() => transition(state, { type: 'APPLY_SELECTED' })).toThrow(
      /Selecione/,
    );

    state = transition(state, {
      type: 'SET_ITEM_DECISION',
      itemId: 'synthetic-1',
      decision: 'selected',
    }).state;
    state = transition(state, {
      type: 'SET_ITEM_DECISION',
      itemId: 'synthetic-2',
      decision: 'refused',
    }).state;
    const applying = transition(state, { type: 'APPLY_SELECTED' });

    expect(applying.effects).toEqual([
      {
        type: 'FILL_TARGET',
        operationId: 'operation-1',
        itemId: 'synthetic-1',
      },
    ]);
    expect(JSON.stringify(applying.effects)).not.toContain('SUBMIT');
  });

  it('selects only remaining items and preserves refusals', () => {
    let state = transition(validatedOperation(), {
      type: 'PREVIEW_READY',
      itemIds: ['synthetic-1', 'synthetic-2'],
      dryRun: false,
    }).state;
    state = transition(state, {
      type: 'SET_ITEM_DECISION',
      itemId: 'synthetic-1',
      decision: 'refused',
    }).state;
    state = transition(state, { type: 'SELECT_REMAINING' }).state;

    expect(state.items).toEqual([
      { id: 'synthetic-1', decision: 'refused' },
      { id: 'synthetic-2', decision: 'selected' },
    ]);
  });

  it('cancels the batch without producing a write', () => {
    const result = transition(validatedOperation(), { type: 'CANCEL' });

    expect(result.state.phase).toBe('cancelled');
    expect(result.effects).toEqual([
      { type: 'OPERATION_CANCELLED', operationId: 'operation-1' },
    ]);
  });
});
