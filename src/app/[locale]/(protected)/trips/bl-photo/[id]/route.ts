import { defaultFileStore } from '@/lib/files/server-store';
import { getPool } from '@/lib/db/pools';
import { openDriverBlPhoto } from '@/modules/field';
import { authorize } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission driver_bl_photos.read (offices, owner roles, plant, support): the driver's photo of a signed BL; RLS is checked again, every view is audited
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const notFound = () => new Response('Not found', { status: 404 });
  const pool = getPool('app');
  const allowed = await authorize('driver_bl_photos.read', { getState: currentAuthState, appPool: pool });
  if (!allowed.ok) return notFound();
  const { id } = await ctx.params;
  const opened = await openDriverBlPhoto(pool, allowed.user, id, { store: defaultFileStore() });
  if (!opened.ok)
    return opened.error === 'NOT_FOUND' ? notFound() : new Response('Unavailable', { status: 409 });
  const { contentType, bytes, orderCode } = opened.value;
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': contentType,
      'content-disposition': `inline; filename="${orderCode}-bl-chauffeur.${contentType.slice(6).replace('jpeg', 'jpg')}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    },
  });
}
