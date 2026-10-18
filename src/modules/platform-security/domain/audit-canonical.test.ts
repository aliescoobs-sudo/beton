import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type AuditChainRow, canonicalAuditEvent, chainHash } from './audit-canonical';

const base: AuditChainRow = {
  id: '1',
  atMicros: '1795676400000000',
  simAtMicros: null,
  actorUserId: '0190c2a8-0000-7000-8000-000000000001',
  actorKind: 'user',
  requestId: 'req-1',
  tableName: 'app_user',
  rowId: null,
  action: 'login',
  beforeJson: null,
  afterJson: '{"a": 1}',
  reason: null,
};

describe('canonicalAuditEvent', () => {
  it('length-prefixes every field and marks NULL with "-"', () => {
    expect(canonicalAuditEvent(base)).toBe(
      '1:1|16:1795676400000000|-|36:0190c2a8-0000-7000-8000-000000000001|4:user|5:req-1|8:app_user|-|5:login|-|8:{"a": 1}|-',
    );
  });

  it('counts UTF-8 bytes, not characters', () => {
    expect(canonicalAuditEvent({ ...base, reason: 'تلغى' })).toMatch(/\|8:تلغى$/);
  });

  it('distinguishes an empty string from NULL', () => {
    expect(canonicalAuditEvent({ ...base, reason: '' })).not.toBe(canonicalAuditEvent(base));
  });

  it('cannot be confused by a separator inside a value', () => {
    const a = canonicalAuditEvent({ ...base, requestId: 'x|5:login', action: 'logout' });
    const b = canonicalAuditEvent({ ...base, requestId: 'x', action: 'login|logout' });
    expect(a).not.toBe(b);
  });
});

describe('chainHash', () => {
  it('is sha256(prev_hash || canonical) and starts from an empty prev_hash', () => {
    const canonical = canonicalAuditEvent(base);
    expect(chainHash(null, base).equals(createHash('sha256').update(canonical, 'utf8').digest())).toBe(true);
    const prev = Buffer.alloc(32, 9);
    expect(
      chainHash(prev, base).equals(createHash('sha256').update(prev).update(canonical, 'utf8').digest()),
    ).toBe(true);
  });
});
