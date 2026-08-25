import { describe, expect, it } from 'vitest';

import {
  civilDate,
  closingMonth,
  fixedClock,
  formatBrazilianDate,
  makeCivilDate,
  shiftMonth,
} from '../../../src/domain/civil-date';
import {
  assertIntegerMinutes,
  formatDurationMinutes,
  formatRubyDurationMinutes,
  parseDurationMinutes,
} from '../../../src/domain/duration';

describe('datas civis', () => {
  it('valida calendário sem converter a data por timezone', () => {
    expect(civilDate('2024-02-29')).toBe('2024-02-29');
    expect(() => civilDate('2026-02-29')).toThrow('Data civil inválida');
    expect(() => civilDate('2026-13-01')).toThrow('Data civil inválida');
  });

  it('formata a data no contrato DD/MM/AAAA do Ruby', () => {
    expect(formatBrazilianDate(civilDate('2026-08-03'))).toBe('03/08/2026');
    expect(makeCivilDate(2026, 8, 3)).toBe('2026-08-03');
  });

  it('desloca meses corretamente na virada dezembro/janeiro', () => {
    expect(shiftMonth(closingMonth('2026-01'), -1)).toBe('2025-12');
    expect(shiftMonth(closingMonth('2025-12'), 1)).toBe('2026-01');
  });

  it('oferece relógio determinístico para a resolução do período', () => {
    expect(fixedClock('2026-08-22').today()).toBe('2026-08-22');
  });
});

describe('durações em minutos inteiros', () => {
  it('converte e formata sem horas em ponto flutuante', () => {
    expect(parseDurationMinutes('07:30')).toBe(450);
    expect(parseDurationMinutes('-01:30')).toBe(-90);
    expect(formatDurationMinutes(450)).toBe('07:30');
    expect(formatDurationMinutes(-90)).toBe('-01:30');
    expect(formatRubyDurationMinutes(-30)).toBe('-1:30');
  });

  it('rejeita formato inválido e valores que não sejam minutos inteiros', () => {
    expect(() => parseDurationMinutes('7h30')).toThrow('Duração inválida');
    expect(() => assertIntegerMinutes(7.5)).toThrow('minutos inteiros');
  });
});
