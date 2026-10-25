'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Button, Input, Select } from '@/ui';

type Result = { ok: boolean; error?: string };

/** A fill: truck, day, litres, odometer when read, tank or station. Quantities only. */
export function FuelFillForm({
  trucks,
  today,
  record,
}: {
  trucks: { id: string; code: string }[];
  today: string;
  record: (input: unknown) => Promise<Result>;
}) {
  const t = useTranslations('operations.fuel');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const odometer = String(data.get('odometer') ?? '').trim();
    setPending(true);
    setMessage(null);
    try {
      const result = await record({
        truckId: String(data.get('truck') ?? ''),
        filledOn: String(data.get('date') ?? ''),
        litres: String(data.get('litres') ?? '').trim(),
        odometerKm: odometer === '' ? null : Number(odometer),
        source: String(data.get('source') ?? 'tank'),
      });
      if (!result.ok) return setMessage({ text: t(`errors.${result.error}` as never), ok: false });
      setMessage({ text: t('fillSaved'), ok: true });
      form.reset();
      router.refresh();
    } catch {
      setMessage({ text: t('errors.INVALID'), ok: false });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="form-band flex flex-wrap items-end gap-3" data-testid="fuel-fill-form">
      <label className="block">
        <span className="field-label">{t('truck')}</span>
        <Select name="truck" required data-testid="fuel-truck">
          {trucks.map((k) => (
            <option key={k.id} value={k.id}>
              {k.code}
            </option>
          ))}
        </Select>
      </label>
      <label className="block">
        <span className="field-label">{t('date')}</span>
        <Input type="date" name="date" defaultValue={today} required dir="ltr" data-testid="fuel-date" />
      </label>
      <label className="block">
        <span className="field-label">{t('litres')}</span>
        <Input
          name="litres"
          inputMode="decimal"
          required
          dir="ltr"
          className="w-28"
          data-testid="fuel-litres"
        />
      </label>
      <label className="block">
        <span className="field-label">{t('odometer')}</span>
        <Input name="odometer" inputMode="numeric" dir="ltr" className="w-32" data-testid="fuel-odometer" />
      </label>
      <label className="block">
        <span className="field-label">{t('source')}</span>
        <Select name="source" data-testid="fuel-source">
          <option value="tank">{t('sources.tank')}</option>
          <option value="station">{t('sources.station')}</option>
        </Select>
      </label>
      <Button type="submit" disabled={pending} data-testid="fuel-fill-submit">
        {t('record')}
      </Button>
      {message && (
        <span role={message.ok ? 'status' : 'alert'} className="text-sm" data-testid="fuel-fill-message">
          {message.text}
        </span>
      )}
    </form>
  );
}

/** A purchase of fuel (litres and the total paid): money, shown to the owner only. */
export function FuelPurchaseForm({
  today,
  record,
}: {
  today: string;
  record: (input: unknown) => Promise<Result>;
}) {
  const t = useTranslations('operations.fuel');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setMessage(null);
    try {
      const result = await record({
        purchasedOn: String(data.get('date') ?? ''),
        litres: String(data.get('litres') ?? '').trim(),
        totalMad: String(data.get('total') ?? '').trim(),
      });
      if (!result.ok) return setMessage({ text: t(`errors.${result.error}` as never), ok: false });
      setMessage({ text: t('purchaseSaved'), ok: true });
      form.reset();
      router.refresh();
    } catch {
      setMessage({ text: t('errors.INVALID'), ok: false });
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="form-band flex flex-wrap items-end gap-3"
      data-testid="fuel-purchase-form"
    >
      <label className="block">
        <span className="field-label">{t('date')}</span>
        <Input
          type="date"
          name="date"
          defaultValue={today}
          required
          dir="ltr"
          data-testid="fuel-purchase-date"
        />
      </label>
      <label className="block">
        <span className="field-label">{t('litres')}</span>
        <Input
          name="litres"
          inputMode="decimal"
          required
          dir="ltr"
          className="w-32"
          data-testid="fuel-purchase-litres"
        />
      </label>
      <label className="block">
        <span className="field-label">{t('totalPaid')}</span>
        <Input
          name="total"
          inputMode="decimal"
          required
          dir="ltr"
          className="w-36"
          data-testid="fuel-purchase-total"
        />
      </label>
      <Button type="submit" variant="secondary" disabled={pending} data-testid="fuel-purchase-submit">
        {t('recordPurchase')}
      </Button>
      {message && (
        <span role={message.ok ? 'status' : 'alert'} className="text-sm" data-testid="fuel-purchase-message">
          {message.text}
        </span>
      )}
    </form>
  );
}
