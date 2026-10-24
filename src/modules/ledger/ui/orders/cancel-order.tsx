'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { StepUpDialog } from '@/modules/platform-security/ui/step-up-dialog';

type Result = { ok: true; number: string } | { ok: false; error: string };

/** The owner cancels an order with a reversing entry: a reason, a confirmation, a fresh second factor when asked. */
export function CancelOrder({
  orderId,
  cancel,
}: {
  orderId: string;
  cancel: (orderId: string, reason: string) => Promise<Result>;
}) {
  const t = useTranslations('ledger.orderDetail');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => Promise<Result>) | null>(null);

  async function run(action: () => Promise<Result>) {
    const result = await action();
    if (result.ok) {
      setOpen(false);
      return router.refresh();
    }
    if (result.error === 'STEP_UP_REQUIRED') return setRetry(() => action);
    setMessage(
      {
        ALREADY_REVERSED: t('alreadyReversed'),
        CANNOT_REVERSE_REVERSAL: t('alreadyReversed'),
        REASON_REQUIRED: t('reasonRequired'),
        WINDOW_CLOSED: t('windowClosed'),
      }[result.error] ?? t('error'),
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    setMessage(null);
    void run(() => cancel(orderId, reason));
  }

  if (!open)
    return (
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => setOpen(true)}
        data-testid="order-cancel"
      >
        {t('cancelButton')}
      </button>
    );
  return (
    <div className="space-y-2">
      <form onSubmit={submit} className="form-band flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="field-label">{t('reason')}</span>
          <input
            name="reason"
            required
            minLength={3}
            maxLength={500}
            className="input mt-1 w-72"
            data-testid="order-cancel-reason"
          />
        </label>
        <button type="submit" className="btn btn-primary btn-sm" data-testid="order-cancel-confirm">
          {t('confirmCancel')}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>
          {t('back')}
        </button>
      </form>
      {message && (
        <p role="alert" className="text-sm">
          {message}
        </p>
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
    </div>
  );
}
