'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Table, Th } from '@/ui';
import { ActionsTh, AddButton, CancelButton, EditButton, FormRow, type Message, Notice } from '../read-mode';
import { createSiteAction, updateSiteAction, type SiteActionResult } from './actions';

export interface SiteRow {
  id: string;
  label: string;
  address: string;
  zoneId: string;
}

const input = 'input mt-1';

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
  const [message, setMessage] = useState<Message | null>(null);
  // 'new' = the add form, a site id = that row's edit form; null = read mode.
  const [open, setOpen] = useState<string | null>(null);

  async function submit(
    id: string,
    event: FormEvent<HTMLFormElement>,
    action: (input: unknown) => Promise<SiteActionResult>,
  ) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = await action({
      label: String(data.get('label') ?? ''),
      address: String(data.get('address') ?? ''),
      zoneId: String(data.get('zoneId') ?? ''),
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
        <span className="field-label">{t('label')}</span>
        <input name="label" defaultValue={site?.label} maxLength={120} required className={input} />
      </label>
      <label className="block">
        <span className="field-label">{t('address')}</span>
        <input name="address" defaultValue={site?.address} maxLength={500} className={input} />
      </label>
      <label className="block">
        <span className="field-label">{t('zone')}</span>
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

  const zoneName = new Map(zones.map((z) => [z.id, z.name]));

  return (
    <section className="mt-8" data-testid="sites">
      <h2 className="text-xl">{t('title')}</h2>
      <div className="mt-3 space-y-3">
        <Notice message={message} testId="site-message" />
        {open === 'new' ? (
          <form
            onSubmit={(e) => void submit('new', e, (value) => createSiteAction(clientId, value))}
            className="form-band grid gap-3 sm:grid-cols-3"
            data-testid="site-new"
          >
            {fields()}
            <div className="flex items-end gap-3">
              <button type="submit" className="btn btn-primary btn-sm">
                {t('add')}
              </button>
              <CancelButton onClick={() => setOpen(null)} />
            </div>
            <Notice message={message} id="new" testId="site-message" />
          </form>
        ) : (
          <AddButton label={t('add')} onClick={() => setOpen('new')} testId="site-add" />
        )}
        <Table>
          <thead>
            <tr>
              <Th>{t('label')}</Th>
              <Th>{t('address')}</Th>
              <Th>{t('zone')}</Th>
              <ActionsTh />
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => (
              <tr key={site.id} data-testid={`site-${site.label}`}>
                {open === site.id ? (
                  <FormRow columns={4}>
                    <form
                      onSubmit={(e) => void submit(site.id, e, (value) => updateSiteAction(site.id, value))}
                      className="grid gap-3 py-2 sm:grid-cols-3"
                    >
                      {fields(site)}
                      <div className="flex items-end gap-3">
                        <button type="submit" className="btn btn-primary btn-sm">
                          {t('save')}
                        </button>
                        <CancelButton onClick={() => setOpen(null)} />
                      </div>
                      <Notice message={message} id={site.id} testId="site-message" />
                    </form>
                  </FormRow>
                ) : (
                  <>
                    <td className="font-medium">
                      <bdi>{site.label}</bdi>
                    </td>
                    <td>
                      <bdi>{site.address}</bdi>
                    </td>
                    <td>
                      <bdi>{zoneName.get(site.zoneId) ?? ''}</bdi>
                    </td>
                    <td className="text-end">
                      <EditButton onClick={() => setOpen(site.id)} testId="site-edit" />
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </section>
  );
}
