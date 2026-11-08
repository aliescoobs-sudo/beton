'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/ui';

export type MarkDeliveredResult = { ok: true } | { ok: false; error: string };

/** Marks a load made outside any rotation as delivered, now. Once only; a load of a rotation is delivered by its tracking. */
export function MarkDeliveredButton({
  deliveryId,
  blNo,
  record,
}: {
  deliveryId: string;
  blNo: string;
  record: (input: unknown) => Promise<MarkDeliveredResult>;
}) {
  const t = useTranslations('operations.deliveries');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function click() {
    setPending(true);
    setMessage(null);
    try {
      const result = await record({ deliveryId });
      if (result.ok) return router.refresh();
      setMessage(t(`errors.${result.error}` as never));
      if (result.error === 'ALREADY_DELIVERED') router.refresh();
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
        data-testid={`mark-delivered-${blNo}`}
      >
        {t('markDelivered')}
      </Button>
      {message && (
        <span role="alert" className="text-sm text-danger">
          {message}
        </span>
      )}
    </span>
  );
}
