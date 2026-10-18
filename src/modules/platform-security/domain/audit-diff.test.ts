import { describe, expect, it } from 'vitest';
import { auditDiff } from './audit-diff';

describe('auditDiff (T20)', () => {
  it('lists only the fields that changed, with before and after', () => {
    expect(
      auditDiff(
        { key: 'auth.step_up_minutes', value: 8, updated_at: 'a' },
        { key: 'auth.step_up_minutes', value: 10, updated_at: 'b' },
      ),
    ).toEqual([
      { field: 'updated_at', before: 'a', after: 'b' },
      { field: 'value', before: 8, after: 10 },
    ]);
  });

  it('shows every field of an insert as new', () => {
    expect(auditDiff(null, { id: '1', label: 'x' })).toEqual([
      { field: 'id', before: undefined, after: '1' },
      { field: 'label', before: undefined, after: 'x' },
    ]);
  });

  it('compares nested values by content', () => {
    expect(auditDiff({ v: { a: [1, 2] } }, { v: { a: [1, 2] } })).toEqual([]);
  });

  it('is empty for service events without data', () => {
    expect(auditDiff(null, null)).toEqual([]);
  });
});
