'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { formatCentimes } from '@/lib/money';
import { StepUpDialog } from '@/modules/platform-security/ui/step-up-dialog';
import { Button } from '@/ui';
import type { MyDisclosure, PendingDisclosure } from '../../service/disclosure-service';

type Result = { ok: true } | { ok: false; error: string };

/** The cards of the figure requests in the approvals inbox: one tap approves one view within 15 minutes, or denies. */
export function DisclosureCards({
  cards,
  decide,
}: {
  cards: PendingDisclosure[];
  decide: (input: {
    id: string;
    approve: boolean;
    mode?: 'single_view' | 'window';
    minutes?: number;
  }) => Promise<Result>;
}) {
  const t = useTranslations('ledger.disclosure');
  const router = useRouter();
  const [retry, setRetry] = useState<(() => Promise<Result>) | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function run(action: () => Promise<Result>) {
    const r = await action();
    if (r.ok) {
      setMessage(t('done'));
      return router.refresh();
    }
    if (r.error === 'STEP_UP_REQUIRED') return setRetry(() => action);
    setMessage(t('error'));
  }
  if (cards.length === 0) return null;
  return (
    <section className="mt-8 space-y-3" data-testid="disclosure-cards">
      <h2 className="text-lg font-semibold">{t('title')}</h2>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <ul className="space-y-3">
        {cards.map((c) => (
          <li key={c.id} className="card space-y-2 p-4" data-testid={`disclosure-${c.itemRef}`}>
            <p className="text-sm">
              {t('card', { who: c.requesterName, kind: t(`kind.${c.itemKind}`), ref: c.itemRef })}
            </p>
            {c.reason && <p className="text-sm text-muted">{c.reason}</p>}
            <p className="text-sm">{t('willDo')}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                data-testid={`disclosure-approve-${c.itemRef}`}
                onClick={() => void run(() => decide({ id: c.id, approve: true }))}
              >
                {t('approveOnce')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  void run(() => decide({ id: c.id, approve: true, mode: 'window', minutes: 15 }))
                }
              >
                {t('approveWindow')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                data-testid={`disclosure-deny-${c.itemRef}`}
                onClick={() => void run(() => decide({ id: c.id, approve: false }))}
              >
                {t('deny')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
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
    </section>
  );
}

/** The requester's side: ask for one figure, then read it once it is approved. */
export function MyDisclosures({
  items,
  request,
  view,
}: {
  items: MyDisclosure[];
  request: (input: { kind: string; ref: string; reason?: string }) => Promise<Result>;
  view: (
    id: string,
  ) => Promise<{ ok: true; centimes: number; viewsLeft: number | null } | { ok: false; error: string }>;
}) {
  const t = useTranslations('ledger.disclosure');
  const router = useRouter();
  const [kind, setKind] = useState('order_total');
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, number>>({});
  return (
    <div className="mt-6 space-y-6" data-testid="my-disclosures">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void request({ kind, ref, reason: reason || undefined }).then((r) => {
            setMessage(r.ok ? t('asked') : t(`errors.${r.error}`));
            if (r.ok) {
              setRef('');
              router.refresh();
            }
          });
        }}
      >
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="input"
          data-testid="disclosure-kind"
        >
          {(['order_total', 'invoice_total', 'client_balance'] as const).map((k) => (
            <option key={k} value={k}>
              {t(`kind.${k}`)}
            </option>
          ))}
        </select>
        <input
          className="input"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder={t('ref')}
          data-testid="disclosure-ref"
          required
        />
        <input
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('reason')}
          maxLength={300}
        />
        <Button type="submit" data-testid="disclosure-submit">
          {t('ask')}
        </Button>
        {message && (
          <p role="status" className="text-sm" data-testid="disclosure-message">
            {message}
          </p>
        )}
      </form>
      <ul className="space-y-2">
        {items.map((d) => (
          <li
            key={d.id}
            className="card flex items-center justify-between gap-2 p-3 text-sm"
            data-testid={`my-disclosure-${d.itemRef}`}
          >
            <span>
              {t(`kind.${d.itemKind}`)} · <bdi dir="ltr">{d.itemRef}</bdi> · {t(`status.${d.status}`)}
            </span>
            {d.status === 'approved' &&
              (d.viewsLeft === null || d.viewsLeft > 0) &&
              shown[d.id] === undefined && (
                <Button
                  type="button"
                  data-testid={`disclosure-view-${d.itemRef}`}
                  onClick={() =>
                    void view(d.id).then((r) => {
                      if (r.ok) setShown((s) => ({ ...s, [d.id]: r.centimes }));
                      else setMessage(t('errors.NOT_AVAILABLE'));
                    })
                  }
                >
                  {t('view')}
                </Button>
              )}
            {shown[d.id] !== undefined && (
              <bdi dir="ltr" className="font-medium" data-testid={`disclosure-figure-${d.itemRef}`}>
                {formatCentimes(shown[d.id] as number)} MAD
              </bdi>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
