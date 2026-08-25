import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assignExpertProject,
  calculatePunchDays,
  civilDate,
  compareAhgoraWithChannel,
  formatRubyDurationMinutes,
} from '../../src/domain';

const oraclePath = resolve(
  import.meta.dirname,
  '../fixtures/ruby-domain-oracle.rb',
);
const legacySourceAvailable = ['Ahgora.rb', 'Expert.rb'].every((file) =>
  existsSync(resolve(import.meta.dirname, '../../../standalone/source', file)),
);

function rubyOracle(request: Record<string, unknown>): unknown {
  const result = spawnSync('ruby', [oraclePath], {
    encoding: 'utf8',
    input: JSON.stringify(request),
  });
  if (result.status !== 0) {
    throw new Error(`Ruby oracle failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as unknown;
}

describe.skipIf(!legacySourceAvailable)('actual Ruby source oracle', () => {
  it('matches permissive clock arithmetic and Ruby negative formatting', () => {
    expect(
      rubyOracle({
        action: 'time_to_minutes',
        values: ['08:05', '29:75', '09:00'],
      }),
    ).toEqual([485, 1815, 540]);
    expect(rubyOracle({ action: 'negative_format', minutes: -30 })).toBe(
      '-1:30',
    );
    expect(formatRubyDurationMinutes(-30)).toBe('-1:30');
  });

  it('matches first duplicate override and literal inverted-pair calculation', () => {
    const raw = '18/08/2026=09:00,08:30;18/08/2026=08:00,17:00';
    expect(rubyOracle({ action: 'override', raw, date: '2026-08-18' })).toEqual(
      ['09:00', '08:30'],
    );

    const calculated = calculatePunchDays(
      [{ date: civilDate('2026-08-18'), times: ['08:00', '17:00'] }],
      [
        { date: civilDate('2026-08-18'), times: ['09:00', '08:30'] },
        { date: civilDate('2026-08-18'), times: ['08:00', '17:00'] },
      ],
    );
    expect(calculated.records[0]?.duration).toBe('-1:30');
  });

  it('matches textual last-row comparison instead of normalized minutes', () => {
    const ahgora = [{ date: '2026-08-18', duration: '08:00' }];
    const channel = [
      { date: '2026-08-18', duration: '07:00' },
      { date: '2026-08-18', duration: '8:00' },
      { date: '2026-08-19', duration: '08:00' },
    ];
    expect(rubyOracle({ action: 'comparison', ahgora, channel })).toEqual([
      { date: '2026-08-18', status: 'divergent' },
    ]);
    expect(
      compareAhgoraWithChannel(
        [
          {
            date: civilDate('2026-08-18'),
            durationMinutes: 480,
            duration: '08:00',
          },
        ],
        channel.map((row) => ({
          date: civilDate(row.date),
          durationMinutes: 480,
          duration: row.duration,
        })),
      ).map(({ date, status }) => ({ date, status })),
    ).toEqual([{ date: '2026-08-18', status: 'divergent' }]);
  });

  it('matches the active Expert assignment and its non-positive barrier', () => {
    const request = {
      action: 'expert',
      date: '18/08/2026',
      duration: '07:30',
      config: { project: 'SYNTHETIC-PROJECT', activity: 'SYNTHETIC-ACTIVITY' },
    };
    const ruby = rubyOracle(request) as {
      value: Array<Record<string, string>>;
    };
    const typescript = assignExpertProject(
      { date: civilDate('2026-08-18'), durationMinutes: 450 },
      { project: 'SYNTHETIC-PROJECT', activity: 'SYNTHETIC-ACTIVITY' },
    );
    expect(ruby.value[0]?.Projeto).toBe(typescript.project);
    expect(ruby.value[0]?.['Associar Atividade']).toBe(typescript.activity);
    expect(ruby.value[0]?.Duração).toBe(typescript.duration);
    expect(rubyOracle({ ...request, duration: '-00:30' })).toMatchObject({
      error: 'ArgumentError',
    });
    expect(() =>
      assignExpertProject(
        { date: civilDate('2026-08-18'), durationMinutes: -30 },
        { project: 'SYNTHETIC-PROJECT', activity: 'SYNTHETIC-ACTIVITY' },
      ),
    ).toThrow(/maior que zero/);
  });
});
