import { createOTP } from '@better-auth/utils/otp';
import { APIError, getSessionFromCtx } from 'better-auth/api';
import { symmetricDecrypt } from 'better-auth/crypto';
import type pg from 'pg';
import type { Clock } from '@/modules/clock';
import type { ParameterValues } from '../domain/parameters';
import { sensitiveActionBlocker } from '../domain/step-up';
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
  | { kind: 'enable'; userId: string; reenrol: boolean }
  | { kind: 'regenerate'; userId: string }
  | { kind: 'login' | 'enrol' | 'reenrol' | 'step_up'; userId: string | null; method: 'totp' | 'recovery' };

interface Deps {
  authPool: pg.Pool;
  clock: Clock;
  parameters: () => Promise<ParameterValues>;
}

const TOTP_PERIOD_SECONDS = 30;

/** Per-request state handed from the before-hook to the after-hook (keyed by the request's headers object). */
const flows = new WeakMap<object, Flow>();
const flowKey = (ctx: HookCtx): object | undefined => ctx.headers ?? ctx.request;

interface SessionUserRow {
  id: string;
  twoFactorEnabled?: boolean | null;
  reenrolRequired?: boolean;
}

async function roleOf(pool: pg.Pool, userId: string): Promise<UserRole> {
  const { rows } = await pool.query<{ role: UserRole }>('select role from "user" where id = $1', [userId]);
  return rows[0]!.role;
}

async function twoFactorVerified(pool: pg.Pool, userId: string): Promise<boolean | null> {
  const { rows } = await pool.query<{ verified: boolean | null }>(
    'select verified from "twoFactor" where "userId" = $1',
    [userId],
  );
  return rows[0] ? rows[0].verified !== false : null;
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

async function passwordMatches(ctx: HookCtx, userId: string, password: unknown): Promise<boolean> {
  if (typeof password !== 'string') return false;
  const accounts: { providerId: string; password?: string | null }[] =
    await ctx.context.internalAdapter.findAccounts(userId);
  const hash = accounts.find((a) => a.providerId === 'credential')?.password;
  return !!hash && (await ctx.context.password.verify({ hash, password }));
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
  const user = session?.user as SessionUserRow | undefined;
  const enrolled = user?.twoFactorEnabled === true;

  if (ctx.path === '/two-factor/enable') {
    if (!session || !user) throw new APIError('UNAUTHORIZED');
    // Only authenticator apps: the "otp" method would turn 2FA on without one.
    if (ctx.body?.method !== undefined && ctx.body.method !== 'totp') throw new APIError('BAD_REQUEST');
    let reenrol = false;
    if (enrolled) {
      // Enrolling again is allowed only after a recovery-code login (DECISIONS 72); owner resets come in T13.
      if (!user.reenrolRequired) throw new APIError('FORBIDDEN', { message: 'Already enrolled' });
      // Check the password before touching anything, so a wrong one cannot disable the current authenticator.
      if (!(await passwordMatches(ctx, user.id, ctx.body?.password))) {
        throw new APIError('BAD_REQUEST', { message: 'Invalid password' });
      }
      await deps.authPool.query('update "twoFactor" set verified = false where "userId" = $1', [user.id]);
      // A new secret is a new replay domain: steps used by the old authenticator must not block the new one.
      await deps.authPool.query('update totp_used_step set last_step = 0 where user_id = $1', [user.id]);
      reenrol = true;
    }
    if (key) flows.set(key, { kind: 'enable', userId: user.id, reenrol });
    return;
  }

  if (ctx.path === '/two-factor/generate-backup-codes') {
    if (!session || !user) throw new APIError('UNAUTHORIZED');
    if (!enrolled) throw new APIError('FORBIDDEN');
    // Sensitive action 'auth.regenerate_recovery_codes'.
    const at = (session.session as { twoFactorAt?: Date | string | null }).twoFactorAt;
    const blocker = sensitiveActionBlocker(
      { reenrolRequired: user.reenrolRequired === true, twoFactorAt: at ? new Date(at) : null },
      deps.clock.now(),
      (await deps.parameters())['auth.step_up_minutes'] * 60_000,
    );
    if (blocker)
      throw new APIError('FORBIDDEN', { code: blocker, message: 'A fresh second factor is required' });
    if (key) flows.set(key, { kind: 'regenerate', userId: user.id });
    return;
  }

  // verify-totp / verify-backup-code
  if (ctx.body?.trustDevice) throw new APIError('BAD_REQUEST', { message: 'trustDevice is not allowed' });
  const userId = await twoFactorUserId(ctx, session);
  const method = ctx.path === '/two-factor/verify-totp' ? 'totp' : 'recovery';
  let kind: 'login' | 'enrol' | 'reenrol' | 'step_up' = 'login';
  if (user) {
    if (!enrolled) kind = 'enrol';
    else
      kind =
        user.reenrolRequired && (await twoFactorVerified(deps.authPool, user.id)) === false
          ? 'reenrol'
          : 'step_up';
  }
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
    await auditAuthEvent(deps.authPool, actor, {
      action: 'recovery_codes_generated',
      table: 'twoFactor',
      ...(flow.kind === 'enable' && flow.reenrol ? { reason: 're_enrolment' } : {}),
    });
    return;
  }

  const sessionId: string | undefined =
    ctx.context.newSession?.session.id ?? (await getSessionFromCtx(ctx))?.session.id;

  if (flow.method === 'recovery') {
    // A recovery code proves less than a TOTP: no step-up credit, and a new authenticator is required (DECISIONS 72).
    await deps.authPool.query('update "user" set "reenrolRequired" = true where id = $1', [flow.userId]);
    await auditAuthEvent(deps.authPool, actor, { action: 'recovery_code_used', table: 'twoFactor' });
    if (flow.kind === 'login') {
      await auditAuthEvent(deps.authPool, actor, {
        action: 'login',
        table: 'session',
        reason: 'recovery_code',
        ...(sessionId ? { rowId: sessionId } : {}),
      });
    }
    return;
  }

  if (sessionId) {
    await deps.authPool.query('update session set "twoFactorAt" = $1 where id = $2', [
      deps.clock.now(),
      sessionId,
    ]);
  }
  if (flow.kind === 'reenrol') {
    await deps.authPool.query('update "user" set "reenrolRequired" = false where id = $1', [flow.userId]);
  }
  const action =
    flow.kind === 'login' ? 'login' : flow.kind === 'step_up' ? 'step_up' : 'two_factor_enrolled';
  await auditAuthEvent(deps.authPool, actor, {
    action,
    table: 'session',
    ...(sessionId ? { rowId: sessionId } : {}),
    ...(flow.kind === 'reenrol' ? { reason: 're_enrolment' } : {}),
  });
}
