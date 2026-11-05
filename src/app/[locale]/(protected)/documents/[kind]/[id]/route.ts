import { pdfContext, pdfResponse } from '@/app/pdf-response';
import { getPool } from '@/lib/db/pools';
import { defaultFileStore } from '@/lib/files/server-store';
import {
  avoirPdf,
  COPY_REQUEST_KIND,
  consumeDocumentCopy,
  getInvoiceDocument,
  getInvoiceForPrint,
  getQuote,
  invoicePdf,
  legalMentions,
  listAvoirs,
  mayOpen,
  openSupplierInvoiceFile,
  quotePdf,
  recordLibraryOpen,
} from '@/modules/ledger';
import { deliveryNotePdf, getDeliveryNote } from '@/modules/operations';
import { authorize, isDocumentKind } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';

// @permission documents.read (every signed-in role), then the permission of the document type (§16.2): the type is checked again here, the read goes through the caller's own row-level security (or the invoice print door), and every open is audited
export async function GET(
  request: Request,
  ctx: { params: Promise<{ kind: string; id: string }> },
): Promise<Response> {
  const notFound = () => new Response('Not found', { status: 404 });
  const pool = getPool('app');
  const allowed = await authorize('documents.read', { getState: currentAuthState, appPool: pool });
  if (!allowed.ok) return notFound();
  const { kind, id } = await ctx.params;
  if (!isDocumentKind(kind) || !mayOpen(allowed.user.role, kind)) return notFound();
  const user = allowed.user;
  // F08: `?copy=<request id>` is the delivery of a client copy. It needs an approved request of the caller for this very document,
  // consumed here (single use, 24 hours). Without it, this is the internal view/print, which is unchanged. A client copy of a
  // document type that has no request kind (a supplier file) does not exist.
  const copyId = new URL(request.url).searchParams.get('copy');
  const gate = async (docKind: keyof typeof COPY_REQUEST_KIND, number: string): Promise<boolean> =>
    copyId === null ||
    (await consumeDocumentCopy(pool, user, { requestId: copyId, kind: docKind, docRef: number }).catch(
      () => false,
    ));
  if (copyId !== null && !(kind in COPY_REQUEST_KIND)) return notFound();
  switch (kind) {
    case 'invoice': {
      const printed = ['office_sales', 'office'].includes(user.role);
      const doc = printed
        ? await getInvoiceForPrint(pool, user, id)
        : await getInvoiceDocument(pool, user, id);
      if (!doc) return notFound();
      if (!(await gate('invoice', doc.invoice.number))) return notFound();
      await recordLibraryOpen(pool, user, `${copyId ? 'copy:' : ''}invoice:${doc.invoice.number}`);
      return pdfResponse(invoicePdf(doc, await pdfContext(user)), doc.invoice.number);
    }
    case 'avoir': {
      const avoir = (await listAvoirs(pool, user)).find((a) => a.id === id);
      if (!avoir) return notFound();
      if (!(await gate('avoir', avoir.number))) return notFound();
      await recordLibraryOpen(pool, user, `${copyId ? 'copy:' : ''}avoir:${avoir.number}`);
      return pdfResponse(avoirPdf(avoir, await pdfContext(user)), avoir.number);
    }
    case 'quote': {
      const quote = await getQuote(pool, user, id);
      if (!quote) return notFound();
      if (!(await gate('quote', quote.code))) return notFound();
      await recordLibraryOpen(pool, user, `${copyId ? 'copy:' : ''}quote:${quote.code}`);
      return pdfResponse(quotePdf(quote, await pdfContext(user)), quote.code);
    }
    case 'bl': {
      const note = await getDeliveryNote(pool, user, id);
      if (!note) return notFound();
      if (!(await gate('bl', note.blNo))) return notFound();
      const { company, specimen } = await pdfContext(user);
      const mentions = company ? legalMentions({ ...company, rib: null }) : [];
      await recordLibraryOpen(pool, user, `${copyId ? 'copy:' : ''}bl:${note.blNo}`);
      return pdfResponse(deliveryNotePdf(note, { specimen, company: mentions }), `BL-${note.blNo}`);
    }
    case 'supplier_invoice_file': {
      const opened = await openSupplierInvoiceFile(
        pool,
        user,
        { supplierInvoiceId: id.split(':')[0] ?? '', fileId: id.split(':')[1] ?? '' },
        { store: defaultFileStore() },
      );
      if (!opened.ok) return notFound();
      const { contentType, bytes, code, seq } = opened.value;
      await recordLibraryOpen(pool, user, `supplier_invoice_file:${code}-${seq}`);
      const extension =
        contentType === 'application/pdf' ? 'pdf' : contentType.slice(6).replace('jpeg', 'jpg');
      return new Response(new Uint8Array(bytes), {
        headers: {
          'content-type': contentType,
          'content-disposition': `${contentType === 'application/pdf' ? 'attachment' : 'inline'}; filename="${code}-${seq}.${extension}"`,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'private, no-store',
        },
      });
    }
  }
}
