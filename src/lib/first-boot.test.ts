import { describe, expect, it } from 'vitest';
import { firstBootAllows } from './first-boot';

describe('the protected first start serves only the set-up paths (C2)', () => {
  it('allows sign-in, enrolment, the checklist, accounts, plants, parameters and the auth and health endpoints', () => {
    for (const p of [
      '/fr',
      '/fr/login',
      '/ar/enrol',
      '/ary/checklist',
      '/fr/admin/users',
      '/fr/admin/users/123',
      '/fr/parameters',
      '/fr/master-data/plants',
      '/api/auth/sign-in/email',
      '/api/health/ready',
    ])
      expect(firstBootAllows(p), p).toBe(true);
  });
  it('refuses every business page and endpoint', () => {
    for (const p of [
      '/fr/orders',
      '/fr/invoices',
      '/fr/payments/new',
      '/fr/master-data/clients',
      '/fr/admin/field',
      '/fr/finance',
      '/fr/loads',
      '/api/field/sync',
      '/api/finance',
      '/api/push/subscribe',
      '/xx/login',
      '/login',
      '/fr/loginx',
      '/fr/../orders',
    ])
      expect(firstBootAllows(p), p).toBe(false);
  });
});
