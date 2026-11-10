import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// R17-11: the fictitious training instance has no number a trainee could dial.
describe('no dialable number and no call link in the training instance', () => {
  it('every tel: link of the phone app goes through Dial, which is plain text in training mode', () => {
    const src = readFileSync('src/modules/field/ui/field-app.tsx', 'utf8');
    expect(src.match(/href=\{`tel:/g)?.length).toBe(1); // only inside Dial
    expect(src).toMatch(/training\s*\)?\s*\n?\s*return \(\s*<span[^>]*data-dial-disabled/);
    expect(readFileSync('src/app/[locale]/driver/page.tsx', 'utf8')).toContain(
      'trainingMode={env.TRAINING_MODE}',
    );
  });
  it('the seeded phones start with the international prefix twice, which no country accepts', () => {
    const seed = readFileSync('scripts/seed-training.ts', 'utf8');
    const phones = [...seed.matchAll(/phone: [`']([^`']+)[`']/g)].map((m) => m[1] as string);
    expect(phones.length).toBeGreaterThan(0);
    for (const p of phones) expect(p.replace(/\D/g, ''), p).toMatch(/^0000/);
    expect(seed).not.toMatch(/phone: [`']0[567]/);
  });
});
