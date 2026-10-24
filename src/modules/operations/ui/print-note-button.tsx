'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/ui';

/** Records the print in the audit log, then opens the browser's print dialog. */
export function PrintNoteButton({
  deliveryId,
  audit,
}: {
  deliveryId: string;
  audit: (deliveryId: string) => Promise<{ ok: boolean }>;
}) {
  const t = useTranslations('operations.note');
  return (
    <Button
      type="button"
      data-testid="note-print"
      onClick={async () => {
        await audit(deliveryId).catch(() => undefined);
        window.print();
      }}
    >
      {t('print')}
    </Button>
  );
}
