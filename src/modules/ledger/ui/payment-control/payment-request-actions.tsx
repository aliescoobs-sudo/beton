'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { RequestState } from '../../service/payment-control-service';

type Answer = { ok: boolean; error?: string };

/** What a person may do with one request, by its state; the doors and the trigger decide for real. */
export function PaymentRequestActions({
  id,
  state,
  level,
  canDecide,
  isOwner,
  canIssue,
  decide,
  issue,
}: {
  id: string;
  state: RequestState;
  level: 'small' | 'validate' | 'owner';
  canDecide: boolean;
  isOwner: boolean;
  canIssue: boolean;
  decide: (input: unknown) => Promise<Answer>;
  issue: (input: { requestId: string }) => Promise<Answer>;
}) {
  const t = useTranslations('ledger.paymentRequests');
  const [message, setMessage] = useState<string | null>(null);
  const act = async (p: Promise<Answer>, ok: string) => setMessage((await p).ok ? ok : t('refused'));
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={`pr-actions-${id}`}>
      {state === 'prepared' && canDecide && level === 'validate' && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void act(decide({ id, decision: 'validate' }), t('validatedMsg'))}
        >
          {t('validate')}
        </button>
      )}
      {state === 'prepared' && canDecide && isOwner && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void act(decide({ id, decision: 'approve' }), t('approvedMsg'))}
        >
          {t('approve')}
        </button>
      )}
      {state === 'prepared' && canDecide && (
        <button
          type="button"
          className="btn btn-danger btn-sm"
          onClick={() => void act(decide({ id, decision: 'reject' }), t('rejectedMsg'))}
        >
          {t('reject')}
        </button>
      )}
      {(state === 'validated' || state === 'approved') && canIssue && (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          data-testid="pr-issue"
          onClick={() => void act(issue({ requestId: id }), t('issuedMsg'))}
        >
          {t('issue')}
        </button>
      )}
      {message && (
        <span role="status" className="text-sm">
          {message}
        </span>
      )}
    </div>
  );
}
