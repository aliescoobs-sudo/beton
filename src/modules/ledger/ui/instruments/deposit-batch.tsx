'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Money } from '@/ui';
import type { AccountOption, LifecycleAction } from './instrument-actions';

export interface Depositable {
  id: string;
  label: string;
  amountCentimes: number;
  writtenDate: string | null;
}

/** "Remise en banque": tick the received cheques and LCN, pick the bank account and the date, deposit them in one go. */
export function DepositBatch({
  items,
  banks,
  today,
  deposit,
}: {
  items: Depositable[];
  banks: AccountOption[];
  today: string;
  deposit: LifecycleAction;
}) {
  const t = useTranslations('ledger.lifecycle');
  const router = useRouter();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  if (items.length === 0 || banks.length === 0) return null;

  function toggle(id: string) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setMessage(null);
    const result = await deposit({
      instrumentIds: [...picked],
      accountId: String(data.get('account') ?? ''),
      date: String(data.get('date') ?? ''),
    });
    if (result.ok) {
      setPicked(new Set());
      return router.refresh();
    }
    setMessage(
      result.error === 'ILLEGAL_TRANSITION'
        ? t('illegal')
        : result.error === 'FUTURE_DATE'
          ? t('futureDate')
          : t('invalid'),
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="form-band mt-6 space-y-3" data-testid="deposit-batch">
      <p className="field-label">{t('batch.title')}</p>
      <ul className="space-y-1">
        {items.map((i) => (
          <li key={i.id}>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={picked.has(i.id)}
                onChange={() => toggle(i.id)}
                data-testid={`batch-pick-${i.label}`}
              />
              <bdi>{i.label}</bdi>
              {i.writtenDate && (
                <bdi dir="ltr" className="text-sm text-muted">
                  {i.writtenDate}
                </bdi>
              )}
              <Money centimes={i.amountCentimes} />
            </label>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="field-label">{t('account')}</span>
          <select name="account" required className="input mt-1" data-testid="batch-account">
            <option value="">—</option>
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">{t('date')}</span>
          <input
            name="date"
            type="date"
            required
            max={today}
            defaultValue={today}
            dir="ltr"
            className="input mt-1"
          />
        </label>
        <button
          type="submit"
          disabled={picked.size === 0}
          className="btn btn-primary btn-sm"
          data-testid="batch-deposit"
        >
          {t('batch.deposit', { count: picked.size })}
        </button>
      </div>
      {message && (
        <p role="alert" className="text-sm" data-testid="batch-error">
          {message}
        </p>
      )}
    </form>
  );
}
