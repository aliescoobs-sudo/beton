'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { parseCentimes } from '@/lib/money';
import { parseMilliQty } from '@/lib/quantity';
import type { Effect } from '../../domain/effects';
import { EffectsPanel } from '../effects/effects-panel';

type Result = { ok: true; code: string; effects: Effect[] } | { ok: false; error: string };
export interface ComponentChoice {
  id: string;
  name: string;
}
interface Line {
  componentId: string;
  description: string;
  qty: string;
  price: string;
}
const emptyLine = (): Line => ({ componentId: '', description: '', qty: '', price: '' });
const INPUT = 'input mt-1';

/**
 * "Facture fournisseur": the order by its printed code (office cannot read purchases), the supplier's own number and dates,
 * and the lines as the supplier wrote them. Entered blind by office: the answer is our code and nothing about money.
 */
export function SupplierInvoiceForm({
  components,
  today,
  createAction,
}: {
  components: ComponentChoice[];
  today: string;
  createAction: (input: unknown) => Promise<Result>;
}) {
  const t = useTranslations('ledger.supplierInvoices');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<{ code: string; effects: Effect[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    const parsed = [];
    for (const l of lines) {
      const qty = parseMilliQty(l.qty);
      const price = parseCentimes(l.price);
      if (!qty.ok || price === null || price <= 0 || (!l.componentId && !l.description.trim()))
        return setMessage(t('invalid'));
      parsed.push({
        componentId: l.componentId || null,
        description: l.description.trim() || null,
        qtyMilli: qty.value,
        unitPriceHtCentimes: price,
      });
    }
    setMessage(null);
    setBusy(true);
    try {
      const result = await createAction({
        purchaseCode: text('purchaseCode'),
        supplierInvoiceNo: text('supplierInvoiceNo'),
        invoiceDate: text('invoiceDate'),
        dueDate: text('dueDate') || null,
        lines: parsed,
      });
      if (result.ok) setDone({ code: result.code, effects: result.effects });
      else
        setMessage(
          {
            INVALID: t('invalid'),
            REFUSED: t('refused'),
            NOT_FOUND: t('notFound'),
            PAYMENT_TERM_TOO_LONG: t('termTooLong'),
            DUE_BEFORE_INVOICE: t('dueBefore'),
            TOO_MANY_ATTEMPTS: t('tooMany'),
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
        <p role="status" className="text-lg font-medium" data-testid="si-saved">
          {t('saved')} <bdi dir="ltr">{done.code}</bdi>
        </p>
        <EffectsPanel effects={done.effects} testId="si-effects" />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid="si-another"
          onClick={() => {
            setDone(null);
            setLines([emptyLine()]);
          }}
        >
          {t('another')}
        </button>
      </div>
    );

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="mt-6 max-w-3xl space-y-4"
      data-testid="si-form"
      noValidate
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">{t('purchaseCode')}</span>
          <input
            name="purchaseCode"
            required
            dir="ltr"
            placeholder="ACH-2026-00001"
            className="input num mt-1"
            data-testid="si-purchase"
          />
        </label>
        <label className="block">
          <span className="field-label">{t('supplierNo')}</span>
          <input
            name="supplierInvoiceNo"
            required
            maxLength={60}
            dir="ltr"
            className={INPUT}
            data-testid="si-no"
          />
        </label>
        <label className="block">
          <span className="field-label">{t('invoiceDate')}</span>
          <input
            name="invoiceDate"
            type="date"
            required
            max={today}
            defaultValue={today}
            dir="ltr"
            className={INPUT}
            data-testid="si-date"
          />
        </label>
        <label className="block">
          <span className="field-label">{t('dueDate')}</span>
          <input name="dueDate" type="date" dir="ltr" className={INPUT} data-testid="si-due" />
          <span className="field-hint block">{t('dueHint')}</span>
        </label>
      </div>
      <fieldset className="space-y-3">
        <legend className="field-label">{t('lines')}</legend>
        {lines.map((l, i) => (
          <div
            key={i}
            className="grid gap-2 sm:grid-cols-[2fr_2fr_1fr_1fr_auto]"
            data-testid={`si-line-${i}`}
          >
            <select
              value={l.componentId}
              onChange={(e) => setLine(i, { componentId: e.target.value })}
              className="input"
              aria-label={t('component')}
              data-testid={`si-component-${i}`}
            >
              <option value="">{t('service')}</option>
              {components.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              value={l.description}
              onChange={(e) => setLine(i, { description: e.target.value })}
              placeholder={t('description')}
              maxLength={200}
              className="input"
              aria-label={t('description')}
              data-testid={`si-description-${i}`}
            />
            <input
              value={l.qty}
              onChange={(e) => setLine(i, { qty: e.target.value })}
              placeholder={t('qty')}
              inputMode="decimal"
              dir="ltr"
              className="input"
              aria-label={t('qty')}
              data-testid={`si-qty-${i}`}
            />
            <input
              value={l.price}
              onChange={(e) => setLine(i, { price: e.target.value })}
              placeholder={t('unitPrice')}
              inputMode="decimal"
              dir="ltr"
              className="input"
              aria-label={t('unitPrice')}
              data-testid={`si-price-${i}`}
            />
            {lines.length > 1 && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setLines((p) => p.filter((_, n) => n !== i))}
              >
                {t('removeLine')}
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setLines((p) => [...p, emptyLine()])}
          data-testid="si-add-line"
        >
          {t('addLine')}
        </button>
      </fieldset>
      {message && (
        <p role="alert" className="field-error" data-testid="si-error">
          {message}
        </p>
      )}
      <button type="submit" disabled={busy} className="btn btn-primary" data-testid="si-save">
        {t('create')}
      </button>
    </form>
  );
}
