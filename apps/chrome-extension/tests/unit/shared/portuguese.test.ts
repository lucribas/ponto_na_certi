import { describe, expect, it } from 'vitest';
import {
  formatPortugueseQuantity,
  inflectPortuguese,
} from '../../../src/shared/portuguese';

describe('pluralização em português', () => {
  it.each([
    [0, '0 marcações'],
    [1, '1 marcação'],
    [2, '2 marcações'],
  ])('formata a quantidade %i corretamente', (count, expected) => {
    expect(formatPortugueseQuantity(count, 'marcação', 'marcações')).toBe(
      expected,
    );
  });

  it('mantém a concordância de gênero e número', () => {
    expect(inflectPortuguese(1, 'confirmada', 'confirmadas')).toBe(
      'confirmada',
    );
    expect(inflectPortuguese(2, 'confirmada', 'confirmadas')).toBe(
      'confirmadas',
    );
  });
});
