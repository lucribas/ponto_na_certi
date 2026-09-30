import { describe, expect, it } from 'vitest';

import { civilDate } from '../../../src/domain/civil-date';
import {
  compareSourceWithChannel,
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
      compareSourceWithChannel(
        [{ date: AUG_18, durationMinutes: 450, duration: '07:30' }],
        channelRows,
      ),
    ).toEqual([
      {
        status: 'equal',
        date: AUG_18,
        sourceMinutes: 450,
        channelMinutes: 450,
        sourceDuration: '07:30',
        channelDuration: '07:30',
      },
    ]);
  });

  it('classifica novo, igual e divergente iterando somente as datas do Ahgora', () => {
    const comparisons = compareSourceWithChannel(
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
        sourceMinutes: 450,
        sourceDuration: '07:30',
      },
      {
        status: 'equal',
        date: AUG_19,
        sourceMinutes: 480,
        channelMinutes: 480,
        sourceDuration: '08:00',
        channelDuration: '08:00',
      },
      {
        status: 'divergent',
        date: AUG_20,
        sourceMinutes: 420,
        channelMinutes: 300,
        sourceDuration: '07:00',
        channelDuration: '05:00',
      },
    ]);
    expect(comparisons.some(({ date }) => date === CHANNEL_ONLY)).toBe(false);
    expect(missingCandidates(comparisons)).toEqual([
      { date: AUG_18, durationMinutes: 450, duration: '07:30' },
    ]);
  });

  it('também reproduz a conversão final do Ahgora para hash com última linha', () => {
    const comparisons = compareSourceWithChannel(
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
        sourceMinutes: 120,
        sourceDuration: '02:00',
      },
    ]);
  });

  it('preserva a comparação textual do Ruby mesmo quando os minutos são iguais', () => {
    expect(
      compareSourceWithChannel(
        [{ date: AUG_18, durationMinutes: 480, duration: '08:00' }],
        [{ date: AUG_18, durationMinutes: 480, duration: '8:00' }],
      ),
    ).toEqual([
      {
        status: 'divergent',
        date: AUG_18,
        sourceMinutes: 480,
        channelMinutes: 480,
        sourceDuration: '08:00',
        channelDuration: '8:00',
      },
    ]);
  });
});
