'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { parseCentimes } from '@/lib/money';
import { parseMilliQty } from '@/lib/quantity';
import type { Effect } from '../../domain/effects';
import { EffectsPanel } from '../effects/effects-panel';

type Result = { ok: true; code: string; effects: Effect[] } | { ok: false; error: string };
export interface SupplierOption {
  id: string;
  code: string;
  name: string;
}
export interface ComponentOption {
  id: string;
  name: string;
  units: { id: string; label: string }[];
}
interface Line {
  kind: 'stock' | 'service';
  componentId: string;
  unitId: string;
  description: string;
  qty: string;
  price: string;
}

const INPUT = 'input mt-1';
const emptyLine = (components: ComponentOption[]): Line => ({
  kind: 'stock',
  componentId: components[0]?.id ?? '',
  unitId: components[0]?.units[0]?.id ?? '',
  description: '',
  qty: '',
  price: '',
});

/**
 * "Nouvel achat": the supplier, the supplier's invoice, stocked lines (component, unit, quantity, price) and service lines
 * (transport, fuel), and how it will be paid. Entered blind by office: the answer is the code, never an amount.
 */
export function PurchaseForm({
  suppliers,
  components,
  today,
  createAction,
}: {
  suppliers: SupplierOption[];
  components: ComponentOption[];
  today: string;
  createAction: (input: unknown) => Promise<Result>;
}) {
  const t = useTranslations('ledger.purchases');
  const [supplierId, setSupplierId] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [dueDate, setDueDate] = useState('');
  const [plan, setPlan] = useState<'transfer' | 'cheques'>('transfer');
  const [lines, setLines] = useState<Line[]>([emptyLine(components)]);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<{ code: string; effects: Effect[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (n: number, patch: Partial<Line>) =>
    setLines(lines.map((l, i) => (i === n ? { ...l, ...patch } : l)));

  function build(): unknown | null {
    if (!supplierId) return null;
    const out = [];
    for (const l of lines) {
      const price = parseCentimes(l.price);
      if (price === null || price <= 0) return null;
      if (l.kind === 'stock') {
        const qty = parseMilliQty(l.qty);
        if (!qty.ok || qty.value <= 0 || !l.componentId || !l.unitId) return null;
        out.push({
          componentId: l.componentId,
          purchaseUnitId: l.unitId,
          qtyMilli: qty.value,
          unitPriceHtCentimes: price,
        });
      } else {
        if (l.description.trim().length === 0) return null;
        const qty = l.qty.trim() === '' ? { ok: true as const, value: 1000 } : parseMilliQty(l.qty);
        if (!qty.ok || qty.value <= 0) return null;
        out.push({ description: l.description.trim(), qtyMilli: qty.value, unitPriceHtCentimes: price });
      }
    }
    return {
      supplierId,
      supplierInvoiceNo: invoiceNo.trim() || null,
      supplierInvoiceDate: invoiceDate || null,
      dueDate: dueDate || null,
      lines: out,
      plan:
        plan === 'cheques'
          ? [
              { method: 'cheque', dueDate: addDays(invoiceDate || today, 30), percentBp: 5000 },
              { method: 'cheque', dueDate: addDays(invoiceDate || today, 60), percentBp: 5000 },
            ]
          : null,
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const input = build();
    if (!input) return setMessage(t('invalid'));
    setBusy(true);
    try {
      const result = await createAction(input);
      if (result.ok) setDone({ code: result.code, effects: result.effects });
      else
        setMessage(
          {
            INVALID: t('invalid'),
            NOT_FOUND: t('notFound'),
            SUPPLIER_ARCHIVED: t('supplierArchived'),
            PAYMENT_TERM_TOO_LONG: t('termTooLong'),
            DUE_BEFORE_ORDER: t('dueBefore'),
            PLAN_INVALID: t('planInvalid'),
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
        <p role="status" className="text-lg font-medium" data-testid="purchase-saved">
          {t('saved')} <bdi dir="ltr">{done.code}</bdi>
        </p>
        <EffectsPanel effects={done.effects} testId="purchase-effects" />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          data-testid="purchase-another"
          onClick={() => {
            setDone(null);
            setLines([emptyLine(components)]);
          }}
        >
          {t('another')}
        </button>
      </div>
    );

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-6 space-y-5" data-testid="purchase-form" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">{t('supplier')}</span>
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className={INPUT}
            required
            data-testid="purchase-supplier"
          >
            <option value="">—</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} · {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">{t('invoiceNo')}</span>
          <input
            value={invoiceNo}
            onChange={(e) => setInvoiceNo(e.target.value)}
            dir="ltr"
            className={INPUT}
            data-testid="purchase-invoice-no"
          />
        </label>
        <label className="block">
          <span className="field-label">{t('invoiceDate')}</span>
          <input
            type="date"
            value={invoiceDate}
            max={today}
            onChange={(e) => setInvoiceDate(e.target.value)}
            dir="ltr"
            className={INPUT}
            data-testid="purchase-invoice-date"
          />
        </label>
        <label className="block">
          <span className="field-label">{t('dueDate')}</span>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            dir="ltr"
            className={INPUT}
            data-testid="purchase-due"
          />
          <span className="field-hint block">{t('dueHint')}</span>
        </label>
      </div>

      <fieldset className="form-band space-y-3">
        <legend className="field-label px-1">{t('lines')}</legend>
        {lines.map((l, n) => (
          <div key={n} className="flex flex-wrap items-end gap-2" data-testid="purchase-line">
            <label className="block">
              <span className="field-label">{t('kind')}</span>
              <select
                value={l.kind}
                onChange={(e) => set(n, { kind: e.target.value as Line['kind'] })}
                className={INPUT}
                data-testid="purchase-line-kind"
              >
                <option value="stock">{t('kindStock')}</option>
                <option value="service">{t('kindService')}</option>
              </select>
            </label>
            {l.kind === 'stock' ? (
              <>
                <label className="block">
                  <span className="field-label">{t('component')}</span>
                  <select
                    value={l.componentId}
                    onChange={(e) =>
                      set(n, {
                        componentId: e.target.value,
                        unitId: components.find((c) => c.id === e.target.value)?.units[0]?.id ?? '',
                      })
                    }
                    className={INPUT}
                    data-testid="purchase-line-component"
                  >
                    {components.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="field-label">{t('unit')}</span>
                  <select
                    value={l.unitId}
                    onChange={(e) => set(n, { unitId: e.target.value })}
                    className={INPUT}
                    data-testid="purchase-line-unit"
                  >
                    {(components.find((c) => c.id === l.componentId)?.units ?? []).map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <label className="block">
                <span className="field-label">{t('description')}</span>
                <input
                  value={l.description}
                  onChange={(e) => set(n, { description: e.target.value })}
                  className={`${INPUT} w-64`}
                  data-testid="purchase-line-description"
                />
              </label>
            )}
            <label className="block">
              <span className="field-label">{t('qty')}</span>
              <input
                value={l.qty}
                onChange={(e) => set(n, { qty: e.target.value })}
                inputMode="decimal"
                dir="ltr"
                className={`${INPUT} w-28`}
                data-testid="purchase-line-qty"
              />
            </label>
            <label className="block">
              <span className="field-label">{t('price')}</span>
              <input
                value={l.price}
                onChange={(e) => set(n, { price: e.target.value })}
                inputMode="decimal"
                dir="ltr"
                className={`${INPUT} w-32`}
                data-testid="purchase-line-price"
              />
            </label>
            {lines.length > 1 && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setLines(lines.filter((_, i) => i !== n))}
              >
                {t('removeLine')}
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setLines([...lines, emptyLine(components)])}
          data-testid="purchase-add-line"
        >
          {t('addLine')}
        </button>
      </fieldset>

      <label className="block max-w-sm">
        <span className="field-label">{t('plan')}</span>
        <select
          value={plan}
          onChange={(e) => setPlan(e.target.value as 'transfer' | 'cheques')}
          className={INPUT}
          data-testid="purchase-plan"
        >
          <option value="transfer">{t('planTransfer')}</option>
          <option value="cheques">{t('planCheques')}</option>
        </select>
      </label>

      {message && (
        <p role="alert" className="field-error" data-testid="purchase-message">
          {message}
        </p>
      )}
      <button type="submit" disabled={busy} className="btn btn-primary" data-testid="purchase-save">
        {t('save')}
      </button>
    </form>
  );
}

/** Calendar days on a business date, local arithmetic on the text (the server validates the plan). */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}
