'use client';

import { useTranslations } from 'next-intl';

/** Records the print in the audit log, then opens the browser's print dialog (which also saves a PDF). */
export function PrintInvoiceButton({
  invoiceId,
  audit,
}: {
  invoiceId: string;
  audit: (invoiceId: string) => Promise<{ ok: boolean }>;
}) {
  const t = useTranslations('ledger.invoiceDocument');
  return (
    <button
      type="button"
      className="btn btn-primary"
      data-testid="invoice-print"
      onClick={async () => {
        await audit(invoiceId).catch(() => undefined);
        window.print();
      }}
    >
      {t('print')}
    </button>
  );
}
