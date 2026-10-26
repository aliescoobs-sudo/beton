'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Button } from '@/ui';

export type BlReturnResult = { ok: true } | { ok: false; error: string };

const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

/**
 * Records that the signed BL came back, today, with nothing returned unused (the common case), and the scan when one is
 * chosen (a photo or a PDF). Once only; the scan can also be added later by `BlScanAttach`.
 */
export function BlReturnButton({
  deliveryId,
  blNo,
  today,
  record,
}: {
  deliveryId: string;
  blNo: string;
  today: string;
  record: (data: FormData) => Promise<BlReturnResult>;
}) {
  const t = useTranslations('operations.deliveries');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setMessage(null);
    try {
      const result = await record(data);
      if (result.ok) return router.refresh();
      setMessage(t(`errors.${result.error}` as never));
      if (result.error === 'ALREADY_RETURNED') router.refresh();
    } catch {
      setMessage(t('errors.INVALID'));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="inline-flex flex-col gap-1">
      <input type="hidden" name="deliveryId" value={deliveryId} />
      <input type="hidden" name="returnedOn" value={today} />
      <input
        type="file"
        name="file"
        accept={ACCEPT}
        aria-label={t('scanLabel')}
        data-testid={`bl-file-${blNo}`}
        className="max-w-48 text-sm"
      />
      <Button type="submit" variant="secondary" disabled={pending} data-testid={`bl-return-${blNo}`}>
        {t('markReturned')}
      </Button>
      {message && (
        <span role="alert" className="text-sm text-signal">
          {message}
        </span>
      )}
    </form>
  );
}
