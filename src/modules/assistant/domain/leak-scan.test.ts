import { describe, expect, it } from 'vitest';
import { scanForLeaks } from './leak-scan';

const index = {
  names: ['Béton Atlas Sud', 'شركة النور', 'Ahmed Bennani', 'Attijariwafa bank', '12345-A-6'],
  numbers: ['0500000067', '001234567000089', '8451237'],
};

describe('the leak scan (AC-ASSIST-05, 06)', () => {
  it('passes a payload made of codes, quantities and placeholders', () => {
    const payload = JSON.stringify({
      client: 'CLT-017',
      bl: 'BL-2026-00012',
      volumeM3: 7.5,
      openAmount: '{{AMT_1}}',
    });
    expect(scanForLeaks(payload, index)).toEqual([]);
  });

  it('finds a name in any case, accent or script', () => {
    expect(scanForLeaks('{"client":"BETON ATLAS SUD"}', index)).toEqual([{ kind: 'name' }]);
    expect(scanForLeaks('livrer chez béton atlas sud demain', index)).toEqual([{ kind: 'name' }]);
    expect(scanForLeaks('فاتورة شركة النور', index)).toEqual([{ kind: 'name' }]);
    expect(scanForLeaks('conducteur Ahmed Bennani', index)).toEqual([{ kind: 'name' }]);
    expect(scanForLeaks('banque Attijariwafa Bank', index)).toEqual([{ kind: 'name' }]);
  });

  it('finds a plate, a phone, an ICE and an instrument number whatever the separators', () => {
    expect(scanForLeaks('camion 12345-A-6', index)).toEqual([{ kind: 'name' }]);
    expect(scanForLeaks('tel 05 00 00 00 67', index).map((h) => h.kind)).toContain('number');
    expect(scanForLeaks('ICE 001234567000089', index).map((h) => h.kind)).toContain('number');
    expect(scanForLeaks('chèque 845-1237', index).map((h) => h.kind)).toContain('number');
  });

  it('finds the shape of a phone, an ICE, a long number and an amount even when unknown', () => {
    expect(scanForLeaks('+212 5 00 00 00 78', { names: [], numbers: [] }).map((h) => h.kind)).toContain(
      'phone_shape',
    );
    expect(scanForLeaks('999888777666555', { names: [], numbers: [] }).map((h) => h.kind)).toContain(
      'ice_shape',
    );
    expect(scanForLeaks('chèque 7654321', { names: [], numbers: [] }).map((h) => h.kind)).toContain(
      'long_number',
    );
    expect(scanForLeaks('reste 45 000,00 MAD', { names: [], numbers: [] }).map((h) => h.kind)).toContain(
      'amount_shape',
    );
  });

  it('returns kinds only, never the value', () => {
    expect(JSON.stringify(scanForLeaks('Béton Atlas Sud 8451237', index))).not.toMatch(/Atlas|8451237/);
  });
});
