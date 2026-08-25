export function parseDurationMinutes(value: string): number {
  const match = /^(-?)(\d+):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Duração inválida: ${value}`);
  }

  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

export function formatDurationMinutes(minutes: number): string {
  assertIntegerMinutes(minutes);
  const sign = minutes < 0 ? '-' : '';
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const remainingMinutes = absolute % 60;
  return `${sign}${String(hours).padStart(2, '0')}:${String(remainingMinutes).padStart(2, '0')}`;
}

/** Reproduz Integer#/ e Integer#% usados pelo format do Ahgora Ruby em totais negativos. */
export function formatRubyDurationMinutes(minutes: number): string {
  assertIntegerMinutes(minutes);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes - hours * 60;
  return `${String(hours).padStart(2, '0')}:${String(remainingMinutes).padStart(2, '0')}`;
}

export function assertIntegerMinutes(minutes: number): void {
  if (!Number.isSafeInteger(minutes)) {
    throw new Error(`Duração deve usar minutos inteiros: ${String(minutes)}`);
  }
}
