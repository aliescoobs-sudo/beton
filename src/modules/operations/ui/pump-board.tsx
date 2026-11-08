'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import type { PumpBoardRow, PumpConflictRow, PumpOption, PumpWaitingRow } from '../service/pump-service';
import { Button } from '@/ui';

type Result = { ok: true } | { ok: false; error: string };
const hhmm = (min: number | null) =>
  min === null
    ? '—'
    : `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMinutes = (text: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * The pump board of a day (REQUIREMENTS-V1 §16.6): pumped orders waiting for a pump (no truck can be planned for them), the pumps
 * scheduled on site with their window, and the conflicts (a truck before the pump is ready, a pump booked twice).
 */
export function PumpBoard({
  date,
  board,
  waiting,
  conflicts,
  pumps,
  operators,
  editable,
  markPumped,
  schedule,
  reschedule,
  resolve,
}: {
  date: string;
  board: PumpBoardRow[];
  waiting: PumpWaitingRow[];
  conflicts: PumpConflictRow[];
  pumps: PumpOption[];
  operators: PumpOption[];
  editable: boolean;
  markPumped: (input: { orderCode: string; pumped: boolean }) => Promise<Result>;
  schedule: (input: unknown) => Promise<Result>;
  reschedule: (input: { jobId: string; onSiteMin: number }) => Promise<Result>;
  resolve: (input: { id: string }) => Promise<Result>;
}) {
  const t = useTranslations('pumps');
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [orderId, setOrderId] = useState('');

  async function run(action: () => Promise<Result>) {
    setMessage(null);
    try {
      const r = await action();
      if (r.ok) return router.refresh();
      setMessage(t(`errors.${r.error}` as never));
    } catch {
      setMessage(t('errors.INVALID'));
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const onSite = toMinutes(String(f.get('onSite') ?? ''));
    if (onSite === null) return setMessage(t('errors.INVALID'));
    const num = (k: string) => {
      const v = String(f.get(k) ?? '').trim();
      return v === '' ? undefined : Number(v);
    };
    void run(() =>
      schedule({
        date,
        pumpId: f.get('pump'),
        operatorId: f.get('operator'),
        orderId: orderId || null,
        onSiteMin: onSite,
        setupMin: num('setup'),
        durationMin: num('duration'),
        siteLabel: String(f.get('site') ?? '') || undefined,
        address: String(f.get('address') ?? '') || null,
        plannedM3: num('m3') ?? null,
      }),
    );
  }

  return (
    <div className="space-y-8">
      {message && (
        <p role="alert" className="text-danger" data-testid="pump-message">
          {message}
        </p>
      )}

      <section data-testid="pump-conflicts" className="space-y-2">
        <h2 className="text-xl">{t('conflicts')}</h2>
        {conflicts.length === 0 ? (
          <p className="text-sm text-muted" data-testid="pump-no-conflict">
            {t('noConflict')}
          </p>
        ) : (
          <ul className="space-y-2">
            {conflicts.map((c) => (
              <li
                key={c.id}
                className={c.resolvedAt ? 'text-muted' : 'font-semibold text-danger'}
                data-testid={`pump-conflict-${c.kind}`}
                data-resolved={c.resolvedAt ? 'yes' : 'no'}
              >
                {c.kind === 'truck_before_pump'
                  ? t('truckBeforePump', {
                      order: c.orderCode ?? '',
                      truck: hhmm(c.tripArriveMin),
                      pump: hhmm(
                        c.onSiteMin === null || c.setupMin === null ? null : c.onSiteMin + c.setupMin,
                      ),
                    })
                  : t('doubleBooked', { pump: c.pumpCode })}
                {editable && !c.resolvedAt && (
                  <Button
                    type="button"
                    variant="secondary"
                    className="ms-3"
                    onClick={() => void run(() => resolve({ id: c.id }))}
                    data-testid={`pump-resolve-${c.id}`}
                  >
                    {t('resolve')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {editable && (
        <section className="space-y-2" aria-labelledby="pump-mark">
          <h2 id="pump-mark" className="text-xl">
            {t('markTitle')}
          </h2>
          <form
            className="flex flex-wrap items-end gap-2"
            data-testid="pump-mark-form"
            onSubmit={(e) => {
              e.preventDefault();
              const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
              if (code) void run(() => markPumped({ orderCode: code, pumped: true }));
            }}
          >
            <label className="block">
              <span className="field-label">{t('orderCode')}</span>
              <input
                name="code"
                required
                placeholder="CMD-2026-00012"
                dir="ltr"
                className="input mt-1"
                data-testid="pump-mark-code"
              />
            </label>
            <Button type="submit" data-testid="pump-mark-save">
              {t('markPumped')}
            </Button>
          </form>
        </section>
      )}

      <section data-testid="pump-waiting" className="space-y-2">
        <h2 className="text-xl">{t('waiting')}</h2>
        {waiting.length === 0 ? (
          <p className="text-sm text-muted">{t('noWaiting')}</p>
        ) : (
          <ul className="space-y-1">
            {waiting.map((w) => (
              <li key={w.orderId} data-testid={`pump-waiting-${w.orderCode}`}>
                <bdi dir="ltr">{w.orderCode}</bdi> · {w.clientName} ·{' '}
                <bdi dir="ltr">{(w.volumeL / 1000).toLocaleString('fr-FR')} m³</bdi>{' '}
                <span className="text-danger">{t('noTruckBeforePump')}</span>
                {editable && (
                  <Button
                    type="button"
                    variant="secondary"
                    className="ms-3"
                    onClick={() => setOrderId(w.orderId)}
                    data-testid={`pump-pick-${w.orderCode}`}
                  >
                    {t('pickOrder')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section data-testid="pump-board" className="space-y-2">
        <h2 className="text-xl">{t('board')}</h2>
        {board.length === 0 ? (
          <p className="text-sm text-muted" data-testid="pump-none">
            {t('none')}
          </p>
        ) : (
          <ul className="space-y-2">
            {board.map((j) => (
              <li key={j.jobId} data-testid={`pump-job-${j.pumpCode}-${j.orderCode ?? 'free'}`}>
                <bdi dir="ltr" className="font-semibold">
                  {j.pumpCode}
                </bdi>{' '}
                · {j.operatorName} · {j.orderCode ? <bdi dir="ltr">{j.orderCode}</bdi> : t('noOrder')} ·{' '}
                {j.siteLabel}
                <br />
                <span className="text-sm">
                  {t('onSite')} <bdi dir="ltr">{hhmm(j.onSiteMin)}</bdi> · {t('ready')}{' '}
                  <bdi dir="ltr">{hhmm(j.onSiteMin === null ? null : j.onSiteMin + j.setupMin)}</bdi> ·{' '}
                  {t('until')}{' '}
                  <bdi dir="ltr">
                    {hhmm(j.onSiteMin === null ? null : j.onSiteMin + j.setupMin + (j.durationMin ?? 120))}
                  </bdi>
                  {j.firstTruckArriveMin !== null && (
                    <>
                      {' '}
                      · {t('firstTruck')} <bdi dir="ltr">{hhmm(j.firstTruckArriveMin)}</bdi>
                    </>
                  )}
                  {j.openConflicts > 0 && <span className="text-danger"> · ⚠ {j.openConflicts}</span>}
                </span>
                {editable && (
                  <form
                    className="mt-1 inline-flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const v = toMinutes(String(new FormData(e.currentTarget).get('time') ?? ''));
                      if (v === null) return setMessage(t('errors.INVALID'));
                      void run(() => reschedule({ jobId: j.jobId, onSiteMin: v }));
                    }}
                  >
                    <input
                      name="time"
                      placeholder="hh:mm"
                      dir="ltr"
                      className="input w-24"
                      aria-label={t('onSite')}
                      data-testid={`pump-move-time-${j.pumpCode}`}
                    />
                    <Button type="submit" variant="secondary" data-testid={`pump-move-${j.pumpCode}`}>
                      {t('move')}
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {editable && (
        <section className="space-y-2" aria-labelledby="pump-new">
          <h2 id="pump-new" className="text-xl">
            {t('schedule')}
          </h2>
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" data-testid="pump-form">
            <label className="block">
              <span className="field-label">{t('pump')}</span>
              <select name="pump" required className="input mt-1" data-testid="pump-select">
                {pumps.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="field-label">{t('operator')}</span>
              <select name="operator" required className="input mt-1" data-testid="pump-operator">
                {operators.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.code} · {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="field-label">{t('order')}</span>
              <select
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                className="input mt-1"
                data-testid="pump-order"
              >
                <option value="">—</option>
                {waiting.map((w) => (
                  <option key={w.orderId} value={w.orderId}>
                    {w.orderCode} · {w.clientName}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="field-label">{t('onSite')} (hh:mm)</span>
              <input
                name="onSite"
                required
                placeholder="07:30"
                dir="ltr"
                className="input mt-1"
                data-testid="pump-onsite"
              />
            </label>
            <label className="block">
              <span className="field-label">{t('setup')}</span>
              <input
                name="setup"
                inputMode="numeric"
                dir="ltr"
                className="input mt-1"
                data-testid="pump-setup"
              />
            </label>
            <label className="block">
              <span className="field-label">{t('duration')}</span>
              <input name="duration" inputMode="numeric" dir="ltr" className="input mt-1" />
            </label>
            <label className="block">
              <span className="field-label">{t('m3')}</span>
              <input name="m3" inputMode="numeric" dir="ltr" className="input mt-1" />
            </label>
            <label className="block">
              <span className="field-label">{t('site')}</span>
              <input name="site" className="input mt-1" data-testid="pump-site" />
            </label>
            <label className="block sm:col-span-2">
              <span className="field-label">{t('address')}</span>
              <input name="address" className="input mt-1" />
            </label>
            <div className="sm:col-span-2">
              <Button type="submit" data-testid="pump-save">
                {t('save')}
              </Button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
