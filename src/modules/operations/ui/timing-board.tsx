'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button, Input, Select, StatusPill } from '@/ui';
import { ESTIMATE_STAGES, type BoardTruck, type EstimateStage } from '../domain/trip-timing';
import { carryMessage, takeCarriedMessage } from './carried-message';
import type { DelayStats, EstimateView } from '../service/timing-service';

type Done = { ok: true; conflicts?: string[] } | { ok: false; error: string };

export interface TimingBoardProps {
  trucks: BoardTruck[];
  /** The estimates behind the projection, by "plant|zone", and a readable name of each route. */
  estimates: Record<string, Record<EstimateStage, EstimateView>>;
  routeLabels: Record<string, string>;
  /** Trucks and drivers a rotation can be moved to. */
  movable: { trucks: { id: string; code: string }[]; drivers: { id: string; code: string; name: string }[] };
  canAct: boolean;
  stats: DelayStats | null;
  reassign: (input: {
    tripId: string;
    truckId: string;
    driverId: string | null;
    reason: string;
    overlapReason?: string;
  }) => Promise<Done>;
  postpone: (input: { tripId: string; reason: string }) => Promise<Done>;
  setEstimate: (input: {
    plantId: string;
    zoneId: string | null;
    stage: EstimateStage;
    minutes: number;
    reason: string;
  }) => Promise<Done>;
}

const clock = (dayStartMs: number, ms: number) => {
  const m = Math.round((ms - dayStartMs) / 60_000);
  const mm = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
};
const minuteClock = (min: number) => clock(0, min * 60_000);

