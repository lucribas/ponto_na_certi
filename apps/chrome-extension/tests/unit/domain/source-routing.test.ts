import { describe, expect, it } from 'vitest';
import {
  planSourceSlices,
  resolvePeriod,
  samePeriodRequest,
} from '../../../src/domain';
describe('roteamento de fonte por data civil', () => {
  it('compara períodos após serialização com ordem de propriedades diferente', () => {
    expect(
      samePeriodRequest(
        { kind: 'range', start: '2026-09-21', end: '2026-09-25' },
        { end: '2026-09-25', kind: 'range', start: '2026-09-21' },
      ),
    ).toBe(true);
    expect(
      samePeriodRequest(
        { kind: 'month', month: '2026-09' },
        { kind: 'month', month: '2026-10' },
      ),
    ).toBe(false);
  });
  it('separa o corte inclusivo e preserva fechamento 26 a 25', () => {
    expect(
      planSourceSlices(
        { start: '2026-09-20', end: '2026-09-21' },
        '2026-09-29',
      ),
    ).toEqual([
      { provider: 'ahgora', start: '2026-09-20', end: '2026-09-20' },
      { provider: 'senior', start: '2026-09-21', end: '2026-09-21' },
    ]);
    expect(
      planSourceSlices(
        resolvePeriod(
          { kind: 'month', month: '2026-09' },
          { today: () => '2026-09-29' },
        ),
        '2026-09-29',
      ),
    ).toEqual([
      { provider: 'ahgora', start: '2026-08-26', end: '2026-09-20' },
      { provider: 'senior', start: '2026-09-21', end: '2026-09-25' },
    ]);
  });
  it('limita datas futuras e não exige uma competência ainda futura', () => {
    expect(
      planSourceSlices(
        { start: '2026-09-26', end: '2026-10-25' },
        '2026-09-29',
      ),
    ).toEqual([{ provider: 'senior', start: '2026-09-26', end: '2026-09-29' }]);
    expect(
      planSourceSlices(
        { start: '2027-01-01', end: '2027-01-31' },
        '2026-09-29',
      ),
    ).toEqual([]);
    expect(() =>
      planSourceSlices(
        { start: '2026-09-22', end: '2026-09-21' },
        '2026-09-29',
      ),
    ).toThrow();
  });
});
