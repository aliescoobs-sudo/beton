'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useMemo, useState } from 'react';
import { formatCentimes, parseCentimes } from '@/lib/money';
import { parseMilliQty } from '@/lib/quantity';
import { formatPercentBp, parsePercentBp } from '../../domain/percent';
import { PLAN_METHODS, type PlanMethod } from '../../domain/plan';
import { PLAN_PRESETS, type PlanPreset } from '../../domain/plan-presets';
import type { Effect } from '../../domain/effects';
import type { OrderError, OrderPreview } from '../../service/order-service';
import { EffectsPanel } from '../effects/effects-panel';

export interface OrderFormClient {
  id: string;
  code: string;
  name: string;
  defaultZoneId: string | null;
}

export type CreateOrderActionResult =
  | { ok: true; code: string; effects: Effect[] }
  | { ok: false; error: OrderError | 'UNAUTHENTICATED' | 'FORBIDDEN' };
export type PreviewOrderActionResult =
  { ok: true; preview: OrderPreview } | { ok: false; error: OrderError | 'UNAUTHENTICATED' | 'FORBIDDEN' };

interface Row {
  method: PlanMethod;
  dueDate: string;
  kind: 'percent' | 'amount';
  value: string;
}

const INPUT = 'input mt-1';

/**
 * One-screen order entry (AC-LED-10). Office enters blind (DECISIONS 81): it never sees a price or an amount, only the
 * code of the order it saved. The owner can ask for a preview of the amounts, computed by the server.
 */
