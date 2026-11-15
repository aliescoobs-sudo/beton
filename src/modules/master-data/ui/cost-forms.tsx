'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { parseCentimes } from '@/lib/money';
import { Button } from '@/ui';
import { parseLitresToMl } from '../domain/cost-input';

type Answer = { ok: true } | { ok: false; error: string };
type Replace = (input: unknown) => Promise<Answer>;
const KEYS = [
  'diesel_per_l',
  'delivery_other_per_m3',
  'pump_per_m3',
  'plant_per_m3',
  'overhead_per_m3',
] as const;
const KINDS = ['mixer', 'pump', 'external', 'hauler'] as const;
const METHODS = ['GOULOTTE', 'POMPE'] as const;

/** The four replace forms of the cost data screen. A value is typed in MAD (or litres), travels as integer centimes (or millilitres), and is saved as a NEW row (never an update). */
export function CostForms({
  classes,
  trucks,
  transports,
  replaceRate,
  replaceFuel,
  replaceTransport,
  replaceGrid,
}: {
  classes: { id: string; code: string }[];
  trucks: { id: string; code: string }[];
  transports: { id: string; label: string }[];
  replaceRate: Replace;
  replaceFuel: Replace;
  replaceTransport: Replace;
  replaceGrid: Replace;
}) {
  const t = useTranslations('costs');
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);

  async function submit(
    event: FormEvent<HTMLFormElement>,
    build: (d: FormData) => unknown | null,
    send: Replace,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = build(new FormData(form));
    if (input === null) return setMessage(t('errors.INVALID'));
    const r = await send(input);
    if (r.ok) {
      setMessage(null);
      form.reset();
      return router.refresh();
    }
    setMessage(t(`errors.${r.error}` as never));
  }
  const text = (d: FormData, name: string) => String(d.get(name) ?? '');
  const common = (
    <>
      <label className="block">
        <span className="field-label">{t('from')}</span>
        <input name="from" type="date" required dir="ltr" className="input mt-1" />
      </label>
      <label className="block">
        <span className="field-label">{t('source')}</span>
        <input name="source" required minLength={3} maxLength={300} className="input mt-1 w-56" />
      </label>
      <label className="block">
        <span className="field-label">{t('reason')}</span>
        <input name="reason" required minLength={3} maxLength={500} className="input mt-1 w-56" />
      </label>
    </>
  );

  return (
    <div className="mt-8" data-testid="costs-forms">
      <h2 className="text-lg font-semibold">{t('replace')}</h2>
      <p className="text-sm">{t('replaceHint')}</p>
      <form
        className="form-band mb-3 flex flex-wrap items-end gap-2"
        data-testid="costs-rate-form"
        onSubmit={(e) =>
          submit(
            e,
            (d) => {
              const v = parseCentimes(text(d, 'value'));
              return v === null
                ? null
                : {
                    key: text(d, 'key'),
                    valueCentimes: v,
                    effectiveFrom: text(d, 'from'),
                    plantId: null,
                    sourceNote: text(d, 'source'),
                    reason: text(d, 'reason'),
                  };
            },
            replaceRate,
          )
        }
      >
        <label className="block">
          <span className="field-label">{t('rates.key')}</span>
          <select name="key" required className="input mt-1">
            {KEYS.map((k) => (
              <option key={k} value={k}>
                {t(`rates.keys.${k}` as never)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">{t('valueMad')}</span>
          <input name="value" required inputMode="decimal" dir="ltr" className="input num mt-1 w-28" />
        </label>
        {common}
        <Button type="submit" small>
          {t('replaceRate')}
        </Button>
      </form>

      <form
        className="form-band mb-3 flex flex-wrap items-end gap-2"
        data-testid="costs-fuel-form"
        onSubmit={(e) =>
          submit(
            e,
            (d) => {
              const kind = text(d, 'scope');
              const [trip, hour, km] = ['trip', 'hour', 'km'].map((n) =>
                text(d, n) === '' ? undefined : parseLitresToMl(text(d, n)),
              );
              if (trip === null || hour === null || km === null) return null;
              return {
                truckKind: (KINDS as readonly string[]).includes(kind) ? kind : null,
                truckId: (KINDS as readonly string[]).includes(kind) ? null : kind,
                perTripMl: trip ?? null,
                perHourMl: hour ?? null,
                perKmMl: km ?? null,
                effectiveFrom: text(d, 'from'),
                sourceNote: text(d, 'source'),
                reason: text(d, 'reason'),
              };
            },
            replaceFuel,
          )
        }
      >
        <label className="block">
          <span className="field-label">{t('fuel.scope')}</span>
          <select name="scope" required className="input mt-1">
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kinds.${k}` as never)}
              </option>
            ))}
            {trucks.map((tr) => (
              <option key={tr.id} value={tr.id}>
                {tr.code}
              </option>
            ))}
          </select>
        </label>
        {(['trip', 'hour', 'km'] as const).map((n) => (
          <label key={n} className="block">
            <span className="field-label">{t(`fuel.${n}Litres` as never)}</span>
            <input name={n} inputMode="decimal" dir="ltr" className="input num mt-1 w-24" />
          </label>
        ))}
        {common}
        <Button type="submit" small>
          {t('replaceFuel')}
        </Button>
      </form>

      <form
        className="form-band mb-3 flex flex-wrap items-end gap-2"
        data-testid="costs-transport-form"
        onSubmit={(e) =>
          submit(
            e,
            (d) => {
              const v = parseCentimes(text(d, 'value'));
              return v === null
                ? null
                : {
                    priceId: text(d, 'price'),
                    transportCentimes: v,
                    sourceNote: text(d, 'source'),
                    reason: text(d, 'reason'),
                  };
            },
            replaceTransport,
          )
        }
      >
        <label className="block">
          <span className="field-label">{t('transport.component')}</span>
          <select name="price" required className="input mt-1">
            {transports.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">{t('valueMad')}</span>
          <input name="value" required inputMode="decimal" dir="ltr" className="input num mt-1 w-28" />
        </label>
        <label className="block">
          <span className="field-label">{t('source')}</span>
          <input name="source" required minLength={3} maxLength={300} className="input mt-1 w-56" />
        </label>
        <label className="block">
          <span className="field-label">{t('reason')}</span>
          <input name="reason" required minLength={3} maxLength={500} className="input mt-1 w-56" />
        </label>
        <Button type="submit" small>
          {t('replaceTransport')}
        </Button>
      </form>

      <form
        className="form-band mb-3 flex flex-wrap items-end gap-2"
        data-testid="costs-grid-form"
        onSubmit={(e) =>
          submit(
            e,
            (d) => {
              const v = parseCentimes(text(d, 'value'));
              return v === null
                ? null
                : {
                    classId: text(d, 'class'),
                    method: text(d, 'method'),
                    priceCentimes: v,
                    effectiveFrom: text(d, 'from'),
                    reason: text(d, 'reason'),
                  };
            },
            replaceGrid,
          )
        }
      >
        <label className="block">
          <span className="field-label">{t('grid.class')}</span>
          <select name="class" required className="input mt-1">
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">{t('grid.method')}</span>
          <select name="method" required className="input mt-1">
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`methods.${m}` as never)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">{t('valueMad')}</span>
          <input name="value" required inputMode="decimal" dir="ltr" className="input num mt-1 w-28" />
        </label>
        <label className="block">
          <span className="field-label">{t('from')}</span>
          <input name="from" type="date" required dir="ltr" className="input mt-1" />
        </label>
        <label className="block">
          <span className="field-label">{t('reason')}</span>
          <input name="reason" required minLength={3} maxLength={500} className="input mt-1 w-56" />
        </label>
        <Button type="submit" small>
          {t('replaceGrid')}
        </Button>
      </form>
      {message && (
        <p role="alert" className="text-sm font-semibold" data-testid="costs-message">
          {message}
        </p>
      )}
    </div>
  );
}
