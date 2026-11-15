'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';

type Answer = { ok: boolean; error?: string };

/** Prepares an outgoing payment: nothing is issued yet. Another user validates it (or the owner approves it) first. */
export function PaymentRequestForm({
  suppliers,
  prepare,
}: {
  suppliers: { id: string; code: string; name: string }[];
  prepare: (input: unknown) => Promise<Answer>;
}) {
  const t = useTranslations('ledger.paymentRequests');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setMessage(null);
    try {
      const r = await prepare({
        supplierId: f.get('supplierId'),
        method: f.get('method'),
        amount: String(f.get('amount') ?? ''),
        number: f.get('number') || undefined,
        bank: f.get('bank') || undefined,
        writtenDate: f.get('writtenDate') || undefined,
        note: f.get('note') || undefined,
      });
      if (r.ok) {
        form.reset();
        setMessage(t('prepared'));
      } else setMessage(t('refused'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="form-band mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      data-testid="payment-request-form"
    >
      <label className="block">
        <span className="field-label">{t('supplier')}</span>
        <select name="supplierId" required className="input mt-1" data-testid="pr-supplier">
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="field-label">{t('method')}</span>
        <select name="method" required className="input mt-1" data-testid="pr-method">
          {(['cheque', 'lcn', 'transfer', 'cash'] as const).map((m) => (
            <option key={m} value={m}>
              {t(`methods.${m}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="field-label">{t('amount')}</span>
        <input
          name="amount"
          required
          inputMode="decimal"
          dir="ltr"
          className="input mt-1"
          data-testid="pr-amount"
        />
      </label>
      <label className="block">
        <span className="field-label">{t('writtenDate')}</span>
        <input name="writtenDate" type="date" dir="ltr" className="input mt-1" />
      </label>
      <label className="block">
        <span className="field-label">{t('number')}</span>
        <input name="number" dir="ltr" maxLength={60} className="input mt-1" />
      </label>
      <label className="block">
        <span className="field-label">{t('bank')}</span>
        <input name="bank" maxLength={80} className="input mt-1" />
      </label>
      <label className="block sm:col-span-2">
        <span className="field-label">{t('note')}</span>
        <input name="note" maxLength={500} className="input mt-1" />
      </label>
      <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-4">
        <button type="submit" disabled={busy} className="btn btn-primary" data-testid="pr-save">
          {t('prepare')}
        </button>
        {message && (
          <p role="status" data-testid="pr-message">
            {message}
          </p>
        )}
      </div>
    </form>
  );
}
