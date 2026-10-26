'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Select } from '@/ui';
import { ltr } from './format';

/** Each truck's default driver (D91): chosen by a manager, proposed by dispatch, overridden per rotation with a reason. */
export function TruckDefaults({
  trucks,
  drivers,
  canWrite,
  save,
}: {
  trucks: { truckId: string; truckCode: string; driverId: string | null }[];
  drivers: { id: string; code: string; name: string }[];
  canWrite: boolean;
  save: (input: { truckId: string; driverId: string | null }) => Promise<{ ok: boolean }>;
}) {
  const t = useTranslations('operations.dispatch');
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);

  async function change(truckId: string, value: string) {
    setMessage(null);
    const result = await save({ truckId, driverId: value === '' ? null : value });
    if (!result.ok) return setMessage(t('driverError'));
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <ul className="text-sm" data-testid="truck-defaults">
        {trucks.map((k) => (
          <li key={k.truckId} className="row-item flex flex-wrap items-center gap-3">
            <bdi dir="ltr">{ltr(k.truckCode)}</bdi>
            <Select
              value={k.driverId ?? ''}
              disabled={!canWrite}
              aria-label={t('defaultFor', { truck: ltr(k.truckCode) })}
              onChange={(e) => void change(k.truckId, e.target.value)}
              data-testid={`default-select-${k.truckCode}`}
            >
              <option value="">{t('noDefaultDriver')}</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </li>
        ))}
      </ul>
      {message && (
        <p role="alert" className="text-sm text-signal">
          {message}
        </p>
      )}
    </div>
  );
}
