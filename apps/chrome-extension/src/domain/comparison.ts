import type { CivilDate, ComparableWorkRecord } from './types';

export type Comparison =
  | {
      readonly status: 'missing';
      readonly date: CivilDate;
      readonly sourceMinutes: number;
      readonly sourceDuration: string;
    }
  | {
      readonly status: 'equal';
      readonly date: CivilDate;
      readonly sourceMinutes: number;
      readonly channelMinutes: number;
      readonly sourceDuration: string;
      readonly channelDuration: string;
    }
  | {
      readonly status: 'divergent';
      readonly date: CivilDate;
      readonly sourceMinutes: number;
      readonly channelMinutes: number;
      readonly sourceDuration: string;
      readonly channelDuration: string;
    };

export function compareSourceWithChannel(
  ahgoraRows: readonly ComparableWorkRecord[],
  channelRows: readonly ComparableWorkRecord[],
): readonly Comparison[] {
  const ahgoraByDate = lastRowByDate(ahgoraRows);
  const channelByDate = lastRowByDate(channelRows);

  return [...ahgoraByDate.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((ahgora) => {
      const channel = channelByDate.get(ahgora.date);
      if (!channel) {
        return {
          status: 'missing',
          date: ahgora.date,
          sourceMinutes: ahgora.durationMinutes,
          sourceDuration: ahgora.duration,
        };
      }
      if (channel.duration === ahgora.duration) {
        return {
          status: 'equal',
          date: ahgora.date,
          sourceMinutes: ahgora.durationMinutes,
          channelMinutes: channel.durationMinutes,
          sourceDuration: ahgora.duration,
          channelDuration: channel.duration,
        };
      }
      return {
        status: 'divergent',
        date: ahgora.date,
        sourceMinutes: ahgora.durationMinutes,
        channelMinutes: channel.durationMinutes,
        sourceDuration: ahgora.duration,
        channelDuration: channel.duration,
      };
    });
}

export function missingCandidates(
  comparisons: readonly Comparison[],
): readonly ComparableWorkRecord[] {
  return comparisons
    .filter(
      (comparison): comparison is Extract<Comparison, { status: 'missing' }> =>
        comparison.status === 'missing',
    )
    .map(({ date, sourceMinutes, sourceDuration }) => ({
      date,
      durationMinutes: sourceMinutes,
      duration: sourceDuration,
    }));
}

export function lastRowByDate(
  rows: readonly ComparableWorkRecord[],
): ReadonlyMap<CivilDate, ComparableWorkRecord> {
  const result = new Map<CivilDate, ComparableWorkRecord>();
  for (const row of rows) {
    result.set(row.date, row);
  }
  return result;
}
