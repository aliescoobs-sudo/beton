'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { parseMilliQty } from '@/lib/quantity';
import { Button } from '@/ui';

export type ArrivalResult = { ok: true; confirmationId?: string } | { ok: false; error: string };
export interface ArrivalLineView {
  lineId: string;
  name: string;
  unit: string;
  ordered: number;
  received: number;
}
export interface ArrivalPayload {
  purchaseId: string;
  note?: string;
  lines?: { lineId: string; arrivedMilli: number; rejectedMilli: number; available: boolean }[];
}

const qty = (milli: number) => (milli / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 3 });

/**
 * First step of the two-step receipt (D133, §16.7): the plant confirms that the delivery arrived, with what it counted per line
 * (arrived, refused, usable now) and the weighbridge ticket or the delivery note. Without counting it still confirms, as before.
 * Nothing enters the booked stock yet; what is marked usable shows as arrived stock the plant may produce with.
 */
export function ConfirmArrivalButton({
  purchaseId,
  code,
  lines = [],
  confirm,
  attachFile,
}: {
  purchaseId: string;
  code: string;
  lines?: ArrivalLineView[];
  confirm: (input: ArrivalPayload) => Promise<ArrivalResult>;
  attachFile?: (data: FormData) => Promise<ArrivalResult>;
}) {
  const t = useTranslations('operations.receipts');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(payload: ArrivalPayload, files: { kind: string; file: File }[] = []) {
    setPending(true);
    setMessage(null);
    try {
      const result = await confirm(payload);
      if (!result.ok) return setMessage(t(`arrivalErrors.${result.error}` as never));
      for (const f of files) {
        if (!result.confirmationId || !attachFile) break;
        const data = new FormData();
        data.set('confirmationId', result.confirmationId);
        data.set('kind', f.kind);
        data.set('file', f.file);
        const attached = await attachFile(data);
        if (!attached.ok) return setMessage(t(`arrivalErrors.${attached.error}` as never));
      }
      setOpen(false);
      router.refresh();
    } catch {
      setMessage(t('arrivalErrors.INVALID'));
    } finally {
      setPending(false);
    }
  }

  function submitCount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const out: NonNullable<ArrivalPayload['lines']> = [];
    for (const l of lines) {
      const arrivedText = String(form.get(`arrived-${l.lineId}`) ?? '').trim();
      if (arrivedText === '') continue;
      const arrived = parseMilliQty(arrivedText);
      const rejectedText = String(form.get(`rejected-${l.lineId}`) ?? '').trim();
      const rejected = rejectedText === '' ? { ok: true as const, value: 0 } : parseMilliQty(rejectedText);
      if (!arrived.ok || !rejected.ok || rejected.value > arrived.value)
        return setMessage(t('arrivalErrors.INVALID'));
      out.push({
        lineId: l.lineId,
        arrivedMilli: arrived.value,
        rejectedMilli: rejected.value,
        available: form.get(`available-${l.lineId}`) === 'on' && arrived.value > rejected.value,
      });
    }
    const files: { kind: string; file: File }[] = [];
    for (const kind of ['weighbridge_ticket', 'delivery_note']) {
      const f = form.get(kind);
      if (f instanceof File && f.size > 0) files.push({ kind, file: f });
    }
    void run({ purchaseId, note: String(form.get('note') ?? '').trim() || undefined, lines: out }, files);
  }

  return (
    <span className="inline-flex flex-col gap-2">
      {!open ? (
        <Button
          type="button"
          disabled={pending}
          onClick={() => (lines.length > 0 ? setOpen(true) : void run({ purchaseId }))}
          data-testid={`confirm-arrival-${code}`}
        >
          {t('confirmArrival')}
        </Button>
      ) : (
        <form
          onSubmit={submitCount}
          className="space-y-2 rounded border border-rule p-2 text-sm"
          data-testid={`arrival-form-${code}`}
        >
          <p className="font-semibold">{t('countTitle')}</p>
          {lines.map((l) => (
            <fieldset key={l.lineId} className="space-y-1">
              <legend>
                {l.name} ·{' '}
                <bdi dir="ltr">
                  {qty(l.received)} / {qty(l.ordered)} {l.unit}
                </bdi>
              </legend>
              <div className="flex flex-wrap items-center gap-2">
                <label>
                  {t('arrivedQty')}{' '}
                  <input
                    name={`arrived-${l.lineId}`}
                    inputMode="decimal"
                    dir="ltr"
                    className="input w-24"
                    data-testid={`arrived-${code}-${l.lineId}`}
                  />
                </label>
                <label>
                  {t('rejectedQty')}{' '}
                  <input
                    name={`rejected-${l.lineId}`}
                    inputMode="decimal"
                    dir="ltr"
                    className="input w-24"
                    data-testid={`rejected-${code}-${l.lineId}`}
                  />
                </label>
                <label className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    name={`available-${l.lineId}`}
                    data-testid={`available-${code}-${l.lineId}`}
                  />
                  {t('availableNow')}
                </label>
              </div>
            </fieldset>
          ))}
          <label className="block">
            {t('noteLabel')} <input name="note" maxLength={300} className="input w-full" />
          </label>
          {attachFile && (
            <div className="flex flex-wrap gap-3">
              <label>
                {t('ticketLabel')}{' '}
                <input
                  type="file"
                  name="weighbridge_ticket"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                />
              </label>
              <label>
                {t('deliveryNoteLabel')}{' '}
                <input
                  type="file"
                  name="delivery_note"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                />
              </label>
            </div>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={pending} data-testid={`arrival-submit-${code}`}>
              {t('confirmWithCount')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => void run({ purchaseId })}
              data-testid={`arrival-nocount-${code}`}
            >
              {t('confirmNoCount')}
            </Button>
          </div>
        </form>
      )}
      {message && (
        <span role="alert" className="text-sm text-danger" data-testid={`arrival-error-${code}`}>
          {message}
        </span>
      )}
    </span>
  );
}
