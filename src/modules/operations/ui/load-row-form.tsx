'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import type { Effect } from '@/modules/ledger';
import { EffectsPanel } from '@/modules/ledger/ui/effects/effects-panel';
import { Button, Select } from '@/ui';
import { formatM3 } from './format';

export interface TruckOption {
  id: string;
  code: string;
  capacityL: number;
}
export type LoadActionResult =
  | { ok: true; blNo: string; volumeL: number; warnings: string[]; effects: Effect[] }
  | { ok: false; error: string };

/** One tap to load: pick the truck (volume is the smaller of what is left and the truck) or type a smaller m³. */
export function LoadRowForm({
  orderId,
  orderCode,
  trucks,
  createLoad,
}: {
  orderId: string;
  orderCode: string;
  trucks: TruckOption[];
  createLoad: (input: unknown) => Promise<LoadActionResult>;
}) {
  const t = useTranslations('operations.loads');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; effects: Effect[] } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const m3 = String(data.get('m3') ?? '')
      .trim()
      .replace(',', '.');
    const volumeL = m3 === '' ? null : Math.round(Number(m3) * 1000);
    if (volumeL !== null && (!Number.isFinite(volumeL) || volumeL < 1))
      return setMessage(t('errors.INVALID'));
    setPending(true);
    setMessage(null);
    try {
      const result = await createLoad({ orderId, truckId: String(data.get('truck') ?? ''), volumeL });
      if (!result.ok) return setMessage(t(`errors.${result.error}` as never));
      setDone({
        text: [
          `${result.blNo} · ${formatM3(result.volumeL)} m³`,
          result.warnings.includes('LONG_TRIP') ? t('longTrip') : '',
          result.warnings.includes('OVER_ORDER') ? t('overOrder') : '',
          result.warnings.includes('OVER_ORDER_MINOR') ? t('overOrderMinor') : '',
        ]
          .filter(Boolean)
          .join(' · '),
        effects: result.effects,
      });
    } catch {
      setMessage(t('errors.INVALID'));
    } finally {
      setPending(false);
    }
  }

  if (done)
    return (
      <div role="status" data-testid={`load-done-${orderCode}`} className="text-sm">
        {t('created')} <bdi dir="ltr">{done.text}</bdi>
        <EffectsPanel effects={done.effects} testId={`load-effects-${orderCode}`} />
        <Button
          type="button"
          variant="secondary"
          small
          onClick={() => router.refresh()}
          data-testid={`load-continue-${orderCode}`}
        >
          {t('continue')}
        </Button>
      </div>
    );

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2" noValidate>
      <label>
        <span className="field-label">{t('truck')}</span>
        <Select name="truck" required data-testid={`load-truck-${orderCode}`}>
          {trucks.map((k) => (
            <option key={k.id} value={k.id}>
              {k.code} · {formatM3(k.capacityL)} m³
            </option>
          ))}
        </Select>
      </label>
      <label>
        <span className="field-label">{t('m3')}</span>
        <input
          name="m3"
          inputMode="decimal"
          dir="ltr"
          placeholder={t('m3Auto')}
          className="input num w-28"
          data-testid={`load-m3-${orderCode}`}
        />
      </label>
      <Button
        type="submit"
        disabled={pending || trucks.length === 0}
        data-testid={`load-create-${orderCode}`}
      >
        {t('create')}
      </Button>
      {message && (
        <p role="alert" className="w-full text-sm text-danger">
          {message}
        </p>
      )}
    </form>
  );
}
