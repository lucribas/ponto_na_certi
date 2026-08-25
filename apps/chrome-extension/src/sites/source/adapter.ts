import {
  compareCivilDates,
  type CivilDate,
  type ResolvedPeriod,
} from '../../domain';
import { filterParsedDays, parseMirrorCalendarText } from './calendar';
import type {
  AhgoraSourceErrorCode,
  AhgoraSourceErrorDto,
  CaptureAhgoraResult,
  FrameExecution,
  AhgoraProbeDto,
  SourceScriptRunner,
} from './contracts';

export interface CaptureAhgoraRequest {
  readonly tabId: number;
  readonly today: CivilDate;
  readonly period: ResolvedPeriod;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export async function captureAhgora(
  runner: SourceScriptRunner,
  request: CaptureAhgoraRequest,
): Promise<CaptureAhgoraResult> {
  if (request.signal?.aborted) return failure('CANCELLED', 'detect', false);

  if (runner.capturePeriod) {
    const direct = await runner.capturePeriod(request.tabId, {
      months: request.period.mirrorMonths,
      ...(request.timeoutMs === undefined
        ? {}
        : { timeoutMs: request.timeoutMs }),
    });
    if (!direct.ok) {
      if (direct.code === 'login-required')
        return failure('LOGIN_REQUIRED', 'detect', true);
      if (direct.code === 'month-not-available')
        return failure('MONTH_NOT_AVAILABLE', 'parse', false);
      if (
        direct.code === 'api-contract-invalid' ||
        direct.code === 'punch-time-invalid'
      )
        return failure('SOURCE_DATA_INVALID', 'parse', false);
      return failure('SCRIPT_INJECTION_FAILED', 'parse', true);
    }
    const days = direct.months
      .flatMap((month) => month.days)
      .filter(
        ({ date }) =>
          compareCivilDates(date, request.period.start) >= 0 &&
          compareCivilDates(date, request.period.end) <= 0,
      );
    const warnings = days.flatMap(({ date, times }) =>
      times.length % 2 === 0
        ? []
        : [{ kind: 'odd-punch-count' as const, date, count: times.length }],
    );
    return {
      ok: true,
      tabId: request.tabId,
      frameId: 0,
      months: direct.months.map(({ month, days: monthDays }) => ({
        month,
        days: monthDays,
        warnings: monthDays.flatMap(({ date, times }) =>
          times.length % 2 === 0
            ? []
            : [{ kind: 'odd-punch-count' as const, date, count: times.length }],
        ),
      })),
      days,
      warnings,
      realDomValidation: 'manual-validation-pending',
    };
  }

  let probes: readonly FrameExecution<AhgoraProbeDto>[];
  try {
    if (!runner.probe) throw new Error('SOURCE_RUNNER_UNAVAILABLE');
    probes = await runner.probe(request.tabId);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'MIRROR_HOST_PERMISSION_REQUIRED'
    ) {
      return failure('MIRROR_HOST_PERMISSION_REQUIRED', 'frame', true);
    }
    return failure('SCRIPT_INJECTION_FAILED', 'detect', true);
  }

  const top = probes.find(({ frameId }) => frameId === 0)?.result;
  if (!top?.titleMatches) {
    return failure('PAGE_NOT_RECOGNIZED', 'detect', false);
  }
  if (top.loginForm === 'visible') {
    return failure('LOGIN_REQUIRED', 'detect', true);
  }
  if (!top.mirrorElement) {
    return failure('MIRROR_FRAME_NOT_FOUND', 'frame', true);
  }

  const mirrorFrames = probes.filter(
    ({ frameId, result }) => frameId !== 0 && result?.monthlySummary,
  );
  if (mirrorFrames.length === 0) {
    return failure('MIRROR_FRAME_INACCESSIBLE', 'frame', true);
  }
  if (mirrorFrames.length > 1) {
    return failure('MIRROR_FRAME_AMBIGUOUS', 'frame', false);
  }
  const frameId = mirrorFrames[0]?.frameId;
  if (frameId === undefined) {
    return failure('MIRROR_FRAME_INACCESSIBLE', 'frame', true);
  }

