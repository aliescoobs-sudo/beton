'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { StepUpDialog } from '@/modules/platform-security/ui/step-up-dialog';
import { Button } from '@/ui';

export type ConfirmExcessResult = { ok: true } | { ok: false; error: string };

/** The owner confirms that an excess load stands and is billed at the order's price (a fresh second factor is asked). */
export function ExcessConfirm({
  excessId,
  confirm,
}: {
  excessId: string;
  confirm: (input: { excessId: string; note: string }) => Promise<ConfirmExcessResult>;
}) {
  const t = useTranslations('dashboard.excess');
  const router = useRouter();
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => Promise<ConfirmExcessResult>) | null>(null);

  async function run(action: () => Promise<ConfirmExcessResult>) {
    const result = await action();
    if (result.ok) return router.refresh();
    if (result.error === 'STEP_UP_REQUIRED') return setRetry(() => action);
    setMessage(t('error'));
  }

  return (
    <span className="mt-1 flex flex-wrap items-end gap-2" data-testid={`excess-${excessId}`}>
      <label className="block">
        <span className="sr-only">{t('note')}</span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('note')}
          maxLength={500}
          className="input w-56"
        />
      </label>
      <Button
        small
        onClick={() => void run(() => confirm({ excessId, note }))}
        data-testid={`excess-confirm-${excessId}`}
      >
        {t('confirm')}
      </Button>
      {message && (
        <span role="alert" className="text-sm font-semibold">
          {message}
        </span>
      )}
      {retry && (
        <StepUpDialog
          onVerified={() => {
            const again = retry;
            setRetry(null);
            void run(again);
          }}
          onCancel={() => setRetry(null)}
        />
      )}
    </span>
  );
}
