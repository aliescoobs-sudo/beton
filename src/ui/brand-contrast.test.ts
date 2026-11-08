import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// KAYAS brand contrast (WCAG 2.x): every text/background pair the UI actually uses, light and dark, read from src/app/globals.css.
// Thresholds: 4.5:1 for body text, 3:1 for large text and non-text indicators. White on Citron (1.69:1) must fail, and no class list
// may put white text on a Citron fill.
const css = readFileSync('src/app/globals.css', 'utf8');

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6});/g)) out[m[1]!] = m[2]!;
  return out;
}
const themeStart = css.indexOf('@theme {');
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const light = tokens(css.slice(themeStart, darkStart));
const dark = { ...light, ...tokens(css.slice(darkStart, css.indexOf('@layer base'))) };

const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) =>
  0.2126 * lin(channel(hex, 0)) + 0.7152 * lin(channel(hex, 1)) + 0.0722 * lin(channel(hex, 2));
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** `fg` at `alpha` over `bg` (text-white/70 on the Forêt band). */
function blend(fg: string, alpha: number, bg: string): string {
  const mix = (i: number) =>
    Math.round((channel(fg, i) * alpha + channel(bg, i) * (1 - alpha)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${mix(0)}${mix(1)}${mix(2)}`;
}

const WHITE = '#ffffff';
type Pair = {
  name: string;
  fg: (t: Record<string, string>) => string;
  bg: (t: Record<string, string>) => string;
  min: number;
};
const t = (k: string) => (tk: Record<string, string>) => tk[k]!;
const fixed = (hex: string) => () => hex;

const pairs: Pair[] = [
  // body text on every surface
  ...['canvas', 'surface', 'band'].flatMap((bg): Pair[] => [
    { name: `ink on ${bg}`, fg: t('ink'), bg: t(bg), min: 4.5 },
    { name: `muted on ${bg}`, fg: t('muted'), bg: t(bg), min: 4.5 },
    { name: `heading on ${bg}`, fg: t('heading'), bg: t(bg), min: 4.5 },
    { name: `danger (error text) on ${bg}`, fg: t('danger'), bg: t(bg), min: 4.5 },
  ]),
  // buttons: primary = Forêt fill + white text; secondary = light fill + heading-coloured text
  { name: 'primary button: white on forest', fg: fixed(WHITE), bg: t('forest'), min: 4.5 },
  { name: 'primary button hover: white on #014522', fg: fixed(WHITE), bg: fixed('#014522'), min: 4.5 },
  { name: 'secondary button: heading on surface', fg: t('heading'), bg: t('surface'), min: 4.5 },
  // the Forêt header and drawer
  { name: 'header: white on forest', fg: fixed(WHITE), bg: t('forest'), min: 4.5 },
  {
    name: 'header: white/70 on forest',
    fg: (tk) => blend(WHITE, 0.7, tk.forest!),
    bg: t('forest'),
    min: 4.5,
  },
  { name: 'header: Citron marker/focus on forest (non-text)', fg: t('citron'), bg: t('forest'), min: 3 },
  // focus ring and input border (non-text, 3:1)
  { name: 'focus ring on canvas', fg: t('focus'), bg: t('canvas'), min: 3 },
  { name: 'focus ring on surface', fg: t('focus'), bg: t('surface'), min: 3 },
  { name: 'input border on surface', fg: t('field'), bg: t('surface'), min: 3 },
  // fixed-colour banners and badges (unchanged status colours)
  { name: 'training banner: white on signal red', fg: fixed(WHITE), bg: t('signal'), min: 4.5 },
  { name: 'fake-data banner: graphite on amber', fg: t('graphite'), bg: t('amber'), min: 4.5 },
  { name: 'simulation badge: white on sim', fg: fixed(WHITE), bg: t('sim'), min: 4.5 },
  { name: 'simulation past day: ink on sim-past', fg: t('ink'), bg: t('sim-past'), min: 4.5 },
  { name: 'toast: white on graphite', fg: fixed(WHITE), bg: t('graphite'), min: 4.5 },
  { name: 'tinted band: forest-text link on band', fg: t('forest'), bg: fixed('#e2e9e5'), min: 4.5 },
  // Citron is an accent: as a fill it carries Graphite text only
  { name: 'graphite on citron', fg: t('graphite'), bg: t('citron'), min: 4.5 },
];

describe.each([
  ['light', light],
  ['dark', dark],
])('contrast of every text/background pair in %s mode', (_mode, tk) => {
  it.each(pairs.map((p) => [p.name, p] as const))('%s', (_name, p) => {
    const ratio = contrast(p.fg(tk), p.bg(tk));
    expect(ratio, `${p.name}: ${p.fg(tk)} on ${p.bg(tk)} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
      p.min,
    );
  });
});

describe('Citron discipline', () => {
  it('white on Citron fails (1.69:1, from the brand guide) and Forêt on Citron passes', () => {
    expect(contrast(WHITE, light.citron!)).toBeLessThan(2);
    expect(contrast(WHITE, light.citron!)).toBeLessThan(4.5);
    expect(contrast(light.forest!, light.citron!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light.forest!, WHITE)).toBeGreaterThanOrEqual(8.5);
  });

  it('no class list in the source puts white text on a Citron fill, or Citron as body text', () => {
    const files = execFileSync('git', ['ls-files', 'src', '--', '*.tsx', '*.css'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    const offenders: string[] = [];
    for (const f of files) {
      for (const [i, line] of readFileSync(f, 'utf8').split('\n').entries()) {
        const fillsCitron = /\bbg-citron\b|background:\s*var\(--color-citron\)/.test(line);
        if (fillsCitron && /\btext-white\b|color:\s*#fff\b/.test(line)) offenders.push(`${f}:${i + 1}`);
        if (/(^|[\s'"`])(text-citron)\b/.test(line)) offenders.push(`${f}:${i + 1} (Citron as text)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the contrast checker itself catches a failing pair (sanity)', () => {
    expect(contrast('#ffffff', '#9ada02')).toBeCloseTo(1.69, 1);
    expect(contrast('#01592b', '#ffffff')).toBeCloseTo(8.52, 1);
  });
});
