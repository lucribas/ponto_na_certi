import { describe, expect, it } from 'vitest';

import {
  evaluatePunchAlert,
  isLunchMonitoringTime,
} from '../../../src/application/punch-alerts';
import { civilDate } from '../../../src/domain';

function evaluate(
  currentTime: string,
  punchTimes: readonly string[],
  enabled = true,
) {
  return evaluatePunchAlert({
    date: civilDate('2026-08-24'),
    currentTime,
    punchTimes,
    enabled,
  });
}

describe('monitoramento fixo das batidas do almoço', () => {
  it.each(['12:30', '13:00', '13:30', '14:00'])(
    'monitora exatamente às %s',
    (time) => expect(isLunchMonitoringTime(time)).toBe(true),
  );

  it.each(['12:29', '12:45', '14:01', '18:00'])('não monitora às %s', (time) =>
    expect(isLunchMonitoringTime(time)).toBe(false),
  );

  it.each(['12:30', '13:00', '13:30', '14:00'])(
    'alerta saída ausente às %s quando existe somente a entrada',
    (time) => {
      expect(evaluate(time, ['08:00'])).toMatchObject({
        phase: 'lunch-exit',
        title: 'Saída para o almoço pendente',
      });
    },
  );

  it.each(['12:30', '13:00', '13:30'])(
    'aguarda o retorno às %s quando a saída já foi registrada',
    (time) => {
      expect(evaluate(time, ['08:00', '12:15'])).toBeUndefined();
    },
  );

  it('alerta às 14:00 quando falta a batida de retorno', () => {
    expect(evaluate('14:00', ['08:00', '12:15'])).toMatchObject({
      phase: 'lunch-return',
      title: 'Retorno do almoço pendente',
    });
  });

  it('aceita o retorno registrado e pares adicionais concluídos', () => {
    expect(evaluate('14:00', ['08:00', '12:15', '13:20'])).toBeUndefined();
    expect(
      evaluate('14:00', ['08:00', '10:00', '10:10', '12:15', '13:20']),
    ).toBeUndefined();
  });

  it('não alerta sem batidas ou com o monitor desligado', () => {
    expect(evaluate('12:30', [])).toBeUndefined();
    expect(evaluate('12:30', ['08:00'], false)).toBeUndefined();
  });

  it('inclui o intervalo na assinatura para permitir novo lembrete', () => {
    expect(evaluate('12:30', ['08:00'])?.signature).toBe(
      '2026-08-24|12:30|lunch-exit|08:00',
    );
    expect(evaluate('13:00', ['08:00'])?.signature).toBe(
      '2026-08-24|13:00|lunch-exit|08:00',
    );
  });
});
