import { describe, expect, it } from 'vitest';

import { civilDate, fixedClock } from '../../src/domain/civil-date';
import { compareAhgoraWithChannel } from '../../src/domain/comparison';
import { assignExpertProject } from '../../src/domain/expert';
import { defaultPeriod, resolvePeriod } from '../../src/domain/period';
import { calculatePunchDays } from '../../src/domain/punches';

describe('caracterização Ruby → TypeScript com dados sintéticos', () => {
  it.each([
    ['2026-08-10', '2026-06-26', '2026-07-25'],
    ['2026-08-25', '2026-06-26', '2026-07-25'],
    ['2026-08-31', '2026-06-26', '2026-07-25'],
    ['2026-01-15', '2025-11-26', '2025-12-25'],
  ])('B01: Date.today << 1 para hoje=%s', (today, start, end) => {
    expect(resolvePeriod(defaultPeriod(), fixedClock(today))).toMatchObject({
      start,
      end,
    });
  });

  it('B03/B04/B05/B18: paridade permissiva, override literal e dia ímpar omitido', () => {
    const overriddenDate = civilDate('2026-08-18');
    const oddDate = civilDate('2026-08-19');
    const negativeDate = civilDate('2026-08-20');
    const result = calculatePunchDays(
      [
        { date: overriddenDate, times: ['08:00', '09:00'] },
        { date: oddDate, times: ['08:00', '12:00', '13:00'] },
        { date: negativeDate, times: ['18:00', '08:00'] },
      ],
      [
        { date: overriddenDate, times: ['25:70', '27:80'] },
        { date: overriddenDate, times: ['00:00', '00:01'] },
      ],
    );

    expect(
      result.records.map(({ date, durationMinutes }) => [
        date,
        durationMinutes,
      ]),
    ).toEqual([
      [overriddenDate, 130],
      [negativeDate, -600],
    ]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        { kind: 'unusual-time', date: overriddenDate, time: '25:70' },
        { kind: 'odd-punch-count', date: oddDate, count: 3 },
        {
          kind: 'inverted-pair',
          date: negativeDate,
          start: '18:00',
          end: '08:00',
        },
      ]),
    );
  });

  it('B06/B07: última linha Channel vence e data exclusiva Channel é ignorada', () => {
    const date = civilDate('2026-08-18');
    const channelOnly = civilDate('2026-08-19');
    expect(
      compareAhgoraWithChannel(
        [{ date, durationMinutes: 450, duration: '07:30' }],
        [
          { date, durationMinutes: 420, duration: '07:00' },
          { date, durationMinutes: 450, duration: '07:30' },
          { date: channelOnly, durationMinutes: 60, duration: '01:00' },
        ],
      ),
    ).toEqual([
      {
        status: 'equal',
        date,
        ahgoraMinutes: 450,
        channelMinutes: 450,
        ahgoraDuration: '07:30',
        channelDuration: '07:30',
      },
    ]);
    expect(
      compareAhgoraWithChannel(
        [{ date, durationMinutes: 450, duration: '07:30' }],
        [{ date, durationMinutes: 450, duration: '7:30' }],
      )[0]?.status,
    ).toBe('divergent');
  });

  it('B08: Expert barra o total literal não positivo e aplica defaults ao positivo', () => {
    const date = civilDate('2026-08-18');
    const config = {
      project: 'PROJETO_SINTETICO',
      activity: 'ATIVIDADE_SINTETICA',
    };
    expect(() =>
      assignExpertProject({ date, durationMinutes: -600 }, config),
    ).toThrow('maior que zero');
    expect(
      assignExpertProject({ date, durationMinutes: 450 }, config),
    ).toMatchObject({
      kind: 'PROJETOS',
      activityType: 'Nenhum',
      task: 'Nenhum',
      duration: '07:30',
    });
  });
});

describe('B19 fora da API: caracterização isolada da assimetria anual Ruby', () => {
  it.each([
    ['2026-01-15', ['2025-01', '2025-12'], ['2025-01-01', '2026-01-15']],
    ['2026-02-15', ['2026-01', '2026-01'], ['2026-01-01', '2026-02-15']],
    ['2026-07-15', ['2026-01', '2026-06'], ['2026-01-01', '2026-07-15']],
    ['2026-12-31', ['2026-01', '2026-11'], ['2026-01-01', '2026-12-31']],
    ['2027-01-01', ['2026-01', '2026-12'], ['2026-01-01', '2027-01-01']],
  ] as const)(
    'documenta intervalos diferentes para hoje=%s sem expor modo anual no produto',
    (today, expectedAhgora, expectedChannel) => {
      expect(rubyAnnualCharacterization(today)).toEqual({
        ahgoraMonths: expectedAhgora,
        channelRange: expectedChannel,
      });
    },
  );
});

function rubyAnnualCharacterization(today: string): {
  readonly ahgoraMonths: readonly [string, string];
  readonly channelRange: readonly [string, string];
} {
  const [year, month, day] = today.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const previousMonth = month === 1 ? 12 : month - 1;
  const previousMonthYear = month === 1 ? year - 1 : year;
  const thirtyOneDaysEarlier = new Date(Date.UTC(year, month - 1, day - 31));
  return {
    ahgoraMonths: [
      `${String(previousMonthYear)}-01`,
      `${String(previousMonthYear)}-${String(previousMonth).padStart(2, '0')}`,
    ],
    channelRange: [
      `${String(thirtyOneDaysEarlier.getUTCFullYear())}-01-01`,
      today,
    ],
  };
}
