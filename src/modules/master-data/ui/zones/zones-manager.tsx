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
      {!editable && <p className="text-sm text-gray-600">{t('readOnly')}</p>}
      <ul className="space-y-3">
        {zones.map((zone) => (
          <li key={zone.id} className="rounded border border-gray-200 p-3" data-testid={`zone-${zone.name}`}>
            {editable ? (
              <form
                onSubmit={(e) => void submit(zone.id, e, (input) => updateZoneAction(zone.id, input))}
                className="flex flex-wrap items-end gap-3"
              >
                <label className="block">
                  <span className="text-sm font-medium">{t('name')}</span>
                  <input
                    name="name"
                    defaultValue={zone.name}
                    maxLength={80}
                    required
                    className="mt-1 block w-56 rounded border border-gray-300 px-3 py-1"
                  />
                </label>
                <label className="block">
                  <span className="text-sm font-medium">{t('oneWayMin')}</span>
                  <input
                    name="oneWayMin"
                    type="number"
                    min={1}
                    max={480}
                    defaultValue={zone.oneWayMin}
                    required
                    dir="ltr"
                    className="mt-1 block w-28 rounded border border-gray-300 px-3 py-1"
                  />
                </label>
                <button type="submit" className="rounded bg-gray-900 px-3 py-1 text-sm text-white">
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
                <span className="font-medium" data-testid="zone-name">
                  {zone.name}
                </span>
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
          className="flex flex-wrap items-end gap-3 rounded border border-dashed border-gray-300 p-3"
          data-testid="zone-new"
        >
          <label className="block">
            <span className="text-sm font-medium">{t('name')}</span>
            <input
              name="name"
              maxLength={80}
              required
              className="mt-1 block w-56 rounded border border-gray-300 px-3 py-1"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">{t('oneWayMin')}</span>
            <input
              name="oneWayMin"
              type="number"
              min={1}
              max={480}
              required
              dir="ltr"
              className="mt-1 block w-28 rounded border border-gray-300 px-3 py-1"
            />
          </label>
          <button type="submit" className="rounded bg-gray-900 px-3 py-1 text-sm text-white">
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
