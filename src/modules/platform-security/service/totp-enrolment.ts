import { createOTP } from '@better-auth/utils/otp';
import type pg from 'pg';
import { TOTP_ISSUER, totpQrDataUrl } from '../domain/totp-qr';

/**
 * QR code of the caller's own staged authenticator. The secret is read from the database (the staged re-enrolment,
 * or the not yet verified first enrolment) and never passed in by the browser, so it is not a server-action argument
 * and cannot reach a framework log.
 */
export async function pendingTotpQr(
  pool: pg.Pool,
  decrypt: (sealed: string) => string | Promise<string>,
  user: { id: string; email: string; reenrolRequired: boolean },
): Promise<string | null> {
  const { rows } = user.reenrolRequired
    ? await pool.query<{ secret: string }>('select secret from two_factor_pending where user_id = $1', [
        user.id,
      ])
    : await pool.query<{ secret: string }>(
        'select secret from "twoFactor" where "userId" = $1 and verified = false',
        [user.id],
      );
  if (!rows[0]) return null;
  const uri = createOTP(await decrypt(rows[0].secret)).url(TOTP_ISSUER, user.email);
  return totpQrDataUrl(uri, user.email);
}
