import { civilDate } from '../../domain/civil-date';
import { parseDurationMinutes } from '../../domain/duration';
import type { CivilDate, ComparableWorkRecord } from '../../domain/types';
import {
  requiredElement,
  requiredInput,
  requiredSelect,
  selectExactOption,
  setInputValue,
} from './dom';
import { detectChannelPage } from './detection';
import { CHANNEL_SELECTORS } from './selectors';
import {
  ChannelAdapterError,
  waitForCondition,
  type WaitOptions,
} from './wait';

export interface ChannelExtractRow extends ComparableWorkRecord {
  readonly rowIndex: number;
}

export interface ChannelReadError {
  readonly rowIndex: number;
  readonly code: 'invalid-row';
}

export interface ChannelReadResult {
  readonly rows: readonly ChannelExtractRow[];
  readonly errors: readonly ChannelReadError[];
}

export interface ReadChannelExtractOptions extends WaitOptions {
  readonly startDate: string;
  readonly endDate: string;
}

export async function readChannelExtract(
  document: Document,
  options: ReadChannelExtractOptions,
): Promise<ChannelReadResult> {
  assertReadablePage(document);

  const pageSize = requiredSelect(
    document,
    CHANNEL_SELECTORS.pageSize,
    'Seletor de paginação',
  );
  if (!selectExactOption(pageSize, 'Não paginar')) {
    throw new ChannelAdapterError(
      'not-found',
      'Opção Não paginar não encontrada no Channel.',
    );
  }

  const content = requiredElement(
    document,
    CHANNEL_SELECTORS.content,
    'Conteúdo do extrato',
  );
  const startDate = requiredInput(
    content,
    CHANNEL_SELECTORS.startDate,
    'Data inicial',
  );
  const endDate = requiredInput(
    content,
    CHANNEL_SELECTORS.endDate,
    'Data final',
  );
  const filter = requiredElement(
    document,
    CHANNEL_SELECTORS.filter,
    'Ação Filtrar',
  );
  const previousReport = document.querySelector<HTMLElement>(
    CHANNEL_SELECTORS.extractRows,
  );
  const previousText = normalizedText(previousReport);

  setInputValue(startDate, options.startDate);
  setInputValue(endDate, options.endDate);
  filter.click();

  const report = await waitForCondition(
    () => {
      const current = document.querySelector<HTMLElement>(
        CHANNEL_SELECTORS.extractRows,
      );
      if (!current) return undefined;
      if (
        !previousReport ||
        current !== previousReport ||
        normalizedText(current) !== previousText
      ) {
        return current;
      }
      return undefined;
    },
    'atualização do extrato',
    options,
  ).catch((error: unknown) => {
    if (error instanceof ChannelAdapterError && error.code === 'timeout') {
      throw new ChannelAdapterError(
        'report-not-refreshed',
        'O extrato não apresentou uma atualização observável após Filtrar.',
      );
    }
    throw error;
  });

  return parseChannelExtract(report.textContent);
}

export function parseChannelExtract(text: string): ChannelReadResult {
  const rows: ChannelExtractRow[] = [];
  const errors: ChannelReadError[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  lines.forEach((line, rowIndex) => {
    const [rawDate, duration] = line.split(/\s+/);
    try {
      if (!rawDate || !duration) throw new Error('linha incompleta');
      rows.push({
        rowIndex,
        date: parseBrazilianDate(rawDate),
        duration,
        durationMinutes: parseDurationMinutes(duration),
      });
    } catch {
      errors.push({ rowIndex, code: 'invalid-row' });
    }
  });

  return { rows, errors };
}

function assertReadablePage(document: Document): void {
  const state = detectChannelPage(document);
  if (state === 'login') {
    throw new ChannelAdapterError(
      'login-required',
      'Autentique-se na aba do Channel.',
    );
  }
  if (state === 'entry-form') {
    throw new ChannelAdapterError(
      'entry-form-open',
      'Feche ou cancele o formulário de apontamento e abra o Extrato do Channel.',
    );
  }
  if (state === 'unknown') {
    throw new ChannelAdapterError(
      'not-channel-page',
      'Página do Channel não reconhecida.',
    );
  }
}

function parseBrazilianDate(value: string): CivilDate {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) throw new Error('data inválida');
  const day = match[1];
  const month = match[2];
  const year = match[3];
  if (!day || !month || !year) throw new Error('data inválida');
  return civilDate(`${year}-${month}-${day}`);
}

function normalizedText(element: HTMLElement | null): string {
  return element === null ? '' : element.textContent.trim();
}
