'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Button, Input, Select } from '@/ui';
import { formatM3 } from './format';

export type LossResult = { ok: true } | { ok: false; error: string };

const REASONS = ['rejected_by_client', 'returned_unused', 'too_old', 'quality', 'other'] as const;

/**
 * Concrete that came back or was refused: a reason and the litres (m³; empty = the whole load), once per load. It gives no
 * component back and changes nothing the order bills. Shows the loss once it is recorded.
 */
export function LossButton({
  deliveryId,
  blNo,
  loadL,
  loss,
  record,
}: {
  deliveryId: string;
  blNo: string;
  loadL: number;
  loss: { volumeL: number; reason: string } | null;
  record: (input: unknown) => Promise<LossResult>;
}) {
  const t = useTranslations('operations.loss');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (loss)
    return (
      <span className="text-sm" data-testid={`loss-${blNo}`}>
        {t('recorded', { m3: formatM3(loss.volumeL), reason: t(`reasons.${loss.reason}` as never) })}
      </span>
    );

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
      const result = await record({
        deliveryId,
        volumeL,
        reason: String(data.get('reason') ?? ''),
        note: String(data.get('note') ?? ''),
      });
      if (result.ok) {
        setOpen(false);
        return router.refresh();
      }
      setMessage(t(`errors.${result.error}` as never));
      if (result.error === 'ALREADY_RECORDED') router.refresh();
    } catch {
      setMessage(t('errors.INVALID'));
    } finally {
      setPending(false);
    }
  }

  if (!open)
    return (
      <Button
        type="button"
        variant="secondary"
        onClick={() => setOpen(true)}
        data-testid={`loss-open-${blNo}`}
      >
        {t('open')}
      </Button>
    );

  return (
    <form onSubmit={submit} className="form-band space-y-2" data-testid={`loss-form-${blNo}`}>
      <label className="block">
        <span className="field-label">{t('reason')}</span>
        <Select name="reason" required data-testid={`loss-reason-${blNo}`}>
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`reasons.${r}`)}
            </option>
          ))}
        </Select>
      </label>
      <label className="block">
        <span className="field-label">{t('m3', { max: formatM3(loadL) })}</span>
        <Input
          name="m3"
          inputMode="decimal"
          dir="ltr"
          placeholder={formatM3(loadL)}
          data-testid={`loss-m3-${blNo}`}
        />
      </label>
      <label className="block">
        <span className="field-label">{t('note')}</span>
        <Input name="note" maxLength={300} data-testid={`loss-note-${blNo}`} />
      </label>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending} data-testid={`loss-submit-${blNo}`}>
          {t('save')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          {t('cancel')}
        </Button>
      </div>
      {message && (
        <span role="alert" className="text-sm text-signal" data-testid={`loss-error-${blNo}`}>
          {message}
        </span>
      )}
    </form>
  );
}
