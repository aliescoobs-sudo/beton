'use server';

import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { offersFinanceEnrolment } from '@/lib/training';
import { currentAuthState } from '../auth/request-state';
import { authSecretCipher } from '../auth/secret-cipher';
import { pendingTotpQr } from '../service/totp-enrolment';

// @permission enrolment — only for the caller's own (re-)enrolment, checked below
/**
 * QR code for the caller's own enrolment (or re-enrolment after a recovery-code login). Takes no argument: the secret
 * is the one staged server-side, so it never travels through a server-function call (and its logging). Rendered on
 * our server; the secret is never sent to an external service (DECISIONS 73).
 */
export async function totpQrForEnrolment(): Promise<string | null> {
  const state = await currentAuthState();
  // R12-07: also the voluntary enrolment of a training account of a finance role (same rule as the enrolment page), never anybody else.
  const enrolling =
    state.kind === 'needs_enrolment' ||
    (state.kind === 'authenticated' &&
      (state.user.reenrolRequired || (getEnv().TRAINING_MODE && offersFinanceEnrolment(state.user))));
  if (!enrolling) return null;
  const { id, email, reenrolRequired } = state.user;
  return pendingTotpQr(getPool('auth'), authSecretCipher(getEnv()).decrypt, {
    id,
    email,
    reenrolRequired,
  });
}
