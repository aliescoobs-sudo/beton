'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { createSiteAction, updateSiteAction, type SiteActionResult } from './actions';

export interface SiteRow {
  id: string;
  label: string;
  address: string;
  zoneId: string;
}

const input = 'mt-1 block w-full rounded border border-gray-300 px-3 py-1';

/** Delivery sites of one client: add and edit inline (office, owner, partner; the server checks again). */
export function SitesPanel({
  clientId,
  sites,
  zones,
}: {
  clientId: string;
  sites: SiteRow[];
  zones: { id: string; name: string }[];
}) {
  const t = useTranslations('masterData.sites');
  const router = useRouter();
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);

  async function submit(
    id: string,
    event: FormEvent<HTMLFormElement>,
    action: (input: unknown) => Promise<SiteActionResult>,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const result = await action({
      label: String(data.get('label') ?? ''),
      address: String(data.get('address') ?? ''),
      zoneId: String(data.get('zoneId') ?? ''),
    });
    if (result.ok) {
      setMessage({ id, text: t('saved') });
      if (id === 'new') form.reset();
      return router.refresh();
    }
    setMessage({
      id,
      text:
        result.error === 'DUPLICATE_LABEL'
          ? t('duplicate')
          : result.error === 'INVALID'
            ? t('invalid')
            : t('error'),
    });
  }

  const fields = (site?: SiteRow) => (
    <>
      <label className="block">
        <span className="text-sm font-medium">{t('label')}</span>
        <input name="label" defaultValue={site?.label} maxLength={120} required className={input} />
      </label>
      <label className="block">
        <span className="text-sm font-medium">{t('address')}</span>
        <input name="address" defaultValue={site?.address} maxLength={500} className={input} />
      </label>
      <label className="block">
        <span className="text-sm font-medium">{t('zone')}</span>
        <select name="zoneId" defaultValue={site?.zoneId ?? ''} className={input}>
          <option value="">—</option>
          {zones.map((zone) => (
            <option key={zone.id} value={zone.id}>
              {zone.name}
            </option>
          ))}
        </select>
      </label>
    </>
  );

  return (
    <section className="mt-8" data-testid="sites">
      <h2 className="text-lg font-semibold">{t('title')}</h2>
      <ul className="mt-3 space-y-3">
        {sites.map((site) => (
          <li key={site.id} className="rounded border border-gray-200 p-3" data-testid={`site-${site.label}`}>
            <form
              onSubmit={(e) => void submit(site.id, e, (value) => updateSiteAction(site.id, value))}
              className="grid gap-3 sm:grid-cols-3"
            >
              {fields(site)}
              <button type="submit" className="w-fit rounded bg-gray-900 px-3 py-1 text-sm text-white">
                {t('save')}
              </button>
              {message?.id === site.id && (
                <p role="status" className="text-sm" data-testid="site-message">
                  {message.text}
                </p>
              )}
            </form>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => void submit('new', e, (value) => createSiteAction(clientId, value))}
        className="mt-3 grid gap-3 rounded border border-dashed border-gray-300 p-3 sm:grid-cols-3"
        data-testid="site-new"
      >
        {fields()}
        <button type="submit" className="w-fit rounded bg-gray-900 px-3 py-1 text-sm text-white">
          {t('add')}
        </button>
        {message?.id === 'new' && (
          <p role="status" className="text-sm" data-testid="site-message">
            {message.text}
          </p>
        )}
      </form>
    </section>
  );
}
