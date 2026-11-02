'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Button, StatusPill, Table, Td, Th } from '@/ui';
import { createPlantAction, updatePlantAction, type PlantActionResult } from './actions';

export interface PlantRow {
  id: string;
  code: string;
  name: string;
  status: 'active' | 'archived';
}

/** Everyone internal reads the plants; owner and partner add, rename or archive (the server checks again). */
export function PlantsManager({ plants, editable }: { plants: PlantRow[]; editable: boolean }) {
  const t = useTranslations('masterData.plants');
  const router = useRouter();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  async function done(result: PlantActionResult) {
    if (result.ok) {
      setMessage({ text: t('saved'), ok: true });
      return router.refresh();
    }
    setMessage({
      text:
        result.error === 'DUPLICATE'
          ? t('duplicate')
          : result.error === 'INVALID'
            ? t('invalid')
            : t('error'),
      ok: false,
    });
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const result = await createPlantAction({
      code: String(data.get('code') ?? ''),
      name: String(data.get('name') ?? ''),
    });
    if (result.ok) form.reset();
    await done(result);
  }

  return (
    <div className="mt-6 space-y-4">
      {!editable && <p className="text-sm text-muted">{t('readOnly')}</p>}
      {message && (
        <p
          role="status"
          className={message.ok ? 'text-sm' : 'text-sm text-signal'}
          data-testid="plant-message"
        >
          {message.text}
        </p>
      )}
      {editable && (
        <form
          onSubmit={(e) => void add(e)}
          className="form-band flex flex-wrap items-end gap-3"
          data-testid="plant-new"
        >
          <label className="block">
            <span className="field-label">{t('code')}</span>
            <input name="code" maxLength={8} required dir="ltr" className="input mt-1 w-32 uppercase" />
          </label>
          <label className="block">
            <span className="field-label">{t('name')}</span>
            <input name="name" maxLength={80} required className="input mt-1 w-56" />
          </label>
          <Button type="submit" data-testid="plant-add">
            {t('add')}
          </Button>
        </form>
      )}
      <Table data-testid="plants-list">
        <thead>
          <tr>
            <Th>{t('code')}</Th>
            <Th>{t('name')}</Th>
            <Th>{t('status')}</Th>
            {editable && <Th>{t('actions')}</Th>}
          </tr>
        </thead>
        <tbody>
          {plants.map((p) => (
            <tr key={p.id} data-testid={`plant-${p.code}`}>
              <Td>
                <bdi dir="ltr">{p.code}</bdi>
              </Td>
              <Td>{p.name}</Td>
              <Td>
                <StatusPill status={p.status === 'active' ? 'paid' : 'late'}>
                  {t(`statuses.${p.status}`)}
                </StatusPill>
              </Td>
              {editable && (
                <Td>
                  <Button
                    type="button"
                    variant="secondary"
                    small
                    onClick={() =>
                      void updatePlantAction(p.id, {
                        status: p.status === 'active' ? 'archived' : 'active',
                      }).then(done)
                    }
                    data-testid={`plant-toggle-${p.code}`}
                  >
                    {p.status === 'active' ? t('archive') : t('restore')}
                  </Button>
                </Td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
