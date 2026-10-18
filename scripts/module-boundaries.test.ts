import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();

async function boundaryErrors(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'boundaries/dependencies').map((m) => m.message);
}

describe('module boundaries (CAPABILITY-MAP §1)', () => {
  it('forbids shared lib code from importing route code', async () => {
    const errors = await boundaryErrors(
      'src/lib/boundary-probe.ts',
      "import Page from '@/app/[locale]/(protected)/page';\nexport const probe = Page;\n",
    );
    expect(errors).toHaveLength(1);
  });

  it('allows routes to import i18n', async () => {
    const errors = await boundaryErrors(
      'src/app/boundary-probe.ts',
      "import { routing } from '@/i18n/routing';\nexport const probe = routing;\n",
    );
    expect(errors).toEqual([]);
  });
});
