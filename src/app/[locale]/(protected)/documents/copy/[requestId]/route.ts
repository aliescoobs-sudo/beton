import { getPool } from '@/lib/db/pools';
import {
  COPY_REQUEST_KIND,
  listDocumentLibrary,
  listMyDocumentRequests,
  type DocumentRequestKind,
} from '@/modules/ledger';
import { authorize, type DocumentKind } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';
import { getEnv } from '@/lib/server-env';

const KIND_OF: Record<string, DocumentKind> = Object.fromEntries(
  Object.entries(COPY_REQUEST_KIND).map(([k, v]) => [v, k as DocumentKind]),
);

// @permission documents.request (offices and accountant): turns the caller's own approved request into the link of the document it names (F08).
// It reads nothing but the caller's own requests and the library the caller may already open, and consumes nothing: the download does.
export async function GET(
  request: Request,
  ctx: { params: Promise<{ requestId: string; locale: string }> },
): Promise<Response> {
  const notFound = () => new Response('Not found', { status: 404 });
  if (!getEnv().DOCUMENTS_V1_ENABLED) return notFound();
  const pool = getPool('app');
  const allowed = await authorize('documents.request', { getState: currentAuthState, appPool: pool });
  if (!allowed.ok) return notFound();
  const { requestId } = await ctx.params;
  const mine = (await listMyDocumentRequests(pool, allowed.user)).find(
    (r) => r.id === requestId && r.status === 'approved',
  );
  const kind = mine ? KIND_OF[mine.kind as DocumentRequestKind] : undefined;
  if (!mine || !kind || !mine.docRef) return notFound();
  const entry = (await listDocumentLibrary(pool, allowed.user, kind)).find((e) => e.number === mine.docRef);
  if (!entry) return notFound();
  // Same origin, built from the request's own path, never from a parameter.
  const target = new URL(
    `/documents/${kind}/${encodeURIComponent(entry.id)}?copy=${encodeURIComponent(requestId)}`,
    request.url,
  );
  return Response.redirect(target, 302);
}
