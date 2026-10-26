'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { StepUpDialog } from '@/modules/platform-security/ui/step-up-dialog';
import type { Effect } from '../../domain/effects';

type Result = { ok: true; number: string; effects: Effect[] } | { ok: false; error: string };

/** Issues the avoir of one refused or brought-back load: a reason, then a fresh second factor when the server asks. */
export function IssueAvoir({
  deliveryId,
  blNo,
  issue,
}: {
  deliveryId: string;
  blNo: string;
  issue: (input: unknown) => Promise<Result>;
}) {
  const t = useTranslations('ledger.avoirs');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => Promise<Result>) | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<Result>) {
    setBusy(true);
    try {
      const result = await action();
      if (result.ok) {
        setOpen(false);
        setMessage(null);
        return router.refresh();
      }
      if (result.error === 'STEP_UP_REQUIRED') return setRetry(() => action);
      setMessage(
        (
          { NOTHING_TO_CREDIT: t('nothing'), INVALID: t('invalid'), CONFLICT: t('conflict') } as Record<
            string,
            string
          >
        )[result.error] ?? t('error'),
      );
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    void run(() => issue({ deliveryId, reason }));
  }

  return (
    <div data-testid={`avoir-candidate-${blNo}`}>
      {!open ? (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setOpen(true)}
          data-testid="avoir-open"
        >
          {t('issue')}
        </button>
      ) : (
        <form onSubmit={submit} className="form-band flex flex-wrap items-end gap-2" data-testid="avoir-form">
          <label className="block">
            <span className="field-label">{t('reason')}</span>
            <input
              name="reason"
              required
              minLength={3}
              maxLength={500}
              className="input mt-1 w-64"
              data-testid="avoir-reason"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="btn btn-primary btn-sm"
            data-testid="avoir-confirm"
          >
            {t('confirm')}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>
            {t('cancel')}
          </button>
        </form>
      )}
      {message && (
        <p role="alert" className="text-sm" data-testid="avoir-error">
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
