'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Table, Th } from '@/ui';
import { ActionsTh, AddButton, CancelButton, EditButton, FormRow, type Message, Notice } from '../read-mode';
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
  leadTimeDays: number | null;
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
  const [message, setMessage] = useState<Message | null>(null);
  // 'new' = the add form, a supplier id = that row's edit form; null = read mode.
  const [open, setOpen] = useState<string | null>(null);

  async function submit(
    id: string,
    event: FormEvent<HTMLFormElement>,
    action: (input: unknown) => Promise<SupplierActionResult>,
  ) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '');
    const result = await action({
      name: text('name'),
      category: text('category'),
      ice: text('ice'),
      phone: text('phone'),
      paymentTermsDays: text('paymentTermsDays') === '' ? undefined : Number(text('paymentTermsDays')),
      leadTimeDays: text('leadTimeDays') === '' ? null : Number(text('leadTimeDays')),
    });
    if (result.ok) {
      setMessage({ id, text: t('saved'), ok: true });
      setOpen(null);
      return router.refresh();
    }
    setMessage({
      id,
      ok: false,
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
    setMessage({ id, text: t('error'), ok: false });
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
      <label className="block">
        <span className="field-label">{t('leadTime')}</span>
        <input
          name="leadTimeDays"
          type="number"
          min={0}
          max={120}
          defaultValue={s?.leadTimeDays ?? ''}
          dir="ltr"
          className={input}
          data-testid="supplier-lead-time"
        />
      </label>
    </>
  );

  const columns = 8;
  return (
    <div className="mt-6 space-y-4">
      <Notice message={message} testId="supplier-message" />
      {open === 'new' ? (
        <section className="form-band">
          <h2 className="mb-3 text-xl">{t('new')}</h2>
          <form
            onSubmit={(e) => void submit('new', e, createSupplierAction)}
            className="grid gap-3 sm:grid-cols-3"
            data-testid="supplier-new"
          >
            {fields()}
            <div className="flex items-end gap-3">
              <button type="submit" className="btn btn-primary btn-sm">
                {t('add')}
              </button>
              <CancelButton onClick={() => setOpen(null)} />
            </div>
            <Notice message={message} id="new" testId="supplier-message" />
          </form>
        </section>
      ) : (
        <AddButton label={t('add')} onClick={() => setOpen('new')} testId="supplier-add" />
      )}
      <Table>
        <thead>
          <tr>
            <Th>{t('code')}</Th>
            <Th>{t('name')}</Th>
            <Th>{t('category')}</Th>
            <Th>{t('ice')}</Th>
            <Th>{t('phone')}</Th>
            <Th numeric>{t('paymentTerms')}</Th>
            <Th numeric>{t('leadTime')}</Th>
            <ActionsTh />
          </tr>
        </thead>
        <tbody>
          {suppliers.map((s) => (
            <tr key={s.id} data-testid={`supplier-${s.name}`}>
              {open === s.id ? (
                <FormRow columns={columns}>
                  <form
                    onSubmit={(e) => void submit(s.id, e, (value) => updateSupplierAction(s.id, value))}
                    className="grid gap-3 py-2 sm:grid-cols-3"
                  >
                    <p className="text-sm sm:col-span-3">
                      <span dir="ltr" className="font-mono">
                        {s.code}
                      </span>
                    </p>
                    {fields(s)}
                    <div className="flex items-end gap-3">
                      <button type="submit" className="btn btn-primary btn-sm">
                        {t('save')}
                      </button>
                      <CancelButton onClick={() => setOpen(null)} />
                    </div>
                    <Notice message={message} id={s.id} testId="supplier-message" />
                  </form>
                </FormRow>
              ) : (
                <>
                  <td>
                    <span dir="ltr" className="font-mono">
                      {s.code}
                    </span>
                  </td>
                  <td className="font-medium">
                    <bdi>{s.name}</bdi>
                    {s.status === 'archived' && (
                      <span className="ms-3 text-muted" data-testid="supplier-archived">
                        {t('archivedBadge')}
                      </span>
                    )}
                  </td>
                  <td>{t(`categories.${s.category as (typeof CATEGORIES)[number]}`)}</td>
                  <td>
                    <bdi dir="ltr">{s.ice}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{s.phone}</bdi>
                  </td>
                  <td className="is-num">
                    <bdi dir="ltr">{s.paymentTermsDays}</bdi>
                  </td>
                  <td className="is-num">
                    <bdi dir="ltr">{s.leadTimeDays ?? '—'}</bdi>
                  </td>
                  <td className="whitespace-nowrap text-end">
                    {s.status === 'active' && (
                      <>
                        <EditButton onClick={() => setOpen(s.id)} testId="supplier-edit" />
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
                      </>
                    )}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
