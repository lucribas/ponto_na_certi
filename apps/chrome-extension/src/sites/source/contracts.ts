import type { CivilDate, ClosingMonth, PunchDay } from '../../domain';
import type {
  AhgoraApiCaptureInput,
  AhgoraApiCaptureResult,
} from './api-injected';

export interface AhgoraProbeDto {
  readonly titleMatches: boolean;
  readonly loginForm: 'visible' | 'hidden' | 'absent';
  readonly mirrorElement: boolean;
  readonly monthlySummary: boolean;
}

export interface MonthCaptureInput {
  readonly month: ClosingMonth;
  readonly navigationYear: number;
  readonly timeoutMs: number;
}

export type InjectedMonthCaptureDto =
  | {
      readonly ok: true;
      readonly selection: 'already-selected' | 'changed';
      readonly bodyText: string;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'MONTH_SELECTOR_NOT_FOUND'
        | 'YEAR_CONTROL_NOT_FOUND'
        | 'MONTH_BUTTON_NOT_FOUND'
        | 'MONTH_CHANGE_TIMEOUT'
        | 'CALENDAR_LOAD_TIMEOUT';
    };

export interface FrameExecution<TResult> {
  readonly frameId: number;
  readonly result?: TResult;
}

export interface SourceScriptRunner {
  probe?(tabId: number): Promise<readonly FrameExecution<AhgoraProbeDto>[]>;
  captureMonth?(
    tabId: number,
    frameId: number,
    input: MonthCaptureInput,
  ): Promise<FrameExecution<InjectedMonthCaptureDto>>;
  capturePeriod?(
    tabId: number,
    input: AhgoraApiCaptureInput,
  ): Promise<AhgoraApiCaptureResult>;
}

export interface SourceParseWarning {
  readonly kind: 'odd-punch-count';
  readonly date: CivilDate;
  readonly count: number;
}

export interface ParsedMirrorMonthDto {
  readonly month: ClosingMonth;
  readonly days: readonly PunchDay[];
  readonly warnings: readonly SourceParseWarning[];
}

export type AhgoraSourceErrorCode =
  | 'CANCELLED'
  | 'SCRIPT_INJECTION_FAILED'
  | 'PAGE_NOT_RECOGNIZED'
  | 'LOGIN_REQUIRED'
  | 'MIRROR_HOST_PERMISSION_REQUIRED'
  | 'MIRROR_FRAME_NOT_FOUND'
  | 'MIRROR_FRAME_INACCESSIBLE'
  | 'MIRROR_FRAME_AMBIGUOUS'
  | 'MONTH_SELECTOR_NOT_FOUND'
  | 'YEAR_CONTROL_NOT_FOUND'
  | 'MONTH_BUTTON_NOT_FOUND'
  | 'MONTH_CHANGE_TIMEOUT'
  | 'CALENDAR_LOAD_TIMEOUT'
  | 'CALENDAR_PARSE_FAILED'
  | 'SOURCE_DATA_INVALID'
  | 'MONTH_NOT_AVAILABLE';

export interface AhgoraSourceErrorDto {
  readonly code: AhgoraSourceErrorCode;
  readonly stage: 'detect' | 'frame' | 'select-month' | 'parse';
  readonly message: string;
  readonly retryable: boolean;
  readonly realDomValidation: 'manual-validation-pending';
}

export type CaptureAhgoraResult =
  | {
      readonly ok: true;
      readonly tabId: number;
      readonly frameId: number;
      readonly months: readonly ParsedMirrorMonthDto[];
      readonly days: readonly PunchDay[];
      readonly warnings: readonly SourceParseWarning[];
      readonly realDomValidation: 'manual-validation-pending';
    }
  | { readonly ok: false; readonly error: AhgoraSourceErrorDto };
