'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { formatCentimes, parseCentimes } from '@/lib/money';
import { createClientOverrideAction } from './actions';

export interface OverrideView {
  id: string;
  typeCode: string;
  priceHtPerM3Centimes: number;
  effectiveFrom: string;
  reason: string;
}

const INPUT = 'input mt-1';

/** The price overrides of one client (read-only for office) and, for owner and partner, the form with its mandatory reason. */
export function OverridesPanel({
  clientId,
  overrides,
  types,
  editable,
}: {
  clientId: string;
  overrides: OverrideView[];
  types: { id: string; code: string; label: string }[];
  editable: boolean;
}) {
  const t = useTranslations('masterData.overrides');
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const price = parseCentimes(String(data.get('price') ?? ''));
    if (price === null) return setMessage(t('invalid'));
    const result = await createClientOverrideAction({
      clientId,
      concreteTypeId: String(data.get('concreteTypeId') ?? ''),
      priceHtPerM3Centimes: price,
      effectiveFrom: String(data.get('effectiveFrom') ?? ''),
      reason: String(data.get('reason') ?? ''),
    });
    if (result.ok) {
      setMessage(t('saved'));
      return router.refresh();
    }
    setMessage(
      result.error === 'INVALID'
        ? t('invalid')
        : result.error === 'NOT_AFTER_LATEST'
          ? t('notAfterLatest')
          : result.error === 'INACTIVE'
            ? t('inactive')
            : t('error'),
    );
  }

  return (
    <section className="mt-8 card p-3" data-testid="overrides">
      <h2 className="font-medium">{t('title')}</h2>
      {overrides.length === 0 && <p className="mt-2 text-sm text-muted">{t('none')}</p>}
      <ul className="mt-2 space-y-1 text-sm">
        {overrides.map((o) => (
          <li key={o.id} data-testid="override-row">
            <span dir="ltr">{o.typeCode}</span> · <span dir="ltr">{o.effectiveFrom}</span> ·{' '}
            <span dir="ltr">{formatCentimes(o.priceHtPerM3Centimes)} MAD HT / m³</span> ·{' '}
            {t('reasonShown', { reason: o.reason })}
          </li>
        ))}
      </ul>
      {editable && (
        <form onSubmit={(e) => void submit(e)} className="mt-3 space-y-3" data-testid="override-new">
          <h3 className="text-sm font-medium">{t('newOverride')}</h3>
          <div className="flex flex-wrap gap-3">
            <label className="block">
              <span className="text-sm">{t('type')}</span>
              <select name="concreteTypeId" required className={INPUT}>
                {types.map((type) => (
                  <option key={type.id} value={type.id}>
                    <bdi dir="ltr">{type.code}</bdi> · <bdi>{type.label}</bdi>
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-sm">{t('price')}</span>
              <input name="price" required inputMode="decimal" dir="ltr" className={`${INPUT} w-32`} />
            </label>
            <label className="block">
              <span className="text-sm">{t('effectiveFrom')}</span>
              <input name="effectiveFrom" type="date" required dir="ltr" className={INPUT} />
            </label>
          </div>
          <label className="block">
            <span className="text-sm">{t('reason')}</span>
            <textarea name="reason" required maxLength={500} rows={2} className={`${INPUT} w-full`} />
          </label>
          <button type="submit" className="btn btn-primary btn-sm">
            {t('publish')}
          </button>
          {message && (
            <p role="status" className="text-sm" data-testid="override-message">
              {message}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
