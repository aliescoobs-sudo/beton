'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { CHARGE_CATEGORIES, CHARGE_MODES } from '../../domain/charge';

type Answer = { ok: boolean; error?: string; withDocument?: boolean };

/** Records one charge: beneficiary, category, HT and VAT in MAD (TTC is their sum), payment mode, the reference of the supporting document (or none: it is flagged). */
export function ChargeForm({
  today,
  record,
}: {
  today: string;
  record: (input: unknown) => Promise<Answer>;
}) {
  const t = useTranslations('ledger.charges');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setMessage(null);
    try {
      const r = await record({
        date: f.get('date'),
        beneficiary: f.get('beneficiary'),
        category: f.get('category'),
        ht: String(f.get('ht') ?? ''),
        vat: String(f.get('vat') || '0'),
        mode: f.get('mode'),
        documentRef: f.get('documentRef') || undefined,
        note: f.get('note') || undefined,
      });
      if (r.ok) {
        form.reset();
        setMessage(t('recorded'));
      } else setMessage(t('refused'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="form-band mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      data-testid="charge-form"
    >
      <label className="block">
        <span className="field-label">{t('date')}</span>
        <input name="date" type="date" dir="ltr" defaultValue={today} required className="input mt-1" />
      </label>
      <label className="block">
        <span className="field-label">{t('beneficiary')}</span>
        <input
          name="beneficiary"
          required
          minLength={2}
          maxLength={120}
          className="input mt-1"
          data-testid="charge-beneficiary"
        />
      </label>
      <label className="block">
        <span className="field-label">{t('category')}</span>
        <select name="category" required className="input mt-1" data-testid="charge-category">
          {CHARGE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`categories.${c}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="field-label">{t('mode')}</span>
        <select name="mode" required className="input mt-1">
          {CHARGE_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`modes.${m}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="field-label">{t('ht')}</span>
        <input
          name="ht"
          inputMode="decimal"
          dir="ltr"
          required
          className="input mt-1"
          data-testid="charge-ht"
        />
      </label>
      <label className="block">
        <span className="field-label">{t('vat')}</span>
        <input
          name="vat"
          inputMode="decimal"
          dir="ltr"
          placeholder="0,00"
          className="input mt-1"
          data-testid="charge-vat"
        />
      </label>
      <label className="block">
        <span className="field-label">{t('documentRef')}</span>
        <input name="documentRef" maxLength={80} dir="ltr" className="input mt-1" data-testid="charge-doc" />
        <span className="field-hint">{t('documentHint')}</span>
      </label>
      <label className="block">
        <span className="field-label">{t('note')}</span>
        <input name="note" maxLength={500} className="input mt-1" />
      </label>
      <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-4">
        <button type="submit" disabled={busy} className="btn btn-primary" data-testid="charge-save">
          {t('save')}
        </button>
        {message && (
          <p role="status" data-testid="charge-message">
            {message}
          </p>
        )}
      </div>
    </form>
  );
}
