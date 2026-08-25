import { describe, expect, it } from 'vitest';

import { civilDate } from '../../../src/domain/civil-date';
import {
  compareAhgoraWithChannel,
  lastRowByDate,
  missingCandidates,
} from '../../../src/domain/comparison';

const AUG_18 = civilDate('2026-08-18');
const AUG_19 = civilDate('2026-08-19');
const AUG_20 = civilDate('2026-08-20');
const CHANNEL_ONLY = civilDate('2026-08-21');

describe('comparação Ahgora → Channel', () => {
  it('mantém a última linha de cada data do Channel sem somar duplicidades', () => {
    const channelRows = [
      { date: AUG_18, durationMinutes: 420, duration: '07:00' },
      { date: AUG_18, durationMinutes: 450, duration: '07:30' },
    ];

    expect(lastRowByDate(channelRows).get(AUG_18)?.durationMinutes).toBe(450);
    expect(
      compareAhgoraWithChannel(
        [{ date: AUG_18, durationMinutes: 450, duration: '07:30' }],
        channelRows,
      ),
    ).toEqual([
      {
        status: 'equal',
        date: AUG_18,
        ahgoraMinutes: 450,
        channelMinutes: 450,
        ahgoraDuration: '07:30',
        channelDuration: '07:30',
      },
    ]);
  });

  it('classifica novo, igual e divergente iterando somente as datas do Ahgora', () => {
    const comparisons = compareAhgoraWithChannel(
      [
        { date: AUG_18, durationMinutes: 450, duration: '07:30' },
        { date: AUG_19, durationMinutes: 480, duration: '08:00' },
        { date: AUG_20, durationMinutes: 420, duration: '07:00' },
      ],
      [
        { date: AUG_19, durationMinutes: 480, duration: '08:00' },
        { date: AUG_20, durationMinutes: 300, duration: '05:00' },
        { date: CHANNEL_ONLY, durationMinutes: 999, duration: '16:39' },
      ],
    );

    expect(comparisons).toEqual([
      {
        status: 'missing',
        date: AUG_18,
        ahgoraMinutes: 450,
        ahgoraDuration: '07:30',
      },
      {
        status: 'equal',
        date: AUG_19,
        ahgoraMinutes: 480,
        channelMinutes: 480,
        ahgoraDuration: '08:00',
        channelDuration: '08:00',
      },
      {
        status: 'divergent',
        date: AUG_20,
        ahgoraMinutes: 420,
        channelMinutes: 300,
        ahgoraDuration: '07:00',
        channelDuration: '05:00',
      },
    ]);
    expect(comparisons.some(({ date }) => date === CHANNEL_ONLY)).toBe(false);
    expect(missingCandidates(comparisons)).toEqual([
      { date: AUG_18, durationMinutes: 450, duration: '07:30' },
    ]);
  });

  it('também reproduz a conversão final do Ahgora para hash com última linha', () => {
    const comparisons = compareAhgoraWithChannel(
      [
        { date: AUG_18, durationMinutes: 60, duration: '01:00' },
        { date: AUG_18, durationMinutes: 120, duration: '02:00' },
      ],
      [],
    );
    expect(comparisons).toEqual([
      {
        status: 'missing',
        date: AUG_18,
        ahgoraMinutes: 120,
        ahgoraDuration: '02:00',
      },
    ]);
  });

  it('preserva a comparação textual do Ruby mesmo quando os minutos são iguais', () => {
    expect(
      compareAhgoraWithChannel(
        [{ date: AUG_18, durationMinutes: 480, duration: '08:00' }],
        [{ date: AUG_18, durationMinutes: 480, duration: '8:00' }],
      ),
    ).toEqual([
      {
        status: 'divergent',
        date: AUG_18,
        ahgoraMinutes: 480,
        channelMinutes: 480,
        ahgoraDuration: '08:00',
        channelDuration: '8:00',
      },
    ]);
  });
});
