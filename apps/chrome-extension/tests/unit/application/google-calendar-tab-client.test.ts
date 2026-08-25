import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  calendarArchiveEvents,
  calendarArchiveInfo,
  fetchGoogleCalendarExport,
  requestGoogleCalendarTabAccess,
} from '../../../src/sites/google-calendar';
import { civilDate, rangePeriod, resolvePeriod } from '../../../src/domain';

afterEach(() => vi.unstubAllGlobals());

const recurringCalendar = `BEGIN:VCALENDAR\r
VERSION:2.0\r
X-WR-CALNAME:Equipe\\, Produto\r
BEGIN:VEVENT\r
UID:daily-1\r
DTSTART;TZID=America/Sao_Paulo:20260824T090000\r
DTEND;TZID=America/Sao_Paulo:20260824T093000\r
RRULE:FREQ=DAILY;COUNT=3\r
SUMMARY:Daily do Produto\r
DESCRIPTION:Alinhamento diário\r
LOCATION:Sala 1\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:daily-1\r
RECURRENCE-ID;TZID=America/Sao_Paulo:20260825T090000\r
DTSTART;TZID=America/Sao_Paulo:20260825T100000\r
DTEND;TZID=America/Sao_Paulo:20260825T104500\r
SUMMARY:Daily movida\r
END:VEVENT\r
END:VCALENDAR\r
`;

function archive(files: Readonly<Record<string, string>>): string {
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
      ),
    ),
  ).toString('base64');
}

describe('Google Calendar pela aba autenticada', () => {
  it('lista calendários do ZIP sem guardar conteúdo de eventos', () => {
    expect(
      calendarArchiveInfo(
        archive({
          'equipe.ics': recurringCalendar,
          'Pessoal.ics': recurringCalendar.replace(
            'Equipe\\, Produto',
            'Pessoal',
          ),
          'ignorar.txt': 'fora do contrato',
        }),
      ),
    ).toEqual([
      { id: 'tab:equipe.ics', name: 'Equipe, Produto' },
      { id: 'tab:Pessoal.ics', name: 'Pessoal' },
    ]);
  });

  it('expande recorrências, aplica exceções e filtra período e calendário', () => {
    const period = resolvePeriod(
      rangePeriod(civilDate('2026-08-24'), civilDate('2026-08-26')),
      { today: () => civilDate('2026-08-24') },
    );
    const events = calendarArchiveEvents(
      archive({ 'equipe.ics': recurringCalendar }),
      period,
      ['tab:equipe.ics'],
    );

    expect(events).toHaveLength(3);
    expect(events.map((event) => event.title)).toEqual([
      'Daily do Produto',
      'Daily movida',
      'Daily do Produto',
    ]);
    expect(events[1]).toMatchObject({
      start: '2026-08-25T13:00:00.000Z',
      end: '2026-08-25T13:45:00.000Z',
    });
    expect(
      calendarArchiveEvents(
        archive({ 'equipe.ics': recurringCalendar }),
        period,
        ['tab:outro.ics'],
      ),
    ).toEqual([]);
  });

  it('executa o GET na origem e na conta da própria aba', async () => {
    const zip = Buffer.from(
      zipSync({ 'equipe.ics': strToU8(recurringCalendar) }),
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(zip, {
        headers: { 'content-type': 'application/zip' },
      }),
    );
    vi.stubGlobal('location', {
      origin: 'https://calendar.google.com',
      pathname: '/calendar/u/2/r/week',
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchGoogleCalendarExport();

    expect(result).toMatchObject({ ok: true, byteLength: zip.byteLength });
    expect((fetchMock.mock.calls[0]?.[0] as URL).href).toBe(
      'https://calendar.google.com/calendar/exporticalzip?authuser=2',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      credentials: 'include',
    });
  });

  it('pede apenas o host web exato no gesto do usuário', async () => {
    const request = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('chrome', { permissions: { request } });

    await expect(requestGoogleCalendarTabAccess()).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({
      origins: ['https://calendar.google.com/*'],
    });
  });
});
