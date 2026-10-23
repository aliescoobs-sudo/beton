import { describe, expect, it } from 'vitest';
import { parseCorrectionInput } from './correction';

describe('parseCorrectionInput', () => {
  it('accepts a document code and a reason, normalising case and spaces', () => {
    expect(parseCorrectionInput({ documentCode: ' cmd-2026-00012 ', reason: '  Mauvais   volume ' })).toEqual(
      {
        ok: true,
        value: { documentCode: 'CMD-2026-00012', reason: 'Mauvais volume' },
      },
    );
  });

  it.each([
    { documentCode: 'XYZ-2026-00001', reason: 'ok ok' },
    { documentCode: 'CMD-26-1', reason: 'ok ok' },
    { documentCode: 'CMD-2026-00001', reason: 'ab' },
    { documentCode: 'CMD-2026-00001' },
    { documentCode: 'CMD-2026-00001', reason: 'x'.repeat(501) },
    null,
  ])('refuses %j', (input) => {
    expect(parseCorrectionInput(input)).toEqual({ ok: false, error: 'INVALID' });
  });
});
