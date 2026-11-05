import { describe, it, expect, vi } from 'vitest';
import { realClock } from '@/modules/clock';
import { handleFinancePost } from './http';
const actor = {
  id: '01900000-0000-7000-8000-000000000010',
  role: 'owner',
  name: 'Owner',
  email: 'fake@example.test',
  locale: 'fr' as const,
  twoFactorEnabled: true,
  reenrolRequired: false,
};
const request = (input: unknown, origin = 'http://localhost:3200') =>
  new Request('http://localhost:3200/api/finance', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
function deps(role = 'owner', enabled = true) {
  return {
    baseUrl: 'http://localhost:3200',
    getState: vi.fn(async () => ({
      kind: 'authenticated',
      user: { ...actor, role },
      session: { twoFactorAt: realClock.now() },
    })),
    enabled: vi.fn(async () => enabled),
    execute: vi.fn(async () => ({ id: 'made' })),
  };
}
describe('finance HTTP authorization and flag', () => {
  it('is hidden when disabled; writes do not execute', async () => {
    const d = deps('owner', false);
    expect((await handleFinancePost(request({ action: 'entry' }), d)).status).toBe(404);
    expect(d.execute).not.toHaveBeenCalled();
  });
  for (const role of [
    'office',
    'office_sales',
    'office_purchases',
    'partner',
    'plant',
    'support',
    'accountant',
    'driver',
    'pump_operator',
    'client_portal',
    'supplier_portal',
  ])
    it(`refuses ${role} before loading finance data`, async () => {
      const d = deps(role);
      expect((await handleFinancePost(request({ action: 'entry' }), d)).status).toBe(404);
      expect(d.enabled).not.toHaveBeenCalled();
      expect(d.execute).not.toHaveBeenCalled();
    });
  it('refuses cross-origin, missing origin, or un-enrolled state', async () => {
    const d = deps();
    expect((await handleFinancePost(request({ action: 'entry' }, 'https://untrusted.test'), d)).status).toBe(
      404,
    );
    expect(d.getState).not.toHaveBeenCalled();
    d.getState.mockResolvedValue({
      kind: 'authenticated',
      user: { ...actor, twoFactorEnabled: false },
      session: { twoFactorAt: realClock.now() },
    });
    expect((await handleFinancePost(request({ action: 'entry' }), d)).status).toBe(404);
  });
  it('allows owner and app_admin writes; configuration is a separate, step-up protected administrative endpoint', async () => {
    const d = deps('app_admin');
    expect((await handleFinancePost(request({ action: 'entry' }), d)).status).toBe(200);
    expect((await handleFinancePost(request({ action: 'configure' }), d)).status).toBe(404);
    const c = { ...deps('owner', true), configuration: true };
    expect((await handleFinancePost(request({ action: 'configure' }), c)).status).toBe(200);
    expect((await handleFinancePost(request({ action: 'entry' }), c)).status).toBe(404);
  });
  it('F10: with the environment flag off the configuration endpoint is hidden too and executes nothing', async () => {
    for (const role of ['owner', 'app_admin']) {
      const c = { ...deps(role, false), configuration: true };
      const res = await handleFinancePost(request({ action: 'configure', enabled: true }), c);
      expect(res.status).toBe(404);
      expect(c.enabled).toHaveBeenCalled();
      expect(c.execute).not.toHaveBeenCalled();
    }
  });
  it('F10: the configuration endpoint still needs the role, the origin and a signed-in session', async () => {
    const wrongRole = { ...deps('office_sales', true), configuration: true };
    expect((await handleFinancePost(request({ action: 'configure' }), wrongRole)).status).toBe(404);
    expect(wrongRole.execute).not.toHaveBeenCalled();
  });
  it('sanitizes database errors, enforces a bounded body and signals fresh TOTP', async () => {
    const d = deps();
    d.execute.mockRejectedValueOnce(new Error('STEP_UP_REQUIRED'));
    const step = await handleFinancePost(request({ action: 'entry' }), d);
    expect(step.status).toBe(409);
    expect(await step.json()).toEqual({ error: 'STEP_UP_REQUIRED' });
    d.execute.mockRejectedValueOnce(new Error('private row details'));
    const refused = await handleFinancePost(request({ action: 'entry' }), d);
    expect(await refused.text()).not.toContain('private');
    expect(
      (await handleFinancePost(request({ action: 'entry', payload: 'x'.repeat(131073) }), d)).status,
    ).toBe(413);
  });
});
