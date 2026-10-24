'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { parseCentimes } from '@/lib/money';
import { Money, Table, Th } from '@/ui';
import type { OpeningState } from '../../service/opening-service';

type Result = { ok: true } | { ok: false; error: string };
interface Option {
  id: string;
  label: string;
}

/** The opening date (once) and what clients owe us and we owe suppliers on it. Owner edits; support reads. */
export function OpeningManager({
  state,
  editable,
  clients,
  suppliers,
  dateAction,
  partyAction,
}: {
  state: OpeningState;
  editable: boolean;
  clients: Option[];
  suppliers: Option[];
  dateAction: (input: unknown) => Promise<Result>;
  partyAction: (input: unknown) => Promise<Result>;
}) {
  const t = useTranslations('ledger.opening');
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [kind, setKind] = useState<'client' | 'supplier'>('client');

  const errorText = (e: string) =>
    ({
      INVALID: t('invalid'),
      ALREADY_ENTERED: t('alreadyEntered'),
      OPENING_FIRST: t('openingFirst'),
      DUPLICATE: t('duplicate'),
      PARTY_ARCHIVED: t('partyArchived'),
      NOT_FOUND: t('notFound'),
    })[e] ?? t('error');

  async function done(result: Result) {
    if (result.ok) {
      setMessage(null);
      return router.refresh();
    }
    setMessage(errorText(result.error));
  }

  async function submitDate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await done(
      await dateAction({ openingDate: String(new FormData(event.currentTarget).get('openingDate') ?? '') }),
    );
  }

  async function submitParty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const amount = parseCentimes(String(data.get('amount') ?? '').trim());
    const partyId = String(data.get('party') ?? '');
    if (amount === null || !partyId) return setMessage(t('invalid'));
    await done(
      await partyAction({
        ...(kind === 'client' ? { clientId: partyId } : { supplierId: partyId }),
        amountCentimes: amount,
        reference: String(data.get('reference') ?? '').trim() || null,
      }),
    );
  }

  return (
    <div className="mt-6 space-y-6">
      {message && (
        <p role="alert" className="text-sm" data-testid="opening-message">
          {message}
        </p>
      )}
      {state.openingDate ? (
        <p data-testid="opening-date">
          {t('openingDate')} : <bdi dir="ltr">{state.openingDate}</bdi>
        </p>
      ) : editable ? (
        <form
          onSubmit={(e) => void submitDate(e)}
          className="form-band flex flex-wrap items-end gap-3"
          data-testid="opening-date-form"
        >
          <label className="block">
            <span className="field-label">{t('openingDate')}</span>
            <input
              name="openingDate"
              type="date"
              required
              dir="ltr"
              className="input mt-1"
              data-testid="opening-date-input"
            />
          </label>
          <button type="submit" className="btn btn-primary btn-sm" data-testid="opening-date-save">
            {t('enterDate')}
          </button>
          <p className="basis-full text-sm text-muted">{t('onceNote')}</p>
        </form>
      ) : (
        <p className="text-sm text-muted">{t('notEntered')}</p>
      )}

      {state.openingDate && editable && (
        <form
          onSubmit={(e) => void submitParty(e)}
          className="form-band flex flex-wrap items-end gap-3"
          data-testid="opening-party-form"
        >
          <label className="block">
            <span className="field-label">{t('kind')}</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value === 'supplier' ? 'supplier' : 'client')}
              className="input mt-1"
              data-testid="opening-kind"
            >
              <option value="client">{t('client')}</option>
              <option value="supplier">{t('supplier')}</option>
            </select>
          </label>
          <label className="block">
            <span className="field-label">{t('party')}</span>
            <select name="party" required className="input mt-1 w-64" data-testid="opening-party">
              <option value="">—</option>
              {(kind === 'client' ? clients : suppliers).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="field-label">{t(kind === 'client' ? 'amountClient' : 'amountSupplier')}</span>
            <input
              name="amount"
              required
              inputMode="decimal"
              dir="ltr"
              autoComplete="off"
              className="input mt-1 w-40"
              data-testid="opening-amount"
            />
          </label>
          <label className="block">
            <span className="field-label">{t('reference')}</span>
            <input name="reference" maxLength={200} className="input mt-1 w-56" />
          </label>
          <button type="submit" className="btn btn-primary btn-sm" data-testid="opening-party-save">
            {t('add')}
          </button>
        </form>
      )}

      {state.parties.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>{t('party')}</Th>
              <Th>{t('kind')}</Th>
              <Th numeric>{t('owed')}</Th>
              <Th>{t('reference')}</Th>
            </tr>
          </thead>
          <tbody>
            {state.parties.map((p) => (
              <tr key={p.id} data-testid={`opening-row-${p.partyName}`}>
                <td className="font-medium">
                  <bdi>{p.partyName}</bdi>
                </td>
                <td>{t(p.kind === 'client' ? 'clientOwes' : 'weOwe')}</td>
                <td className="is-num">
                  <Money centimes={p.amountCentimes} />
                </td>
                <td>{p.reference ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
