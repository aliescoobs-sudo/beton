import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import type pg from 'pg';
import { type Env, secretValuesOf } from '@/lib/env';
import { createClockLogger, getLogger, realClock } from '@/modules/clock';
import { ANONYMOUS_ACTOR_ID } from './actors';
import { auditAuthEvent } from './audit';
import {
  checkLogin,
  clientIp,
  identifierHmacHex,
  type LoginGuardDeps,
  normalizeIdentifier,
  recordLogin,
} from './login-guard';
import { readParameters } from '../service/parameter-service';
import { baseAuthOptions } from './options';
import { enforceAbsoluteLifetime } from './session-lifetime';
import { afterTwoFactor, beforeTwoFactor, TWO_FACTOR_PATHS } from './two-factor-hooks';

/** Auth endpoints reachable over HTTP; everything else Better Auth ships answers 404 (ADR 0001). */
export const ALLOWED_AUTH_PATHS = new Set<string>([
  '/sign-in/email',
  '/sign-out',
  '/get-session',
  ...TWO_FACTOR_PATHS,
]);

/** One message for every lockout, so it never reveals whether an account exists. */
export const LOCKED_MESSAGE = 'Too many attempts. Try again later.';

export interface CreateAuthDeps {
  authPool: pg.Pool;
  env: Env;
  /** Line sink for logs (tests); defaults to the process logger. */
  log?: (line: string) => void;
}

export function createAuth({ authPool, env, log }: CreateAuthDeps) {
  const logger = log
    ? createClockLogger({ clock: realClock, secretValues: secretValuesOf(env), write: log })
    : getLogger();
  const parameters = () => readParameters(authPool);
  const guard: LoginGuardDeps = {
    pool: authPool,
    hmacKey: env.LOOKUP_HMAC_KEY,
    clock: realClock,
    parameters,
  };
  const anonymous = { userId: ANONYMOUS_ACTOR_ID, role: 'anonymous' as const };
  const twoFactorDeps = { authPool, clock: realClock, parameters };
  const signInAttempt = (body: unknown) => ({
    identifier: normalizeIdentifier((body as { email?: unknown } | undefined)?.email),
  });

  return betterAuth({
    ...baseAuthOptions({ authPool, env }),
    // Only the message reaches our logger: arguments can carry request data (emails, bodies).
    logger: {
      level: 'warn',
      log: (level, message) => logger[level](String(message)),
    },
    // Replaces Better Auth's own error printing (which bypasses our logger): status and code only.
    onAPIError: {
      onError: (error) => {
        const e = error as { status?: unknown; body?: { code?: unknown } };
        logger.warn('auth request refused', {
          status: String(e.status ?? 'unknown'),
          code: String(e.body?.code ?? ''),
        });
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            // Disabled users never get a session (AC-SEC-14), whichever flow creates it.
            const { rows } = await authPool.query<{ status: string }>(
              'select status from "user" where id = $1',
              [session.userId],
            );
            if (rows[0]?.status !== 'active') return false;
            // Raw IPs are never stored (a CHECK constraint enforces it); login_attempt keeps a keyed hash.
            return { data: { ...session, ipAddress: null } };
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!ALLOWED_AUTH_PATHS.has(ctx.path)) throw new APIError('NOT_FOUND');

        if (ctx.path === '/sign-out') {
          const session = await getSessionFromCtx(ctx);
          if (session) {
            await auditAuthEvent(
              authPool,
              { userId: session.user.id, role: session.user.role },
              {
                action: 'logout',
                table: 'session',
                rowId: session.session.id,
              },
            );
          }
          return;
        }
        await enforceAbsoluteLifetime(ctx, twoFactorDeps);
        if (ctx.path.startsWith('/two-factor/')) return beforeTwoFactor(ctx, twoFactorDeps);

        if (ctx.path === '/sign-in/email') {
          const { identifier } = signInAttempt(ctx.body);
          const ip = clientIp(ctx.headers);
          const verdict = await checkLogin(guard, identifier, ip);
          if (verdict !== 'allowed') {
            await auditAuthEvent(authPool, anonymous, {
              action: 'account_locked',
              table: 'user',
              after: { identifier_hmac: identifierHmacHex(env.LOOKUP_HMAC_KEY, identifier), scope: verdict },
            });
            throw new APIError('TOO_MANY_REQUESTS', { message: LOCKED_MESSAGE });
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path.startsWith('/two-factor/')) return afterTwoFactor(ctx, twoFactorDeps);
        if (ctx.path !== '/sign-in/email') return;
        const { identifier } = signInAttempt(ctx.body);
        const ip = clientIp(ctx.headers);
        const failed = ctx.context.returned instanceof APIError;
        await recordLogin(guard, identifier, ip, !failed);

        if (failed) {
          const known = identifier ? await ctx.context.internalAdapter.findUserByEmail(identifier) : null;
          await auditAuthEvent(authPool, anonymous, {
            action: 'login_failed',
            table: 'user',
            ...(known ? { rowId: known.user.id } : {}),
            after: { identifier_hmac: identifierHmacHex(env.LOOKUP_HMAC_KEY, identifier) },
          });
          return;
        }

        // With 2FA on, the password step only opens the TOTP step; the login is audited after TOTP.
        const session = ctx.context.newSession;
        if (session && session.user.twoFactorEnabled !== true) {
          await auditAuthEvent(
            authPool,
            { userId: session.user.id, role: session.user.role },
            {
              action: 'login',
              table: 'session',
              rowId: session.session.id,
            },
          );
        }
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
