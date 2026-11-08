import { afterAll, describe, expect, it } from 'vitest';
import { TRAINING_EMAIL_DOMAIN } from '../src/lib/training';
import { BOOTSTRAP_ACTOR_ID } from '../src/modules/platform-security';
import { resolveAuthState } from '../src/modules/platform-security/auth/session-gate';
import { withStepUp } from '../src/modules/platform-security/auth/step-up-guard';
import { createUser } from '../src/modules/platform-security/auth/user-service';
import { can } from '../src/modules/platform-security/domain/permissions';
import { defaultParameters } from '../src/modules/platform-security/domain/parameters';
import { authTestKit } from './auth-helpers';

// T1: a training account works with a password alone, only while TRAINING_MODE is on and only on the reserved address. Nothing else changes.
const kit = authTestKit();
afterAll(() => kit.close());

async function signedIn(email: string, role: 'office_sales' | 'accountant' = 'office_sales') {
  await createUser(kit.auth, kit.authPool, {
    actor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' },
    email,
    name: 'Compte Démo',
    password: kit.password,
    role,
    locale: 'fr',
  });
  const cookie = kit.cookieOf(await kit.call('/sign-in/email', { email, password: kit.password }));
  return cookie;
}
const stateOf = (cookie: string, trainingMode: boolean) =>
  resolveAuthState(kit.auth, new Headers({ cookie }), { trainingMode });
const unique = () => Math.random().toString(36).slice(2, 9);

describe('password-only training accounts (T1)', () => {
  it('are authenticated with a password alone in training mode, with their own role and no more', async () => {
    const cookie = await signedIn(`ventes-${unique()}@${TRAINING_EMAIL_DOMAIN}`);
    const s = await stateOf(cookie, true);
    expect(s.kind).toBe('authenticated');
    if (s.kind !== 'authenticated') return;
    expect(s.user.role).toBe('office_sales');
    // the role is the application's own: office sales still reads no money, and an accountant still cannot write orders
    expect(can(s.user.role, 'orders.read_money')).toBe(false);
    expect(can('accountant', 'orders.write')).toBe(false);
  });

  it('are asked to enrol as everybody else when the instance is not in training mode', async () => {
    const cookie = await signedIn(`ventes-${unique()}@${TRAINING_EMAIL_DOMAIN}`);
    expect((await stateOf(cookie, false)).kind).toBe('needs_enrolment');
    expect((await resolveAuthState(kit.auth, new Headers({ cookie }))).kind).toBe('needs_enrolment');
  });

  it('are not granted to any other address: a real-looking account still has to enrol, even in training mode', async () => {
    const cookie = await signedIn(`ventes-${unique()}@kayas.test`);
    expect((await stateOf(cookie, true)).kind).toBe('needs_enrolment');
    const spoof = await signedIn(`x-${unique()}@${TRAINING_EMAIL_DOMAIN}.evil.test`);
    expect((await stateOf(spoof, true)).kind).toBe('needs_enrolment');
  });

  it('can practise a sensitive action: the step-up is satisfied by the signed-in session, and the database mark is set', async () => {
    const cookie = await signedIn(`compta-${unique()}@${TRAINING_EMAIL_DOMAIN}`, 'accountant');
    const state = await stateOf(cookie, true);
    const result = await withStepUp('prices.confirm', async (u) => u.stepUpVerified === true, {
      getState: async () => state,
      parameters: async () => defaultParameters(),
    });
    expect(result).toEqual({ ok: true, value: true });
  });
});
