'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { createZoneAction, updateZoneAction, type ZoneActionResult } from './actions';

export interface ZoneRow {
  id: string;
  name: string;
  oneWayMin: number;
}

/** Everyone signed in reads the zones; owner and partner edit (the server checks again on every write). */
export function ZonesManager({ zones, editable }: { zones: ZoneRow[]; editable: boolean }) {
  const t = useTranslations('masterData.zones');
  const router = useRouter();
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);

  async function submit(
    id: string,
    event: FormEvent<HTMLFormElement>,
    action: (input: unknown) => Promise<ZoneActionResult>,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const result = await action({
      name: String(data.get('name') ?? ''),
      oneWayMin: Number(data.get('oneWayMin')),
    });
    if (result.ok) {
      setMessage({ id, text: t('saved') });
      if (id === 'new') form.reset();
      return router.refresh();
    }
    const text =
      result.error === 'DUPLICATE_NAME'
        ? t('duplicate')
        : result.error === 'INVALID'
          ? t('invalid')
          : t('error');
    setMessage({ id, text });
  }

  return (
    <div className="mt-6 space-y-4">
      {!editable && <p className="text-sm text-muted">{t('readOnly')}</p>}
      <ul className="space-y-3">
        {zones.map((zone) => (
          <li key={zone.id} className="row-item" data-testid={`zone-${zone.name}`}>
            {editable ? (
              <form
                onSubmit={(e) => void submit(zone.id, e, (input) => updateZoneAction(zone.id, input))}
                className="flex flex-wrap items-end gap-3"
              >
                <label className="block">
                  <span className="field-label">{t('name')}</span>
                  <input
                    name="name"
                    defaultValue={zone.name}
                    maxLength={80}
                    required
                    className="input mt-1 w-56"
                  />
                </label>
                <label className="block">
                  <span className="field-label">{t('oneWayMin')}</span>
                  <input
                    name="oneWayMin"
                    type="number"
                    min={1}
                    max={480}
                    defaultValue={zone.oneWayMin}
                    required
                    dir="ltr"
                    className="input mt-1 w-28"
                  />
                </label>
                <button type="submit" className="btn btn-primary btn-sm">
                  {t('save')}
                </button>
                {message?.id === zone.id && (
                  <p role="status" className="text-sm" data-testid="zone-message">
                    {message.text}
                  </p>
                )}
              </form>
            ) : (
              <p className="flex flex-wrap gap-x-6">
                <bdi className="font-medium" data-testid="zone-name">
                  {zone.name}
                </bdi>
                <span dir="ltr" data-testid="zone-minutes">
                  {t('minutes', { count: zone.oneWayMin })}
                </span>
              </p>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form
          onSubmit={(e) => void submit('new', e, createZoneAction)}
          className="flex flex-wrap items-end gap-3 form-band"
          data-testid="zone-new"
        >
          <label className="block">
            <span className="field-label">{t('name')}</span>
            <input name="name" maxLength={80} required className="input mt-1 w-56" />
          </label>
          <label className="block">
            <span className="field-label">{t('oneWayMin')}</span>
            <input
              name="oneWayMin"
              type="number"
              min={1}
              max={480}
              required
              dir="ltr"
              className="input mt-1 w-28"
            />
          </label>
          <button type="submit" className="btn btn-primary btn-sm">
            {t('add')}
          </button>
          {message?.id === 'new' && (
            <p role="status" className="text-sm" data-testid="zone-message">
              {message.text}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
