import type { ResolvedPeriod } from '../../domain';
import type {
  GoogleCalendarInfo,
  GoogleCalendarSettings,
} from '../../application/settings';
import type { CalendarEvent } from '../../application/google-calendar';

export interface GoogleCalendarGateway {
  connect(): Promise<{
    readonly email?: string;
    readonly calendars: readonly GoogleCalendarInfo[];
  }>;
  disconnect(): Promise<void>;
  listEvents(
    period: ResolvedPeriod,
    calendarIds: readonly string[],
  ): Promise<readonly CalendarEvent[]>;
}

interface GoogleCalendarListResponse {
  readonly items?: readonly {
    readonly id?: string;
    readonly summary?: string;
    readonly primary?: boolean;
  }[];
  readonly nextPageToken?: string;
}

interface GoogleEventsResponse {
  readonly items?: readonly GoogleEventResource[];
  readonly nextPageToken?: string;
}

interface GoogleEventResource {
  readonly id?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly status?: string;
  readonly transparency?: string;
  readonly start?: { readonly dateTime?: string; readonly date?: string };
  readonly end?: { readonly dateTime?: string; readonly date?: string };
  readonly attendees?: readonly {
    readonly self?: boolean;
    readonly responseStatus?: string;
    readonly email?: string;
  }[];
}

const API = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_CALENDAR_API_ORIGIN = 'https://www.googleapis.com/*';

export async function requestGoogleCalendarApiAccess(): Promise<boolean> {
  return chrome.permissions.request({
    origins: [GOOGLE_CALENDAR_API_ORIGIN],
  });
}

export class ChromeGoogleCalendarClient implements GoogleCalendarGateway {
  async connect(): Promise<{
    email?: string;
    calendars: readonly GoogleCalendarInfo[];
  }> {
    const token = await authToken(true);
    const items = await readCalendarList(token);
    const calendars = items.flatMap((item) =>
      item.id && item.summary
        ? [
            {
              id: item.id,
              name: item.summary,
              ...(item.primary ? { primary: true } : {}),
            },
          ]
        : [],
    );
    const email = items
      .flatMap((item) => item.id ?? [])
      .find((id) => id.includes('@'));
    return { ...(email ? { email } : {}), calendars };
  }

  async disconnect(): Promise<void> {
    await chrome.identity.clearAllCachedAuthTokens();
    await chrome.permissions.remove({
      origins: [GOOGLE_CALENDAR_API_ORIGIN],
    });
  }

  async listEvents(
    period: ResolvedPeriod,
    calendarIds: readonly string[],
  ): Promise<readonly CalendarEvent[]> {
    const token = await authToken(false);
    const timeMin = new Date(`${period.start}T00:00:00`).toISOString();
    const end = new Date(`${period.end}T00:00:00`);
    end.setDate(end.getDate() + 1);
    const timeMax = end.toISOString();
    const pages = await Promise.all(
      calendarIds.map((calendarId) =>
        readCalendarEvents(calendarId, timeMin, timeMax, token),
      ),
    );
    return pages.flat();
  }
}

async function readCalendarList(
  token: string,
): Promise<NonNullable<GoogleCalendarListResponse['items']>> {
  const items: NonNullable<GoogleCalendarListResponse['items']>[number][] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      minAccessRole: 'reader',
      ...(pageToken ? { pageToken } : {}),
    });
    const response = await apiGet<GoogleCalendarListResponse>(
      `${API}/users/me/calendarList?${query.toString()}`,
      token,
    );
    items.push(...(response.items ?? []));
    pageToken = response.nextPageToken;
  } while (pageToken);
  return items;
}

export function calendarCaptureEnabled(
  settings?: GoogleCalendarSettings,
): boolean {
  if (!settings) return false;
  return (
    (settings.enabled ?? settings.connected) &&
    settings.connected &&
    settings.selectedCalendarIds.length > 0 &&
    settings.rules.some((rule) => rule.enabled)
  );
}

async function readCalendarEvents(
  calendarId: string,
  timeMin: string,
  timeMax: string,
  token: string,
): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      ...(pageToken ? { pageToken } : {}),
    });
    const response = await apiGet<GoogleEventsResponse>(
      `${API}/calendars/${encodeURIComponent(calendarId)}/events?${query.toString()}`,
      token,
    );
    for (const item of response.items ?? []) {
      const normalized = normalizeEvent(calendarId, item);
      if (normalized) events.push(normalized);
    }
    pageToken = response.nextPageToken;
  } while (pageToken);
  return events;
}

function normalizeEvent(
  calendarId: string,
  item: GoogleEventResource,
): CalendarEvent | undefined {
  if (!item.id || !item.start || !item.end) return undefined;
  const allDay = item.start.date !== undefined;
  const start =
    item.start.dateTime ??
    (item.start.date ? `${item.start.date}T00:00:00` : undefined);
  const end =
    item.end.dateTime ??
    (item.end.date ? `${item.end.date}T00:00:00` : undefined);
  if (!start || !end) return undefined;
  const self = item.attendees?.find((attendee) => attendee.self);
  return {
    id: item.id,
    calendarId,
    title: item.summary ?? '',
    start,
    end,
    allDay,
    ...(item.description ? { description: item.description } : {}),
    ...(item.location ? { location: item.location } : {}),
    ...(item.status ? { status: item.status } : {}),
    ...(item.transparency ? { transparency: item.transparency } : {}),
    ...(self?.responseStatus
      ? { selfResponseStatus: self.responseStatus }
      : {}),
  };
}

async function authToken(interactive: boolean): Promise<string> {
  if (!googleOAuthConfigured())
    throw new Error(
      'Google Calendar não configurado nesta extensão. Defina GOOGLE_OAUTH_CLIENT_ID durante o build.',
    );
  const result = await chrome.identity.getAuthToken({ interactive });
  if (!result.token) throw new Error('Conecte novamente sua conta Google.');
  return result.token;
}

export function googleOAuthConfigured(): boolean {
  return Boolean(chrome.runtime.getManifest().oauth2?.client_id.trim());
}

async function apiGet<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    if (response.status === 401)
      await chrome.identity.removeCachedAuthToken({ token });
    throw new Error(
      response.status === 401
        ? 'A sessão do Google Calendar expirou. Reconecte sua conta.'
        : `Falha ao consultar Google Calendar (${String(response.status)}).`,
    );
  }
  return (await response.json()) as T;
}
