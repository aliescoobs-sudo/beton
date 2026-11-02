'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { parseMilliQty } from '@/lib/quantity';
import { StepUpDialog } from '@/modules/platform-security/ui/step-up-dialog';
import { Button } from '@/ui';

export type CountResult =
  { ok: true; before: number; counted: number; difference: number } | { ok: false; error: string };

/** Display unit → base units: kg for grams and L for millilitres are thousandths; a litre component takes whole litres. */
export function countedToBase(text: string, baseUnit: string): number | null {
  const parsed = parseMilliQty(text);
  if (!parsed.ok) return null;
  if (baseUnit === 'L') return parsed.value % 1000 === 0 ? parsed.value / 1000 : null;
  return parsed.value;
}

/** The owner enters what the physical count found; the correction is a movement with the reason (a fresh second factor is asked). */
export function CountForm({
  componentId,
  baseUnit,
  plantId,
  count,
}: {
  componentId: string;
  baseUnit: string;
  /** The plant being counted (R1); absent while no plant is set up. */
  plantId?: string;
  count: (input: {
    componentId: string;
    countedBase: number;
    reason: string;
    plantId?: string;
  }) => Promise<CountResult>;
}) {
  const t = useTranslations('operations.stock');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => Promise<CountResult>) | null>(null);
  const unit = baseUnit === 'L' ? 'L' : baseUnit === 'g' ? 'kg' : 'L';

  async function run(action: () => Promise<CountResult>) {
    const result = await action();
    if (result.ok) {
      setOpen(false);
      return router.refresh();
    }
    if (result.error === 'STEP_UP_REQUIRED') return setRetry(() => action);
    setMessage(
      t(
        `countErrors.${['INVALID', 'NO_DIFFERENCE', 'NOT_FOUND'].includes(result.error) ? result.error : 'other'}` as never,
      ),
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const base = countedToBase(String(data.get('counted') ?? ''), baseUnit);
    if (base === null) return setMessage(t('countErrors.INVALID'));
    setMessage(null);
    void run(() =>
      count({
        componentId,
        countedBase: base,
        reason: String(data.get('reason') ?? ''),
        ...(plantId ? { plantId } : {}),
      }),
    );
  }

  if (!open)
    return (
      <Button
        variant="secondary"
        small
        onClick={() => setOpen(true)}
        data-testid={`count-open-${componentId}`}
      >
        {t('count')}
      </Button>
    );
  return (
    <form
      onSubmit={submit}
      className="form-band flex flex-wrap items-end gap-2"
      data-testid={`count-form-${componentId}`}
    >
      <label className="block">
        <span className="field-label">{t('counted', { unit })}</span>
        <input
          name="counted"
          required
          inputMode="decimal"
          dir="ltr"
          className="input num mt-1 w-32"
          data-testid={`count-qty-${componentId}`}
        />
      </label>
      <label className="block">
        <span className="field-label">{t('countReason')}</span>
        <input
          name="reason"
          required
          minLength={3}
          maxLength={500}
          className="input mt-1 w-64"
          data-testid={`count-reason-${componentId}`}
        />
      </label>
      <Button type="submit" small data-testid={`count-save-${componentId}`}>
        {t('countSave')}
      </Button>
      <Button variant="secondary" small onClick={() => setOpen(false)}>
        {t('countCancel')}
      </Button>
      {message && (
        <p role="alert" className="w-full text-sm font-semibold">
          {message}
        </p>
      )}
      {retry && (
        <StepUpDialog
          onVerified={() => {
            const again = retry;
            setRetry(null);
            void run(again);
          }}
          onCancel={() => setRetry(null)}
        />
      )}
    </form>
  );
}
