'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { Effect } from '@/modules/ledger';
import { EffectsPanel } from '@/modules/ledger/ui/effects/effects-panel';
import { Button } from '@/ui';
import { clockText } from '../domain/dispatch';
import { TRIP_STEPS, type TripStep } from '../domain/trip-steps';
import type { TripView } from '../service/trip-service';
import { formatM3, ltr } from './format';

export type TripStepResult =
  | { ok: true; step: string; blNo: string | null; warnings: string[]; effects: Effect[] }
  | { ok: false; error: string };

/**
 * The day's rotations on a phone: one card each, the steps taken with their time, and one big button for the next step.
 * The first step is the load itself (the BL is made). Waiting time on site and the other figures are derived, shown when
 * the steps they need were taken.
 */
export function TripBoard({
  trips,
  canTrack,
  record,
}: {
  trips: TripView[];
  canTrack: boolean;
  record: (input: unknown) => Promise<TripStepResult>;
}) {
  const t = useTranslations('operations.trips');
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [effects, setEffects] = useState<Record<string, Effect[]>>({});

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
            className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-sm sm:grid-cols-3"
            data-testid="trip-steps"
          >
            {TRIP_STEPS.map((s) => (
              <li key={s} data-step={s} data-done={trip.events[s] ? 'true' : 'false'}>
                <span className={trip.events[s] ? 'font-semibold' : 'text-muted'}>
                  {t(`step.${s}` as never)}
                </span>{' '}
                <bdi dir="ltr">{trip.clock[s] ?? '—'}</bdi>
              </li>
            ))}
          </ol>

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
