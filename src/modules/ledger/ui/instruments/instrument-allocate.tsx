'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { formatCentimes, parseCentimes } from '@/lib/money';
import type { InstrumentRow } from './instruments-table';

export interface OpenInvoiceOption {
  id: string;
  number: string;
  dueDate: string;
  openCentimes: number;
  clientId: string;
}
export type AllocateResult = { ok: true; allocatedCentimes: number } | { ok: false; error: string };

/**
 * "Imputer sur une facture" (owner only; the server checks again): directs what a payment has not covered to one open
 * invoice of its client instead of the oldest due first. The reason is required: it stays with the allocation records.
 */
export function InstrumentAllocate({
  row,
  invoices,
  allocate,
}: {
  row: InstrumentRow;
  invoices: OpenInvoiceOption[];
  allocate: (input: unknown) => Promise<AllocateResult>;
}) {
  const t = useTranslations('ledger.directAllocation');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = invoices.filter((i) => i.clientId === row.partyId);
  const eligible =
    row.direction === 'in' &&
    row.unallocatedCentimes > 0 &&
    ['received', 'deposited', 'cleared'].includes(row.state) &&
    mine.length > 0;
  if (!eligible) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    const amount = parseCentimes(text('amount'));
    if (amount === null || amount <= 0) return setMessage(t('invalid'));
    setBusy(true);
    setMessage(null);
    try {
      const result = await allocate({
        instrumentId: row.id,
        invoiceId: text('invoice'),
        amountCentimes: amount,
        reason: text('reason'),
      });
      if (result.ok) {
        setOpen(false);
        return router.refresh();
      }
      setMessage(result.error === 'NOT_ALLOWED' ? t('refused') : t('invalid'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2" data-testid={`allocate-${row.number ?? row.id}`}>
      {!open ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setOpen(true)}
          data-testid="allocate-open"
        >
          {t('button')}
        </button>
      ) : (
        <form
          onSubmit={(e) => void submit(e)}
          className="form-band flex flex-wrap items-end gap-2"
          data-testid="allocate-form"
        >
          <p className="basis-full text-sm font-medium">
            {t('confirm', { left: formatCentimes(row.unallocatedCentimes) })}
          </p>
          <label className="block">
            <span className="field-label">{t('invoice')}</span>
            <select name="invoice" required className="input mt-1" data-testid="allocate-invoice">
              {mine.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.number} · {i.dueDate} · {formatCentimes(i.openCentimes)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="field-label">{t('amount')}</span>
            <input
              name="amount"
              inputMode="decimal"
              dir="ltr"
              required
              defaultValue={formatCentimes(row.unallocatedCentimes).replace(/\s/g, '')}
              className="input mt-1 w-32"
              data-testid="allocate-amount"
            />
          </label>
          <label className="block">
            <span className="field-label">{t('reason')}</span>
            <input
              name="reason"
              required
              minLength={3}
              maxLength={500}
              className="input mt-1 w-64"
              data-testid="allocate-reason"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="btn btn-primary btn-sm"
            data-testid="allocate-confirm"
          >
            {t('confirmButton')}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>
            {t('cancelButton')}
          </button>
        </form>
      )}
      {message && (
        <p role="alert" className="text-sm" data-testid="allocate-error">
          {message}
        </p>
      )}
    </div>
  );
}
