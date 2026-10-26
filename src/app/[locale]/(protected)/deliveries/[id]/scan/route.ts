import { defaultFileStore } from '@/lib/files/server-store';
import { getPool } from '@/lib/db/pools';
import { openDeliveryScan } from '@/modules/operations';
import { authorize } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission delivery_files.read (owner, partner, office, plant, support): the scan of a signed BL; RLS is checked again, every view is audited
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const notFound = () => new Response('Not found', { status: 404 });
  const pool = getPool('app');
  const allowed = await authorize('delivery_files.read', { getState: currentAuthState, appPool: pool });
  if (!allowed.ok) return notFound();
  const { id } = await ctx.params;
  const opened = await openDeliveryScan(pool, allowed.user, id, { store: defaultFileStore() });
  if (!opened.ok)
    return opened.error === 'NOT_FOUND' ? notFound() : new Response('Unavailable', { status: 409 });
  const { contentType, bytes, blNo } = opened.value;
  const extension = contentType === 'application/pdf' ? 'pdf' : contentType.slice(6).replace('jpeg', 'jpg');
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': contentType,
      // A PDF is only ever downloaded; an image may be shown, inside a sandbox that runs nothing.
      'content-disposition': `${contentType === 'application/pdf' ? 'attachment' : 'inline'}; filename="${blNo}-signe.${extension}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    },
  });
}
