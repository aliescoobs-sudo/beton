'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Button } from '@/ui';

export type AttachScanResult = { ok: true } | { ok: false; error: string };

/** Adds the scan to a BL whose signed return is already recorded. Once only. */
export function BlScanAttach({
  deliveryId,
  blNo,
  attach,
}: {
  deliveryId: string;
  blNo: string;
  attach: (data: FormData) => Promise<AttachScanResult>;
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
      const result = await attach(data);
      if (result.ok) return router.refresh();
      setMessage(t(`errors.${result.error}` as never));
    } catch {
      setMessage(t('errors.INVALID'));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-1 inline-flex flex-col gap-1">
      <input type="hidden" name="deliveryId" value={deliveryId} />
      <input
        type="file"
        name="file"
        required
        accept="image/jpeg,image/png,image/webp,application/pdf"
        aria-label={t('scanLabel')}
        data-testid={`scan-file-${blNo}`}
        className="max-w-48 text-sm"
      />
      <Button type="submit" variant="secondary" disabled={pending} data-testid={`scan-attach-${blNo}`}>
        {t('addScan')}
      </Button>
      {message && (
        <span role="alert" className="text-sm text-signal">
          {message}
        </span>
      )}
    </form>
  );
}
