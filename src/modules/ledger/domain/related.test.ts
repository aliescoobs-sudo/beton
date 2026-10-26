import { describe, expect, it } from 'vitest';
import { type RelatedDocument, uniqueRelated } from './related';

const doc = (kind: RelatedDocument['kind'], code: string, path: string | null = null): RelatedDocument => ({
  kind,
  code,
  path,
});

describe('uniqueRelated (AC-INT-17)', () => {
  it('keeps one of each document and orders them along the chain', () => {
    const out = uniqueRelated([
      doc('payment', 'CH-1'),
      doc('invoice', 'FA-2026-00002', '/invoices/b'),
      doc('bl', 'BL-2026-00001', '/deliveries/a'),
      doc('payment', 'CH-1'),
      doc('order', 'CMD-2026-00001'),
      doc('invoice', 'FA-2026-00001', '/invoices/a'),
    ]);
    expect(out.map((d) => d.code)).toEqual([
      'CMD-2026-00001',
      'BL-2026-00001',
      'FA-2026-00001',
      'FA-2026-00002',
      'CH-1',
    ]);
  });
});
