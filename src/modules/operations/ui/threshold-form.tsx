'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { parseMilliQty } from '@/lib/quantity';
import { Button } from '@/ui';

export type ThresholdResult = { ok: true } | { ok: false; error: string };

/** The low-stock threshold of one component, typed in kg or L (never a float: thousandths, then ×1000 for g and mL). */
export function ThresholdForm({
  componentId,
  baseUnit,
  plantId,
  save,
}: {
  componentId: string;
  baseUnit: string;
  /** The plant whose threshold this is (R1); absent while no plant is set up. */
  plantId?: string;
  save: (input: unknown) => Promise<ThresholdResult>;
}) {
  const t = useTranslations('operations.stock');
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const big = baseUnit === 'g' || baseUnit === 'mL';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get('threshold') ?? '');
    const milli = parseMilliQty(text);
    // kg → g: thousandths of a kg are grams; a litre stays a litre (a whole number is required).
    const qty = milli.ok ? (big ? milli.value : milli.value % 1000 === 0 ? milli.value / 1000 : NaN) : NaN;
    if (!Number.isFinite(qty) || qty < 1) return setMessage(t('thresholdInvalid'));
    setMessage(null);
    const result = await save({ componentId, lowQtyBase: qty, ...(plantId ? { plantId } : {}) });
    if (result.ok) return router.refresh();
    setMessage(t('thresholdInvalid'));
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2" noValidate>
      <input
        name="threshold"
        inputMode="decimal"
        dir="ltr"
        aria-label={t('threshold')}
        className="input num w-28"
        data-testid={`threshold-input-${componentId}`}
      />
      <Button type="submit" variant="secondary" data-testid={`threshold-save-${componentId}`}>
        {t('thresholdSave')}
      </Button>
      {message && (
        <span role="alert" className="text-sm text-signal">
          {message}
        </span>
      )}
    </form>
  );
}
