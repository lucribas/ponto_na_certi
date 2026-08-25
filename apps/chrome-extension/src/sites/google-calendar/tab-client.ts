import ICAL from 'ical.js';
import { unzipSync } from 'fflate';

import type { CalendarEvent } from '../../application/google-calendar';
import type { GoogleCalendarInfo } from '../../application/settings';
import type { ResolvedPeriod } from '../../domain';
import {
  fetchGoogleCalendarExport,
  type GoogleCalendarExportResult,
} from './tab-injected';

export const GOOGLE_CALENDAR_WEB_ORIGIN = 'https://calendar.google.com/*';
const MAX_OCCURRENCES_PER_CALENDAR = 10_000;
const MAX_UNCOMPRESSED_EXPORT_BYTES = 96 * 1024 * 1024;

export async function requestGoogleCalendarTabAccess(): Promise<boolean> {
  return chrome.permissions.request({ origins: [GOOGLE_CALENDAR_WEB_ORIGIN] });
}

export async function removeGoogleCalendarTabAccess(): Promise<void> {
  await chrome.permissions.remove({ origins: [GOOGLE_CALENDAR_WEB_ORIGIN] });
}

export class ChromeGoogleCalendarTabClient {
  async connect(tabId: number): Promise<{
    readonly calendars: readonly GoogleCalendarInfo[];
  }> {
    const archive = await this.fetchArchive(tabId);
    const calendars = calendarArchiveInfo(archive);
    if (calendars.length === 0)
      throw new Error(
        'O Google Calendar não exportou nenhum calendário disponível para esta conta.',
      );
    return { calendars };
  }

  async listEvents(
    tabId: number,
    period: ResolvedPeriod,
    calendarIds: readonly string[],
  ): Promise<readonly CalendarEvent[]> {
    return calendarArchiveEvents(
      await this.fetchArchive(tabId),
      period,
      calendarIds,
    );
  }

  private async fetchArchive(tabId: number): Promise<string> {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: fetchGoogleCalendarExport,
    });
    const result: GoogleCalendarExportResult = execution?.result ?? {
      ok: false,
      code: 'network-error',
    };
    console.info('[PontoNaCerti][GoogleCalendarTabRunner]', {
      status: result.ok ? 'ok' : 'failed',
      tabId,
      code: result.ok ? undefined : result.code,
      byteLength: result.ok ? result.byteLength : undefined,
    });
    if (!result.ok) throw new Error(calendarExportFailureMessage(result.code));
    return result.archiveBase64;
  }
}

export function calendarArchiveInfo(
  archiveBase64: string,
): readonly GoogleCalendarInfo[] {
  return readIcsFiles(archiveBase64).map(({ id, name }) => ({ id, name }));
}

export function calendarArchiveEvents(
  archiveBase64: string,
  period: ResolvedPeriod,
  selectedCalendarIds: readonly string[],
): readonly CalendarEvent[] {
  const selected = new Set(selectedCalendarIds);
  const start = new Date(`${period.start}T00:00:00`).getTime();
  const endExclusiveDate = new Date(`${period.end}T00:00:00`);
  endExclusiveDate.setDate(endExclusiveDate.getDate() + 1);
  const endExclusive = endExclusiveDate.getTime();
  return readIcsFiles(archiveBase64).flatMap((file) =>
    selected.has(file.id)
      ? eventsFromIcs(file.id, file.text, start, endExclusive)
      : [],
  );
}

interface IcsFile {
  readonly id: string;
  readonly name: string;
  readonly text: string;
}

