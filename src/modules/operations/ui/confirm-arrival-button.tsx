'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/ui';

export type ArrivalResult = { ok: true } | { ok: false; error: string };

/** First step of the two-step receipt: the plant confirms that the delivery arrived. Nothing enters the stock yet. */
export function ConfirmArrivalButton({
  purchaseId,
  code,
  confirm,
}: {
  purchaseId: string;
  code: string;
  confirm: (input: { purchaseId: string }) => Promise<ArrivalResult>;
}) {
  const t = useTranslations('operations.receipts');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setMessage(null);
    try {
      const result = await confirm({ purchaseId });
      if (result.ok) return router.refresh();
      setMessage(t(`arrivalErrors.${result.error}` as never));
    } catch {
      setMessage(t('arrivalErrors.INVALID'));
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-2">
      <Button
        type="button"
        disabled={pending}
        onClick={() => void run()}
        data-testid={`confirm-arrival-${code}`}
      >
        {t('confirmArrival')}
      </Button>
      {message && (
        <span role="alert" className="text-sm text-signal" data-testid={`arrival-error-${code}`}>
          {message}
        </span>
      )}
    </span>
  );
}
