import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AC-RE-14: delays, rates and horizons are parameters; the domain code carries none of their default values.
const files = readdirSync(__dirname).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

describe('no literal parameter value in rules-engine/domain (AC-RE-14)', () => {
  it.each(files)('%s', (file) => {
    const code = readFileSync(join(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      // fixed arithmetic constants are named and allowed
      .replace(
        /^(export )?const (BP_DENOMINATOR|DAYS_PER_YEAR|MAX_SINGLES_PER_KIND|MAX_OPTIONS|MAX_SPLITS|MAX_CAUSES|SUNDAY|MONTH_END_LEAD_DAYS) = .*$/gm,
        '',
      );
    // a discount rate (800), a split (5000), an advance (3000), a lead or delay literal used as an argument or default
    expect(code.match(/\b(800|3000|3_000|5000|5_000|2000|2_000)\b/g) ?? []).toEqual([]);
    expect(code).not.toMatch(/(clearing|delay|lead|postpone|horizon)\w*\s*[:=]\s*\d/i);
  });
});
