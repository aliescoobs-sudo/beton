'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Table, Th } from '@/ui';
import { ActionsTh, AddButton, CancelButton, EditButton, FormRow, type Message, Notice } from '../read-mode';
import { createConcreteTypeAction, updateConcreteTypeAction, type ConcreteTypeActionResult } from './actions';

export interface ConcreteTypeRow {
  id: string;
  code: string;
  label: string;
  status: 'active' | 'archived';
}

const INPUT = 'input mt-1';
const BUTTON = 'btn btn-primary btn-sm';

/** Everyone signed in reads the types; owner and partner edit (the server checks again on every write). */
export function ConcreteTypesManager({ types, editable }: { types: ConcreteTypeRow[]; editable: boolean }) {
  const t = useTranslations('masterData.concreteTypes');
  const router = useRouter();
  const [message, setMessage] = useState<Message | null>(null);
  // 'new' = the add form, a type id = that row's edit form; null = read mode.
  const [open, setOpen] = useState<string | null>(null);

  async function submit(
    id: string,
    event: FormEvent<HTMLFormElement>,
    run: (data: FormData) => Promise<ConcreteTypeActionResult>,
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
        result.error === 'DUPLICATE_CODE'
          ? t('duplicate')
          : result.error === 'INVALID'
            ? t('invalid')
            : t('error'),
    });
  }

  return (
    <div className="mt-6 space-y-4">
      {!editable && <p className="text-sm text-muted">{t('readOnly')}</p>}
      <Notice message={message} testId="type-message" />
      {editable &&
        (open === 'new' ? (
          <form
            onSubmit={(e) =>
              void submit('new', e, (d) =>
                createConcreteTypeAction({
                  code: String(d.get('code') ?? ''),
                  label: String(d.get('label') ?? ''),
                }),
              )
            }
            className="form-band flex flex-wrap items-end gap-3"
            data-testid="type-new"
          >
            <label className="block">
              <span className="field-label">{t('code')}</span>
              <input name="code" maxLength={10} required dir="ltr" className={`${INPUT} w-32`} />
            </label>
            <label className="block">
              <span className="field-label">{t('label')}</span>
              <input name="label" maxLength={80} required className={`${INPUT} w-56`} />
            </label>
            <button type="submit" className={BUTTON}>
              {t('add')}
            </button>
            <CancelButton onClick={() => setOpen(null)} />
            <Notice message={message} id="new" testId="type-message" />
          </form>
        ) : (
          <AddButton label={t('add')} onClick={() => setOpen('new')} testId="type-add" />
        ))}
      <Table>
        <thead>
          <tr>
            <Th>{t('codeColumn')}</Th>
            <Th>{t('label')}</Th>
            <Th>{t('status')}</Th>
            {editable && <ActionsTh />}
          </tr>
        </thead>
        <tbody>
          {types.map((type) => (
            <tr key={type.id} data-testid={`type-${type.code}`}>
              {open === type.id ? (
                <FormRow columns={4}>
                  <form
                    onSubmit={(e) =>
                      void submit(type.id, e, (d) =>
                        updateConcreteTypeAction(
                          type.id,
                          String(d.get('label') ?? ''),
                          d.get('archived') === 'on' ? 'archived' : 'active',
                        ),
                      )
                    }
                    className="flex flex-wrap items-end gap-3 py-2"
                  >
                    <span dir="ltr" className="font-medium">
                      {type.code}
                    </span>
                    <label className="block">
                      <span className="field-label">{t('label')}</span>
                      <input
                        name="label"
                        defaultValue={type.label}
                        maxLength={80}
                        required
                        className={`${INPUT} w-56`}
                      />
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input name="archived" type="checkbox" defaultChecked={type.status === 'archived'} />
                      {t('archived')}
                    </label>
                    <button type="submit" className={BUTTON}>
                      {t('save')}
                    </button>
                    <CancelButton onClick={() => setOpen(null)} />
                    <Notice message={message} id={type.id} testId="type-message" />
                  </form>
                </FormRow>
              ) : (
                <>
                  <td className="font-medium">
                    <span dir="ltr">{type.code}</span>
                  </td>
                  <td>
                    <bdi data-testid="type-label">{type.label}</bdi>
                  </td>
                  <td className="text-muted">{type.status === 'archived' ? t('archived') : ''}</td>
                  {editable && (
                    <td className="text-end">
                      <EditButton onClick={() => setOpen(type.id)} testId="type-edit" />
                    </td>
                  )}
                </>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
