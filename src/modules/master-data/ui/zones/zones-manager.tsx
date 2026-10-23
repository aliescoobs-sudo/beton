'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Table, Th } from '@/ui';
import { ActionsTh, AddButton, CancelButton, EditButton, FormRow, type Message, Notice } from '../read-mode';
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
  const [message, setMessage] = useState<Message | null>(null);
  // 'new' = the add form, a zone id = that row's edit form; null = read mode.
  const [open, setOpen] = useState<string | null>(null);

  async function submit(
    id: string,
    event: FormEvent<HTMLFormElement>,
    action: (input: unknown) => Promise<ZoneActionResult>,
  ) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = await action({
      name: String(data.get('name') ?? ''),
      oneWayMin: Number(data.get('oneWayMin')),
    });
    if (result.ok) {
      setMessage({ id, text: t('saved'), ok: true });
      setOpen(null);
      return router.refresh();
    }
    const text =
      result.error === 'DUPLICATE_NAME'
        ? t('duplicate')
        : result.error === 'INVALID'
          ? t('invalid')
          : t('error');
    setMessage({ id, text, ok: false });
  }

  const fieldset = (zone?: ZoneRow) => (
    <>
      <label className="block">
        <span className="field-label">{t('name')}</span>
        <input name="name" defaultValue={zone?.name} maxLength={80} required className="input mt-1 w-56" />
      </label>
      <label className="block">
        <span className="field-label">{t('oneWayMin')}</span>
        <input
          name="oneWayMin"
          type="number"
          min={1}
          max={480}
          defaultValue={zone?.oneWayMin}
          required
          dir="ltr"
          className="input mt-1 w-28"
        />
      </label>
    </>
  );

  return (
    <div className="mt-6 space-y-4">
      {!editable && <p className="text-sm text-muted">{t('readOnly')}</p>}
      <Notice message={message} testId="zone-message" />
      {editable &&
        (open === 'new' ? (
          <form
            onSubmit={(e) => void submit('new', e, createZoneAction)}
            className="form-band flex flex-wrap items-end gap-3"
            data-testid="zone-new"
          >
            {fieldset()}
            <button type="submit" className="btn btn-primary btn-sm">
              {t('add')}
            </button>
            <CancelButton onClick={() => setOpen(null)} />
            <Notice message={message} id="new" testId="zone-message" />
          </form>
        ) : (
          <AddButton label={t('add')} onClick={() => setOpen('new')} testId="zone-add" />
        ))}
      <Table>
        <thead>
          <tr>
            <Th>{t('name')}</Th>
            <Th numeric>{t('oneWayMin')}</Th>
            {editable && <ActionsTh />}
          </tr>
        </thead>
        <tbody>
          {zones.map((zone) => (
            <tr key={zone.id} data-testid={`zone-${zone.name}`}>
              {open === zone.id ? (
                <FormRow columns={3}>
                  <form
                    onSubmit={(e) => void submit(zone.id, e, (input) => updateZoneAction(zone.id, input))}
                    className="flex flex-wrap items-end gap-3 py-2"
                  >
                    {fieldset(zone)}
                    <button type="submit" className="btn btn-primary btn-sm">
                      {t('save')}
                    </button>
                    <CancelButton onClick={() => setOpen(null)} />
                    <Notice message={message} id={zone.id} testId="zone-message" />
                  </form>
                </FormRow>
              ) : (
                <>
                  <td className="font-medium">
                    <bdi data-testid="zone-name">{zone.name}</bdi>
                  </td>
                  <td className="is-num">
                    <span dir="ltr" data-testid="zone-minutes">
                      {t('minutes', { count: zone.oneWayMin })}
                    </span>
                  </td>
                  {editable && (
                    <td className="text-end">
                      <EditButton onClick={() => setOpen(zone.id)} testId="zone-edit" />
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