function readIcsFiles(archiveBase64: string): readonly IcsFile[] {
  let binary: string;
  try {
    binary = atob(archiveBase64);
  } catch {
    throw new Error(
      'A aba do Google Calendar retornou uma exportação inválida.',
    );
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let files: Record<string, Uint8Array>;
  let expandedBytes = 0;
  const expansionLimitError = new Error(
    'A exportação descompactada do Google Calendar excede o limite seguro de 96 MB.',
  );
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        if (!file.name.toLocaleLowerCase('en-US').endsWith('.ics'))
          return false;
        expandedBytes += file.originalSize;
        if (expandedBytes <= MAX_UNCOMPRESSED_EXPORT_BYTES) return true;
        throw expansionLimitError;
      },
    });
  } catch (error) {
    if (error === expansionLimitError) throw error;
    throw new Error('Não foi possível abrir a exportação do Google Calendar.', {
      cause: error,
    });
  }
  const decoder = new TextDecoder();
  return Object.entries(files)
    .filter(([filename]) =>
      filename.toLocaleLowerCase('en-US').endsWith('.ics'),
    )
    .map(([filename, content]) => {
      const text = decoder.decode(content);
      const basename = filename.split('/').pop() ?? filename;
      return {
        id: `tab:${encodeURIComponent(filename)}`,
        name: calendarName(text) ?? basename.replace(/\.ics$/i, ''),
        text,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
}

function calendarName(text: string): string | undefined {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const match = /^X-WR-CALNAME(?:;[^:]*)?:(.*)$/im.exec(unfolded)?.[1]?.trim();
  return match ? unescapeIcsText(match) : undefined;
}

function eventsFromIcs(
  calendarId: string,
  text: string,
  periodStart: number,
  periodEndExclusive: number,
): readonly CalendarEvent[] {
  let root: ICAL.Component;
  try {
    root = ICAL.Component.fromString(text);
  } catch {
    throw new Error(
      'Um calendário exportado contém dados iCalendar inválidos.',
    );
  }
  const components = root.getAllSubcomponents('vevent');
  const masters = new Map<string, ICAL.Event>();
  const detached: ICAL.Event[] = [];
  for (const component of components) {
    const event = new ICAL.Event(component);
    if (component.hasProperty('recurrence-id')) detached.push(event);
    else masters.set(event.uid, event);
  }

  const output: CalendarEvent[] = [];
  let occurrenceCount = 0;
  for (const event of masters.values()) {
    if (!event.isRecurring()) {
      appendOccurrence(
        output,
        calendarId,
        event,
        event.startDate,
        event.endDate,
        periodStart,
        periodEndExclusive,
      );
      continue;
    }
    const iterator = event.iterator();
    let occurrence = iterator.next() as ICAL.Time | undefined;
    while (occurrence !== undefined) {
      occurrenceCount += 1;
      if (occurrenceCount > MAX_OCCURRENCES_PER_CALENDAR)
        throw new Error(
          'O calendário exportado possui recorrências demais para uma captura segura.',
        );
      const details = event.getOccurrenceDetails(occurrence);
      const occurrenceStart = details.startDate.toJSDate().getTime();
      if (occurrenceStart >= periodEndExclusive) break;
      appendOccurrence(
        output,
        calendarId,
        details.item,
        details.startDate,
        details.endDate,
        periodStart,
        periodEndExclusive,
      );
      occurrence = iterator.next();
    }
  }
  // Exceções sem evento mestre ainda representam ocorrências reais.
  for (const event of detached) {
    if (masters.has(event.uid)) continue;
    appendOccurrence(
      output,
      calendarId,
      event,
      event.startDate,
      event.endDate,
      periodStart,
      periodEndExclusive,
    );
  }
  return output.sort((left, right) => left.start.localeCompare(right.start));
}

function appendOccurrence(
  output: CalendarEvent[],
  calendarId: string,
  event: ICAL.Event,
  start: ICAL.Time,
  end: ICAL.Time,
  periodStart: number,
  periodEndExclusive: number,
): void {
  const startMs = start.toJSDate().getTime();
  const endMs = end.toJSDate().getTime();
  if (endMs <= periodStart || startMs >= periodEndExclusive) return;
  const property = (name: string): string | undefined => {
    const value = event.component.getFirstPropertyValue(name);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  const status = property('status')?.toLocaleLowerCase('en-US');
  const transparency = property('transp')?.toLocaleLowerCase('en-US');
  output.push({
    id: `${event.uid}::${start.toICALString()}`,
    calendarId,
    title: event.summary,
    start: start.toJSDate().toISOString(),
    end: end.toJSDate().toISOString(),
    allDay: start.isDate,
    ...(event.description ? { description: event.description } : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(status ? { status } : {}),
    ...(transparency ? { transparency } : {}),
  });
}

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function calendarExportFailureMessage(
  code: Exclude<GoogleCalendarExportResult, { ok: true }>['code'],
): string {
  return {
    'invalid-calendar-origin':
      'A aba registrada não pertence ao Google Calendar.',
    'login-required':
      'Conclua o login na aba do Google Calendar e tente conectar novamente.',
    'export-forbidden':
      'A conta ou o administrador bloqueou a exportação do Google Calendar.',
    'export-too-large':
      'A exportação do Google Calendar excede o limite seguro de 32 MB.',
    'invalid-export':
      'O Google Calendar não retornou um arquivo de exportação válido. Confirme o login na aba.',
    'network-error':
      'Não foi possível consultar a exportação pela aba do Google Calendar.',
  }[code];
}
