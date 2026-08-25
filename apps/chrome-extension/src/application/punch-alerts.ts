import type { CivilDate } from '../domain';

export type PunchAlertPhase = 'lunch-exit' | 'lunch-return';

export interface PunchAlertDecision {
  readonly phase: PunchAlertPhase;
  readonly title: string;
  readonly message: string;
  readonly signature: string;
}

export interface PunchAlertEvaluation {
  readonly date: CivilDate;
  readonly currentTime: string;
  readonly punchTimes: readonly string[];
  readonly enabled: boolean;
}

const MONITOR_TIMES = new Set(['12:30', '13:00', '13:30', '14:00']);

export function isLunchMonitoringTime(currentTime: string): boolean {
  return MONITOR_TIMES.has(currentTime);
}

export function evaluatePunchAlert(
  input: PunchAlertEvaluation,
): PunchAlertDecision | undefined {
  if (
    !input.enabled ||
    !isLunchMonitoringTime(input.currentTime) ||
    input.punchTimes.length === 0
  )
    return undefined;

  const count = input.punchTimes.length;
  if (count < 2) {
    return decision(
      'lunch-exit',
      'Saída para o almoço pendente',
      `Há ${punchCountLabel(count)} hoje. Confira a batida de saída para o almoço no Ahgora.`,
      input,
    );
  }

  if (input.currentTime !== '14:00') return undefined;
  if (count >= 3 && count % 2 === 1) return undefined;
  return decision(
    'lunch-return',
    'Retorno do almoço pendente',
    `Há ${punchCountLabel(count)} hoje. Confira a batida de retorno do almoço no Ahgora.`,
    input,
  );
}

function decision(
  phase: PunchAlertPhase,
  title: string,
  message: string,
  input: PunchAlertEvaluation,
): PunchAlertDecision {
  return {
    phase,
    title,
    message,
    signature: [input.date, input.currentTime, phase, ...input.punchTimes].join(
      '|',
    ),
  };
}

function punchCountLabel(count: number): string {
  return `${String(count)} ${count === 1 ? 'batida registrada' : 'batidas registradas'}`;
}
