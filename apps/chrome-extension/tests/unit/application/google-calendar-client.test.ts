import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  calendarCaptureEnabled,
  ChromeGoogleCalendarClient,
  requestGoogleCalendarApiAccess,
} from '../../../src/sites/google-calendar';
import { civilDate, resolvePeriod, rangePeriod } from '../../../src/domain';

afterEach(() => vi.unstubAllGlobals());

describe('cliente Google Calendar', () => {
  it('só participa da captura quando uso, conexão, calendário e regra estão ativos', () => {
    const activeRule = {
      id: 'daily',
      name: 'Daily',
      enabled: true,
      calendarIds: ['primary'],
      fields: ['title' as const],
      matchMode: 'any' as const,
      phrases: ['daily'],
      excludedPhrases: [],
      ignoreCancelled: true,
      ignoreDeclined: true,
      ignoreAllDay: true,
      busyOnly: true,
    };
    const configured = {
      enabled: true,
      accessMode: 'oauth' as const,
      connected: true,
      calendars: [{ id: 'primary', name: 'Principal' }],
      selectedCalendarIds: ['primary'],
      rules: [activeRule],
    };

    expect(calendarCaptureEnabled(configured)).toBe(true);
    expect(calendarCaptureEnabled({ ...configured, enabled: false })).toBe(
      false,
    );
    expect(calendarCaptureEnabled({ ...configured, connected: false })).toBe(
      false,
    );
    expect(
      calendarCaptureEnabled({ ...configured, selectedCalendarIds: [] }),
    ).toBe(false);
    expect(
      calendarCaptureEnabled({
        ...configured,
        rules: [{ ...activeRule, enabled: false }],
      }),
    ).toBe(false);
  });

  it('autentica por chrome.identity, lista calendários e pagina eventos', async () => {
    const getAuthToken = vi.fn().mockResolvedValue({ token: 'token-test' });
    vi.stubGlobal('chrome', {
      runtime: {
        getManifest: () => ({
          oauth2: { client_id: 'test.apps.googleusercontent.com' },
        }),
      },
      identity: {
        getAuthToken,
        removeCachedAuthToken: vi.fn(),
        clearAllCachedAuthTokens: vi.fn(),
      },
      permissions: { request: vi.fn(), remove: vi.fn() },
    });
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes('calendarList') && !url.includes('pageToken'))
        return new Response(
          JSON.stringify({
            items: [
              { id: 'user@example.com', summary: 'Principal', primary: true },
            ],
            nextPageToken: 'page-2',
          }),
        );
      if (url.includes('calendarList'))
        return new Response(
          JSON.stringify({
            items: [{ id: 'team', summary: 'Equipe' }],
          }),
        );
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'evt',
              summary: 'Daily',
              start: { dateTime: '2026-08-24T09:00:00-03:00' },
              end: { dateTime: '2026-08-24T09:30:00-03:00' },
              attendees: [{ self: true, responseStatus: 'accepted' }],
            },
          ],
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new ChromeGoogleCalendarClient();

    await expect(client.connect()).resolves.toEqual({
      email: 'user@example.com',
      calendars: [
        { id: 'user@example.com', name: 'Principal', primary: true },
        { id: 'team', name: 'Equipe' },
      ],
    });
    const period = resolvePeriod(
      rangePeriod(civilDate('2026-08-24'), civilDate('2026-08-24')),
      { today: () => civilDate('2026-08-24') },
    );
    await expect(
      client.listEvents(period, ['user@example.com']),
    ).resolves.toMatchObject([
      { id: 'evt', calendarId: 'user@example.com', title: 'Daily' },
    ]);
    expect(getAuthToken).toHaveBeenNthCalledWith(1, { interactive: true });
    expect(getAuthToken).toHaveBeenNthCalledWith(2, { interactive: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('informa quando o OAuth não foi configurado no build', async () => {
    const getAuthToken = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({}) },
      identity: { getAuthToken, removeCachedAuthToken: vi.fn() },
      permissions: { request: vi.fn(), remove: vi.fn() },
    });

    await expect(new ChromeGoogleCalendarClient().connect()).rejects.toThrow(
      'GOOGLE_OAUTH_CLIENT_ID',
    );
    expect(getAuthToken).not.toHaveBeenCalled();
  });

  it('solicita o host da API no gesto de conexão', async () => {
    const request = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('chrome', { permissions: { request } });

    await expect(requestGoogleCalendarApiAccess()).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({
      origins: ['https://www.googleapis.com/*'],
    });
  });

  it('desautoriza a conta e libera o host ao desconectar', async () => {
    const clearAllCachedAuthTokens = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('chrome', {
      identity: { clearAllCachedAuthTokens },
      permissions: { remove },
    });

    await expect(
      new ChromeGoogleCalendarClient().disconnect(),
    ).resolves.toBeUndefined();
    expect(clearAllCachedAuthTokens).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith({
      origins: ['https://www.googleapis.com/*'],
    });
  });
});
