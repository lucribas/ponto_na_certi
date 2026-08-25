export type SourceEvidenceStatus =
  'supported-by-active-ruby' | 'manual-validation-pending';

export interface SourceSelectorEvidence {
  readonly logicalName: string;
  readonly locator: string;
  readonly rubyReference: string;
  readonly evidence: SourceEvidenceStatus;
}

/**
 * This is an evidence ledger, not a catalogue of guessed selectors. Every
 * locator below is used by the active path in apps/standalone/source/Ahgora.rb.
 * Whether the authenticated production DOM still matches remains a manual
 * validation item.
 */
export const AHGORA_SOURCE_EVIDENCE: readonly SourceSelectorEvidence[] = [
  {
    logicalName: 'page title',
    locator: 'document.title contains "ahgora" (case-insensitive)',
    rubyReference: 'Ahgora#ahgora_page?',
    evidence: 'supported-by-active-ruby',
  },
  {
    logicalName: 'login form',
    locator: '#boxLogin (visible means login is required)',
    rubyReference: 'Ahgora#web_login',
    evidence: 'supported-by-active-ruby',
  },
  {
    logicalName: 'mirror frame',
    locator: '#mirror',
    rubyReference: 'Ahgora#process_mirror_month',
    evidence: 'supported-by-active-ruby',
  },
  {
    logicalName: 'mirror ready marker',
    locator: 'body text contains "MONTHLY SUMMARY"',
    rubyReference: 'Ahgora#process_mirror_month',
    evidence: 'supported-by-active-ruby',
  },
  {
    logicalName: 'month selector and controls',
    locator:
      'button text matching [A-Z]+/YYYY; exact JAN..DEC; exact chevron_left/chevron_right',
    rubyReference: 'Ahgora#select_mirror_month',
    evidence: 'supported-by-active-ruby',
  },
  {
    logicalName: 'calendar loaded marker',
    locator: 'body text contains "Horas Trabalhadas"',
    rubyReference: 'Ahgora#process_mirror_month',
    evidence: 'supported-by-active-ruby',
  },
] as const;

export const AHGORA_REAL_DOM_VALIDATION: SourceEvidenceStatus =
  'manual-validation-pending';
