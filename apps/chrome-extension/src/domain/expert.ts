import { assertIntegerMinutes, formatDurationMinutes } from './duration';
import type { CivilDate, WorkRecord } from './types';

export interface ExpertConfig {
  readonly project: string;
  readonly activity: string;
  readonly activityType?: string;
  readonly task?: string;
  readonly comments?: string;
}

export interface ProjectAssignment {
  readonly kind: 'PROJETOS';
  readonly project: string;
  readonly activityType: string;
  readonly activity: string;
  readonly task: string;
  readonly date: CivilDate;
  readonly durationMinutes: number;
  readonly duration: string;
  readonly comments: string;
  /** Total que deve existir no dia imediatamente antes desta nova marcação. */
  readonly expectedExistingMinutes?: number;
}

export interface AdHocAssignment {
  readonly kind: 'AVULSO';
  readonly client: string;
  readonly operationNature: string;
  readonly activityType: string;
  readonly date: CivilDate;
  readonly durationMinutes: number;
  readonly duration: string;
  readonly comments: string;
  /** Total que deve existir no dia imediatamente antes desta nova marcação. */
  readonly expectedExistingMinutes?: number;
}

export type ChannelAssignment = ProjectAssignment | AdHocAssignment;

export function assignExpertProject(
  record: WorkRecord,
  config: ExpertConfig,
): ProjectAssignment {
  assertIntegerMinutes(record.durationMinutes);
  if (record.durationMinutes <= 0) {
    throw new Error('A duração deve ser maior que zero');
  }

  return {
    kind: 'PROJETOS',
    project: config.project,
    activityType: config.activityType ?? 'Nenhum',
    activity: config.activity,
    task: config.task ?? 'Nenhum',
    date: record.date,
    durationMinutes: record.durationMinutes,
    duration: formatDurationMinutes(record.durationMinutes),
    comments: config.comments ?? '',
  };
}

export function assignAdHoc(
  record: WorkRecord,
  config: {
    readonly client: string;
    readonly operationNature: string;
    readonly activityType?: string;
    readonly comments?: string;
  },
): AdHocAssignment {
  assertIntegerMinutes(record.durationMinutes);
  if (record.durationMinutes <= 0) {
    throw new Error('A duração deve ser maior que zero');
  }
  return {
    kind: 'AVULSO',
    client: config.client,
    operationNature: config.operationNature,
    activityType: config.activityType ?? 'Nenhum',
    date: record.date,
    durationMinutes: record.durationMinutes,
    duration: formatDurationMinutes(record.durationMinutes),
    comments: config.comments ?? '',
  };
}
