'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { StepUpDialog } from '@/modules/platform-security/ui/step-up-dialog';

type Result = { ok: true } | { ok: false; error: string };
export type DecisionAction = (input: unknown) => Promise<Result>;
type Mode = 'accept' | 'approve' | 'reject';

/**
 * The owner's decisions on a pending supplier invoice: accept the gaps (a reason), approve for payment (the payable is
 * created from the invoice), reject (a reason). Accepting and approving ask for a fresh second factor when the server says so.
 */
export function SupplierInvoiceDecisions({
  supplierInvoiceId,
  state,
  hasGaps,
  dueDate,
  actions,
}: {
  supplierInvoiceId: string;
  state: 'entered' | 'gaps_accepted';
  hasGaps: boolean;
  dueDate: string;
  actions: { accept: DecisionAction; approve: DecisionAction; reject: DecisionAction };
}) {
  const t = useTranslations('ledger.supplierInvoices.decisions');
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => Promise<Result>) | null>(null);
  const [busy, setBusy] = useState(false);

  const canApprove = !hasGaps || state === 'gaps_accepted';
  const modes: Mode[] = [];
  if (hasGaps && state === 'entered') modes.push('accept');
  if (canApprove) modes.push('approve');
  modes.push('reject');

  async function run(action: () => Promise<Result>) {
    setBusy(true);
    try {
      const result = await action();
      if (result.ok) {
        setMode(null);
        setMessage(null);
        return router.refresh();
      }
      if (result.error === 'STEP_UP_REQUIRED') return setRetry(() => action);
      setMessage(
        (
          {
            GAPS_NOT_ACCEPTED: t('gapsNotAccepted'),
            NOT_PENDING: t('notPending'),
            NO_GAPS: t('noGaps'),
            INVALID: t('invalid'),
            REFUSED: t('refused'),
            CONFLICT: t('conflict'),
          } as Record<string, string>
        )[result.error] ?? t('error'),
      );
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    if (mode === 'accept')
      return void run(() => actions.accept({ supplierInvoiceId, reason: text('reason') }));
    if (mode === 'reject')
      return void run(() => actions.reject({ supplierInvoiceId, reason: text('reason') }));
    // One transfer on the invoice's due date for the whole amount (the plan the database applies when none is given).
    if (mode === 'approve') return void run(() => actions.approve({ supplierInvoiceId, plan: null }));
  }

  return (
    <div className="space-y-3" data-testid="si-decisions">
      {mode === null ? (
        <div className="flex flex-wrap gap-2">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              className={m === 'approve' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              onClick={() => setMode(m)}
              data-testid={`si-${m}`}
            >
              {t(`${m}.button`)}
            </button>
          ))}
        </div>
      ) : (
        <form
          onSubmit={submit}
          className="form-band flex flex-wrap items-end gap-2"
          data-testid={`si-form-${mode}`}
        >
          <p className="basis-full text-sm font-medium">{t(`${mode}.confirm`)}</p>
          {(mode === 'accept' || mode === 'reject') && (
            <label className="block">
              <span className="field-label">{t('reason')}</span>
              <input
                name="reason"
                required
                minLength={3}
                maxLength={500}
                className="input mt-1 w-72"
                data-testid="si-reason"
              />
            </label>
          )}
          {mode === 'approve' && (
            <p className="basis-full text-sm text-muted">{t('approve.plan', { due: dueDate })}</p>
          )}
          <button type="submit" disabled={busy} className="btn btn-primary btn-sm" data-testid="si-confirm">
            {t('confirmButton')}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode(null)}>
            {t('cancelButton')}
          </button>
        </form>
      )}
      {message && (
        <p role="alert" className="text-sm" data-testid="si-decision-error">
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
