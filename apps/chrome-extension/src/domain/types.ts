export type CivilDate = `${number}-${number}-${number}`;

export type ClosingMonth = `${number}-${number}`;

export interface WorkRecord {
  readonly date: CivilDate;
  readonly durationMinutes: number;
}

export interface ComparableWorkRecord extends WorkRecord {
  /** Texto observado no Ruby; a comparação de paridade é textual. */
  readonly duration: string;
  readonly project?: string;
  readonly activity?: string;
}

export interface PunchDay {
  readonly date: CivilDate;
  readonly times: readonly string[];
}
