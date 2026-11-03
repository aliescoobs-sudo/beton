import { defaultFileStore } from '@/lib/files/server-store';
import { getPool } from '@/lib/db/pools';
import { openArrivalFile } from '@/modules/operations';
import { authorize } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission receipts.read (owner roles, plant, office_purchases, support): the weighbridge ticket or delivery note of an arrival; RLS is checked again, every view is audited
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const notFound = () => new Response('Not found', { status: 404 });
  const pool = getPool('app');
  const allowed = await authorize('receipts.read', { getState: currentAuthState, appPool: pool });
  if (!allowed.ok) return notFound();
  const { id } = await ctx.params;
  const opened = await openArrivalFile(pool, allowed.user, id, { store: defaultFileStore() });
  if (!opened.ok)
    return opened.error === 'NOT_FOUND' ? notFound() : new Response('Unavailable', { status: 409 });
  const { contentType, bytes, kind } = opened.value;
  const extension = contentType === 'application/pdf' ? 'pdf' : contentType.slice(6).replace('jpeg', 'jpg');
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': contentType,
      'content-disposition': `${contentType === 'application/pdf' ? 'attachment' : 'inline'}; filename="${kind}.${extension}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    },
  });
}
