'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import {
  createComponentAction,
  createPurchaseUnitAction,
  updateComponentAction,
  type ComponentActionResult,
  updatePurchaseUnitAction,
} from './actions';

export interface ComponentView {
  id: string;
  code: string;
  nameFr: string;
  nameAr: string;
  baseUnit: 'g' | 'mL' | 'L';
  lowStockThreshold: number;
  status: 'active' | 'archived';
  units: { id: string; label: string; factorToBase: number; status: 'active' | 'archived' }[];
}

const INPUT = 'mt-1 block rounded border border-gray-300 px-3 py-1';
const BUTTON = 'rounded bg-gray-900 px-3 py-1 text-sm text-white';

/** Everyone signed in reads components; owner and partner edit (the server checks again on every write). */
export function ComponentsManager({
  components,
  editable,
}: {
  components: ComponentView[];
  editable: boolean;
}) {
  const t = useTranslations('masterData.components');
  const locale = useLocale();
  const router = useRouter();
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);

  async function submit(
    id: string,
    event: FormEvent<HTMLFormElement>,
    run: (data: FormData) => Promise<ComponentActionResult>,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const result = await run(new FormData(form));
    if (result.ok) {
      setMessage({ id, text: t('saved') });
      if (id.startsWith('new')) form.reset();
      return router.refresh();
    }
    setMessage({
      id,
      text:
        result.error === 'DUPLICATE_NAME'
          ? t('duplicate')
          : result.error === 'INVALID'
            ? t('invalid')
            : t('error'),
    });
  }

  const fields = (data: FormData) => ({
    nameFr: String(data.get('nameFr') ?? ''),
    nameAr: String(data.get('nameAr') ?? ''),
    baseUnit: String(data.get('baseUnit') ?? ''),
    lowStockThreshold: String(data.get('lowStockThreshold') ?? ''),
  });
  const note = (id: string) =>
    message?.id === id && (
      <p role="status" className="text-sm" data-testid="component-message">
        {message.text}
      </p>
    );

  return (
    <div className="mt-6 space-y-4">
      {!editable && <p className="text-sm text-gray-600">{t('readOnly')}</p>}
      <ul className="space-y-3">
        {components.map((c) => (
          <li key={c.id} className="rounded border border-gray-200 p-3" data-testid={`component-${c.code}`}>
            <p className="flex flex-wrap items-baseline gap-x-4">
              <span dir="ltr" className="text-sm text-gray-600">
                {c.code}
              </span>
              <span className="font-medium" data-testid="component-name">
                {locale === 'ar' ? c.nameAr : c.nameFr}
              </span>
              <span dir="ltr" className="text-sm">
                {t('baseUnitValue', { unit: c.baseUnit })} ·{' '}
                {t('thresholdValue', { count: c.lowStockThreshold })}
              </span>
              {c.status === 'archived' && <span className="text-sm text-gray-600">{t('archivedBadge')}</span>}
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {c.units.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center gap-3" data-testid={`unit-${u.label}`}>
                  <span>{u.label}</span>
                  <span dir="ltr">
                    = {u.factorToBase} {c.baseUnit}
                  </span>
                  {u.status === 'archived' && <span className="text-gray-600">{t('archivedBadge')}</span>}
                  {editable && (
                    <button
                      type="button"
                      className="underline"
                      onClick={() =>
                        void updatePurchaseUnitAction(
                          u.id,
                          u.label,
                          u.status === 'active' ? 'archived' : 'active',
                        ).then(() => router.refresh())
                      }
                    >
                      {u.status === 'active' ? t('archive') : t('restore')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {editable && (
              <>
                <form
                  onSubmit={(e) =>
                    void submit(c.id, e, (d) =>
                      updateComponentAction(
                        c.id,
                        fields(d),
                        d.get('archived') === 'on' ? 'archived' : 'active',
                      ),
                    )
                  }
                  className="mt-3 flex flex-wrap items-end gap-3"
                >
                  <input type="hidden" name="baseUnit" value={c.baseUnit} />
                  <label className="block">
                    <span className="text-sm font-medium">{t('nameFr')}</span>
                    <input
                      name="nameFr"
                      defaultValue={c.nameFr}
                      maxLength={80}
                      required
                      className={`${INPUT} w-48`}
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm font-medium">{t('nameAr')}</span>
                    <input
                      name="nameAr"
                      defaultValue={c.nameAr}
                      maxLength={80}
                      required
                      dir="rtl"
                      className={`${INPUT} w-48`}
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm font-medium">{t('threshold', { unit: c.baseUnit })}</span>
                    <input
                      name="lowStockThreshold"
                      type="number"
                      min={0}
                      defaultValue={c.lowStockThreshold}
                      dir="ltr"
                      className={`${INPUT} w-36`}
                    />
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input name="archived" type="checkbox" defaultChecked={c.status === 'archived'} />
                    {t('archivedBadge')}
                  </label>
                  <button type="submit" className={BUTTON}>
                    {t('save')}
                  </button>
                  {note(c.id)}
                </form>
                <form
                  onSubmit={(e) =>
                    void submit(`new-unit-${c.id}`, e, (d) =>
                      createPurchaseUnitAction(c.id, {
                        label: String(d.get('label') ?? ''),
                        factorToBase: Number(d.get('factorToBase')),
                      }),
                    )
                  }
                  className="mt-3 flex flex-wrap items-end gap-3"
                  data-testid={`unit-new-${c.code}`}
                >
                  <label className="block">
                    <span className="text-sm font-medium">{t('unitLabel')}</span>
                    <input name="label" maxLength={80} required className={`${INPUT} w-40`} />
                  </label>
                  <label className="block">
                    <span className="text-sm font-medium">{t('factor', { unit: c.baseUnit })}</span>
                    <input
                      name="factorToBase"
                      type="number"
                      min={1}
                      step={1}
                      required
                      dir="ltr"
                      className={`${INPUT} w-36`}
                    />
                  </label>
                  <button type="submit" className={BUTTON}>
                    {t('addUnit')}
                  </button>
                  {note(`new-unit-${c.id}`)}
                </form>
              </>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form
          onSubmit={(e) => void submit('new', e, (d) => createComponentAction(fields(d)))}
          className="flex flex-wrap items-end gap-3 rounded border border-dashed border-gray-300 p-3"
          data-testid="component-new"
        >
          <label className="block">
            <span className="text-sm font-medium">{t('nameFr')}</span>
            <input name="nameFr" maxLength={80} required className={`${INPUT} w-48`} />
          </label>
          <label className="block">
            <span className="text-sm font-medium">{t('nameAr')}</span>
            <input name="nameAr" maxLength={80} required dir="rtl" className={`${INPUT} w-48`} />
          </label>
          <label className="block">
            <span className="text-sm font-medium">{t('baseUnit')}</span>
            <select name="baseUnit" defaultValue="g" dir="ltr" className={INPUT}>
              <option value="g">g</option>
              <option value="mL">mL</option>
              <option value="L">L</option>
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium">{t('thresholdShort')}</span>
            <input name="lowStockThreshold" type="number" min={0} dir="ltr" className={`${INPUT} w-36`} />
          </label>
          <button type="submit" className={BUTTON}>
            {t('add')}
          </button>
          {note('new')}
        </form>
      )}
    </div>
  );
}
