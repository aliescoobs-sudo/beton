'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
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
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);

  async function submit(
    id: string,
    event: FormEvent<HTMLFormElement>,
    run: (data: FormData) => Promise<ConcreteTypeActionResult>,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const result = await run(new FormData(form));
    if (result.ok) {
      setMessage({ id, text: t('saved') });
      if (id === 'new') form.reset();
      return router.refresh();
    }
    setMessage({
      id,
      text:
        result.error === 'DUPLICATE_CODE'
          ? t('duplicate')
          : result.error === 'INVALID'
            ? t('invalid')
            : t('error'),
    });
  }

  const note = (id: string) =>
    message?.id === id && (
      <p role="status" className="text-sm" data-testid="type-message">
        {message.text}
      </p>
    );

  return (
    <div className="mt-6 space-y-4">
      {!editable && <p className="text-sm text-muted">{t('readOnly')}</p>}
      <ul className="space-y-3">
        {types.map((type) => (
          <li key={type.id} className="card p-3" data-testid={`type-${type.code}`}>
            {editable ? (
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
                className="flex flex-wrap items-end gap-3"
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
                {note(type.id)}
              </form>
            ) : (
              <p className="flex flex-wrap gap-x-6">
                <span dir="ltr" className="font-medium">
                  {type.code}
                </span>
                <bdi data-testid="type-label">{type.label}</bdi>
                {type.status === 'archived' && <span className="text-muted">{t('archived')}</span>}
              </p>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form
          onSubmit={(e) =>
            void submit('new', e, (d) =>
              createConcreteTypeAction({
                code: String(d.get('code') ?? ''),
                label: String(d.get('label') ?? ''),
              }),
            )
          }
          className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-line-strong bg-canvas/60 p-3"
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
          {note('new')}
        </form>
      )}
    </div>
  );
}
