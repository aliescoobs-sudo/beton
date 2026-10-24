'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import type { Effect } from '../../domain/effects';
import { EffectsPanel } from '../effects/effects-panel';

type Result = { ok: true; number: string; effects: Effect[] } | { ok: false; error: string };

/**
 * "Facturer une commande": the order is named by its printed code (office cannot list orders); the invoice covers every
 * load of that order not yet invoiced. The answer is the invoice number and what it changed, filtered for the role.
 */
export function InvoiceForm({ createAction }: { createAction: (input: unknown) => Promise<Result> }) {
  const t = useTranslations('ledger.invoices');
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<{ number: string; effects: Effect[] } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const orderCode = String(data.get('orderCode') ?? '')
      .trim()
      .toUpperCase();
    const dueDate = String(data.get('dueDate') ?? '').trim();
    setMessage(null);
    setBusy(true);
    try {
      const result = await createAction({ orderCode, dueDate: dueDate || null });
      if (result.ok) setDone({ number: result.number, effects: result.effects });
      else
        setMessage(
          {
            INVALID: t('invalid'),
            NOT_FOUND: t('notFound'),
            NOTHING_TO_INVOICE: t('nothingToInvoice'),
            PAYMENT_TERM_TOO_LONG: t('termTooLong'),
            DUE_BEFORE_INVOICE: t('dueBefore'),
            CONFLICT: t('conflict'),
          }[result.error] ?? t('error'),
        );
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <div className="mt-6 space-y-4">
        <p role="status" className="text-lg font-medium" data-testid="invoice-saved">
          {t('saved')} <bdi dir="ltr">{done.number}</bdi>
        </p>
        <EffectsPanel effects={done.effects} testId="invoice-effects" />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          data-testid="invoice-another"
          onClick={() => setDone(null)}
        >
          {t('another')}
        </button>
      </div>
    );

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="mt-6 max-w-xl space-y-4"
      data-testid="invoice-form"
      noValidate
    >
      <label className="block">
        <span className="field-label">{t('orderCode')}</span>
        <input
          name="orderCode"
          required
          dir="ltr"
          placeholder="CMD-2026-00001"
          className="input num mt-1"
          data-testid="invoice-order-code"
        />
      </label>
      <label className="block">
        <span className="field-label">{t('dueDate')}</span>
        <input name="dueDate" type="date" dir="ltr" className="input mt-1" data-testid="invoice-due" />
        <span className="field-hint block">{t('dueHint')}</span>
      </label>
      {message && (
        <p role="alert" className="field-error" data-testid="invoice-error">
          {message}
        </p>
      )}
      <button type="submit" disabled={busy} className="btn btn-primary" data-testid="invoice-save">
        {t('create')}
      </button>
    </form>
  );
}
