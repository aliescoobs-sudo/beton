'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useMemo, useState } from 'react';
import { parseMilliQty } from '@/lib/quantity';
import type { Effect } from '../../domain/effects';
import { EffectsPanel } from '../effects/effects-panel';

type Result = { ok: true; code: string; effects: Effect[] } | { ok: false; error: string };
const INPUT = 'input mt-1';

/**
 * "Nouveau devis": client, type of concrete and volume; the price is the one in force, resolved by the server. Entered blind
 * by office: the answer is the code, never an amount.
 */
export function QuoteForm({
  clients,
  types,
  createAction,
}: {
  clients: { id: string; code: string; name: string }[];
  types: { id: string; code: string; label: string }[];
  createAction: (input: unknown) => Promise<Result>;
}) {
  const t = useTranslations('ledger.quotes');
  const [search, setSearch] = useState('');
  const [clientId, setClientId] = useState('');
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [volume, setVolume] = useState('');
  const [days, setDays] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<{ code: string; effects: Effect[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients.filter(
      (c) => q === '' || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q),
    );
  }, [clients, search]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const litres = parseMilliQty(volume);
    const validDays = days.trim() === '' ? null : Number(days);
    if (!clientId || !litres.ok || litres.value <= 0 || (validDays !== null && !Number.isInteger(validDays)))
      return setMessage(t('invalid'));
    setBusy(true);
    try {
      const result = await createAction({
        clientId,
        concreteTypeId: typeId,
        volumeL: litres.value,
        validDays,
      });
      if (result.ok) setDone({ code: result.code, effects: result.effects });
      else
        setMessage(
          {
            INVALID: t('invalid'),
            NOT_FOUND: t('notFound'),
            CLIENT_ARCHIVED: t('clientArchived'),
            TYPE_INACTIVE: t('typeInactive'),
            NO_PRICE: t('noPrice'),
            CONFLICT: t('conflict'),
          }[result.error] ?? t('error'),
        );
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <div className="mt-6 space-y-4">
        <p role="status" className="text-lg font-medium" data-testid="quote-saved">
          {t('saved')} <bdi dir="ltr">{done.code}</bdi>
        </p>
        <EffectsPanel effects={done.effects} testId="quote-effects" />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          data-testid="quote-another"
          onClick={() => setDone(null)}
        >
          {t('another')}
        </button>
      </div>
    );

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="mt-6 grid max-w-3xl gap-4 sm:grid-cols-2"
      data-testid="quote-form"
      noValidate
    >
      <label className="block">
        <span className="field-label">{t('clientSearch')}</span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={INPUT}
          data-testid="quote-client-search"
        />
      </label>
      <label className="block">
        <span className="field-label">{t('client')}</span>
        <select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          className={INPUT}
          required
          data-testid="quote-client"
        >
          <option value="">—</option>
          {visible.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} · {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="field-label">{t('type')}</span>
        <select
          value={typeId}
          onChange={(e) => setTypeId(e.target.value)}
          className={INPUT}
          data-testid="quote-type"
        >
          {types.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} · {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="field-label">{t('volume')}</span>
        <input
          value={volume}
          onChange={(e) => setVolume(e.target.value)}
          inputMode="decimal"
          dir="ltr"
          className={INPUT}
          data-testid="quote-volume"
        />
      </label>
      <label className="block">
        <span className="field-label">{t('validDays')}</span>
        <input
          value={days}
          onChange={(e) => setDays(e.target.value)}
          inputMode="numeric"
          dir="ltr"
          className={INPUT}
          data-testid="quote-days"
        />
        <span className="field-hint block">{t('validHint')}</span>
      </label>
      {message && (
        <p role="alert" className="field-error sm:col-span-2" data-testid="quote-message">
          {message}
        </p>
      )}
      <div className="sm:col-span-2">
        <button type="submit" disabled={busy} className="btn btn-primary" data-testid="quote-save">
          {t('save')}
        </button>
      </div>
    </form>
  );
}
