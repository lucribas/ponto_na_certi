import type { CivilDate, ComparableWorkRecord } from './types';

export type Comparison =
  | {
      readonly status: 'missing';
      readonly date: CivilDate;
      readonly ahgoraMinutes: number;
      readonly ahgoraDuration: string;
    }
  | {
      readonly status: 'equal';
      readonly date: CivilDate;
      readonly ahgoraMinutes: number;
      readonly channelMinutes: number;
      readonly ahgoraDuration: string;
      readonly channelDuration: string;
    }
  | {
      readonly status: 'divergent';
      readonly date: CivilDate;
      readonly ahgoraMinutes: number;
      readonly channelMinutes: number;
      readonly ahgoraDuration: string;
      readonly channelDuration: string;
    };

export function compareAhgoraWithChannel(
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
          ahgoraMinutes: ahgora.durationMinutes,
          ahgoraDuration: ahgora.duration,
        };
      }
      if (channel.duration === ahgora.duration) {
        return {
          status: 'equal',
          date: ahgora.date,
          ahgoraMinutes: ahgora.durationMinutes,
          channelMinutes: channel.durationMinutes,
          ahgoraDuration: ahgora.duration,
          channelDuration: channel.duration,
        };
      }
      return {
        status: 'divergent',
        date: ahgora.date,
        ahgoraMinutes: ahgora.durationMinutes,
        channelMinutes: channel.durationMinutes,
        ahgoraDuration: ahgora.duration,
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
    .map(({ date, ahgoraMinutes, ahgoraDuration }) => ({
      date,
      durationMinutes: ahgoraMinutes,
      duration: ahgoraDuration,
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