export function OrderForm({
  clients,
  sites,
  zones,
  types,
  plants = [],
  today,
  createAction,
  previewAction,
  initial,
}: {
  clients: OrderFormClient[];
  sites: { id: string; clientId: string; label: string; zoneId: string | null }[];
  zones: { id: string; name: string }[];
  types: { id: string; code: string; label: string }[];
  /** The active plants to choose from; empty when there is only one (or the user is bound to a plant). */
  plants?: { id: string; name: string }[];
  today: string;
  createAction: (input: unknown) => Promise<CreateOrderActionResult>;
  /** Present only for a role that may read money. */
  previewAction?: (input: unknown) => Promise<PreviewOrderActionResult>;
  /** An order made from a quote starts with the quote's client, type and volume; the person still reviews and saves. */
  initial?: { clientId: string; typeId: string; volumeM3: string; quoteId: string } | null;
}) {
  const t = useTranslations('ledger.orders');
  const [search, setSearch] = useState('');
  const [clientId, setClientId] = useState(initial?.clientId ?? '');
  const [plantId, setPlantId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [typeId, setTypeId] = useState(initial?.typeId ?? types[0]?.id ?? '');
  const [volume, setVolume] = useState(initial?.volumeM3 ?? '');
  const [delivery, setDelivery] = useState(today);
  const [overridePrice, setOverridePrice] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [preset, setPreset] = useState<PlanPreset>('cash');
  const [rows, setRows] = useState<Row[]>([
    { method: 'advance', dueDate: today, kind: 'percent', value: '50' },
    { method: 'cash', dueDate: today, kind: 'percent', value: '50' },
  ]);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [effects, setEffects] = useState<Effect[]>([]);
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients.filter(
      (c) => q === '' || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q),
    );
  }, [clients, search]);
  const clientSites = sites.filter((s) => s.clientId === clientId);

  const percentSum = rows.every((r) => r.kind === 'percent')
    ? rows.reduce((sum, r) => sum + (parsePercentBp(r.value) ?? 0), 0)
    : null;

  function pickClient(id: string) {
    setClientId(id);
    setSiteId('');
    setZoneId(clients.find((c) => c.id === id)?.defaultZoneId ?? '');
  }

  function pickSite(id: string) {
    setSiteId(id);
    const zone = sites.find((s) => s.id === id)?.zoneId;
    if (zone) setZoneId(zone);
  }

  const errorText = (error: string) =>
    ({
      INVALID: t('invalid'),
      NOT_FOUND: t('notFound'),
      CLIENT_ARCHIVED: t('clientArchived'),
      TYPE_INACTIVE: t('typeInactive'),
      NO_PRICE: t('noPrice'),
      PLAN_INVALID: t('planInvalid'),
      DELIVERY_BEFORE_ORDER: t('deliveryBeforeOrder'),
      FORBIDDEN_OVERRIDE: t('forbiddenOverride'),
      CONFLICT: t('conflict'),
    })[error] ?? t('error');

  /** The server input, or null (the form says why) when a typed value is not a number we accept. */
  function build(): unknown | null {
    const litres = parseMilliQty(volume);
    if (!litres.ok || litres.value <= 0) return null;
    let override: { unitPriceHtCentimes: number; reason: string } | null = null;
    if (overridePrice.trim() !== '') {
      const price = parseCentimes(overridePrice);
      if (price === null || price <= 0 || overrideReason.trim().length < 3) return null;
      override = { unitPriceHtCentimes: price, reason: overrideReason.trim() };
    }
    let plan: unknown;
    if (preset === 'custom') {
      const items = [];
      for (const r of rows) {
        const bp = r.kind === 'percent' ? parsePercentBp(r.value) : null;
        const amount = r.kind === 'amount' ? parseCentimes(r.value) : null;
        if (bp === null && amount === null) return null;
        items.push({
          method: r.method,
          dueDate: r.dueDate,
          ...(bp !== null ? { percentBp: bp } : { amountCentimes: amount }),
        });
      }
      plan = { preset, items };
    } else plan = { preset };
    if (plants.length > 1 && !plantId) return null;
    return {
      clientId,
      ...(plantId ? { plantId } : {}),
      siteId: siteId || null,
      zoneId: zoneId || null,
      concreteTypeId: typeId,
      volumeL: litres.value,
      deliveryDate: delivery,
      plan,
      ...(override ? { priceOverride: override } : {}),
      ...(initial ? { quoteId: initial.quoteId } : {}),
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setPreview(null);
    const input = build();
    if (!input || !clientId) return setMessage(t('invalid'));
    setBusy(true);
    try {
      const result = await createAction(input);
      if (result.ok) {
        setSaved(result.code);
        setEffects(result.effects);
      } else setMessage(errorText(result.error));
    } finally {
      setBusy(false);
    }
  }

  async function showPreview() {
    setMessage(null);
    const input = build();
    if (!input || !clientId || !previewAction) return setMessage(t('invalid'));
    const result = await previewAction(input);
    if (result.ok) setPreview(result.preview);
    else setMessage(errorText(result.error));
  }

  function reset() {
    setSaved(null);
    setSearch('');
    setClientId('');
    setSiteId('');
    setZoneId('');
    setVolume('');
    setPreview(null);
    setMessage(null);
  }

  if (saved) {
    return (
      <div className="mt-6 space-y-4">
        <p role="status" className="text-lg font-medium" data-testid="order-saved">
          {t('saved', { code: saved })}
        </p>
        <EffectsPanel effects={effects} testId="order-effects" />
        <button type="button" onClick={reset} className="btn btn-primary btn-sm" data-testid="order-another">
          {t('another')}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-6 space-y-5" data-testid="order-form">
      {!previewAction && <p className="text-sm text-muted">{t('blindNote')}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block">
            <span className="field-label">{t('clientSearch')}</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={INPUT}
              data-testid="order-client-search"
            />
          </label>
          <label className="mt-2 block">
            <span className="field-label">{t('client')}</span>
            <select
              name="clientId"
              required
              value={clientId}
              onChange={(e) => pickClient(e.target.value)}
              className={INPUT}
              data-testid="order-client"
            >
              <option value="">—</option>
              {visible.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="space-y-2">
          <label className="block">
            <span className="field-label">{t('site')}</span>
            <select
              value={siteId}
              onChange={(e) => pickSite(e.target.value)}
              className={INPUT}
              data-testid="order-site"
            >
              <option value="">—</option>
              {clientSites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="field-label">{t('zone')}</span>
            <select
              value={zoneId}
              onChange={(e) => setZoneId(e.target.value)}
              className={INPUT}
              data-testid="order-zone"
            >
              <option value="">—</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {plants.length > 1 && (
          <label className="block">
            <span className="field-label">{t('plant')}</span>
            <select
              value={plantId}
              onChange={(e) => setPlantId(e.target.value)}
              className={INPUT}
              required
              data-testid="order-plant"
            >
              <option value="">{t('plantChoose')}</option>
              {plants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="field-label">{t('type')}</span>
          <select
            name="concreteTypeId"
            required
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
            className={INPUT}
            data-testid="order-type"
          >
            {types.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} · {c.label}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="field-label">{t('volume')}</span>
            <input
              name="volume"
              required
              inputMode="decimal"
              dir="ltr"
              value={volume}
              onChange={(e) => setVolume(e.target.value)}
              className={INPUT}
              data-testid="order-volume"
            />
          </label>
          <label className="block">
            <span className="field-label">{t('deliveryDate')}</span>
            <input
              name="deliveryDate"
              type="date"
              required
              dir="ltr"
              min={today}
              value={delivery}
              onChange={(e) => setDelivery(e.target.value)}
              className={INPUT}
              data-testid="order-delivery"
            />
          </label>
        </div>
      </div>

      {previewAction && (
        <fieldset className="form-band grid gap-3 sm:grid-cols-2" data-testid="order-override">
          <legend className="field-label px-1">{t('override')}</legend>
          <label className="block">
            <span className="field-label">{t('overridePrice')}</span>
            <input
              inputMode="decimal"
              dir="ltr"
              value={overridePrice}
              onChange={(e) => setOverridePrice(e.target.value)}
              className={INPUT}
              data-testid="order-override-price"
            />
          </label>
          <label className="block">
            <span className="field-label">{t('overrideReason')}</span>
            <input
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              maxLength={500}
              className={INPUT}
              data-testid="order-override-reason"
            />
          </label>
        </fieldset>
      )}

      <fieldset className="form-band space-y-3">
        <legend className="field-label px-1">{t('plan')}</legend>
        <label className="block">
          <span className="field-label">{t('preset')}</span>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value as PlanPreset)}
            className={INPUT}
            data-testid="order-preset"
          >
            {PLAN_PRESETS.map((p) => (
              <option key={p} value={p}>
                {t(`presets.${p}`)}
              </option>
            ))}
          </select>
        </label>
        {preset === 'custom' && (
          <div className="space-y-2" data-testid="order-custom">
            {rows.map((r, n) => (
              <div key={n} className="flex flex-wrap items-end gap-2" data-testid="order-row">
                <label className="block">
                  <span className="field-label">{t('itemMethod')}</span>
                  <select
                    value={r.method}
                    onChange={(e) =>
                      setRows(
                        rows.map((x, i) => (i === n ? { ...x, method: e.target.value as PlanMethod } : x)),
                      )
                    }
                    className={INPUT}
                  >
                    {PLAN_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {t(`methods.${m}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="field-label">{t('itemDue')}</span>
                  <input
                    type="date"
                    dir="ltr"
                    value={r.dueDate}
                    onChange={(e) =>
                      setRows(rows.map((x, i) => (i === n ? { ...x, dueDate: e.target.value } : x)))
                    }
                    className={INPUT}
                  />
                </label>
                <label className="block">
                  <span className="field-label">{t('itemShare')}</span>
                  <select
                    value={r.kind}
                    onChange={(e) =>
                      setRows(
                        rows.map((x, i) => (i === n ? { ...x, kind: e.target.value as Row['kind'] } : x)),
                      )
                    }
                    className={INPUT}
                  >
                    <option value="percent">{t('sharePercent')}</option>
                    <option value="amount">{t('shareAmount')}</option>
                  </select>
                </label>
                <label className="block">
                  <span className="field-label">
                    {r.kind === 'percent' ? t('sharePercent') : t('shareAmount')}
                  </span>
                  <input
                    inputMode="decimal"
                    dir="ltr"
                    value={r.value}
                    onChange={(e) =>
                      setRows(rows.map((x, i) => (i === n ? { ...x, value: e.target.value } : x)))
                    }
                    className={`${INPUT} w-28`}
                    data-testid="order-row-value"
                  />
                </label>
                {rows.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => setRows(rows.filter((_, i) => i !== n))}
                  >
                    {t('removeItem')}
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() =>
                setRows([...rows, { method: 'cheque', dueDate: delivery, kind: 'percent', value: '' }])
              }
            >
              {t('addItem')}
            </button>
            {percentSum !== null && (
              <p className="text-sm" dir="auto" data-testid="order-percent-sum">
                {t('percentSum', { sum: formatPercentBp(percentSum) })}
              </p>
            )}
          </div>
        )}
      </fieldset>

      {preview && (
        <section className="form-band space-y-2" data-testid="order-preview">
          <h2 className="text-lg">{t('previewTitle')}</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:max-w-sm">
            <dt>{t('unitPrice')}</dt>
            <dd dir="ltr" className="text-end">
              <bdi>{formatCentimes(preview.unitPriceHtCentimes)}</bdi> MAD
            </dd>
            <dt>{t('totalHt')}</dt>
            <dd dir="ltr" className="text-end" data-testid="preview-ht">
              <bdi>{formatCentimes(preview.totalHtCentimes)}</bdi> MAD
            </dd>
            <dt>{t('totalVat', { rate: formatPercentBp(preview.vatRateBp) })}</dt>
            <dd dir="ltr" className="text-end">
              <bdi>{formatCentimes(preview.totalVatCentimes)}</bdi> MAD
            </dd>
            <dt className="font-semibold">{t('totalTtc')}</dt>
            <dd dir="ltr" className="text-end font-semibold" data-testid="preview-ttc">
              <bdi>{formatCentimes(preview.totalTtcCentimes)}</bdi> MAD
            </dd>
          </dl>
          <ul className="text-sm">
            {preview.plan.map((i, n) => (
              <li key={n} className="flex gap-3">
                <span>{t(`methods.${i.method}`)}</span>
                <span dir="ltr">{i.dueDate}</span>
                <span dir="ltr">
                  <bdi>{formatCentimes(i.amountCentimes)}</bdi> MAD
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {message && (
        <p role="alert" className="field-error" data-testid="order-message">
          {message}
        </p>
      )}
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className="btn btn-primary" data-testid="order-save">
          {t('save')}
        </button>
        {previewAction && (
          <button
            type="button"
            onClick={() => void showPreview()}
            className="btn btn-secondary"
            data-testid="order-preview-button"
          >
            {t('preview')}
          </button>
        )}
      </div>
    </form>
  );
}
