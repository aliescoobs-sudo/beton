'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { StepUpDialog } from '@/modules/platform-security/ui/step-up-dialog';

type Result = { ok: true; number: string } | { ok: false; error: string };

/** The owner cancels an invoice with a credit note: a reason, a confirmation, a fresh second factor when asked. */
export function CancelInvoice({
  invoiceId,
  number,
  cancel,
}: {
  invoiceId: string;
  number: string;
  cancel: (invoiceId: string, reason: string) => Promise<Result>;
}) {
  const t = useTranslations('ledger.invoices');
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
        ALREADY_CREDITED: t('alreadyCredited'),
        REASON_REQUIRED: t('reasonRequired'),
        CANNOT_CREDIT_CREDIT_NOTE: t('alreadyCredited'),
      }[result.error] ?? t('error'),
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    setMessage(null);
    void run(() => cancel(invoiceId, reason));
  }

  if (!open)
    return (
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen(true)}
        data-testid={`cancel-${number}`}
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
            className="input mt-1 w-64"
            data-testid="cancel-reason"
          />
        </label>
        <button type="submit" className="btn btn-primary btn-sm" data-testid="cancel-confirm">
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
