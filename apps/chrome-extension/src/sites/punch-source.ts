import type { CivilDate, PunchDay, PunchSourceId } from '../domain';
export interface SourceDayIssue {
  readonly date: CivilDate;
  readonly code?: string;
  readonly severity: 'requires-review' | 'blocked';
  readonly message: string;
}
export interface CapturedPunchDay extends PunchDay {
  readonly provider?: PunchSourceId;
}
export type CaptureSourceResult =
  | {
      readonly ok: true;
      readonly days: readonly CapturedPunchDay[];
      readonly issues?: readonly SourceDayIssue[];
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };
