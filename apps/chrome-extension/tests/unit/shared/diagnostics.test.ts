import { describe, expect, it } from 'vitest';

import { toSafeDiagnostic } from '../../../src/shared/diagnostics';
import { BoundaryValidationError } from '../../../src/shared/errors';

describe('safe diagnostics', () => {
  it('does not retain messages or page data from an error', () => {
    const secretLikeInput = 'data, horas, projeto e token sintéticos';
    const diagnostic = toSafeDiagnostic(
      new BoundaryValidationError(secretLikeInput),
      'messaging',
      'preview',
    );

    expect(diagnostic).toEqual({
      code: 'BOUNDARY_REJECTED',
      component: 'messaging',
      phase: 'preview',
    });
    expect(JSON.stringify(diagnostic)).not.toContain(secretLikeInput);
  });
});
