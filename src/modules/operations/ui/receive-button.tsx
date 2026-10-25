'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { parseMilliQty } from '@/lib/quantity';
import type { Effect } from '@/modules/ledger';
import { EffectsPanel } from '@/modules/ledger/ui/effects/effects-panel';
import { Button } from '@/ui';
import { formatM3 } from './format';

export type ReceiveResult = { ok: true; effects: Effect[] } | { ok: false; error: string };

export interface ReceiveLine {
  lineId: string;
  name: string;
  unit: string;
  ordered: number;
  received: number;
}

/**
 * Records a receipt of one purchase today: everything still expected in one tap, or a partial receipt line by line (several
 * receipts per purchase until each ordered quantity is reached). More than ordered needs the owner's confirmation.
 */
export function ReceiveButton({
  purchaseId,
  code,
  lines,
  canConfirmExcess,
  receive,
}: {
  purchaseId: string;
  code: string;
  lines: ReceiveLine[];
  canConfirmExcess: boolean;
  receive: (input: unknown) => Promise<ReceiveResult>;
}) {
  const t = useTranslations('operations.receipts');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [effects, setEffects] = useState<Effect[] | null>(null);
  const [partial, setPartial] = useState(false);

  async function send(input: Record<string, unknown>) {
    setPending(true);
    setMessage(null);
    try {
      const result = await receive({ purchaseId, ...input });
      if (result.ok) return setEffects(result.effects);
      setMessage(t(`errors.${result.error}` as never));
      if (result.error === 'ALREADY_RECEIVED') router.refresh();
    } catch {
      setMessage(t('errors.INVALID'));
    } finally {
      setPending(false);
    }
  }

  function submitPartial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const picked: { lineId: string; qtyMilli: number }[] = [];
    for (const l of lines) {
      const text = String(data.get(`qty-${l.lineId}`) ?? '').trim();
      if (text === '' || text === '0') continue;
      const parsed = parseMilliQty(text);
      if (!parsed.ok) return setMessage(t('errors.INVALID'));
      picked.push({ lineId: l.lineId, qtyMilli: parsed.value });
    }
    if (picked.length === 0) return setMessage(t('errors.INVALID'));
    void send({ lines: picked, confirmExcess: data.get('excess') === 'on' });
  }

  if (effects)
    return (
      <div data-testid={`receipt-done-${code}`} className="text-sm">
        <EffectsPanel effects={effects} testId={`receipt-effects-${code}`} />
        <Button
          type="button"
          variant="secondary"
          small
          onClick={() => {
            // A partial receipt leaves the row on screen: show its buttons again with the new quantities.
            setEffects(null);
            setPartial(false);
            router.refresh();
          }}
          data-testid={`receipt-continue-${code}`}
        >
          {t('continue')}
        </Button>
      </div>
    );

  return (
    <span className="inline-flex flex-col gap-2">
      <span className="inline-flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={pending}
          onClick={() => void send({})}
          data-testid={`receive-${code}`}
        >
          {t('receive')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => setPartial((v) => !v)}
          data-testid={`receive-partial-${code}`}
        >
          {t('partial')}
        </Button>
      </span>
      {partial && (
        <form onSubmit={submitPartial} className="form-band space-y-2" data-testid={`receive-form-${code}`}>
          {lines.map((l) => {
            const remaining = Math.max(0, l.ordered - l.received);
            return (
              <label key={l.lineId} className="block text-sm">
                <span className="field-label">
                  {l.name} · {t('remaining', { qty: `${formatM3(remaining)} ${l.unit}` })}
                </span>
                <input
                  name={`qty-${l.lineId}`}
                  inputMode="decimal"
                  dir="ltr"
                  defaultValue={remaining > 0 ? formatM3(remaining) : ''}
                  className="input num mt-1 w-32"
                  data-testid={`receive-qty-${code}-${l.lineId}`}
                />
              </label>
            );
          })}
          {canConfirmExcess && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="excess" data-testid={`receive-excess-${code}`} />
              {t('confirmExcess')}
            </label>
          )}
          <Button type="submit" disabled={pending} data-testid={`receive-submit-${code}`}>
            {t('receivePartial')}
          </Button>
        </form>
      )}
      {message && (
        <span role="alert" className="text-sm text-signal" data-testid={`receive-error-${code}`}>
          {message}
        </span>
      )}
    </span>
  );
}
