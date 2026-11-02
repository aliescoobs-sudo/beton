import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matrixMarkdown, matrixViolations, VISIBILITY_MATRIX } from './visibility-matrix';

describe('information-visibility matrix (§16.1)', () => {
  it('breaks none of the rules: entering or printing never grants a balance', () => {
    expect(matrixViolations()).toEqual([]);
  });
  it('catches a row where an entering role gets balances', () => {
    const bad = [{ ...VISIBILITY_MATRIX[0]!, keys: undefined, balances: ['office_sales' as const] }];
    expect(matrixViolations(bad).length).toBeGreaterThan(0);
  });
  it('is printed, word for word, in CP-PROD-PLAN.md', () => {
    const plan = readFileSync('docs/checkpoints/CP-PROD-PLAN.md', 'utf8');
    expect(plan).toContain(matrixMarkdown());
  });
});
