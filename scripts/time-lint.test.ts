import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();

async function timeErrors(filePath: string, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-syntax').length;
}

describe('business time comes only from the clock module (AC-CLK-07)', () => {
  it('rejects Date.now() outside the clock module', async () => {
    expect(await timeErrors('src/lib/time-probe.ts', 'export const t = Date.now();\n')).toBe(1);
  });

  it('rejects new Date() without arguments outside the clock module', async () => {
    expect(await timeErrors('src/lib/time-probe.ts', 'export const t = new Date();\n')).toBe(1);
  });

  it('rejects performance.now() outside the clock module', async () => {
    expect(await timeErrors('src/lib/time-probe.ts', 'export const t = performance.now();\n')).toBe(1);
  });

  it('allows parsing a given instant anywhere', async () => {
    expect(await timeErrors('src/lib/time-probe.ts', "export const t = new Date('2026-11-23');\n")).toBe(0);
  });

  it('allows reading real time inside the clock module', async () => {
    expect(
      await timeErrors('src/modules/clock/service/time-probe.ts', 'export const t = Date.now();\n'),
    ).toBe(0);
  });
});
