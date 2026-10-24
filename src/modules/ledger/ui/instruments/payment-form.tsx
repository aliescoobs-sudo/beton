'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useMemo, useState } from 'react';
import { parseCentimes } from '@/lib/money';
import type { Effect } from '../../domain/effects';
import type { InstrumentMethod } from '../../domain/instrument';
import { EffectsPanel } from '../effects/effects-panel';

type Result = { ok: true; effects: Effect[] } | { ok: false; error: string };
interface Party {
  id: string;
  code: string;
  name: string;
}

const INPUT = 'input mt-1';
const METHODS: InstrumentMethod[] = ['cash', 'cheque', 'lcn', 'transfer'];

/**
 * One form for a payment that arrives (from a client) or leaves (to a supplier). Entered blind (DECISIONS 81): the
 * answer is "saved", never an amount or a balance. A cheque or LCN needs its number and the date written on it; an order
 * code covers that order's open items oldest first.
 */
export function PaymentForm({
  clients,
  suppliers,
  receiveAction,
  issueAction,
}: {
  clients: Party[];
  suppliers: Party[];
  receiveAction: (input: unknown) => Promise<Result>;
  issueAction: (input: unknown) => Promise<Result>;
}) {
  const t = useTranslations('ledger.payments');
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [search, setSearch] = useState('');
  const [partyId, setPartyId] = useState('');
  const [method, setMethod] = useState<InstrumentMethod>('cheque');
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [effects, setEffects] = useState<Effect[]>([]);
  const [busy, setBusy] = useState(false);

  const parties = direction === 'in' ? clients : suppliers;
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return parties.filter(
      (p) => q === '' || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q),
    );
  }, [parties, search]);
  const paper = method === 'cheque' || method === 'lcn';

  const errorText = (error: string) =>
    ({
      INVALID: t('invalid'),
      NOT_FOUND: t('notFound'),
      PARTY_ARCHIVED: t('partyArchived'),
      DUPLICATE: t('duplicate'),
      NOTHING_TO_ALLOCATE: t('nothingToAllocate'),
      CONFLICT: t('conflict'),
    })[error] ?? t('error');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    const amount = parseCentimes(text('amount'));
    if (amount === null || amount <= 0 || !partyId) return setMessage(t('invalid'));
    const input = {
      method,
      amountCentimes: amount,
      ...(direction === 'in'
        ? { clientId: partyId, orderCode: text('orderCode') || null }
        : { supplierId: partyId, purchaseCode: text('purchaseCode') || null }),
      number: text('number') || null,
      bank: text('bank') || null,
      writtenDate: text('writtenDate') || null,
    };
    setBusy(true);
    try {
      const result = await (direction === 'in' ? receiveAction(input) : issueAction(input));
      if (result.ok) {
        setSaved(true);
        setEffects(result.effects);
      } else setMessage(errorText(result.error));
    } finally {
      setBusy(false);
    }
  }

  if (saved) {
    return (
      <div className="mt-6 space-y-4">
        <p role="status" className="text-lg font-medium" data-testid="payment-saved">
          {t('saved')}
        </p>
        <EffectsPanel effects={effects} testId="payment-effects" />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          data-testid="payment-another"
          onClick={() => {
            setSaved(false);
            setPartyId('');
            setSearch('');
          }}
        >
          {t('another')}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-6 space-y-5" data-testid="payment-form">
      <p className="text-sm text-muted">{t('blindNote')}</p>
      <div className="flex gap-4" role="radiogroup" aria-label={t('direction')}>
        {(['in', 'out'] as const).map((d) => (
          <label key={d} className="flex items-center gap-2">
            <input
              type="radio"
              name="direction"
              value={d}
              checked={direction === d}
              onChange={() => {
                setDirection(d);
                setPartyId('');
                setSearch('');
              }}
              data-testid={`payment-direction-${d}`}
            />
            <span>{t(d === 'in' ? 'received' : 'paid')}</span>
          </label>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block">
            <span className="field-label">{t(direction === 'in' ? 'clientSearch' : 'supplierSearch')}</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={INPUT}
              data-testid="payment-search"
            />
          </label>
          <label className="mt-2 block">
            <span className="field-label">{t(direction === 'in' ? 'client' : 'supplier')}</span>
            <select
              required
              value={partyId}
              onChange={(e) => setPartyId(e.target.value)}
              className={INPUT}
              data-testid="payment-party"
            >
              <option value="">—</option>
              {visible.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} · {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="field-label">{t('method')}</span>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as InstrumentMethod)}
              className={INPUT}
              data-testid="payment-method"
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`methods.${m}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="field-label">{t('amount')}</span>
            <input
              name="amount"
              required
              inputMode="decimal"
              dir="ltr"
              autoComplete="off"
              className={INPUT}
              data-testid="payment-amount"
            />
          </label>
        </div>
        {method !== 'cash' && (
          <>
            <label className="block">
              <span className="field-label">{t(paper ? 'number' : 'reference')}</span>
              <input
                name="number"
                required={paper}
                maxLength={40}
                dir="ltr"
                className={INPUT}
                data-testid="payment-number"
              />
            </label>
            <label className="block">
              <span className="field-label">{t('bank')}</span>
              <input name="bank" maxLength={80} className={INPUT} data-testid="payment-bank" />
            </label>
          </>
        )}
        {paper && (
          <label className="block">
            <span className="field-label">{t('writtenDate')}</span>
            <input
              name="writtenDate"
              type="date"
              required
              dir="ltr"
              className={INPUT}
              data-testid="payment-written"
            />
          </label>
        )}
        {direction === 'out' && (
          <label className="block">
            <span className="field-label">{t('purchaseCode')}</span>
            <input
              name="purchaseCode"
              placeholder="ACH-2026-00001"
              maxLength={20}
              dir="ltr"
              className={INPUT}
              data-testid="payment-purchase"
            />
          </label>
        )}
        {direction === 'in' && (
          <label className="block">
            <span className="field-label">{t('orderCode')}</span>
            <input
              name="orderCode"
              placeholder="CMD-2026-00001"
              maxLength={20}
              dir="ltr"
              className={INPUT}
              data-testid="payment-order"
            />
          </label>
        )}
      </div>
      {message && (
        <p role="alert" className="text-sm" data-testid="payment-error">
          {message}
        </p>
      )}
      <button type="submit" disabled={busy} className="btn btn-primary" data-testid="payment-save">
        {t('save')}
      </button>
    </form>
  );
}
