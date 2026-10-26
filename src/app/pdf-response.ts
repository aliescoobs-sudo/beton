import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { getCompanyProfile } from '@/modules/ledger';
import type { SessionUser } from '@/modules/platform-security';

/** A generated PDF leaves the server once, as a download: never cached, never sniffed, never stored. */
export function pdfResponse(bytes: Uint8Array, filename: string): Response {
  return new Response(Buffer.from(bytes), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
}

/** The company block and the pilot watermark: the pilot runs on fake data, so every document says so. */
export async function pdfContext(user: SessionUser) {
  const company = await getCompanyProfile(getPool('app'), user, {
    today: (await getRequestClock()).today(),
  });
  return { company, specimen: !getEnv().REAL_DATA };
}
