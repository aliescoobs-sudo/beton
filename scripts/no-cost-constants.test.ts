import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// T16 G5 (SPEC-cost-margin §11, §16; D237): no cost constant lives in the application code. Every rate, norm and price is a row of data (cost_rate, fuel_norm, price_grid,
// purchase_price) that the owner replaces through a data screen; the A1 assumptions exist only in the pilot seed files. This guard reads src/ outside tests and seed files.
const SEED_FILE = /(^|\/)pilot-[\w-]*\.ts$/;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !SEED_FILE.test(path) ? [path] : [];
  });

/** A cost-looking name given a number: `dieselPrice = 1700`, `overhead_per_m3: 3000`, `perTripL: 22`. */
const COST_NAME =
  /\b[\w.]*(diesel|gasoil|fuel_?(price|norm|rate)|overhead|cost_?rate|plant_?cost|pump_?cost|delivery_?cost|transport_?cost|per_?trip|per_?km|per_?hour)\w*\s*[:=]\s*-?\d/i;
export const violationsIn = (source: string): string[] =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .filter((line) => COST_NAME.test(line));

describe('no cost constant in src/ (outside tests and seed files)', () => {
  it('finds source files to read', () => {
    expect(files('src').length).toBeGreaterThan(300);
  });

  it('has no cost-named number in any application source file', () => {
    const offenders = files('src').flatMap((f) =>
      violationsIn(readFileSync(f, 'utf8')).map((l) => `${f}: ${l.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it('would catch one (self-test of the scanner), and leaves comments and seed files alone', () => {
    expect(violationsIn('const dieselPrice = 1700;')).toHaveLength(1);
    expect(violationsIn('const perTripL: number = 22')).toHaveLength(0); // typed declaration, no literal assigned: allowed
    expect(violationsIn('  overhead_per_m3: 3000,')).toHaveLength(1);
    expect(violationsIn('const x = fuelRate = 5;')).toHaveLength(1);
    expect(violationsIn('// dieselPrice = 1700\n/* overheadRate: 30 */')).toHaveLength(0);
    expect(violationsIn('const label = t("diesel")')).toHaveLength(0);
    expect(SEED_FILE.test('src/modules/master-data/service/pilot-cost-seed.ts')).toBe(true);
    expect(SEED_FILE.test('src/modules/master-data/service/cost-service.ts')).toBe(false);
  });
});
