import { renderSVG } from 'uqr';

export const TOTP_ISSUER = 'BELGOBETON';

/**
 * QR code (SVG data URL) for the caller's own TOTP enrolment URI, rendered locally (DECISIONS 73): the secret never
 * leaves our server/browser. Anything that is not a BELGOBETON TOTP URI for `email` is refused (null).
 */
export function totpQrDataUrl(uri: string, email: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'otpauth:' || url.host !== 'totp') return null;
  if (url.searchParams.get('issuer') !== TOTP_ISSUER) return null;
  if (decodeURIComponent(url.pathname.slice(1)) !== `${TOTP_ISSUER}:${email}`) return null;
  if (!/^[A-Z2-7]+=*$/.test(url.searchParams.get('secret') ?? '')) return null;

  const svg = renderSVG(uri, { ecc: 'M', border: 2 });
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
