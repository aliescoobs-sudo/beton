import { describe, expect, it } from 'vitest';
import { Pseudonymizer } from './pseudonymizer';

const entities = [
  { code: 'CLT-017', names: ['Béton Atlas Sud', 'Atlas'] },
  { code: 'CLT-003', names: ['شركة النور', 'Nour'] },
  { code: 'FRN-05', names: ['Ciment du Maroc'] },
];

describe('the question is masked before any model sees it (AC-ASSIST-05)', () => {
  it('replaces known names, Latin or Arabic, by their codes, the longest name first', () => {
    const ps = new Pseudonymizer(entities);
    expect(ps.maskQuestion('Qu’est-ce qui n’est pas facturé pour Béton Atlas Sud ?')).toBe(
      'Qu’est-ce qui n’est pas facturé pour CLT-017 ?',
    );
    expect(ps.maskQuestion('فاتورة ديال شركة النور')).toBe('فاتورة ديال CLT-003');
    expect(ps.maskQuestion('cimént du maroc livre quand')).toBe('FRN-05 livre quand');
    expect(ps.maskQuestion('ATLAS demain')).toBe('CLT-017 demain');
  });

  it('does not touch a word that only contains a name', () => {
    expect(new Pseudonymizer(entities).maskQuestion('atlasien nouveau')).toBe('atlasien nouveau');
  });

  it('hides amounts, phones, ICE and long numbers and keeps them for a draft', () => {
    const ps = new Pseudonymizer(entities);
    const masked = ps.maskQuestion(
      'encaisse le chèque 8451237 de 45 000,50 dh, tel 06 61 23 45 67, ICE 001234567000089, 20 m³ B25',
    );
    expect(masked).not.toMatch(/8451237|45 000|0661|001234567000089/);
    expect(masked).toContain('20 m³ B25');
    const [amount] = masked.match(/\{\{AMT_\d+\}\}/) ?? [];
    expect(ps.userAmount(amount!)).toBe(4_500_050);
    const numbers = [...masked.matchAll(/\{\{NUM_\d+\}\}/g)].map((m) => ps.userNumber(m[0]));
    expect(numbers).toContain('8451237');
    expect(numbers).toContain('001234567000089');
  });

  it('reads Arabic-Indic digits and dirham in Arabic', () => {
    const ps = new Pseudonymizer([]);
    const masked = ps.maskQuestion('خلص ٤٥٠٠ درهم');
    expect(masked).toBe('خلص {{AMT_1}}');
    expect(ps.userAmount('{{AMT_1}}')).toBe(450_000);
  });
});

describe('amounts of tool results are placeholders, put back by code (AC-ASSIST-08)', () => {
  it('hydrates the stored centimes with the screens format', () => {
    const ps = new Pseudonymizer([]);
    const a = ps.amount(362_500);
    const b = ps.amount(-1_250);
    expect(a).not.toContain('3625');
    const out = ps.hydrate(`ouvert ${a}, écart ${b}`);
    expect(out).toEqual({ ok: true, value: 'ouvert 3 625,00 MAD, écart -12,50 MAD' });
  });

  it('refuses a placeholder it never issued', () => {
    expect(new Pseudonymizer([]).hydrate('total {{AMT_9}}')).toEqual({
      ok: false,
      error: 'UNKNOWN_PLACEHOLDER',
    });
  });
});
