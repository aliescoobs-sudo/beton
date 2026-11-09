'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { Effect } from '@/modules/ledger';
import { EffectsPanel } from '@/modules/ledger/ui/effects/effects-panel';
import { Button } from '@/ui';
import { clockText } from '../domain/dispatch';
import type { TripStep } from '../domain/trip-steps';
import type { TripView } from '../service/trip-service';
import { formatM3, ltr } from './format';

export type TripStepResult =
  | {
      ok: true;
      step: string;
      blNo: string | null;
      warnings: string[];
      effects: Effect[];
      /** False when the stage was already there: `by` is who recorded it and when. */
      recorded: boolean;
      by: { source: string; at: string; implicit: boolean; clock: string };
    }
  | { ok: false; error: string };

export interface CorrectInput {
  tripId: string;
  step: string;
  date: string;
  time: string;
  reason: string;
}

/**
 * The day's rotations on a phone: one card each, the steps taken with their time, and one big button for the next step.
 * The first step is the load itself (the BL is made). Waiting time on site and the other figures are derived, shown when
 * the steps they need were taken.
 */
export function TripBoard({
  trips,
  canTrack,
  canCorrect,
  date,
  record,
  correct,
  confirmDelivered,
  confirmStage,
}: {
  trips: TripView[];
  canTrack: boolean;
  canCorrect: boolean;
  date: string;
  record: (input: unknown) => Promise<TripStepResult>;
  correct: (input: CorrectInput) => Promise<{ ok: true } | { ok: false; error: string }>;
  confirmDelivered: (input: { tripId: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
  confirmStage: (input: {
    tripId: string;
    step: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const t = useTranslations('operations.trips');
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [effects, setEffects] = useState<Record<string, Effect[]>>({});
  // T9: the correction form open on one stage of one rotation
  const [fixing, setFixing] = useState<{ tripId: string; step: TripStep } | null>(null);
  const [fix, setFix] = useState({ time: '', reason: '' });

  async function tap(trip: TripView, step: TripStep) {
    setPending(trip.id);
    setMessages((m) => ({ ...m, [trip.id]: '' }));
    try {
      const result = await record({ tripId: trip.id, step });
      if (!result.ok) {
        setMessages((m) => ({ ...m, [trip.id]: t(`errors.${result.error}` as never) }));
        if (result.error === 'ALREADY_RECORDED' || result.error === 'OUT_OF_ORDER') router.refresh();
        return;
      }
      if (!result.recorded) {
        // the stage was already there (the driver's tap, or another screen): the answer is the existing record, nothing was changed
        setMessages((m) => ({
          ...m,
          [trip.id]: t('alreadyBy', {
            who: t(`by.${result.by.source}` as never),
            time: result.by.clock,
          }),
        }));
        router.refresh();
        return;
      }
      if (result.effects.length > 0) setEffects((e) => ({ ...e, [trip.id]: result.effects }));
      const warn = [
        result.warnings.includes('LONG_TRIP') ? t('longTrip') : '',
        result.warnings.includes('OVER_ORDER') ? t('overOrder') : '',
      ].filter(Boolean);
      setMessages((m) => ({
        ...m,
        [trip.id]: [result.blNo ? t('loadedAs', { bl: ltr(result.blNo) }) : '', ...warn]
          .filter(Boolean)
          .join(' · '),
      }));
      router.refresh();
    } catch {
      setMessages((m) => ({ ...m, [trip.id]: t('errors.INVALID') }));
    } finally {
      setPending(null);
    }
  }

  if (trips.length === 0)
    return (
      <p className="text-sm text-muted" data-testid="trips-none">
        {t('none')}
      </p>
    );

  return (
    <ol className="space-y-4" data-testid="trips-list">
      {trips.map((trip) => (
        <li
          key={trip.id}
          className="border border-rule bg-surface p-4"
          data-testid={`trip-${trip.orderCode}-${trip.plan.loadMin}-${trip.truckCode}`}
          data-next={trip.next ?? 'done'}
        >
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <strong className="text-lg">
              <bdi dir="ltr">{trip.truckCode}</bdi> · {trip.driverName ?? t('noDriver')}
            </strong>
            <span>
              <bdi dir="ltr">{trip.orderCode}</bdi> · <bdi dir="ltr">{trip.clientCode}</bdi> ·{' '}
              <bdi dir="ltr">{trip.typeLabel}</bdi>
            </span>
            <span>
              <bdi dir="ltr">{formatM3(trip.volumeL)} m³</bdi>
            </span>
          </div>
          <p className="text-sm text-muted">
            {[trip.siteLabel, trip.zoneName].filter(Boolean).join(' · ') || t('noZone')}
          </p>
          <p className="mt-1 text-sm" dir="ltr">
            {t('planned', {
              load: clockText(trip.plan.loadMin),
              depart: clockText(trip.plan.departMin),
              arrive: clockText(trip.plan.arriveMin),
              back: clockText(trip.plan.backMin),
            })}
          </p>

          <ol
            className="mt-3 grid grid-cols-1 gap-x-3 gap-y-1 text-sm sm:grid-cols-2"
            data-testid="trip-steps"
          >
            {trip.stages.map((st) => (
              <li
                key={st.stage}
                data-step={st.stage}
                data-done={st.done ? 'true' : 'false'}
                data-source={st.source ?? ''}
                data-implicit={st.implicit ? 'true' : 'false'}
                className="flex flex-wrap items-center gap-x-1"
              >
                <span className={st.done ? 'font-semibold' : 'text-muted'}>
                  {t(`step.${st.stage}` as never)}
                </span>{' '}
                <bdi dir="ltr">{trip.clock[st.stage] ?? '—'}</bdi>
                {st.source && (
                  <span className="text-muted" data-testid={`stage-by-${trip.orderCode}-${st.stage}`}>
                    {' · '}
                    {t(`by.${st.source}` as never)}
                    {st.implicit ? ` · ${t('implicit')}` : ''}
                    {st.corrected ? ` · ${t('corrected')}` : ''}
                    {st.stage === 'loaded' && st.declared && !st.implicit ? ` · ${t('declared')}` : ''}
                    {st.stage === 'unloading_finished' && st.source === 'driver' && !st.implicit
                      ? ` · ${t('declaredDelivery')}`
                      : ''}
                    {st.awaiting ? ` · ${t('awaiting')}` : ''}
                    {st.fallback ? ` · ${t('fallback')}` : ''}
                  </span>
                )}
                {canTrack && st.awaiting && (
                  <button
                    type="button"
                    className="min-h-11 min-w-11 px-2 text-xs font-semibold underline"
                    onClick={() =>
                      void (async () => {
                        const r = await confirmStage({ tripId: trip.id, step: st.stage });
                        setMessages((m) => ({
                          ...m,
                          [trip.id]: r.ok ? t('stageConfirmed') : t(`errors.${r.error}` as never),
                        }));
                        if (r.ok) router.refresh();
                      })()
                    }
                    data-testid={`confirm-stage-${trip.orderCode}-${st.stage}`}
                  >
                    {t('confirmStage')}
                  </button>
                )}
                {canCorrect && st.done && (
                  <button
                    type="button"
                    className="min-h-11 min-w-11 px-2 text-xs underline"
                    onClick={() => {
                      setFixing({ tripId: trip.id, step: st.stage });
                      setFix({ time: trip.clock[st.stage] ?? '', reason: '' });
                    }}
                    data-testid={`correct-${trip.orderCode}-${st.stage}`}
                  >
                    {t('correct.open')}
                  </button>
                )}
              </li>
            ))}
          </ol>
          {fixing?.tripId === trip.id && (
            <form
              className="mt-2 flex flex-wrap items-end gap-2 border border-rule p-2"
              data-testid={`correct-form-${trip.orderCode}`}
              onSubmit={(e) => {
                e.preventDefault();
                void (async () => {
                  const r = await correct({
                    tripId: trip.id,
                    step: fixing.step,
                    date,
                    time: fix.time,
                    reason: fix.reason,
                  });
                  setMessages((m) => ({
                    ...m,
                    [trip.id]: r.ok ? t('correct.done') : t(`errors.${r.error}` as never),
                  }));
                  if (r.ok) {
                    setFixing(null);
                    router.refresh();
                  }
                })();
              }}
            >
              <label className="block text-sm">
                <span className="field-label">
                  {t('correct.time')} · {t(`step.${fixing.step}` as never)}
                </span>
                <input
                  type="time"
                  required
                  className="min-h-11 border border-rule px-2"
                  value={fix.time}
                  onChange={(e) => setFix((f) => ({ ...f, time: e.target.value }))}
                  dir="ltr"
                  data-testid={`correct-time-${trip.orderCode}`}
                />
              </label>
              <label className="block flex-1 text-sm">
                <span className="field-label">{t('correct.reason')}</span>
                <input
                  type="text"
                  required
                  minLength={3}
                  maxLength={500}
                  className="min-h-11 w-full border border-rule px-2"
                  value={fix.reason}
                  onChange={(e) => setFix((f) => ({ ...f, reason: e.target.value }))}
                  data-testid={`correct-reason-${trip.orderCode}`}
                />
              </label>
              <Button type="submit" className="min-h-11" data-testid={`correct-save-${trip.orderCode}`}>
                {t('correct.save')}
              </Button>
              <Button type="button" variant="secondary" className="min-h-11" onClick={() => setFixing(null)}>
                {t('correct.cancel')}
              </Button>
            </form>
          )}

          <ul className="mt-2 text-sm" data-testid="trip-times">
            {trip.blNo && (
              <li>
                {t('bl')} <bdi dir="ltr">{trip.blNo}</bdi>
              </li>
            )}
            {trip.times.waitingOnSiteMin !== null && (
              <li data-testid="trip-waiting">
                {t('waiting')} <bdi dir="ltr">{trip.times.waitingOnSiteMin} min</bdi>
              </li>
            )}
            {trip.times.unloadingMin !== null && (
              <li>
                {t('unloading')} <bdi dir="ltr">{trip.times.unloadingMin} min</bdi>
              </li>
            )}
            {trip.times.roundTripMin !== null && (
              <li>
                {t('roundTrip')} <bdi dir="ltr">{trip.times.roundTripMin} min</bdi>
              </li>
            )}
            {trip.times.concreteAgeMin !== null && (
              <li>
                {t('concreteAge')} <bdi dir="ltr">{trip.times.concreteAgeMin} min</bdi>
              </li>
            )}
            {trip.times.departDelayMin !== null && (
              <li>
                {t('departDelay')}{' '}
                <bdi dir="ltr">
                  {trip.times.departDelayMin > 0 ? '+' : ''}
                  {trip.times.departDelayMin} min
                </bdi>
              </li>
            )}
          </ul>

          {canTrack &&
            !trip.delivered &&
            trip.stages.some((x) => x.stage === 'unloading_finished' && x.done) &&
            trip.stages.some((x) => x.stage === 'loaded' && x.done && !x.declared) && (
              <Button
                className="mt-3 min-h-11 w-full"
                variant="secondary"
                onClick={() =>
                  void (async () => {
                    const r = await confirmDelivered({ tripId: trip.id });
                    setMessages((m) => ({
                      ...m,
                      [trip.id]: r.ok ? t('deliveredConfirmed') : t(`errors.${r.error}` as never),
                    }));
                    if (r.ok) router.refresh();
                  })()
                }
                data-testid={`confirm-delivered-${trip.orderCode}`}
              >
                {t('confirmDelivered')}
              </Button>
            )}
          {canTrack && trip.stages.some((x) => x.stage === 'loaded' && x.done && x.declared) && (
            <Button
              className="mt-3 min-h-11 w-full"
              variant="secondary"
              disabled={pending === trip.id}
              onClick={() => void tap(trip, 'loaded')}
              data-testid={`make-load-${trip.orderCode}`}
            >
              {t('do.loaded')}
            </Button>
          )}
          {canTrack && trip.next && (
            <Button
              className="mt-3 min-h-14 w-full text-lg"
              disabled={pending === trip.id}
              onClick={() => void tap(trip, trip.next as TripStep)}
              data-testid={`trip-next-${trip.orderCode}-${trip.plan.loadMin}-${trip.truckCode}`}
            >
              {t(`do.${trip.next}` as never)}
            </Button>
          )}
          {!trip.next && <p className="mt-3 text-sm font-semibold">{t('finished')}</p>}
          {messages[trip.id] && (
            <p role="status" className="mt-2 text-sm" data-testid={`trip-message-${trip.orderCode}`}>
              {messages[trip.id]}
            </p>
          )}
          {effects[trip.id] && (
            <EffectsPanel effects={effects[trip.id] as Effect[]} testId={`trip-effects-${trip.orderCode}`} />
          )}
        </li>
      ))}
    </ol>
  );
}
