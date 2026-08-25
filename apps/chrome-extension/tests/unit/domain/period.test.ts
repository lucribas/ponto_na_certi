import { describe, expect, it } from 'vitest';

import { civilDate, fixedClock } from '../../../src/domain/civil-date';
import {
  defaultPeriod,
  mirrorMonthsForRange,
  monthPeriod,
  rangePeriod,
  resolvePeriod,
} from '../../../src/domain/period';

describe('período 26–25', () => {
  it.each(['2026-08-10', '2026-08-25', '2026-08-31'])(
    'usa o mês-calendário anterior em %s, sem condicionar ao dia 25',
    (today) => {
      expect(resolvePeriod(defaultPeriod(), fixedClock(today))).toEqual({
        mode: 'default',
        start: '2026-06-26',
        end: '2026-07-25',
        mirrorMonths: ['2026-07'],
      });
    },
  );

  it('preserva a virada dezembro/janeiro no default Date.today << 1', () => {
    expect(resolvePeriod(defaultPeriod(), fixedClock('2026-01-15'))).toEqual({
      mode: 'default',
      start: '2025-11-26',
      end: '2025-12-25',
      mirrorMonths: ['2025-12'],
    });
  });

  it('trata o mês explícito como o mês de fechamento', () => {
    expect(
      resolvePeriod(monthPeriod('2026-01'), fixedClock('2030-09-09')),
    ).toEqual({
      mode: 'month',
      start: '2025-12-26',
      end: '2026-01-25',
      mirrorMonths: ['2026-01'],
    });
  });

  it('mantém as duas pontas do intervalo e calcula os espelhos necessários', () => {
    const period = resolvePeriod(
      rangePeriod(civilDate('2026-08-24'), civilDate('2026-08-30')),
      fixedClock('2026-08-22'),
    );

    expect(period).toEqual({
      mode: 'range',
      start: '2026-08-24',
      end: '2026-08-30',
      mirrorMonths: ['2026-08', '2026-09'],
    });
    expect(
      mirrorMonthsForRange(civilDate('2026-08-17'), civilDate('2026-08-23')),
    ).toEqual(['2026-08']);
  });

  it('rejeita mês, datas e ordem inválidos', () => {
    expect(() => monthPeriod('2026-00')).toThrow('Mês de fechamento inválido');
    expect(() => civilDate('2026-04-31')).toThrow('Data civil inválida');
    expect(() =>
      rangePeriod(civilDate('2026-08-30'), civilDate('2026-08-24')),
    ).toThrow('data inicial');
  });
});
