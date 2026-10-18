import { createOTP } from '@better-auth/utils/otp';
import { APIError, getSessionFromCtx } from 'better-auth/api';
import { symmetricDecrypt } from 'better-auth/crypto';
import type pg from 'pg';
import type { Clock } from '@/modules/clock';
import { needsStepUp } from '../domain/step-up';
import { auditAuthEvent } from './audit';
import type { UserRole } from './user-service';

// Better Auth's middleware context; typed loosely on purpose (internal shape, pinned version, covered by tests).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookCtx = any;

export const TWO_FACTOR_PATHS = [
  '/two-factor/enable',
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/generate-backup-codes',
] as const;

type Flow =
  | { kind: 'enable'; userId: string }
  | { kind: 'regenerate'; userId: string }
  | { kind: 'login' | 'enrol' | 'step_up'; userId: string | null; method: 'totp' | 'recovery' };

interface Deps {
  authPool: pg.Pool;
  clock: Clock;
}

const TOTP_PERIOD_SECONDS = 30;

/** Per-request state handed from the before-hook to the after-hook (keyed by the request's headers object). */
const flows = new WeakMap<object, Flow>();
const flowKey = (ctx: HookCtx): object | undefined => ctx.headers ?? ctx.request;

async function roleOf(pool: pg.Pool, userId: string): Promise<UserRole> {
  const { rows } = await pool.query<{ role: UserRole }>('select role from "user" where id = $1', [userId]);
  return rows[0]!.role;
}

/** The user a second factor is being checked for: the session user, or the one behind the pending 2FA cookie. */
async function twoFactorUserId(
  ctx: HookCtx,
  session: { user: { id: string } } | null,
): Promise<string | null> {
  if (session) return session.user.id;
  const cookie = ctx.context.createAuthCookie('two_factor');
  const signed = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!signed) return null;
  const verification = await ctx.context.internalAdapter.findVerificationValue(signed);
  return verification?.value ?? null;
}

/**
 * TOTP replay protection (ADR 0001 gap 15): find the time-step the code belongs to (same ±1 window as the plugin)
 * and claim it atomically; a step already used, or an earlier one, is refused.
 */
async function claimTotpStep(ctx: HookCtx, deps: Deps, userId: string, code: string): Promise<void> {
  const { rows } = await deps.authPool.query<{ secret: string }>(
    'select secret from "twoFactor" where "userId" = $1',
    [userId],
  );
  if (!rows[0]) return; // not enrolled: the plugin refuses
  const otp = createOTP(await symmetricDecrypt({ key: ctx.context.secretConfig, data: rows[0].secret }));
  const current = Math.floor(deps.clock.now().getTime() / 1000 / TOTP_PERIOD_SECONDS);

  let step: number | undefined;
  for (const candidate of [current - 1, current, current + 1]) {
    if ((await otp.hotp(candidate)) === code) step = candidate;
  }
  if (step === undefined) return; // wrong code: the plugin refuses and counts the failure

  const { rowCount } = await deps.authPool.query(
    `insert into totp_used_step (user_id, last_step) values ($1, $2)
     on conflict (user_id) do update set last_step = excluded.last_step where totp_used_step.last_step < excluded.last_step`,
    [userId, step],
  );
  if (!rowCount) throw new APIError('UNAUTHORIZED', { message: 'Invalid code' });
}

export async function beforeTwoFactor(ctx: HookCtx, deps: Deps): Promise<void> {
  const key = flowKey(ctx);
  const session = await getSessionFromCtx(ctx);

  if (ctx.path === '/two-factor/enable' || ctx.path === '/two-factor/generate-backup-codes') {
    if (!session) throw new APIError('UNAUTHORIZED');
    const enrolled = session.user.twoFactorEnabled === true;
    // Re-enrolment happens only after the owner resets a user's 2FA; new codes only once enrolled.
    if (ctx.path === '/two-factor/enable' && enrolled)
      throw new APIError('FORBIDDEN', { message: 'Already enrolled' });
    if (ctx.path === '/two-factor/generate-backup-codes') {
      if (!enrolled) throw new APIError('FORBIDDEN');
      // Sensitive action 'auth.regenerate_recovery_codes': needs a second factor at most 10 minutes old.
      const at = (session.session as { twoFactorAt?: Date | string | null }).twoFactorAt;
      if (needsStepUp(at ? new Date(at) : null, deps.clock.now())) {
        throw new APIError('FORBIDDEN', {
          code: 'STEP_UP_REQUIRED',
          message: 'Confirm with your authenticator code',
        });
      }
    }
    if (key)
      flows.set(key, {
        kind: ctx.path === '/two-factor/enable' ? 'enable' : 'regenerate',
        userId: session.user.id,
      });
    return;
  }

  // verify-totp / verify-backup-code
  if (ctx.body?.trustDevice) throw new APIError('BAD_REQUEST', { message: 'trustDevice is not allowed' });
  const userId = await twoFactorUserId(ctx, session);
  const kind = !session ? 'login' : session.user.twoFactorEnabled ? 'step_up' : 'enrol';
  const method = ctx.path === '/two-factor/verify-totp' ? 'totp' : 'recovery';
  if (method === 'totp' && userId && typeof ctx.body?.code === 'string') {
    await claimTotpStep(ctx, deps, userId, ctx.body.code.trim());
  }
  if (key) flows.set(key, { kind, userId, method });
}

export async function afterTwoFactor(ctx: HookCtx, deps: Deps): Promise<void> {
  const key = flowKey(ctx);
  const flow = key ? flows.get(key) : undefined;
  if (key) flows.delete(key);
  if (!flow || !flow.userId || ctx.context.returned instanceof APIError) return;

  const actor = { userId: flow.userId, role: await roleOf(deps.authPool, flow.userId) };

  if (flow.kind === 'enable' || flow.kind === 'regenerate') {
    await auditAuthEvent(deps.authPool, actor, { action: 'recovery_codes_generated', table: 'twoFactor' });
    return;
  }

  const sessionId: string | undefined =
    ctx.context.newSession?.session.id ?? (await getSessionFromCtx(ctx))?.session.id;
  if (sessionId) {
    await deps.authPool.query('update session set "twoFactorAt" = $1 where id = $2', [
      deps.clock.now(),
      sessionId,
    ]);
  }
  if (flow.method === 'recovery') {
    await auditAuthEvent(deps.authPool, actor, { action: 'recovery_code_used', table: 'twoFactor' });
  }
  const action = flow.kind === 'login' ? 'login' : flow.kind === 'enrol' ? 'two_factor_enrolled' : 'step_up';
  await auditAuthEvent(deps.authPool, actor, {
    action,
    table: 'session',
    ...(sessionId ? { rowId: sessionId } : {}),
  });
}
