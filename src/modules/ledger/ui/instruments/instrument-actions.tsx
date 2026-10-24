'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { parseCentimes } from '@/lib/money';
import { StepUpDialog } from '@/modules/platform-security/ui/step-up-dialog';
import type { InstrumentRow } from './instruments-table';

export type LifecycleResult = { ok: true } | { ok: false; error: string };
export type LifecycleAction = (input: unknown) => Promise<LifecycleResult>;
export interface AccountOption {
  id: string;
  label: string;
  kind: 'cash' | 'bank';
}
export interface CoverOption {
  id: string;
  label: string;
}
export interface LifecycleActions {
  deposit: LifecycleAction;
  clear: LifecycleAction;
  bounce: LifecycleAction;
  regularize: LifecycleAction;
  dispute: LifecycleAction;
  cancel: LifecycleAction;
}

type Mode = 'clear' | 'bounce' | 'regularize' | 'dispute' | 'cancel';

/**
 * The lifecycle buttons of one instrument (owner only, the server checks again). Each opens a small form with a
 * confirmation; bounce and cancel ask for a fresh second factor when the server says so, then retry once.
 */
export function InstrumentActions({
  row,
  today,
  accounts,
  covers,
  actions,
}: {
  row: InstrumentRow;
  today: string;
  accounts: AccountOption[];
  covers: CoverOption[];
  actions: LifecycleActions;
}) {
  const t = useTranslations('ledger.lifecycle');
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => Promise<LifecycleResult>) | null>(null);

  const paper = row.method === 'cheque' || row.method === 'lcn';
  const state = row.state;
  const available: Mode[] = [];
  if (state === 'received' && !paper) available.push('clear');
  if (state === 'deposited' || state === 'issued') available.push('clear');
  if (state === 'deposited') available.push('bounce');
  if (state === 'issued' && paper) available.push('bounce');
  if (state === 'bounced' && row.direction === 'in') available.push('regularize', 'dispute');
  if (['received', 'deposited', 'issued', 'bounced'].includes(state)) available.push('cancel');
  const modes = [...new Set(available)];
  if (modes.length === 0) return null;

  const errorText = (e: string) =>
    ({
      ILLEGAL_TRANSITION: t('illegal'),
      WINDOW_CLOSED: t('windowClosed'),
      COVERING_INVALID: t('coveringInvalid'),
      ACCOUNT_MISMATCH: t('accountMismatch'),
      FUTURE_DATE: t('futureDate'),
      INVALID: t('invalid'),
      NOT_FOUND: t('notFound'),
      CONFLICT: t('conflict'),
    })[e] ?? t('error');

  async function run(action: () => Promise<LifecycleResult>) {
    const result = await action();
    if (result.ok) {
      setMode(null);
      setMessage(null);
      return router.refresh();
    }
    if (result.error === 'STEP_UP_REQUIRED') return setRetry(() => action);
    setMessage(errorText(result.error));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    const date = text('date');
    const base = { instrumentId: row.id, date };
    setMessage(null);
    if (mode === 'clear') return void run(() => actions.clear({ ...base, accountId: text('account') }));
    if (mode === 'bounce') {
      const fee = text('fee') ? parseCentimes(text('fee')) : null;
      if (text('fee') && fee === null) return setMessage(t('invalid'));
      return void run(() => actions.bounce({ ...base, feeCentimes: fee }));
    }
    if (mode === 'regularize')
      return void run(() => actions.regularize({ ...base, coveringInstrumentId: text('cover') }));
    if (mode === 'dispute') return void run(() => actions.dispute({ ...base, reason: text('reason') }));
    if (mode === 'cancel') return void run(() => actions.cancel({ ...base, reason: text('reason') }));
  }

  const needsAccount = mode === 'clear';
  const accountOptions = accounts.filter((a) =>
    row.method === 'cash' ? a.kind === 'cash' : a.kind === 'bank',
  );

  return (
    <div className="space-y-2" data-testid={`actions-${row.number ?? row.id}`}>
      {mode === null ? (
        <div className="flex flex-wrap gap-2">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setMode(m)}
              data-testid={`action-${m}`}
            >
              {t(`${m}.button`)}
            </button>
          ))}
        </div>
      ) : (
        <form
          onSubmit={submit}
          className="form-band flex flex-wrap items-end gap-2"
          data-testid={`form-${mode}`}
        >
          <p className="basis-full text-sm font-medium">{t(`${mode}.confirm`)}</p>
          <label className="block">
            <span className="field-label">{t('date')}</span>
            <input
              name="date"
              type="date"
              required
              max={today}
              defaultValue={today}
              dir="ltr"
              className="input mt-1"
            />
          </label>
          {needsAccount && (
            <label className="block">
              <span className="field-label">{t('account')}</span>
              <select name="account" required className="input mt-1" data-testid="clear-account">
                <option value="">—</option>
                {accountOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {mode === 'bounce' && (
            <label className="block">
              <span className="field-label">{t('fee')}</span>
              <input
                name="fee"
                inputMode="decimal"
                dir="ltr"
                className="input mt-1 w-28"
                data-testid="bounce-fee"
              />
            </label>
          )}
          {mode === 'regularize' && (
            <label className="block">
              <span className="field-label">{t('cover')}</span>
              <select name="cover" required className="input mt-1" data-testid="regularize-cover">
                <option value="">—</option>
                {covers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(mode === 'dispute' || mode === 'cancel') && (
            <label className="block">
              <span className="field-label">{t('reason')}</span>
              <input
                name="reason"
                required
                minLength={3}
                maxLength={500}
                className="input mt-1 w-64"
                data-testid="reason"
              />
            </label>
          )}
          <button type="submit" className="btn btn-primary btn-sm" data-testid="action-confirm">
            {t('confirmButton')}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode(null)}>
            {t('cancelButton')}
          </button>
        </form>
      )}
      {message && (
        <p role="alert" className="text-sm" data-testid="action-error">
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
