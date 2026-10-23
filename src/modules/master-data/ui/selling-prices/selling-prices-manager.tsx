'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { formatCentimes, parseCentimes } from '@/lib/money';
import { createListPriceAction } from './actions';

export interface SellingTypeView {
  id: string;
  code: string;
  label: string;
  /** List price versions, newest first. */
  versions: { id: string; priceHtPerM3Centimes: number; effectiveFrom: string }[];
}

const INPUT = 'input mt-1';

/** Per concrete type: the list price versions (read-only) and, for owner and partner, a "new list price" form. */
export function SellingPricesManager({ types, editable }: { types: SellingTypeView[]; editable: boolean }) {
  const t = useTranslations('masterData.sellingPrices');
  const router = useRouter();
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);

  async function submit(type: SellingTypeView, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const price = parseCentimes(String(data.get('price') ?? ''));
    if (price === null) return setMessage({ id: type.id, text: t('invalid') });
    const result = await createListPriceAction({
      concreteTypeId: type.id,
      priceHtPerM3Centimes: price,
      effectiveFrom: String(data.get('effectiveFrom') ?? ''),
    });
    if (result.ok) {
      setMessage({ id: type.id, text: t('saved') });
      return router.refresh();
    }
    const text =
      result.error === 'INVALID'
        ? t('invalid')
        : result.error === 'NOT_AFTER_LATEST'
          ? t('notAfterLatest')
          : result.error === 'INACTIVE'
            ? t('inactive')
            : t('error');
    setMessage({ id: type.id, text });
  }

  return (
    <div className="mt-6 space-y-6">
      {!editable && <p className="text-sm text-muted">{t('readOnly')}</p>}
      {types.map((type) => (
        <section key={type.id} className="row-item" data-testid={`sell-${type.code}`}>
          <h2 className="flex flex-wrap items-baseline gap-3 text-xl">
            <span dir="ltr">{type.code}</span>
            <bdi>{type.label}</bdi>
          </h2>
          {type.versions.length === 0 && <p className="mt-2 text-sm text-muted">{t('none')}</p>}
          <ul className="mt-2 space-y-1 text-sm">
            {type.versions.map((v) => (
              <li key={v.id} className="flex flex-wrap gap-x-5">
                <span dir="ltr" className="num">
                  {v.effectiveFrom}
                </span>
                <span dir="ltr" className="num">
                  {formatCentimes(v.priceHtPerM3Centimes)} MAD HT / m³
                </span>
              </li>
            ))}
          </ul>
          {editable && (
            <form
              onSubmit={(e) => void submit(type, e)}
              className="mt-3 space-y-3"
              data-testid={`sell-new-${type.code}`}
            >
              <h3 className="text-sm font-semibold">{t('newPrice')}</h3>
              <div className="flex flex-wrap gap-3">
                <label className="block">
                  <span className="text-sm">{t('price')}</span>
                  <input name="price" required inputMode="decimal" dir="ltr" className={`${INPUT} w-32`} />
                </label>
                <label className="block">
                  <span className="text-sm">{t('effectiveFrom')}</span>
                  <input name="effectiveFrom" type="date" required dir="ltr" className={INPUT} />
                </label>
              </div>
              <button type="submit" className="btn btn-primary btn-sm">
                {t('publish')}
              </button>
              {message?.id === type.id && (
                <p role="status" className="text-sm" data-testid="sell-message">
                  {message.text}
                </p>
              )}
            </form>
          )}
        </section>
      ))}
    </div>
  );
}
