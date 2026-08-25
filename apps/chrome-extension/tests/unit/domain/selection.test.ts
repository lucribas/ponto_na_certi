import { describe, expect, it } from 'vitest';

import { civilDate } from '../../../src/domain/civil-date';
import {
  cancelSelection,
  createSelection,
  selectCandidate,
  selectedCandidates,
  selectRemaining,
  skipCandidate,
} from '../../../src/domain/selection';

const FIRST = civilDate('2026-08-18');
const SECOND = civilDate('2026-08-19');

describe('decisões de seleção do lote', () => {
  it('começa sem seleção e suporta selecionar, recusar e selecionar restantes', () => {
    const initial = createSelection([
      { date: FIRST, durationMinutes: 450 },
      { date: SECOND, durationMinutes: 480 },
    ]);
    expect(selectedCandidates(initial)).toEqual([]);

    const firstSelected = selectCandidate(initial, FIRST);
    const secondSkipped = skipCandidate(firstSelected, SECOND);
    const allRemaining = selectRemaining(secondSkipped);

    expect(allRemaining.decisions).toEqual({
      [FIRST]: 'selected',
      [SECOND]: 'skipped',
    });
    expect(selectedCandidates(allRemaining)).toEqual([
      { date: FIRST, durationMinutes: 450 },
    ]);
    expect(initial.decisions[FIRST]).toBe('pending');
  });

  it('cancelar elimina qualquer saída selecionada e bloqueia novas decisões', () => {
    const selected = selectCandidate(
      createSelection([{ date: FIRST, durationMinutes: 450 }]),
      FIRST,
    );
    const cancelled = cancelSelection(selected);

    expect(selectedCandidates(cancelled)).toEqual([]);
    expect(() => selectRemaining(cancelled)).toThrow('cancelada');
  });

  it('rejeita decisão para candidato inexistente', () => {
    const state = createSelection([{ date: FIRST, durationMinutes: 450 }]);
    expect(() => selectCandidate(state, SECOND)).toThrow(
      'Candidato inexistente',
    );
  });
});
