'use server';

import { currentAuthState } from '../auth/request-state';
import { totpQrDataUrl } from '../domain/totp-qr';

// @permission enrolment — only for the caller's own (re-)enrolment, checked below
/**
 * QR code for the caller's own enrolment (or re-enrolment after a recovery-code login). Rendered on our server;
 * the secret is never sent to an external service (DECISIONS 73).
 */
export async function totpQrForEnrolment(totpURI: string): Promise<string | null> {
  const state = await currentAuthState();
  const enrolling =
    state.kind === 'needs_enrolment' || (state.kind === 'authenticated' && state.user.reenrolRequired);
  if (!enrolling) return null;
  return totpQrDataUrl(totpURI, state.user.email);
}
