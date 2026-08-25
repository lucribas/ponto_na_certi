import type { CivilDate, WorkRecord } from './types';

export type SelectionDecision = 'pending' | 'selected' | 'skipped';

export interface SelectionState {
  readonly status: 'active' | 'cancelled';
  readonly candidates: readonly WorkRecord[];
  readonly decisions: Readonly<Record<CivilDate, SelectionDecision>>;
}

export function createSelection(
  candidates: readonly WorkRecord[],
): SelectionState {
  const decisions = Object.fromEntries(
    candidates.map((candidate) => [candidate.date, 'pending' as const]),
  ) as Record<CivilDate, SelectionDecision>;
  return { status: 'active', candidates: [...candidates], decisions };
}

export function selectCandidate(
  state: SelectionState,
  date: CivilDate,
): SelectionState {
  return decide(state, date, 'selected');
}

export function skipCandidate(
  state: SelectionState,
  date: CivilDate,
): SelectionState {
  return decide(state, date, 'skipped');
}

export function selectRemaining(state: SelectionState): SelectionState {
  ensureActive(state);
  const decisions = { ...state.decisions };
  for (const candidate of state.candidates) {
    if (decisions[candidate.date] === 'pending') {
      decisions[candidate.date] = 'selected';
    }
  }
  return {
    ...state,
    decisions,
  };
}

export function cancelSelection(state: SelectionState): SelectionState {
  return { ...state, status: 'cancelled' };
}

export function selectedCandidates(
  state: SelectionState,
): readonly WorkRecord[] {
  if (state.status === 'cancelled') {
    return [];
  }
  return state.candidates.filter(
    (candidate) => state.decisions[candidate.date] === 'selected',
  );
}

function decide(
  state: SelectionState,
  date: CivilDate,
  decision: Exclude<SelectionDecision, 'pending'>,
): SelectionState {
  ensureActive(state);
  if (!(date in state.decisions)) {
    throw new Error(`Candidato inexistente: ${date}`);
  }
  return { ...state, decisions: { ...state.decisions, [date]: decision } };
}

function ensureActive(state: SelectionState): void {
  if (state.status === 'cancelled') {
    throw new Error('A operação foi cancelada');
  }
}