/** The board of the day by truck: status, planned and projected times, delays and the state, with reassign and postpone for the next rotation. */
export function TimingBoardPanel(props: TimingBoardProps) {
  const t = useTranslations('operations.dispatch.timing');
  const tc = useTranslations('operations.dispatch.conflict');
  const router = useRouter();
  const [overlapAsked, setOverlapAsked] = useState(false);
  const [acting, setActing] = useState<{ tripId: string; kind: 'reassign' | 'postpone' } | null>(null);
  // The board is keyed by its rotations, so a reassignment (new rotation ids) rebuilds it after the refresh: the confirmation, with what the
  // new plan still has wrong, is handed to the new instance (module memory: empty on a first load, so no hydration mismatch).
  const [message, setMessage] = useState<string | null>(() => {
    return takeCarriedMessage();
  });
  const [error, setError] = useState<string | null>(null);

  async function run(job: Promise<Done>) {
    setError(null);
    const r = await job;
    if (!r.ok) {
      // A driver or a truck on two rotations at once: the form then asks for the reason of an explicit, audited exception.
      if (r.error === 'OVERLAP') setOverlapAsked(true);
      return setError(t(`errors.${r.error}` as never));
    }
    setActing(null);
    setOverlapAsked(false);
    // What the new plan still has wrong is shown, never dropped.
    const left = (r.conflicts ?? []).map((c) => tc(c as never)).join(', ');
    const text = left ? `${t('done')} ${t('conflictsLeft', { list: left })}` : t('done');
    setMessage(text);
    carryMessage(text);
    router.refresh();
  }

  return (
    <section aria-labelledby="timing-title" className="space-y-4" data-testid="timing-board">
      <h2 id="timing-title" className="text-xl">
        {t('title')}
      </h2>
      <p className="text-sm text-muted">{t('intro')}</p>
      {props.trucks.length === 0 && <p data-testid="timing-none">{t('none')}</p>}
      {message && (
        <p role="status" className="text-sm font-semibold" data-testid="timing-message">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm font-semibold text-signal" data-testid="timing-error">
          {error}
        </p>
      )}
      {props.trucks.map((truck) => (
        <article
          key={truck.truckId}
          className="rounded border border-rule p-3"
          data-testid={`timing-truck-${truck.truckCode}`}
        >
          <header className="flex flex-wrap items-center gap-3">
            <h3 className="text-lg font-bold">
              <bdi dir="ltr">{truck.truckCode}</bdi>
            </h3>
            <span data-testid={`timing-status-${truck.truckCode}`}>{t(`status.${truck.status}`)}</span>
            <StatusPill
              status={
                truck.alert.level === 'critical' ? 'late' : truck.alert.level === 'watch' ? 'due' : 'ontrack'
              }
            >
              <span data-testid={`timing-level-${truck.truckCode}`}>{t(`level.${truck.alert.level}`)}</span>
            </StatusPill>
          </header>
          {truck.alert.level === 'critical' && (
            <p
              role="alert"
              className="mt-2 font-semibold text-signal"
              data-testid={`timing-alert-${truck.truckCode}`}
            >
              {t('affected', { order: truck.alert.nextOrderCode ?? '', min: truck.alert.slipMin })}
            </p>
          )}
          <ul className="mt-2 space-y-2">
            {truck.trips.map((b) => {
              const tr = b.trip;
              const affected = truck.alert.level === 'critical' && truck.alert.nextTripId === tr.tripId;
              const open = Object.keys(tr.steps).length === 0;
              return (
                <li key={tr.tripId} className="row-item text-sm" data-testid={`timing-trip-${tr.orderCode}`}>
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <bdi dir="ltr" className="font-semibold">
                      {tr.orderCode}
                    </bdi>
                    <span>{tr.driverName ?? t('noDriver')}</span>
                    <span>
                      {t('planned', {
                        load: minuteClock(tr.plan.loadMin),
                        back: minuteClock(tr.plan.backMin),
                      })}
                    </span>
                    {b.projection.started && (
                      <span data-testid={`timing-projected-${tr.orderCode}`}>
                        {t('projected', { back: clock(tr.dayStartMs, b.projection.projectedBackMs) })}
                      </span>
                    )}
                    {b.cumulativeDelayMin !== null && (
                      <span data-testid={`timing-delay-${tr.orderCode}`}>
                        {t('delay', {
                          min: b.cumulativeDelayMin > 0 ? `+${b.cumulativeDelayMin}` : b.cumulativeDelayMin,
                        })}
                      </span>
                    )}
                    {b.alert.level === 'watch' && (
                      <span className="text-amber-700">
                        {b.alert.cause === 'late_start'
                          ? t('lateStart', { min: b.alert.overMin })
                          : t('stageOver', { min: b.alert.overMin })}
                      </span>
                    )}
                  </div>
                  {props.canAct && open && (affected || b.alert.level !== 'none') && (
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => setActing({ tripId: tr.tripId, kind: 'reassign' })}
                        data-testid={`reassign-${tr.orderCode}`}
                      >
                        {t('reassign')}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => setActing({ tripId: tr.tripId, kind: 'postpone' })}
                        data-testid={`postpone-${tr.orderCode}`}
                      >
                        {t('postpone')}
                      </Button>
                    </div>
                  )}
                  {acting?.tripId === tr.tripId && (
                    <ActForm
                      kind={acting.kind}
                      orderCode={tr.orderCode}
                      movable={props.movable}
                      askOverlap={overlapAsked}
                      onCancel={() => {
                        setActing(null);
                        setOverlapAsked(false);
                      }}
                      onSubmit={(v) =>
                        run(
                          acting.kind === 'reassign'
                            ? props.reassign({
                                tripId: tr.tripId,
                                truckId: v.truckId,
                                driverId: v.driverId,
                                reason: v.reason,
                                ...(v.overlapReason ? { overlapReason: v.overlapReason } : {}),
                              })
                            : props.postpone({ tripId: tr.tripId, reason: v.reason }),
                        )
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </article>
      ))}

      {props.canAct && Object.keys(props.estimates).length > 0 && <Estimates {...props} />}
      {props.stats && <Stats stats={props.stats} />}
    </section>
  );
}

function ActForm({
  kind,
  orderCode,
  movable,
  askOverlap,
  onCancel,
  onSubmit,
}: {
  kind: 'reassign' | 'postpone';
  orderCode: string;
  movable: TimingBoardProps['movable'];
  askOverlap: boolean;
  onCancel: () => void;
  onSubmit: (v: { truckId: string; driverId: string | null; reason: string; overlapReason: string }) => void;
}) {
  const t = useTranslations('operations.dispatch.timing');
  const [truckId, setTruckId] = useState(movable.trucks[0]?.id ?? '');
  const [driverId, setDriverId] = useState('');
  const [reason, setReason] = useState('');
  const [overlapReason, setOverlapReason] = useState('');
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      data-testid={`act-form-${orderCode}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ truckId, driverId: driverId || null, reason, overlapReason: overlapReason.trim() });
      }}
    >
      {kind === 'reassign' && (
        <>
          <label className="block">
            <span className="field-label">{t('truck')}</span>
            <Select
              value={truckId}
              onChange={(e) => setTruckId(e.target.value)}
              data-testid={`act-truck-${orderCode}`}
            >
              {movable.trucks.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.code}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="field-label">{t('driver')}</span>
            <Select
              value={driverId}
              onChange={(e) => setDriverId(e.target.value)}
              data-testid={`act-driver-${orderCode}`}
            >
              <option value="">{t('noDriver')}</option>
              {movable.drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code} · {d.name}
                </option>
              ))}
            </Select>
          </label>
        </>
      )}
      <label className="block">
        <span className="field-label">{t('reason')}</span>
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={3}
          maxLength={500}
          data-testid={`act-reason-${orderCode}`}
        />
      </label>
      {kind === 'reassign' && askOverlap && (
        <label className="block">
          <span className="field-label">{t('overlapReason')}</span>
          <Input
            value={overlapReason}
            onChange={(e) => setOverlapReason(e.target.value)}
            required
            minLength={3}
            maxLength={300}
            data-testid={`act-overlap-${orderCode}`}
          />
        </label>
      )}
      <Button type="submit" data-testid={`act-confirm-${orderCode}`}>
        {t('confirm')}
      </Button>
      <Button type="button" variant="secondary" onClick={onCancel}>
        {t('cancel')}
      </Button>
    </form>
  );
}

function Estimates(props: TimingBoardProps) {
  const t = useTranslations('operations.dispatch.timing');
  const router = useRouter();
  const keys = Object.keys(props.estimates);
  const [key, setKey] = useState(keys[0] ?? '');
  const [stage, setStage] = useState<EstimateStage>('to_site');
  const [minutes, setMinutes] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <details className="rounded border border-rule p-3" data-testid="timing-estimates">
      <summary className="cursor-pointer font-semibold">{t('estimatesTitle')}</summary>
      <p className="my-2 text-sm text-muted">{t('estimatesIntro')}</p>
      <ul className="space-y-1 text-sm">
        {keys.map((k) => (
          <li key={k} className="row-item">
            <strong>{props.routeLabels[k] ?? k}</strong>:{' '}
            {ESTIMATE_STAGES.map((s) => (
              <span key={s} className="me-3">
                {t(`stage.${s}`)} <bdi dir="ltr">{props.estimates[k]![s].minutes} min</bdi> (
                {t(`source.${props.estimates[k]![s].source}`)})
              </span>
            ))}
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const [plantId, zoneId] = key.split('|');
          const r = await props.setEstimate({
            plantId: plantId!,
            zoneId: zoneId || null,
            stage,
            minutes: Number(minutes),
            reason,
          });
          setMsg(r.ok ? t('done') : t(`errors.${r.error}` as never));
          if (r.ok) router.refresh();
        }}
      >
        <Select value={key} onChange={(e) => setKey(e.target.value)} data-testid="estimate-route">
          {keys.map((k) => (
            <option key={k} value={k}>
              {props.routeLabels[k] ?? k}
            </option>
          ))}
        </Select>
        <Select
          value={stage}
          onChange={(e) => setStage(e.target.value as EstimateStage)}
          data-testid="estimate-stage"
        >
          {ESTIMATE_STAGES.map((s) => (
            <option key={s} value={s}>
              {t(`stage.${s}`)}
            </option>
          ))}
        </Select>
        <Input
          type="number"
          dir="ltr"
          min={0}
          max={720}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          placeholder={t('estimateMinutes')}
          required
          data-testid="estimate-minutes"
        />
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('reason')}
          required
          minLength={3}
          data-testid="estimate-reason"
        />
        <Button type="submit" data-testid="estimate-save">
          {t('estimateSave')}
        </Button>
        {msg && <span role="status">{msg}</span>}
      </form>
    </details>
  );
}

function Stats({ stats }: { stats: DelayStats }) {
  const t = useTranslations('operations.dispatch.timing');
  const empty = stats.byStep.every((s) => s.taps === 0) || stats.byStep.length === 0;
  const fmt = (n: number | null) => (n === null ? '—' : `${n > 0 ? '+' : ''}${n}`);
  return (
    <details className="rounded border border-rule p-3" data-testid="timing-stats">
      <summary className="cursor-pointer font-semibold">{t('statsTitle')}</summary>
      <p className="my-2 text-sm text-muted">{t('statsIntro')}</p>
      {empty ? (
        <p>{t('noStats')}</p>
      ) : (
        <div className="grid gap-4 text-sm md:grid-cols-2">
          <ul>
            <li className="font-semibold">{t('byStep')}</li>
            {stats.byStep.map((s) => (
              <li key={s.step} className="row-item">
                {s.step}: <bdi dir="ltr">{fmt(s.avgStageDelayMin)} min</bdi> · {t('taps', { n: s.taps })}
              </li>
            ))}
          </ul>
          <ul>
            <li className="font-semibold">{t('byRoute')}</li>
            {stats.byRoute.map((s) => (
              <li key={s.zone ?? '-'} className="row-item">
                {s.zone ?? '—'}: <bdi dir="ltr">{fmt(s.avgCumulativeDelayMin)} min</bdi> ·{' '}
                {t('taps', { n: s.taps })}
              </li>
            ))}
          </ul>
          <ul>
            <li className="font-semibold">{t('byDriver')}</li>
            {stats.byDriver.map((s) => (
              <li key={s.driverCode} className="row-item">
                {s.driverCode} · {s.driverName}: <bdi dir="ltr">{fmt(s.avgCumulativeDelayMin)} min</bdi> ·{' '}
                {t('taps', { n: s.taps })}
              </li>
            ))}
          </ul>
          <ul>
            <li className="font-semibold">{t('byDay')}</li>
            {stats.byDay.map((s) => (
              <li key={s.day} className="row-item">
                {s.day}: <bdi dir="ltr">{fmt(s.avgCumulativeDelayMin)} min</bdi> · {t('taps', { n: s.taps })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}
