'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { formatCentimes } from '@/lib/money';
import { StepUpDialog } from '@/modules/platform-security/ui/step-up-dialog';
import { Button, StatusPill } from '@/ui';
import type { ApprovalCard } from '../../service/approval-service';
import type { PaymentRequestView } from '../../service/payment-control-service';

type Result = { ok: true } | { ok: false; error: string };
type Pending = () => Promise<Result>;

/**
 * The approvals inbox: each card says exactly what one tap will do. A decision needs a fresh second factor; a stale one
 * opens the step-up dialog and the same decision is retried once. The server checks every right again.
 */
export function ApprovalsInbox({
  cards,
  payments = [],
  actions,
}: {
  cards: ApprovalCard[];
  /** T19-close B (D247): outgoing payments above the upper limit, waiting for the owner. */
  payments?: PaymentRequestView[];
  actions: {
    confirmPrice: (input: { orderId: string }) => Promise<Result>;
    confirmBulk: (orderIds: string[]) => Promise<Result>;
    release: (input: { orderId: string }) => Promise<Result>;
    decidePayment?: (input: { id: string; decision: 'approve' | 'reject' }) => Promise<Result>;
  };
}) {
  const t = useTranslations('ledger.approvals');
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<Pending | null>(null);
  const prices = cards.filter((c) => c.kind === 'price');

  async function run(action: Pending) {
    setMessage(null);
    const result = await action();
    if (result.ok) {
      setMessage(t('done'));
      return router.refresh();
    }
    if (result.error === 'STEP_UP_REQUIRED') return setRetry(() => action);
    setMessage(t('error'));
  }

  return (
    <div className="mt-6 space-y-4" data-testid="approvals">
      {message && (
        <p role="status" className="text-sm" data-testid="approvals-message">
          {message}
        </p>
      )}
      {cards.length === 0 && payments.length === 0 && (
        <p className="text-sm text-muted" data-testid="approvals-none">
          {t('none')}
        </p>
      )}
      {prices.length > 1 && (
        <Button
          type="button"
          onClick={() => void run(() => actions.confirmBulk(prices.map((c) => c.orderId)))}
          data-testid="approvals-confirm-all"
        >
          {t('confirmAll', { count: prices.length })}
        </Button>
      )}
      <ul className="space-y-3">
        {cards.map((c) => (
          <li
            key={`${c.kind}-${c.orderId}`}
            className="card space-y-2 p-4"
            data-testid={`approval-${c.kind}-${c.orderCode}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={c.kind === 'price' ? 'due' : 'late'}>
                {c.kind === 'price' ? t('kindPrice') : t(`kindCredit.${c.reason}`)}
              </StatusPill>
              <bdi dir="ltr" className="font-medium">
                {c.orderCode}
              </bdi>
              <span>{c.clientName}</span>
            </div>
            <p className="text-sm">
              {t('volume', { m3: (c.volumeL / 1000).toLocaleString('fr-FR') })} ·{' '}
              <bdi dir="ltr">{formatCentimes(c.unitPriceCentimes)} MAD</bdi> {t('perM3')} ·{' '}
              <bdi dir="ltr">{formatCentimes(c.totalHtCentimes)} MAD</bdi> {t('ht')}
            </p>
            {c.kind === 'credit' && (
              <p className="text-sm text-muted">
                {t('exposure', {
                  open: formatCentimes(c.openCentimes),
                  limit: c.limitCentimes === null ? '—' : formatCentimes(c.limitCentimes),
                })}
              </p>
            )}
            <p className="text-sm">{c.kind === 'price' ? t('willConfirm') : t('willRelease')}</p>
            <Button
              type="button"
              onClick={() =>
                void run(() =>
                  c.kind === 'price'
                    ? actions.confirmPrice({ orderId: c.orderId })
                    : actions.release({ orderId: c.orderId }),
                )
              }
              data-testid={`approve-${c.kind}-${c.orderCode}`}
            >
              {c.kind === 'price' ? t('confirm') : t('release')}
            </Button>
          </li>
        ))}
      </ul>
      {payments.length > 0 && actions.decidePayment && (
        <section className="space-y-3" aria-labelledby="approvals-payments" data-testid="approvals-payments">
          <h2 id="approvals-payments" className="text-lg">
            {t('payments.title')}
          </h2>
          <ul className="space-y-3">
            {payments.map((p) => (
              <li key={p.id} className="card space-y-2 p-4" data-testid={`approval-payment-${p.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill status="late">{t('payments.kind')}</StatusPill>
                  <span className="font-medium">{p.supplierName}</span>
                  <bdi dir="ltr">{p.supplierCode}</bdi>
                </div>
                <p className="text-sm">
                  {t(`payments.method.${p.method}`)}
                  {p.number && (
                    <>
                      {' '}
                      <bdi dir="ltr">{p.number}</bdi>
                    </>
                  )}
                  {p.bank && <> · {p.bank}</>}
                  {p.writtenDate && (
                    <>
                      {' · '}
                      {t('payments.dated')} <bdi dir="ltr">{p.writtenDate}</bdi>
                    </>
                  )}{' '}
                  · <bdi dir="ltr">{formatCentimes(p.amountCentimes)} MAD</bdi>
                </p>
                <p className="text-sm text-muted">
                  {t('payments.preparedBy', { name: p.preparedBy ?? '—', date: p.createdAt })}
                  {p.note ? ` · ${p.note}` : ''}
                </p>
                <p className="text-sm">{t('payments.willApprove')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={() => void run(() => actions.decidePayment!({ id: p.id, decision: 'approve' }))}
                    data-testid={`approve-payment-${p.id}`}
                  >
                    {t('payments.approve')}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void run(() => actions.decidePayment!({ id: p.id, decision: 'reject' }))}
                    data-testid={`reject-payment-${p.id}`}
                  >
                    {t('payments.reject')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
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
    </div>
  );
}
