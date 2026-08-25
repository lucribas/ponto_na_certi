import { describe, expect, it } from 'vitest';

import { civilDate } from '../../../src/domain/civil-date';
import {
  calculatePunchDays,
  punchTimeToMinutes,
} from '../../../src/domain/punches';

const DATE = civilDate('2026-08-18');

describe('cálculo de batidas', () => {
  it('soma pares literalmente em minutos inteiros', () => {
    const result = calculatePunchDays([
      { date: DATE, times: ['08:00', '12:00', '13:00', '17:30'] },
    ]);

    expect(result.records).toEqual([
      {
        date: DATE,
        durationMinutes: 510,
        duration: '08:30',
        times: ['08:00', '12:00', '13:00', '17:30'],
        overridden: false,
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('omite dias vazios e dias ímpares com aviso', () => {
    const oddDate = civilDate('2026-08-19');
    const result = calculatePunchDays([
      { date: DATE, times: [] },
      { date: oddDate, times: ['08:00', '12:00', '13:00'] },
    ]);

    expect(result.records).toEqual([]);
    expect(result.warnings).toContainEqual({
      kind: 'odd-punch-count',
      date: oddDate,
      count: 3,
    });
  });

  it('não interpreta par invertido como overnight e preserva o total negativo', () => {
    const result = calculatePunchDays([
      { date: DATE, times: ['18:00', '08:00'] },
    ]);

    expect(result.records[0]?.durationMinutes).toBe(-600);
    expect(result.records[0]?.duration).toBe('-10:00');
    expect(result.warnings).toContainEqual({
      kind: 'inverted-pair',
      date: DATE,
      start: '18:00',
      end: '08:00',
    });
  });

  it('preserva a formatação Ruby baseada em divisão floor para total de -30 minutos', () => {
    const result = calculatePunchDays([
      { date: DATE, times: ['08:30', '08:00'] },
    ]);
    expect(result.records[0]?.durationMinutes).toBe(-30);
    expect(result.records[0]?.duration).toBe('-1:30');
  });

  it('aceita HH:MM fora da faixa usual e apenas emite aviso', () => {
    const result = calculatePunchDays([
      { date: DATE, times: ['25:70', '27:80'] },
    ]);

    expect(punchTimeToMinutes('25:70')).toBe(1570);
    expect(result.records[0]?.durationMinutes).toBe(130);
    expect(
      result.warnings.filter((warning) => warning.kind === 'unusual-time'),
    ).toHaveLength(2);
  });

  it('substitui todas as batidas pela primeira ocorrência de override da data', () => {
    const result = calculatePunchDays(
      [{ date: DATE, times: ['08:00', '09:00'] }],
      [
        { date: DATE, times: ['10:00', '12:00'] },
        { date: DATE, times: ['valor posterior inválido e ignorado'] },
      ],
    );

    expect(result.records[0]).toMatchObject({
      durationMinutes: 120,
      times: ['10:00', '12:00'],
      overridden: true,
    });
  });

  it('rejeita o primeiro override inválido e omite override ímpar com aviso', () => {
    expect(() =>
      calculatePunchDays(
        [{ date: DATE, times: ['08:00', '09:00'] }],
        [{ date: DATE, times: ['8:00', '09:00'] }],
      ),
    ).toThrow('Override de batidas inválido');

    const odd = calculatePunchDays(
      [{ date: DATE, times: [] }],
      [{ date: DATE, times: ['08:00', '12:00', '13:00'] }],
    );
    expect(odd.records).toEqual([]);
    expect(odd.warnings).toContainEqual({
      kind: 'odd-punch-count',
      date: DATE,
      count: 3,
    });
  });
});
