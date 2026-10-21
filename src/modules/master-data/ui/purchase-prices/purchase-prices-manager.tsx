'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { formatCentimes, parseCentimes } from '@/lib/money';
import { createPurchasePriceAction, proposePriceAction } from './actions';

export interface PriceComponentView {
  id: string;
  nameFr: string;
  nameAr: string;
  baseUnit: string;
  units: { id: string; label: string; factorToBase: number }[];
  history: {
    id: string;
    supplierName: string;
    unitLabel: string;
    priceHtCentimes: number;
    effectiveFrom: string;
  }[];
}

export interface CostView {
  code: string;
  label: string;
  /** Centimes per m³, or null when a component has no price (or the type no recette) on that date. */
  costCentimes: number | null;
}

const INPUT = 'mt-1 block rounded border border-gray-300 px-3 py-1';

/**
 * Per component: the price versions (insert-only) and, for owner and partner, a "new price" form. Managers also see
 * the computed cost per m³ of each concrete type. The server checks the permission again on every write.
 */
export function PurchasePricesManager({
  components,
  suppliers,
  costs,
  businessDate,
  editable,
}: {
  components: PriceComponentView[];
  suppliers: { id: string; name: string }[];
  costs: CostView[] | null;
  businessDate: string;
  editable: boolean;
}) {
  const t = useTranslations('masterData.purchasePrices');
  const locale = useLocale();
  const router = useRouter();
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);
  const [proposed, setProposed] = useState<
    Record<string, { supplierId: string; purchaseUnitId: string; price: string }>
  >({});
  const name = (c: PriceComponentView) => (locale === 'ar' ? c.nameAr : c.nameFr);

  async function propose(component: PriceComponentView) {
    const result = await proposePriceAction(component.id);
    if (!result.ok || !result.proposal) {
      return setMessage({ id: component.id, text: t('noLast') });
    }
    const { supplierId, purchaseUnitId, priceHtCentimes } = result.proposal;
    setProposed({
      ...proposed,
      [component.id]: { supplierId, purchaseUnitId, price: formatCentimes(priceHtCentimes) },
    });
  }

  async function submit(component: PriceComponentView, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const price = parseCentimes(String(data.get('price') ?? ''));
    if (price === null) return setMessage({ id: component.id, text: t('invalid') });
    const result = await createPurchasePriceAction({
      componentId: component.id,
      supplierId: String(data.get('supplierId') ?? ''),
      purchaseUnitId: String(data.get('purchaseUnitId') ?? ''),
      priceHtCentimes: price,
      effectiveFrom: String(data.get('effectiveFrom') ?? ''),
    });
    if (result.ok) {
      setMessage({ id: component.id, text: t('saved') });
      return router.refresh();
    }
    const text =
      result.error === 'INVALID' || result.error === 'UNIT_MISMATCH'
        ? t('invalid')
        : result.error === 'NOT_AFTER_LATEST'
          ? t('notAfterLatest')
          : result.error === 'INACTIVE'
            ? t('inactive')
            : t('error');
    setMessage({ id: component.id, text });
  }

  return (
    <div className="mt-6 space-y-6">
      {!editable && <p className="text-sm text-gray-600">{t('readOnly')}</p>}
      {costs && (
        <section className="rounded border border-gray-200 p-3" data-testid="cost-per-m3">
          <h2 className="font-medium">{t('costTitle')}</h2>
          <p className="text-sm text-gray-600">
            {t('costAt')} <span dir="ltr">{businessDate}</span>
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {costs.map((c) => (
              <li key={c.code} data-testid={`cost-${c.code}`}>
                <span dir="ltr">{c.code}</span> · {c.label} :{' '}
                {c.costCentimes === null ? (
                  t('costMissing')
                ) : (
                  <span dir="ltr">{formatCentimes(c.costCentimes)} MAD</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {components.map((c) => {
        const seed = proposed[c.id];
        return (
          <section
            key={c.id}
            className="rounded border border-gray-200 p-3"
            data-testid={`price-${c.nameFr}`}
          >
            <h2 className="font-medium" dir="auto">
              {name(c)}
            </h2>
            {c.history.length === 0 && <p className="mt-2 text-sm text-gray-600">{t('none')}</p>}
            <ul className="mt-2 space-y-1 text-sm">
              {c.history.map((h) => (
                <li key={h.id}>
                  <span dir="ltr">{h.effectiveFrom}</span> · {h.supplierName} ·{' '}
                  <span dir="ltr">
                    {formatCentimes(h.priceHtCentimes)} MAD HT / {h.unitLabel}
                  </span>
                </li>
              ))}
            </ul>
            {editable && (
              <form
                key={seed ? 'proposed' : 'blank'}
                onSubmit={(e) => void submit(c, e)}
                className="mt-3 space-y-3"
                data-testid={`price-new-${c.nameFr}`}
              >
                <h3 className="text-sm font-medium">{t('newPrice')}</h3>
                <div className="flex flex-wrap gap-3">
                  <label className="block">
                    <span className="text-sm">{t('supplier')}</span>
                    <select name="supplierId" required defaultValue={seed?.supplierId} className={INPUT}>
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-sm">{t('unit')}</span>
                    <select
                      name="purchaseUnitId"
                      required
                      defaultValue={seed?.purchaseUnitId}
                      className={INPUT}
                    >
                      {c.units.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-sm">{t('price')}</span>
                    <input
                      name="price"
                      required
                      inputMode="decimal"
                      defaultValue={seed?.price}
                      dir="ltr"
                      className={`${INPUT} w-32`}
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm">{t('effectiveFrom')}</span>
                    <input name="effectiveFrom" type="date" required dir="ltr" className={INPUT} />
                  </label>
                </div>
                <div className="flex gap-3">
                  <button type="submit" className="rounded bg-gray-900 px-3 py-1 text-sm text-white">
                    {t('publish')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void propose(c)}
                    className="rounded border border-gray-300 px-3 py-1 text-sm"
                  >
                    {t('propose')}
                  </button>
                </div>
                {message?.id === c.id && (
                  <p role="status" className="text-sm" data-testid="price-message">
                    {message.text}
                  </p>
                )}
              </form>
            )}
          </section>
        );
      })}
    </div>
  );
}
