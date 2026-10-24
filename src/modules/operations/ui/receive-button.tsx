'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { Effect } from '@/modules/ledger';
import { EffectsPanel } from '@/modules/ledger/ui/effects/effects-panel';
import { Button } from '@/ui';

export type ReceiveResult = { ok: true; effects: Effect[] } | { ok: false; error: string };

/** Records the receipt of one purchase today: its stocked lines go into the stock. Once only. */
export function ReceiveButton({
  purchaseId,
  code,
  receive,
}: {
  purchaseId: string;
  code: string;
  receive: (input: unknown) => Promise<ReceiveResult>;
}) {
  const t = useTranslations('operations.receipts');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [effects, setEffects] = useState<Effect[] | null>(null);

  async function click() {
    setPending(true);
    setMessage(null);
    try {
      const result = await receive({ purchaseId });
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
          onClick={() => router.refresh()}
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
        <span role="alert" className="text-sm text-signal">
          {message}
        </span>
      )}
    </span>
  );
}
