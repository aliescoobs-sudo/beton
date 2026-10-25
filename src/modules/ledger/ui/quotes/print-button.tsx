'use client';

import { useTranslations } from 'next-intl';

/** Records the print in the audit log, then opens the browser's print dialog (which also saves a PDF). */
export function PrintQuoteButton({
  quoteId,
  audit,
}: {
  quoteId: string;
  audit: (quoteId: string) => Promise<{ ok: boolean }>;
}) {
  const t = useTranslations('ledger.quotes');
  return (
    <button
      type="button"
      className="btn btn-secondary"
      data-testid="quote-print"
      onClick={async () => {
        await audit(quoteId).catch(() => undefined);
        window.print();
      }}
    >
      {t('print')}
    </button>
  );
}
