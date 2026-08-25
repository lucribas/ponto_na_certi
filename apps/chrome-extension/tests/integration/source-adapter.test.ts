import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  calculatePunchDays,
  civilDate,
  fixedClock,
  monthPeriod,
  rangePeriod,
  resolvePeriod,
} from '../../src/domain';
import {
  captureAhgora,
  captureAhgoraByApi,
  captureAhgoraMonthInDocument,
  parseMirrorCalendarText,
  probeAhgoraDocument,
  type AhgoraProbeDto,
  type FrameExecution,
  type InjectedMonthCaptureDto,
  type MonthCaptureInput,
  type SourceScriptRunner,
} from '../../src/sites/source';
import { makeMirrorCalendarText } from '../fixtures/source/mirror-calendar';

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Ahgora injected document functions', () => {
  it('repete GET seguro após falha transitória e conclui a captura da API', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ meses: { '2026-08': { referencia: 'ref' } } }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            dias: {
              '2026-08-20': {
                batidas: [{ hora: '08:00' }, { hora: '12:00' }],
              },
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const capture = captureAhgoraByApi({
      months: ['2026-08'],
      timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(250);

    await expect(capture).resolves.toMatchObject({
      ok: true,
      months: [
        {
          month: '2026-08',
          days: [{ date: '2026-08-20', times: ['08:00', '12:00'] }],
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('não repete uma resposta de autenticação recusada', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 401 }));

    await expect(
      captureAhgoraByApi({ months: ['2026-08'], timeoutMs: 1_000 }),
    ).resolves.toEqual({ ok: false, code: 'login-required' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignora marcações PREVISTA vazias ou preenchidas e preserva batidas realizadas', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ meses: { '2026-08': { referencia: '2026-08' } } }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            dias: {
              '2026-08-20': {
                batidas: [
                  { tipo: 'ONLINE', hora: '08:00' },
                  { tipo: 'PREVISTA', hora: '' },
                  { tipo: 'prevista', hora: '09:00' },
                  { tipo: 'MANUAL', hora: '12:00' },
                  { tipo: 'ORIGINAL', hora: '13:00' },
                  { tipo: 'ONLINE', hora: '17:00' },
                ],
              },
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const result = await captureAhgoraByApi({ months: ['2026-08'] });

    expect(result).toMatchObject({
      ok: true,
      months: [
        {
          days: [
            {
              date: '2026-08-20',
              times: ['08:00', '12:00', '13:00', '17:00'],
            },
          ],
        },
      ],
    });
  });

  it('recusa hora inválida de uma batida realizada no limite da API', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ meses: { '2026-08': { referencia: '2026-08' } } }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            dias: {
              '2026-08-20': {
                batidas: [{ tipo: 'ONLINE', hora: '' }],
              },
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );

    await expect(captureAhgoraByApi({ months: ['2026-08'] })).resolves.toEqual({
      ok: false,
      code: 'punch-time-invalid',
    });
  });

  it('detects only the page, login and mirror evidence present in the active Ruby', () => {
    document.title = 'Portal Ahgora';
    document.body.innerHTML =
      '<div id="boxLogin"></div><iframe id="mirror"></iframe>';
    expect(probeAhgoraDocument()).toEqual({
      titleMatches: true,
      loginForm: 'visible',
      mirrorElement: true,
      monthlySummary: false,
    });

    document.querySelector('#boxLogin')?.setAttribute('hidden', '');
    expect(probeAhgoraDocument().loginForm).toBe('hidden');
  });

  it('recognizes an already selected month and waits for the calendar marker', async () => {
    document.body.innerHTML = `
      <button>MONTHLY SUMMARY</button>
      <pre>Saturday\nAUGUST/2026\nMONTHLY SUMMARY\nHoras Trabalhadas</pre>
    `;

    await expect(
      captureAhgoraMonthInDocument({
        month: '2026-08',
        navigationYear: 2026,
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({ ok: true, selection: 'already-selected' });
  });

  it('changes the month and observes asynchronous calendar loading', async () => {
    document.body.innerHTML = `
      <button>JULY/2026</button>
      <button>chevron_left</button>
      <button>chevron_right</button>
      <button id="month">AUG</button>
      <button>MONTHLY SUMMARY</button>
      <pre id="content">Saturday\nMONTHLY SUMMARY</pre>
    `;
    document.querySelector('#month')?.addEventListener('click', () => {
      const content = document.querySelector('#content');
      if (content) content.textContent += '\nAUGUST/2026';
      globalThis.setTimeout(() => {
        if (content) content.textContent += '\nHoras Trabalhadas';
      }, 5);
    });

    await expect(
      captureAhgoraMonthInDocument({
        month: '2026-08',
        navigationYear: 2026,
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({ ok: true, selection: 'changed' });
  });

  it('waits for asynchronously rendered month choices after opening the selector', async () => {
    document.body.innerHTML = `
      <button id="selector">AUGUST/2026keyboard_arrow_down</button>
      <button>MONTHLY SUMMARY</button>
      <pre id="content">Saturday\nMONTHLY SUMMARY</pre>
    `;
    document.querySelector('#selector')?.addEventListener('click', () => {
      globalThis.setTimeout(() => {
        const month = document.createElement('button');
        month.id = 'month';
        month.textContent = 'JUL';
        month.addEventListener('click', () => {
          const content = document.querySelector('#content');
          if (content) content.textContent += '\nJULY/2026\nHoras Trabalhadas';
        });
        document.body.append(month);
      }, 5);
    });

    await expect(
      captureAhgoraMonthInDocument({
        month: '2026-07',
        navigationYear: 2026,
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({ ok: true, selection: 'changed' });
  });
});

describe('Ahgora textual calendar parser', () => {
  it('preserves even punches, omits empty days and reports odd punches', () => {
    const body = makeMirrorCalendarText('2026-08', {
      '2026-07-26': ['08:00', '12:00', '13:00', '17:00'],
      '2026-07-28': ['08:00', '12:00', '13:00'],
    });

    const parsed = parseMirrorCalendarText(body, '2026-08');
    expect(parsed.days.filter(({ times }) => times.length > 0)).toEqual([
      {
        date: '2026-07-26',
        times: ['08:00', '12:00', '13:00', '17:00'],
      },
      { date: '2026-07-28', times: ['08:00', '12:00', '13:00'] },
    ]);
    expect(parsed.warnings).toEqual([
      { kind: 'odd-punch-count', date: '2026-07-28', count: 3 },
    ]);
    expect(parsed.days).toContainEqual({
      date: '2026-07-27',
      times: [],
    });
  });

  it('preserves empty calendar days so a Ruby-compatible override can replace them', () => {
    const parsed = parseMirrorCalendarText(
      makeMirrorCalendarText('2026-08', {}),
      '2026-08',
    );
    const date = civilDate('2026-07-26');

    expect(
      calculatePunchDays(parsed.days, [
        { date, times: ['08:00', '12:00', '13:00', '17:00'] },
      ]).records,
    ).toContainEqual(
      expect.objectContaining({
        date,
        duration: '08:00',
        overridden: true,
      }),
    );
  });

  it('accepts the abbreviated weekday header used by the authenticated mirror', () => {
    const body = makeMirrorCalendarText('2026-08', {
      '2026-07-26': ['08:00', '12:00'],
    }).replace('Saturday', 'Sun\nMon\nTue\nWed\nThu\nFri\nSat');

    expect(parseMirrorCalendarText(body, '2026-08').days).toContainEqual({
      date: '2026-07-26',
      times: ['08:00', '12:00'],
    });
  });

  it('rejects incomplete textual calendars without returning page content', () => {
    expect(() =>
      parseMirrorCalendarText('Saturday\n1\nMONTHLY SUMMARY', '2026-08'),
    ).toThrow(/Dia 26\/07\/2026/);
  });
});

describe('Ahgora source adapter', () => {
  it('prefere a API direta e não consulta frames quando ela está disponível', async () => {
    const probe = vi.fn();
    const runner: SourceScriptRunner = {
      probe,
      capturePeriod: (_tabId, input) =>
        Promise.resolve({
          ok: true,
          months: input.months.map((month) => ({
            month,
            days: [
              {
                date: civilDate('2026-08-18'),
                times: ['08:00', '12:00', '13:00', '17:00'],
              },
            ],
          })),
        }),
    };

    const result = await captureAhgora(runner, {
      tabId: 42,
      today: civilDate('2026-08-22'),
      period: resolvePeriod(monthPeriod('2026-08'), fixedClock('2026-08-22')),
    });

    expect(result).toMatchObject({ ok: true, frameId: 0 });
    expect(probe).not.toHaveBeenCalled();
  });

  it('traduz contrato inválido da API em erro de dados não retentável', async () => {
    const result = await captureAhgora(
      {
        capturePeriod: () =>
          Promise.resolve({ ok: false, code: 'punch-time-invalid' }),
      },
      {
        tabId: 42,
        today: civilDate('2026-08-22'),
        period: resolvePeriod(monthPeriod('2026-08'), fixedClock('2026-08-22')),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'SOURCE_DATA_INVALID',
        stage: 'parse',
        retryable: false,
      },
    });
  });

  it('captures all required mirror months and filters an inclusive range', async () => {
    const runner = new SyntheticRunner({
      '2026-08': makeMirrorCalendarText('2026-08', {
        '2026-08-24': ['08:00', '12:00'],
        '2026-08-25': ['08:00', '12:00'],
      }),
      '2026-09': makeMirrorCalendarText('2026-09', {
        '2026-08-26': ['08:00', '12:00'],
        '2026-09-02': ['08:00', '12:00'],
        '2026-09-03': ['08:00', '12:00'],
      }),
    });
    const period = resolvePeriod(
      rangePeriod(civilDate('2026-08-25'), civilDate('2026-09-02')),
      fixedClock('2026-08-22'),
    );

    const result = await captureAhgora(runner, {
      tabId: 42,
      today: civilDate('2026-08-22'),
      period,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(runner.requestedMonths).toEqual(['2026-08', '2026-09']);
    expect(
      result.days
        .filter(({ times }) => times.length > 0)
        .map(({ date }) => date),
    ).toEqual(['2026-08-25', '2026-08-26', '2026-09-02']);
  });

  it('returns a sanitized activeTab/cross-origin limitation when no child frame is injectable', async () => {
    const runner = new SyntheticRunner({}, false);
    const result = await captureAhgora(runner, {
      tabId: 42,
      today: civilDate('2026-08-22'),
      period: resolvePeriod(monthPeriod('2026-08'), fixedClock('2026-08-22')),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MIRROR_FRAME_INACCESSIBLE');
    expect(result.error.stage).toBe('frame');
    expect(JSON.stringify(result)).not.toContain('Saturday');
  });

  it('reports the missing optional iframe permission with an actionable message', async () => {
    const runner: SourceScriptRunner = {
      probe: () => Promise.reject(new Error('MIRROR_HOST_PERMISSION_REQUIRED')),
      captureMonth: () => Promise.resolve({ frameId: 0 }),
    };
    const result = await captureAhgora(runner, {
      tabId: 42,
      today: civilDate('2026-08-22'),
      period: resolvePeriod(monthPeriod('2026-08'), fixedClock('2026-08-22')),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'MIRROR_HOST_PERMISSION_REQUIRED',
      stage: 'frame',
      retryable: true,
    });
    expect(result.error.message).toContain('Registre novamente');
  });
});

class SyntheticRunner implements SourceScriptRunner {
  readonly requestedMonths: string[] = [];

  constructor(
    private readonly calendars: Readonly<Record<string, string>>,
    private readonly includeMirrorFrame = true,
  ) {}

  probe(): Promise<readonly FrameExecution<AhgoraProbeDto>[]> {
    const results: FrameExecution<AhgoraProbeDto>[] = [
      {
        frameId: 0,
        result: {
          titleMatches: true,
          loginForm: 'absent',
          mirrorElement: true,
          monthlySummary: false,
        },
      },
    ];
    if (this.includeMirrorFrame) {
      results.push({
        frameId: 7,
        result: {
          titleMatches: false,
          loginForm: 'absent',
          mirrorElement: false,
          monthlySummary: true,
        },
      });
    }
    return Promise.resolve(results);
  }

  captureMonth(
    _tabId: number,
    frameId: number,
    input: MonthCaptureInput,
  ): Promise<FrameExecution<InjectedMonthCaptureDto>> {
    this.requestedMonths.push(input.month);
    const bodyText = this.calendars[input.month];
    return Promise.resolve({
      frameId,
      result: bodyText
        ? { ok: true, selection: 'changed', bodyText }
        : { ok: false, code: 'CALENDAR_LOAD_TIMEOUT' },
    });
  }
}