  const months = [];
  for (const month of request.period.mirrorMonths) {
    if (request.signal?.aborted) {
      return failure('CANCELLED', 'select-month', false);
    }

    let execution;
    try {
      if (!runner.captureMonth) throw new Error('SOURCE_RUNNER_UNAVAILABLE');
      execution = await runner.captureMonth(request.tabId, frameId, {
        month,
        navigationYear: Number(request.today.slice(0, 4)),
        timeoutMs: request.timeoutMs ?? 30_000,
      });
    } catch {
      return failure('SCRIPT_INJECTION_FAILED', 'select-month', true);
    }
    if (!execution.result) {
      return failure('SCRIPT_INJECTION_FAILED', 'select-month', true);
    }
    if (!execution.result.ok) {
      return failure(execution.result.code, 'select-month', true);
    }

    try {
      const parsed = parseMirrorCalendarText(execution.result.bodyText, month);
      months.push(
        filterParsedDays(parsed, request.period.start, request.period.end),
      );
    } catch {
      return failure('CALENDAR_PARSE_FAILED', 'parse', false);
    }
  }

  const days = months
    .flatMap((month) => month.days)
    .filter(
      ({ date }) =>
        compareCivilDates(date, request.period.start) >= 0 &&
        compareCivilDates(date, request.period.end) <= 0,
    );
  return {
    ok: true,
    tabId: request.tabId,
    frameId,
    months,
    days,
    warnings: months.flatMap((month) => month.warnings),
    realDomValidation: 'manual-validation-pending',
  };
}

const ERROR_MESSAGES: Readonly<Record<AhgoraSourceErrorCode, string>> = {
  CANCELLED: 'Captura do Ahgora cancelada.',
  SCRIPT_INJECTION_FAILED:
    'Não foi possível executar a captura na aba selecionada.',
  PAGE_NOT_RECOGNIZED: 'A aba selecionada não foi reconhecida como Ahgora.',
  LOGIN_REQUIRED: 'Conclua o login do Ahgora na aba selecionada.',
  MIRROR_HOST_PERMISSION_REQUIRED:
    'Registre novamente a aba Ahgora e conceda acesso ao iframe do espelho.',
  MIRROR_FRAME_NOT_FOUND: 'O espelho do Ahgora não foi encontrado na página.',
  MIRROR_FRAME_INACCESSIBLE:
    'O conteúdo do espelho não está acessível. Com activeTab, um iframe de outra origem pode exigir novo gesto do usuário ou permissão de host exata.',
  MIRROR_FRAME_AMBIGUOUS:
    'Mais de um contexto de espelho foi encontrado na página.',
  MONTH_SELECTOR_NOT_FOUND: 'O seletor de mês do Ahgora não foi encontrado.',
  YEAR_CONTROL_NOT_FOUND: 'O controle de ano do Ahgora não foi encontrado.',
  MONTH_BUTTON_NOT_FOUND: 'O botão do mês solicitado não foi encontrado.',
  MONTH_CHANGE_TIMEOUT: 'O Ahgora não confirmou a mudança de mês a tempo.',
  CALENDAR_LOAD_TIMEOUT: 'O calendário do Ahgora não carregou a tempo.',
  CALENDAR_PARSE_FAILED:
    'O calendário do Ahgora não corresponde ao formato atualmente suportado.',
  SOURCE_DATA_INVALID: 'O Ahgora retornou batidas em um formato não suportado.',
  MONTH_NOT_AVAILABLE:
    'O mês solicitado não está disponível no espelho do Ahgora.',
};

function failure(
  code: AhgoraSourceErrorCode,
  stage: AhgoraSourceErrorDto['stage'],
  retryable: boolean,
): CaptureAhgoraResult {
  return {
    ok: false,
    error: {
      code,
      stage,
      message: ERROR_MESSAGES[code],
      retryable,
      realDomValidation: 'manual-validation-pending',
    },
  };
}
