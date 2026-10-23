import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AC-LED-13: the VAT rate is a parameter stored on each document; domain code never contains a literal rate.
const files = readdirSync(__dirname).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

describe('no literal VAT rate in ledger/domain (AC-LED-13)', () => {
  it.each(files)('%s', (file) => {
    const code = readFileSync(join(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // The unit constants (litres per m³, basis-point denominator) are the only fixed numbers; a rate is neither.
    const rest = code.replace(/^const (LITRES_PER_M3|BP_DENOMINATOR|FULL) = .*$/gm, '');
    // A rate as basis points (2000, 1400, 700, 1000) or as a fraction (0.2, 0.14): none may appear.
    expect(rest.match(/\b(2000|1400|700|1000|0\.(2|20|14|07|1))\b/g) ?? []).toEqual([]);
    expect(code).not.toMatch(/vat\w*\s*[:=]\s*\d/i);
  });
});
