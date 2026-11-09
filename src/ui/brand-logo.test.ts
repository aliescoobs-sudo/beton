import { BRAND_WIDTHS, PAD_CLASS } from './brand';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  resolveBrand,
  SIGNATURE_MIN_WIDTH,
  SIGNATURE_PREFERRED_MIN_WIDTH,
  toneForBackground,
} from './brand-logo';

const viewBox = (path: string) => {
  const svg = readFileSync(path, 'utf8');
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)!;
  return { width: Math.round(Number(m[1])), height: Math.round(Number(m[2])) };
};

describe('KAYAS logo rules', () => {
  it('the committed SVGs have the ratios the component relies on, and contain only plain paths', () => {
    for (const tone of ['colour', 'forest', 'black', 'white']) {
      expect(viewBox(`public/brand/svg/kayas-signature-${tone}.svg`)).toEqual({ width: 1278, height: 279 });
      expect(viewBox(`public/brand/svg/kayas-symbol-${tone}.svg`)).toEqual({ width: 353, height: 279 });
      const svg = readFileSync(`public/brand/svg/kayas-signature-${tone}.svg`, 'utf8');
      expect(svg).not.toMatch(/<script|<image|<a\b|<foreignObject|href=|onload|<style/i);
    }
  });

  it('never stretches: the height always follows the width at the file ratio', () => {
    for (const width of [160, 200, 240, 320, 480]) {
      const s = resolveBrand({ width });
      expect(s.height / s.width).toBeCloseTo(279 / 1278, 2);
    }
    const sym = resolveBrand({ variant: 'symbol', width: 48 });
    expect(sym.height / sym.width).toBeCloseTo(279 / 353, 1);
  });

  it('clear space is a quarter of the symbol height; the signature is never under 120 px and below 160 px the symbol is used', () => {
    expect(resolveBrand({ width: 320 }).clearSpace).toBe(Math.round(resolveBrand({ width: 320 }).height / 4));
    expect(SIGNATURE_MIN_WIDTH).toBe(120);
    expect(SIGNATURE_PREFERRED_MIN_WIDTH).toBe(160);
    for (const width of [100, 119, 120, 150, 159]) expect(resolveBrand({ width }).variant).toBe('symbol');
    expect(resolveBrand({ width: 160 }).variant).toBe('signature');
  });

  it('picks the file by tone: colour on light, white on forest/dark; every referenced file exists', () => {
    expect(toneForBackground('light')).toBe('colour');
    expect(toneForBackground('forest')).toBe('white');
    expect(toneForBackground('dark')).toBe('white');
    expect(resolveBrand({ width: 200, tone: 'white' }).src).toBe('/brand/svg/kayas-signature-white.svg');
    expect(resolveBrand({ width: 100, tone: 'white' }).src).toBe('/brand/svg/kayas-symbol-white.svg');
    for (const tone of ['colour', 'forest', 'black', 'white'] as const)
      for (const width of [100, 200])
        expect(() => readFileSync(`public${resolveBrand({ width, tone }).src}`)).not.toThrow();
  });

  it('every allowed width has a clear-space class equal to a quarter of the symbol height (no inline style: CSP)', () => {
    for (const width of BRAND_WIDTHS) {
      const spec = resolveBrand({ variant: width < 160 ? 'symbol' : 'signature', width });
      expect(PAD_CLASS[spec.height], `width ${width}`).toBe(`p-[${spec.clearSpace}px]`);
    }
  });
});
