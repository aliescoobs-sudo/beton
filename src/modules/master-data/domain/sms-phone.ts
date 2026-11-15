import { createHmac } from 'node:crypto';

/**
 * A Moroccan or international mobile number to E.164 (`+212612345678`), or null. Accepts spaces, dots, dashes, `00` and `+` prefixes
 * and the national `06...` / `07...` forms. A pure function: it is also what the SMS channel will use to look a sender up.
 */
export function normalizePhoneE164(input: string): string | null {
  // NFKC turns full-width digits into ASCII; Arabic-Indic (U+0660..0669) and Persian (U+06F0..06F9) digits are mapped by hand (NFKC leaves them alone)
  const raw = input
    .normalize('NFKC')
    .replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String((d.codePointAt(0)! - 0x0660) % 16))
    .replace(/[\s.\-()]/g, '');
  let digits: string;
  if (raw.startsWith('+')) digits = raw.slice(1);
  else if (raw.startsWith('00')) digits = raw.slice(2);
  else if (/^0[5-7]\d{8}$/.test(raw)) digits = `212${raw.slice(1)}`;
  else return null;
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

/** Keyed hash (HMAC-SHA256, hex) of an E.164 number, with a domain label; the key is the server secret LOOKUP_HMAC_KEY (base64). */
export function phoneLookupHash(hmacKeyBase64: string, e164: string): string {
  return createHmac('sha256', Buffer.from(hmacKeyBase64, 'base64'))
    .update(`sms-phone-v1:${e164}`)
    .digest('hex');
}

/** What the screens may show of a number: the last three digits. */
export const maskPhone = (e164: string): string => `•••${e164.slice(-3)}`;

export const SMS_SENDER_REASONS = [
  'new_driver',
  'new_number',
  'spare_number',
  'sim_change',
  'correction',
] as const;
export const SMS_SENDER_END_REASONS = ['left_company', 'number_changed', 'lost_phone', 'correction'] as const;
