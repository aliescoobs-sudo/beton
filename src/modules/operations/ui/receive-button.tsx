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
    <span className="inline-flex flex-col gap-1">
      <Button type="button" disabled={pending} onClick={click} data-testid={`receive-${code}`}>
        {t('receive')}
      </Button>
      {message && (
        <span role="alert" className="text-sm text-signal" data-testid={`receive-error-${code}`}>
          {message}
        </span>
      )}
    </span>
  );
}
