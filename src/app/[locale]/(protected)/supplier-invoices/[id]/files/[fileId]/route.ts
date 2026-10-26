import { getPool } from '@/lib/db/pools';
import { defaultFileStore } from '@/lib/files/server-store';
import { openSupplierInvoiceFile } from '@/modules/ledger';
import { authorize } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission supplier_invoices.read (owner, support): a stored document of a supplier invoice; RLS is checked again, every view is audited
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string; fileId: string }> },
): Promise<Response> {
  const notFound = () => new Response('Not found', { status: 404 });
  const pool = getPool('app');
  const allowed = await authorize('supplier_invoices.read', { getState: currentAuthState, appPool: pool });
  if (!allowed.ok) return notFound();
  const { id, fileId } = await ctx.params;
  const opened = await openSupplierInvoiceFile(
    pool,
    allowed.user,
    { supplierInvoiceId: id, fileId },
    { store: defaultFileStore() },
  );
  if (!opened.ok)
    return opened.error === 'NOT_FOUND' ? notFound() : new Response('Unavailable', { status: 409 });
  const { contentType, bytes, code, seq } = opened.value;
  const extension = contentType === 'application/pdf' ? 'pdf' : contentType.slice(6).replace('jpeg', 'jpg');
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': contentType,
      // A PDF is only ever downloaded; an image may be shown, inside a sandbox that runs nothing.
      'content-disposition': `${contentType === 'application/pdf' ? 'attachment' : 'inline'}; filename="${code}-${seq}.${extension}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    },
  });
}
