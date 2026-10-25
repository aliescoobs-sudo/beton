'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { StepUpDialog } from '@/modules/platform-security/ui/step-up-dialog';
import { Button } from '@/ui';

export type CancelLoadResult = { ok: true } | { ok: false; error: string };

/**
 * The owner or the partner cancels a load (a reversing delivery with its own BL number, and the stock back): a reason, a
 * confirmation and a fresh second factor. The original BL stays, marked as cancelled.
 */
export function CancelLoadButton({
  deliveryId,
  blNo,
  cancel,
}: {
  deliveryId: string;
  blNo: string;
  cancel: (input: { deliveryId: string; reason: string }) => Promise<CancelLoadResult>;
}) {
  const t = useTranslations('operations.deliveries');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => Promise<CancelLoadResult>) | null>(null);

  async function run(action: () => Promise<CancelLoadResult>) {
    const result = await action();
    if (result.ok) {
      setOpen(false);
      return router.refresh();
    }
    if (result.error === 'STEP_UP_REQUIRED') return setRetry(() => action);
    setMessage(
      t(
        `cancelErrors.${['INVALID', 'NOT_FOUND', 'ALREADY_CANCELLED'].includes(result.error) ? result.error : 'other'}` as never,
      ),
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '');
    void run(() => cancel({ deliveryId, reason }));
  }

  if (!open)
    return (
      <Button variant="secondary" small onClick={() => setOpen(true)} data-testid={`cancel-load-${blNo}`}>
        {t('cancelLoad')}
      </Button>
    );
  return (
    <form
      onSubmit={submit}
      className="form-band flex flex-wrap items-end gap-2"
      data-testid={`cancel-form-${blNo}`}
    >
      <label className="block">
        <span className="field-label">{t('cancelReason')}</span>
        <input
          name="reason"
          required
          minLength={3}
          maxLength={500}
          className="input mt-1 w-64"
          data-testid={`cancel-reason-${blNo}`}
        />
      </label>
      <Button type="submit" variant="danger" small data-testid={`cancel-confirm-${blNo}`}>
        {t('cancelConfirm')}
      </Button>
      <Button variant="secondary" small onClick={() => setOpen(false)}>
        {t('cancelBack')}
      </Button>
      {message && (
        <p role="alert" className="w-full text-sm font-semibold">
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
    </form>
  );
}
