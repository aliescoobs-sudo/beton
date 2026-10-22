'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import {
  archiveSupplierAction,
  createSupplierAction,
  updateSupplierAction,
  type SupplierActionResult,
} from './actions';

export interface SupplierRow {
  id: string;
  code: string;
  name: string;
  category: string;
  ice: string;
  phone: string;
  paymentTermsDays: number;
  status: 'active' | 'archived';
}

const CATEGORIES = ['cement', 'aggregates', 'admixture', 'transport', 'fuel', 'other'] as const;
const input = 'input mt-1';

/** Office, owner and partner create and edit; owner and partner archive (the server checks again on every write). */
export function SuppliersManager({
  suppliers,
  canArchive,
}: {
  suppliers: SupplierRow[];
  canArchive: boolean;
}) {
  const t = useTranslations('masterData.suppliers');
  const router = useRouter();
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);

  async function submit(
    id: string,
    event: FormEvent<HTMLFormElement>,
    action: (input: unknown) => Promise<SupplierActionResult>,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? '');
    const result = await action({
      name: text('name'),
      category: text('category'),
      ice: text('ice'),
      phone: text('phone'),
      paymentTermsDays: text('paymentTermsDays') === '' ? undefined : Number(text('paymentTermsDays')),
    });
    if (result.ok) {
      setMessage({ id, text: t('saved') });
      if (id === 'new') form.reset();
      return router.refresh();
    }
    setMessage({
      id,
      text:
        result.error === 'DUPLICATE_ICE'
          ? t('duplicateIce')
          : result.error === 'INVALID'
            ? t('invalid')
            : t('error'),
    });
  }

  async function archive(id: string) {
    const result = await archiveSupplierAction(id);
    if (result.ok) return router.refresh();
    setMessage({ id, text: t('error') });
  }

  const fields = (s?: SupplierRow) => (
    <>
      <label className="block">
        <span className="field-label">{t('name')}</span>
        <input name="name" defaultValue={s?.name} maxLength={120} required className={input} />
      </label>
      <label className="block">
        <span className="field-label">{t('category')}</span>
        <select name="category" defaultValue={s?.category ?? 'other'} className={input}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`categories.${c}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="field-label">{t('ice')}</span>
        <input name="ice" defaultValue={s?.ice} inputMode="numeric" dir="ltr" className={input} />
      </label>
      <label className="block">
        <span className="field-label">{t('phone')}</span>
        <input name="phone" defaultValue={s?.phone} type="tel" dir="ltr" className={input} />
      </label>
      <label className="block">
        <span className="field-label">{t('paymentTerms')}</span>
        <input
          name="paymentTermsDays"
          type="number"
          min={0}
          max={365}
          defaultValue={s?.paymentTermsDays ?? 30}
          dir="ltr"
          className={input}
        />
      </label>
    </>
  );

  return (
    <div className="mt-6 space-y-6">
      <section className="rounded-lg border border-dashed border-line-strong bg-canvas/60 p-3">
        <h2 className="mb-2 font-medium">{t('new')}</h2>
        <form
          onSubmit={(e) => void submit('new', e, createSupplierAction)}
          className="grid gap-3 sm:grid-cols-3"
          data-testid="supplier-new"
        >
          {fields()}
          <button type="submit" className="btn btn-primary btn-sm h-fit w-fit self-end">
            {t('add')}
          </button>
          {message?.id === 'new' && (
            <p role="status" className="text-sm sm:col-span-3" data-testid="supplier-message">
              {message.text}
            </p>
          )}
        </form>
      </section>
      <ul className="space-y-3">
        {suppliers.map((s) => (
          <li key={s.id} className="card p-3" data-testid={`supplier-${s.name}`}>
            <p className="mb-2 flex items-center gap-4 text-sm">
              <span dir="ltr" className="font-mono">
                {s.code}
              </span>
              {s.status === 'archived' && (
                <span className="text-muted" data-testid="supplier-archived">
                  {t('archivedBadge')}
                </span>
              )}
            </p>
            {s.status === 'active' ? (
              <form
                onSubmit={(e) => void submit(s.id, e, (value) => updateSupplierAction(s.id, value))}
                className="grid gap-3 sm:grid-cols-3"
              >
                {fields(s)}
                <div className="flex items-end gap-3">
                  <button type="submit" className="btn btn-primary btn-sm">
                    {t('save')}
                  </button>
                  {canArchive && (
                    <button
                      type="button"
                      onClick={() => void archive(s.id)}
                      className="btn btn-danger btn-sm"
                      data-testid="supplier-archive"
                    >
                      {t('archive')}
                    </button>
                  )}
                </div>
                {message?.id === s.id && (
                  <p role="status" className="text-sm sm:col-span-3" data-testid="supplier-message">
                    {message.text}
                  </p>
                )}
              </form>
            ) : (
              <p className="font-medium">
                <bdi>{s.name}</bdi>
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
