'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ChargeStatus } from '../../service/charge-service';

type Answer = { ok: boolean; error?: string; withDocument?: boolean };

/** The actions a person may take on one charge, by status (the doors decide for real; this only offers what can work). */
export function ChargeActions({
  id,
  status,
  canDecide,
  canWrite,
  isOwner,
  noDocument,
  decide,
  pay,
  addDocument,
}: {
  id: string;
  status: ChargeStatus;
  canDecide: boolean;
  canWrite: boolean;
  isOwner: boolean;
  noDocument: boolean;
  decide: (input: unknown) => Promise<Answer>;
  pay: (input: unknown) => Promise<Answer>;
  addDocument: (input: unknown) => Promise<Answer>;
}) {
  const t = useTranslations('ledger.charges');
  const [message, setMessage] = useState<string | null>(null);
  const [ref, setRef] = useState('');
  const act = async (p: Promise<Answer>, ok: string) => {
    const r = await p;
    setMessage(r.ok ? ok : t('refused'));
  };
  const needsDecision = status === 'pending_validation' || status === 'pending_approval';
  const payable = status === 'recorded' || status === 'validated' || status === 'approved';
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={`charge-actions-${id}`}>
      {needsDecision && canDecide && (
        <>
          {status === 'pending_validation' && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void act(decide({ id, decision: 'validate' }), t('validatedMsg'))}
            >
              {t('validate')}
            </button>
          )}
          {isOwner && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void act(decide({ id, decision: 'approve' }), t('approvedMsg'))}
            >
              {t('approve')}
            </button>
          )}
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => void act(decide({ id, decision: 'reject' }), t('rejectedMsg'))}
          >
            {t('reject')}
          </button>
        </>
      )}
      {payable && canWrite && (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          data-testid="charge-pay"
          onClick={() => void act(pay({ id }), t('paidMsg'))}
        >
          {t('pay')}
        </button>
      )}
      {noDocument && canWrite && status !== 'rejected' && status !== 'reversed' && (
        <span className="flex items-center gap-1">
          <input
            className="input w-32"
            dir="ltr"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            aria-label={t('documentRef')}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void act(addDocument({ id, ref }), t('documentAdded'))}
          >
            {t('addDocument')}
          </button>
        </span>
      )}
      {message && (
        <span role="status" className="text-sm">
          {message}
        </span>
      )}
    </div>
  );
}
