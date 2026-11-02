import { pdfContext, pdfResponse } from '@/app/pdf-response';
import { getPool } from '@/lib/db/pools';
import { defaultFileStore } from '@/lib/files/server-store';
import {
  avoirPdf,
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
  _request: Request,
  ctx: { params: Promise<{ kind: string; id: string }> },
): Promise<Response> {
  const notFound = () => new Response('Not found', { status: 404 });
  const pool = getPool('app');
  const allowed = await authorize('documents.read', { getState: currentAuthState, appPool: pool });
  if (!allowed.ok) return notFound();
  const { kind, id } = await ctx.params;
  if (!isDocumentKind(kind) || !mayOpen(allowed.user.role, kind)) return notFound();
  const user = allowed.user;
  switch (kind) {
    case 'invoice': {
      const printed = ['office_sales', 'office'].includes(user.role);
      const doc = printed
        ? await getInvoiceForPrint(pool, user, id)
        : await getInvoiceDocument(pool, user, id);
      if (!doc) return notFound();
      await recordLibraryOpen(pool, user, `invoice:${doc.invoice.number}`);
      return pdfResponse(invoicePdf(doc, await pdfContext(user)), doc.invoice.number);
    }
    case 'avoir': {
      const avoir = (await listAvoirs(pool, user)).find((a) => a.id === id);
      if (!avoir) return notFound();
      await recordLibraryOpen(pool, user, `avoir:${avoir.number}`);
      return pdfResponse(avoirPdf(avoir, await pdfContext(user)), avoir.number);
    }
    case 'quote': {
      const quote = await getQuote(pool, user, id);
      if (!quote) return notFound();
      await recordLibraryOpen(pool, user, `quote:${quote.code}`);
      return pdfResponse(quotePdf(quote, await pdfContext(user)), quote.code);
    }
    case 'bl': {
      const note = await getDeliveryNote(pool, user, id);
      if (!note) return notFound();
      const { company, specimen } = await pdfContext(user);
      const mentions = company ? legalMentions({ ...company, rib: null }) : [];
      await recordLibraryOpen(pool, user, `bl:${note.blNo}`);
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
