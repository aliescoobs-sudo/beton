import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractInvoiceDraft, type InvoiceExtractor } from './invoice-extraction';
import { loadEnv } from '../env';

const file = { type: 'image/png' as const, bytes: new Uint8Array([1, 2, 3]) };

afterEach(() => vi.restoreAllMocks());

/** Every way a Node process reaches out: if one of them is called, the test fails. */
function watchOutbound() {
  return [
    vi.spyOn(globalThis, 'fetch'),
    vi.spyOn(http, 'request'),
    vi.spyOn(https, 'request'),
    vi.spyOn(http, 'get'),
    vi.spyOn(https, 'get'),
    vi.spyOn(net.Socket.prototype, 'connect'),
    vi.spyOn(net, 'connect'),
    vi.spyOn(net, 'createConnection'),
  ];
}

describe('the AI reading of an invoice, flag off (AC-INT-15)', () => {
  it('answers DISABLED and makes no outbound request of any kind, the extractor is never called', async () => {
    const watchers = watchOutbound();
    const extractor: InvoiceExtractor = { extract: vi.fn(async () => ({ supplierInvoiceNo: 'X' })) };
    expect(await extractInvoiceDraft({ enabled: false, extractor }, file)).toEqual({
      ok: false,
      error: 'DISABLED',
    });
    expect(await extractInvoiceDraft({ enabled: false }, file)).toEqual({ ok: false, error: 'DISABLED' });
    expect(extractor.extract).not.toHaveBeenCalled();
    for (const w of watchers) expect(w).not.toHaveBeenCalled();
  });

  it('with the flag on and nothing wired it still answers without a call: only the interface exists', async () => {
    const watchers = watchOutbound();
    expect(await extractInvoiceDraft({ enabled: true }, file)).toEqual({ ok: false, error: 'NOT_AVAILABLE' });
    for (const w of watchers) expect(w).not.toHaveBeenCalled();
  });

  it('hands back what a wired extractor gives only when enabled and wired', async () => {
    const extractor: InvoiceExtractor = {
      extract: async () => ({ supplierInvoiceNo: 'F-1', invoiceDate: '2026-06-02' }),
    };
    expect(await extractInvoiceDraft({ enabled: true, extractor }, file)).toEqual({
      ok: true,
      value: { supplierInvoiceNo: 'F-1', invoiceDate: '2026-06-02' },
    });
  });
});

describe('the flag in the environment', () => {
  const base = {
    DATABASE_URL_APP: 'postgres://u:p@localhost:5432/d',
    DATABASE_URL_MIGRATOR: 'postgres://u:p@localhost:5432/d',
    DATABASE_URL_AUTH: 'postgres://u:p@localhost:5432/d',
    DATABASE_URL_SYSTEM: 'postgres://u:p@localhost:5432/d',
    AUTH_SECRET: 'x'.repeat(40),
    FIELD_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`,
    RECOVERY_CODES_KEYS: `k1:${Buffer.alloc(32, 2).toString('base64')}`,
    LOOKUP_HMAC_KEY: Buffer.alloc(32, 3).toString('base64'),
    APP_BASE_URL: 'http://localhost:3000',
    BACKUP_AGE_RECIPIENT: 'age1abc',
  };
  it('is off unless set, and refused with real data or in production', () => {
    expect(loadEnv({ ...base }).AI_EXTRACTION_ENABLED).toBe(false);
    expect(loadEnv({ ...base, AI_EXTRACTION_ENABLED: 'true' }).AI_EXTRACTION_ENABLED).toBe(true);
    expect(() => loadEnv({ ...base, AI_EXTRACTION_ENABLED: 'true', REAL_DATA: 'true' })).toThrow(/CNDP/);
    expect(() => loadEnv({ ...base, AI_EXTRACTION_ENABLED: 'true', NODE_ENV: 'production' })).toThrow(/CNDP/);
  });
});
