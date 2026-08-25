export interface SafeDiagnostic {
  readonly code: string;
  readonly component: 'background' | 'messaging' | 'storage' | 'ui';
  readonly phase?: string;
}

const KNOWN_ERROR_CODES = new Map<string, string>([
  ['BoundaryValidationError', 'BOUNDARY_REJECTED'],
  ['OperationTransitionError', 'TRANSITION_REJECTED'],
]);

/** Returns structural diagnostics only; error messages and page data are discarded. */
export function toSafeDiagnostic(
  error: unknown,
  component: SafeDiagnostic['component'],
  phase?: string,
): SafeDiagnostic {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const diagnostic: SafeDiagnostic = {
    code: KNOWN_ERROR_CODES.get(name) ?? 'UNEXPECTED_FAILURE',
    component,
  };

  return phase === undefined ? diagnostic : { ...diagnostic, phase };
}
