'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/ui';

export type BlReturnResult = { ok: true } | { ok: false; error: string };

/** Records that the signed BL came back, today, with nothing returned unused (the common case). Once only. */
export function BlReturnButton({
  deliveryId,
  blNo,
  today,
  record,
}: {
  deliveryId: string;
  blNo: string;
  today: string;
  record: (input: unknown) => Promise<BlReturnResult>;
}) {
  const t = useTranslations('operations.deliveries');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function click() {
    setPending(true);
    setMessage(null);
    try {
      const result = await record({ deliveryId, returnedOn: today, returnedVolumeL: 0 });
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
    <span className="inline-flex flex-col gap-1">
      <Button
        type="button"
        variant="secondary"
        disabled={pending}
        onClick={click}
        data-testid={`bl-return-${blNo}`}
      >
        {t('markReturned')}
      </Button>
      {message && (
        <span role="alert" className="text-sm text-signal">
          {message}
        </span>
      )}
    </span>
  );
}
