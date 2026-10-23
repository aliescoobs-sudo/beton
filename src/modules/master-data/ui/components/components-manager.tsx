'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Table, Th } from '@/ui';
import { ActionsTh, AddButton, CancelButton, EditButton, FormRow, type Message, Notice } from '../read-mode';
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

const INPUT = 'input mt-1';
const BUTTON = 'btn btn-primary btn-sm';

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
  const [message, setMessage] = useState<Message | null>(null);
  // 'new' = the add form, a component id = its edit form, `unit-<id>` = its add-unit form; null = read mode.
  const [open, setOpen] = useState<string | null>(null);

  async function submit(
    id: string,
    event: FormEvent<HTMLFormElement>,
    run: (data: FormData) => Promise<ComponentActionResult>,
  ) {
    event.preventDefault();
    const result = await run(new FormData(event.currentTarget));
    if (result.ok) {
      setMessage({ id, text: t('saved'), ok: true });
      setOpen(null);
      return router.refresh();
    }
    setMessage({
      id,
      ok: false,
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
  const columns = 5;

  return (
    <div className="mt-6 space-y-4">
      {!editable && <p className="text-sm text-muted">{t('readOnly')}</p>}
      <Notice message={message} testId="component-message" />
      {editable &&
        (open === 'new' ? (
          <form
            onSubmit={(e) => void submit('new', e, (d) => createComponentAction(fields(d)))}
            className="form-band flex flex-wrap items-end gap-3"
            data-testid="component-new"
          >
            <label className="block">
              <span className="field-label">{t('nameFr')}</span>
              <input name="nameFr" maxLength={80} required className={`${INPUT} w-48`} />
            </label>
            <label className="block">
              <span className="field-label">{t('nameAr')}</span>
              <input name="nameAr" maxLength={80} required dir="rtl" className={`${INPUT} w-48`} />
            </label>
            <label className="block">
              <span className="field-label">{t('baseUnit')}</span>
              <select name="baseUnit" defaultValue="g" dir="ltr" className={INPUT}>
                <option value="g">g</option>
                <option value="mL">mL</option>
                <option value="L">L</option>
              </select>
            </label>
            <label className="block">
              <span className="field-label">{t('thresholdShort')}</span>
              <input name="lowStockThreshold" type="number" min={0} dir="ltr" className={`${INPUT} w-36`} />
            </label>
            <button type="submit" className={BUTTON}>
              {t('add')}
            </button>
            <CancelButton onClick={() => setOpen(null)} />
            <Notice message={message} id="new" testId="component-message" />
          </form>
        ) : (
          <AddButton label={t('add')} onClick={() => setOpen('new')} testId="component-add" />
        ))}
      <Table>
        <thead>
          <tr>
            <Th>{t('code')}</Th>
            <Th>{t('name')}</Th>
            <Th>{t('baseUnit')}</Th>
            <Th numeric>{t('thresholdShort')}</Th>
            {editable && <ActionsTh />}
          </tr>
        </thead>
        {components.map((c) => (
          <tbody key={c.id}>
            <tr data-testid={`component-${c.code}`}>
              {open === c.id ? (
                <FormRow columns={columns}>
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
                    className="flex flex-wrap items-end gap-3 py-2"
                  >
                    <input type="hidden" name="baseUnit" value={c.baseUnit} />
                    <label className="block">
                      <span className="field-label">{t('nameFr')}</span>
                      <input
                        name="nameFr"
                        defaultValue={c.nameFr}
                        maxLength={80}
                        required
                        className={`${INPUT} w-48`}
                      />
                    </label>
                    <label className="block">
                      <span className="field-label">{t('nameAr')}</span>
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
                      <span className="field-label">{t('threshold', { unit: c.baseUnit })}</span>
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
                    <CancelButton onClick={() => setOpen(null)} />
                    <Notice message={message} id={c.id} testId="component-message" />
                  </form>
                </FormRow>
              ) : (
                <>
                  <td>
                    <span dir="ltr" className="text-muted">
                      {c.code}
                    </span>
                  </td>
                  <td className="font-medium">
                    <span data-testid="component-name">{locale === 'ar' ? c.nameAr : c.nameFr}</span>
                    {c.status === 'archived' && <span className="ms-3 text-muted">{t('archivedBadge')}</span>}
                  </td>
                  <td>
                    <span dir="ltr">{c.baseUnit}</span>
                  </td>
                  <td className="is-num">
                    <bdi dir="ltr">{c.lowStockThreshold}</bdi>
                  </td>
                  {editable && (
                    <td className="text-end">
                      <EditButton onClick={() => setOpen(c.id)} testId="component-edit" />
                    </td>
                  )}
                </>
              )}
            </tr>
            <tr>
              <td colSpan={columns} className="text-sm">
                <ul className="space-y-1">
                  {c.units.map((u) => (
                    <li
                      key={u.id}
                      className="flex flex-wrap items-center gap-3"
                      data-testid={`unit-${u.label}`}
                    >
                      <bdi>{u.label}</bdi>
                      <span dir="ltr">
                        = {u.factorToBase} {c.baseUnit}
                      </span>
                      {u.status === 'archived' && <span className="text-muted">{t('archivedBadge')}</span>}
                      {editable && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
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
                {editable &&
                  (open === `unit-${c.id}` ? (
                    <form
                      onSubmit={(e) =>
                        void submit(`unit-${c.id}`, e, (d) =>
                          createPurchaseUnitAction(c.id, {
                            label: String(d.get('label') ?? ''),
                            factorToBase: Number(d.get('factorToBase')),
                          }),
                        )
                      }
                      className="form-band mt-2 flex flex-wrap items-end gap-3"
                      data-testid={`unit-new-${c.code}`}
                    >
                      <label className="block">
                        <span className="field-label">{t('unitLabel')}</span>
                        <input name="label" maxLength={80} required className={`${INPUT} w-40`} />
                      </label>
                      <label className="block">
                        <span className="field-label">{t('factor', { unit: c.baseUnit })}</span>
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
                      <CancelButton onClick={() => setOpen(null)} />
                      <Notice message={message} id={`unit-${c.id}`} testId="component-message" />
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setOpen(`unit-${c.id}`)}
                      className="btn btn-ghost btn-sm"
                      data-testid={`unit-add-${c.code}`}
                    >
                      {t('addUnit')}
                    </button>
                  ))}
              </td>
            </tr>
          </tbody>
        ))}
      </Table>
    </div>
  );
}
