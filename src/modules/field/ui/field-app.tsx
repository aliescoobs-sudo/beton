'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { PushSetup } from '@/modules/platform-security/ui/push-setup';
import {
  applyOutcomes,
  EMERGENCY_OPTIONS,
  enqueue,
  mustWipeForAccount,
  newKey,
  nextDriverTap,
  nextPumpStep,
  readStoredDay,
  readStoredQueue,
  wrapDay,
  type QueueAction,
  type SyncOutcome,
} from '../domain/index-client';
import { DAY_KEY, forgetAll, forgetRead, QUEUE_KEY } from './offline-store';
import { dropPhoto, queuedPhotos, queuePhoto, sendPhoto, shrinkPhoto } from './photo-queue';

// The phone app. One big button per step, an emergency button that is always there, large text. Every tap is queued with the
// phone's own time and sent when there is a network; the last day read is kept for the road. No price exists in anything it gets.

const DEVICE_KEY = 'bb_field_device';

/**
 * F07: the site address is shown as text with a copy button; nothing is sent to a third party. The external map link only
 * exists when the operator switched MAP_LINKS_ENABLED on (the server then sends mapUrl), and it is never on in training.
 */
function AddressBlock({
  address,
  mapUrl,
  t,
}: {
  address: string | null;
  mapUrl: string | null;
  t: (key: string) => string;
}) {
  const [copied, setCopied] = useState(false);
  if (!address && !mapUrl) return null;
  const copy = () => {
    if (!address) return;
    void navigator.clipboard?.writeText(address).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  };
  return (
    <div className="space-y-2">
      {address && <p className="text-2xl">{address}</p>}
      {address && (
        <button
          type="button"
          onClick={copy}
          className="rounded-xl border-2 border-rule px-4 py-3 text-xl font-bold"
          data-testid="copy-address"
        >
          {copied ? t('addressCopied') : t('copyAddress')}
        </button>
      )}
      {mapUrl && (
        <a href={mapUrl} target="_blank" rel="noreferrer" className="block text-2xl underline">
          {t('openMap')}
        </a>
      )}
    </div>
  );
}

interface Trip {
  id: string;
  seq: number;
  orderCode: string;
  typeLabel: string;
  volumeL: number;
  clientName: string;
  contactName: string | null;
  phone: string | null;
  siteLabel: string | null;
  address: string | null;
  mapUrl: string | null;
  truckCode: string;
  blNo: string | null;
  loadingStartedAt: string | null;
  steps: Record<string, string>;
  stage: keyof typeof EMERGENCY_OPTIONS;
  unloadedL: number | null;
  blPhotos?: number;
}
interface Instruction {
  id: string;
  tripId: string;
  kind: 'continue' | 'extra_load' | 'redirect' | 'join';
  address: string | null;
  mapUrl: string | null;
  note: string | null;
  joinTruckCode: string | null;
  acknowledgedAt: string | null;
}
interface PumpJob {
  id: string;
  pumpCode: string;
  clientName: string | null;
  siteLabel: string;
  address: string | null;
  mapUrl: string | null;
  plannedM3: number | null;
  steps: string[];
  m3Pumped: number | null;
}
type Day =
  | { kind: 'driver'; userId: string; date: string; trips: Trip[]; instructions: Instruction[] }
  | { kind: 'pump_operator'; userId: string; date: string; jobs: PumpJob[] };

const deviceId = (): string => {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `${newKey()}${newKey()}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
};
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

export function FieldApp({ locale }: { locale: string }) {
  const t = useTranslations('field');
  const [session, setSession] = useState<'unknown' | 'out' | 'in'>('unknown');
  const [day, setDay] = useState<Day | null>(null);
  const [queue, setQueue] = useState<QueueAction[]>([]);
  const [online, setOnline] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ tripId: string } | null>(null);
  const [asking, setAsking] = useState<{ tripId: string } | null>(null);
  // Photos of signed BLs waiting on the phone (by rotation) and the last refusal told to the driver.
  const [photosWaiting, setPhotosWaiting] = useState<Record<string, number>>({});
  const syncing = useRef(false);
  const flushing = useRef(false);
  const queueRef = useRef<QueueAction[]>([]);
  // The account the phone's local work belongs to (F02): the taps and the photos are sent by that account only.
  const ownerRef = useRef<string | null>(null);

  const saveQueue = useCallback((q: QueueAction[]) => {
    queueRef.current = q;
    setQueue(q);
    if (ownerRef.current)
      localStorage.setItem(QUEUE_KEY, JSON.stringify({ userId: ownerRef.current, actions: q }));
  }, []);

  // The server refused this phone's session (expired, revoked, device released): nothing that names a client stays on screen or on the
  // phone. The work waiting to be sent stays, tied to its account, and goes out after that account signs in again.
  const refused = useCallback(async () => {
    await forgetRead();
    setDay(null);
    setSession('out');
  }, []);

  const loadDay = useCallback(async () => {
    try {
      const res = await fetch('/api/field/session', { cache: 'no-store' });
      if (res.status === 401) return await refused();
      if (!res.ok) throw new Error('bad');
      const data = (await res.json()) as Day;
      // Another account on this phone: its day, its taps and its photos are erased before this account sees anything of them.
      const photos = await queuedPhotos().catch(() => []);
      const holders = [
        readStoredDay<Day>(localStorage.getItem(DAY_KEY), Date.now())?.userId,
        ownerRef.current,
        ...photos.map((p) => p.userId),
      ];
      if (mustWipeForAccount(data.userId, holders)) {
        await forgetAll();
        saveQueue([]);
        setPhotosWaiting({});
      }
      ownerRef.current = data.userId;
      localStorage.setItem(DAY_KEY, JSON.stringify(wrapDay(data.userId, data, Date.now())));
      localStorage.setItem(QUEUE_KEY, JSON.stringify({ userId: data.userId, actions: queueRef.current }));
      setDay(data);
      setSession('in');
      setOnline(true);
    } catch {
      // No network: the last day read stays on screen, for the account that read it and for a limited time only.
      const kept = readStoredDay<Day>(localStorage.getItem(DAY_KEY), Date.now());
      if (kept) {
        ownerRef.current = kept.userId;
        setDay(kept.day);
        setSession('in');
      } else {
        await forgetRead();
        setDay(null);
        setSession('out');
      }
      setOnline(false);
    }
  }, [refused, saveQueue]);

  const sync = useCallback(async () => {
    if (syncing.current || queueRef.current.length === 0) return;
    syncing.current = true;
    try {
      const res = await fetch('/api/field/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actions: queueRef.current }),
      });
      if (res.status === 401) return await refused(); // the queue stays: it is sent after the next sign-in
      if (!res.ok) return;
      const { outcomes } = (await res.json()) as { outcomes: SyncOutcome[] };
      saveQueue(applyOutcomes(queueRef.current, outcomes));
      setOnline(true);
      await loadDay();
    } catch {
      setOnline(false);
    } finally {
      syncing.current = false;
    }
  }, [loadDay, saveQueue, refused]);

  // Sends the waiting photos one by one. The server answers for each: stored, try again later, or refused for good.
  const flushPhotos = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      const all = (await queuedPhotos().catch(() => [])).filter((p) => p.userId === ownerRef.current);
      for (const p of all) {
        const verdict = await sendPhoto(p);
        if (verdict === 'retry') break;
        await dropPhoto(p.key);
        if (verdict === 'drop') setMessage(t('photo.refused'));
      }
      const rest = (await queuedPhotos().catch(() => [])).filter((p) => p.userId === ownerRef.current);
      setPhotosWaiting(
        rest.reduce<Record<string, number>>((m, p) => ({ ...m, [p.tripId]: (m[p.tripId] ?? 0) + 1 }), {}),
      );
      if (all.length > rest.length) await loadDay();
    } finally {
      flushing.current = false;
    }
  }, [loadDay, t]);

  async function takePhoto(trip: Trip, file: File | undefined) {
    if (!file) return;
    try {
      const blob = await shrinkPhoto(file);
      if (!ownerRef.current) throw new Error('no account');
      await queuePhoto({
        key: newKey(),
        tripId: trip.id,
        takenAt: new Date().toISOString(),
        blob,
        userId: ownerRef.current,
      });
    } catch {
      return setMessage(t('photo.refused'));
    }
    await flushPhotos();
  }

  useEffect(() => {
    if ('serviceWorker' in navigator)
      void navigator.serviceWorker.register('/driver-sw.js').catch(() => undefined);
    // The stored queue is read after mount (localStorage does not exist on the server), then the day and the sync follow.
    void Promise.resolve()
      .then(() => {
        const kept = readStoredQueue<QueueAction>(localStorage.getItem(QUEUE_KEY));
        ownerRef.current = kept?.userId ?? null;
        saveQueue(kept?.actions ?? []);
      })
      .then(() => loadDay())
      .then(() => sync())
      .then(() => flushPhotos());
    const up = () => {
      setOnline(true);
      void sync();
      void flushPhotos();
    };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    const timer = setInterval(() => {
      void sync();
      void flushPhotos();
    }, 20_000);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      clearInterval(timer);
    };
  }, [loadDay, saveQueue, sync, flushPhotos]);

  function push(action: QueueAction) {
    saveQueue(enqueue(queueRef.current, action));
    void sync();
  }

  // The tap shows at once: the local copy of the day takes the step, the server confirms (or corrects) on the next sync.
  function applyLocal(update: (d: Day) => Day) {
    setDay((d) => {
      if (!d) return d;
      const next = update(d);
      if (ownerRef.current)
        localStorage.setItem(DAY_KEY, JSON.stringify(wrapDay(ownerRef.current, next, Date.now())));
      return next;
    });
  }

  function tapStep(trip: Trip, step: string, volumeL?: number) {
    const at = new Date().toISOString();
    push({ kind: 'step', key: newKey(), tripId: trip.id, step, at, ...(volumeL ? { volumeL } : {}) });
    applyLocal((d) =>
      d.kind !== 'driver'
        ? d
        : {
            ...d,
            trips: d.trips.map((x) =>
              x.id !== trip.id
                ? x
                : step === 'loading_started'
                  ? { ...x, loadingStartedAt: at }
                  : { ...x, steps: { ...x.steps, [step]: at }, unloadedL: volumeL ?? x.unloadedL },
            ),
          },
    );
  }

  function tapPump(job: PumpJob, step: string, m3?: number) {
    push({
      kind: 'pump',
      key: newKey(),
      jobId: job.id,
      step,
      at: new Date().toISOString(),
      ...(m3 ? { m3 } : {}),
    });
    applyLocal((d) =>
      d.kind !== 'pump_operator'
        ? d
        : {
            ...d,
            jobs: d.jobs.map((j) =>
              j.id === job.id ? { ...j, steps: [...j.steps, step], m3Pumped: m3 ?? j.m3Pumped } : j,
            ),
          },
    );
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setMessage(null);
    const res = await fetch('/api/field/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: form.get('code'),
        pin: form.get('pin'),
        deviceId: deviceId(),
        deviceLabel: navigator.userAgent.slice(0, 60),
      }),
    }).catch(() => null);
    if (!res) return setMessage(t('errors.network'));
    if (res.ok) {
      await loadDay();
      return void sync();
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setMessage(
      t(`errors.${body.error === 'LOCKED' || body.error === 'OTHER_DEVICE' ? body.error : 'WRONG'}` as never),
    );
  }

  async function signOut() {
    // What can still be sent goes first; what cannot is told to the driver, because signing out erases it with the rest.
    await sync();
    await flushPhotos();
    const photos = (await queuedPhotos().catch(() => [])).filter((x) => x.userId === ownerRef.current);
    const waiting = queueRef.current.length + photos.length;
    if (waiting > 0 && !window.confirm(t('signOutPending', { count: waiting }))) return;
    await fetch('/api/field/logout', { method: 'POST' }).catch(() => null);
    await forgetAll();
    ownerRef.current = null;
    saveQueue([]);
    setPhotosWaiting({});
    setDay(null);
    setSession('out');
  }

  const big = 'w-full rounded-2xl px-4 py-6 text-3xl font-extrabold leading-tight';

  if (session === 'unknown') return <main className="p-6 text-2xl">…</main>;

  if (session === 'out') {
    return (
      <main
        className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6"
        data-testid="field-login"
      >
        <h1 className="text-4xl font-extrabold">{t('title')}</h1>
        <form onSubmit={(e) => void login(e)} className="space-y-4">
          <label className="block text-2xl">
            {t('code')}
            <input
              name="code"
              required
              autoCapitalize="characters"
              dir="ltr"
              className="input mt-2 w-full text-3xl"
              data-testid="field-code"
            />
          </label>
          <label className="block text-2xl">
            {t('pin')}
            <input
              name="pin"
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              required
              dir="ltr"
              className="input mt-2 w-full text-3xl"
              data-testid="field-pin"
            />
          </label>
          {message && (
            <p role="alert" className="text-2xl text-signal" data-testid="field-error">
              {message}
            </p>
          )}
          <button type="submit" className={`${big} bg-ink text-white`} data-testid="field-signin">
            {t('signIn')}
          </button>
        </form>
        {queue.length > 0 && <p className="text-xl">{t('queued', { count: queue.length })}</p>}
      </main>
    );
  }

  const pending = queue.length;
  return (
    <main className="mx-auto max-w-md space-y-5 p-4 pb-40" data-testid="field-day" lang={locale}>
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-3xl font-extrabold">{t('title')}</h1>
        <button
          type="button"
          onClick={() => void signOut()}
          className="text-xl underline"
          data-testid="field-signout"
        >
          {t('signOut')}
        </button>
      </header>
      <PushSetup
        publicKey={null}
        keyUrl="/api/field/push"
        workerUrl="/driver-sw.js"
        subscribeUrl="/api/field/push"
        labels={{
          enable: t('push.enable'),
          enabled: t('push.enabled'),
          unsupported: t('push.unsupported'),
          denied: t('push.denied'),
          unavailable: t('push.unavailable'),
        }}
      />
      {!online && (
        <p
          role="status"
          className="rounded-xl bg-amber-200 p-3 text-2xl text-black"
          data-testid="field-offline"
        >
          {t('offline')}
        </p>
      )}
      {pending > 0 && (
        <p role="status" className="text-2xl" data-testid="field-queued">
          {t('queued', { count: pending })}
        </p>
      )}

      {day?.kind === 'driver' && (
        <>
          {day.instructions
            .filter(
              (i) => !i.acknowledgedAt && !queue.some((q) => q.kind === 'ack' && q.instructionId === i.id),
            )
            .map((i) => (
              <section
                key={i.id}
                className="space-y-3 rounded-2xl border-4 border-signal p-4"
                data-testid={`instruction-${i.kind}`}
              >
                <h2 className="text-3xl font-extrabold">{t(`instruction.${i.kind}`)}</h2>
                {i.note && <p className="text-2xl">{i.note}</p>}
                <AddressBlock address={i.address} mapUrl={i.mapUrl} t={t} />
                {i.joinTruckCode && (
                  <p className="text-2xl">{t('instruction.joinTruck', { code: i.joinTruckCode })}</p>
                )}
                <button
                  type="button"
                  className={`${big} bg-ink text-white`}
                  onClick={() =>
                    push({ kind: 'ack', key: newKey(), instructionId: i.id, at: new Date().toISOString() })
                  }
                  data-testid="instruction-ack"
                >
                  {t('acknowledge')}
                </button>
              </section>
            ))}
          {day.trips.length === 0 && (
            <p className="text-2xl" data-testid="field-none">
              {t('noTrips')}
            </p>
          )}
          {day.trips.map((trip) => {
            const next = nextDriverTap({ loadingStartedAt: trip.loadingStartedAt, steps: trip.steps });
            return (
              <section
                key={trip.id}
                className="space-y-3 rounded-2xl border-2 border-rule p-4"
                data-testid={`trip-${trip.orderCode}`}
              >
                <h2 className="text-3xl font-extrabold">
                  <bdi dir="ltr">{trip.orderCode}</bdi> · {trip.typeLabel}
                </h2>
                <p className="text-2xl">
                  {trip.clientName} · <bdi dir="ltr">{(trip.volumeL / 1000).toLocaleString('fr-FR')} m³</bdi>
                </p>
                {trip.siteLabel && <p className="text-2xl">{trip.siteLabel}</p>}
                <AddressBlock address={trip.address} mapUrl={trip.mapUrl} t={t} />
                {trip.phone && (
                  <a href={`tel:${trip.phone}`} className="block text-2xl underline">
                    {trip.contactName ? `${trip.contactName} · ` : ''}
                    <bdi dir="ltr">{trip.phone}</bdi>
                  </a>
                )}
                <p className="text-xl">
                  <bdi dir="ltr">{trip.truckCode}</bdi>
                  {trip.blNo && (
                    <>
                      {' '}
                      · BL <bdi dir="ltr">{trip.blNo}</bdi>
                    </>
                  )}
                </p>
                <ol className="space-y-1 text-xl">
                  {(
                    [
                      'loading_started',
                      'departed',
                      'arrived',
                      'unloading_started',
                      'unloading_finished',
                      'back',
                    ] as const
                  ).map((s) => {
                    const at = s === 'loading_started' ? trip.loadingStartedAt : trip.steps[s];
                    return (
                      <li key={s} className={at ? 'font-bold' : 'text-muted'}>
                        {at ? '✓' : '○'} {t(`steps.${s}`)} {at && <bdi dir="ltr">{hhmm(at)}</bdi>}
                        {s === 'unloading_finished' && trip.unloadedL ? (
                          <>
                            {' '}
                            · <bdi dir="ltr">{(trip.unloadedL / 1000).toLocaleString('fr-FR')} m³</bdi>
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
                {trip.unloadedL ? (
                  <div className="space-y-1" data-testid={`photo-${trip.orderCode}`}>
                    <label className="block w-full cursor-pointer rounded-2xl border-4 border-ink px-4 py-4 text-center text-2xl font-extrabold">
                      📷 {t('photo.take')}
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="sr-only"
                        data-testid={`photo-input-${trip.orderCode}`}
                        onChange={(e) => {
                          void takePhoto(trip, e.target.files?.[0]);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    {(trip.blPhotos ?? 0) > 0 && (
                      <p className="text-xl font-bold" data-testid={`photo-sent-${trip.orderCode}`}>
                        ✓ {t('photo.sent', { n: trip.blPhotos ?? 0 })}
                      </p>
                    )}
                    {(photosWaiting[trip.id] ?? 0) > 0 && (
                      <p className="text-xl" data-testid={`photo-waiting-${trip.orderCode}`}>
                        ⏳ {t('photo.waiting', { n: photosWaiting[trip.id] ?? 0 })}
                      </p>
                    )}
                  </div>
                ) : null}
                {next === null ? (
                  <p className="text-2xl font-extrabold" data-testid={`trip-done-${trip.orderCode}`}>
                    {t('idle')}
                  </p>
                ) : 'wait' in next ? (
                  <p
                    className="rounded-xl bg-amber-200 p-3 text-2xl text-black"
                    data-testid={`trip-wait-${trip.orderCode}`}
                  >
                    {t('waitLoad')}
                  </p>
                ) : next.step === 'unloading_finished' ? (
                  <button
                    type="button"
                    className={`${big} bg-signal text-white`}
                    onClick={() => setAsking({ tripId: trip.id })}
                    data-testid={`tap-${trip.orderCode}`}
                  >
                    {t(`steps.${next.step}`)}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`${big} bg-signal text-white`}
                    onClick={() => tapStep(trip, next.step)}
                    data-testid={`tap-${trip.orderCode}`}
                  >
                    {t(`steps.${next.step}`)}
                  </button>
                )}
                <button
                  type="button"
                  className="w-full rounded-2xl border-4 border-red-700 px-4 py-4 text-2xl font-extrabold text-red-700"
                  onClick={() => setSheet({ tripId: trip.id })}
                  data-testid={`emergency-${trip.orderCode}`}
                >
                  ⚠ {t('emergency')}
                </button>
              </section>
            );
          })}
        </>
      )}

      {day?.kind === 'pump_operator' && (
        <>
          {day.jobs.length === 0 && (
            <p className="text-2xl" data-testid="field-none">
              {t('noTrips')}
            </p>
          )}
          {day.jobs.map((job) => {
            const next = nextPumpStep(job.steps);
            return (
              <section
                key={job.id}
                className="space-y-3 rounded-2xl border-2 border-rule p-4"
                data-testid={`pump-${job.siteLabel}`}
              >
                <h2 className="text-3xl font-extrabold">{job.siteLabel}</h2>
                {job.clientName && <p className="text-2xl">{job.clientName}</p>}
                <AddressBlock address={job.address} mapUrl={job.mapUrl} t={t} />
                {job.plannedM3 && <p className="text-xl">{t('plannedM3', { m3: job.plannedM3 })}</p>}
                <ol className="space-y-1 text-xl">
                  {(['arrived', 'set_up', 'pumping_started', 'pumping_ended', 'left'] as const).map((s) => (
                    <li key={s} className={job.steps.includes(s) ? 'font-bold' : 'text-muted'}>
                      {job.steps.includes(s) ? '✓' : '○'} {t(`pump.${s}`)}
                      {s === 'pumping_ended' && job.m3Pumped ? (
                        <>
                          {' '}
                          · <bdi dir="ltr">{job.m3Pumped} m³</bdi>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ol>
                {next === null ? (
                  <p className="text-2xl font-extrabold">{t('idle')}</p>
                ) : next === 'pumping_ended' ? (
                  <PumpEnd
                    label={t(`pump.${next}`)}
                    ask={t('pumpedAsk')}
                    ok={t('confirm')}
                    onDone={(m3) => tapPump(job, next, m3)}
                    testId={`pump-tap-${job.siteLabel}`}
                  />
                ) : (
                  <button
                    type="button"
                    className={`${big} bg-signal text-white`}
                    onClick={() => tapPump(job, next)}
                    data-testid={`pump-tap-${job.siteLabel}`}
                  >
                    {t(`pump.${next}`)}
                  </button>
                )}
              </section>
            );
          })}
        </>
      )}

      {asking && day?.kind === 'driver' && (
        <Sheet title={t('unloadedAsk')} onClose={() => setAsking(null)} closeLabel={t('cancel')}>
          <UnloadedForm
            ok={t('confirm')}
            invalid={t('errors.volume')}
            onDone={(litres) => {
              const trip = day.trips.find((x) => x.id === asking.tripId);
              if (trip) tapStep(trip, 'unloading_finished', litres);
              setAsking(null);
            }}
          />
        </Sheet>
      )}

      {sheet && day?.kind === 'driver' && (
        <EmergencySheet
          trip={day.trips.find((x) => x.id === sheet.tripId)!}
          onClose={() => setSheet(null)}
          onSend={(option, pct) => {
            push({
              kind: 'emergency',
              key: newKey(),
              tripId: sheet.tripId,
              option,
              at: new Date().toISOString(),
              ...(pct !== null ? { pctUnloaded: pct } : {}),
            });
            setSheet(null);
            setMessage(t('emergencySent'));
          }}
        />
      )}
      {message && session === 'in' && (
        <p role="status" className="text-2xl" data-testid="field-message">
          {message}
        </p>
      )}
    </main>
  );
}

function Sheet({
  title,
  children,
  onClose,
  closeLabel,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  closeLabel: string;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-end bg-black/60"
      data-testid="field-sheet"
    >
      <div className="max-h-[90dvh] w-full space-y-4 overflow-y-auto rounded-t-3xl bg-white p-5 text-black">
        <h2 className="text-3xl font-extrabold">{title}</h2>
        {children}
        <button
          type="button"
          className="w-full rounded-2xl border-2 border-black px-4 py-4 text-2xl"
          onClick={onClose}
        >
          {closeLabel}
        </button>
      </div>
    </div>
  );
}

function UnloadedForm({
  ok,
  invalid,
  onDone,
}: {
  ok: string;
  invalid: string;
  onDone: (litres: number) => void;
}) {
  const [error, setError] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const text = String(new FormData(e.currentTarget).get('m3') ?? '')
          .replace(',', '.')
          .trim();
        const m3 = Number(text);
        if (!/^\d{1,3}(\.\d{1,3})?$/.test(text) || !(m3 > 0)) return setError(true);
        onDone(Math.round(m3 * 1000));
      }}
      className="space-y-3"
    >
      <input
        name="m3"
        inputMode="decimal"
        dir="ltr"
        autoFocus
        className="input w-full text-4xl"
        data-testid="field-m3"
      />
      {error && (
        <p role="alert" className="text-2xl text-signal">
          {invalid}
        </p>
      )}
      <button
        type="submit"
        className="w-full rounded-2xl bg-ink px-4 py-5 text-3xl font-extrabold text-white"
        data-testid="field-m3-ok"
      >
        {ok}
      </button>
    </form>
  );
}

function PumpEnd({
  label,
  ask,
  ok,
  onDone,
  testId,
}: {
  label: string;
  ask: string;
  ok: string;
  onDone: (m3: number) => void;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button
        type="button"
        className="w-full rounded-2xl bg-signal px-4 py-6 text-3xl font-extrabold text-white"
        onClick={() => setOpen(true)}
        data-testid={testId}
      >
        {label}
      </button>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const m3 = Number(new FormData(e.currentTarget).get('m3'));
        if (Number.isInteger(m3) && m3 > 0 && m3 <= 500) onDone(m3);
      }}
      className="space-y-3"
    >
      <label className="block text-2xl">
        {ask}
        <input
          name="m3"
          inputMode="numeric"
          dir="ltr"
          className="input mt-2 w-full text-4xl"
          data-testid="pump-m3"
        />
      </label>
      <button
        type="submit"
        className="w-full rounded-2xl bg-ink px-4 py-5 text-3xl font-extrabold text-white"
        data-testid="pump-m3-ok"
      >
        {ok}
      </button>
    </form>
  );
}

function EmergencySheet({
  trip,
  onClose,
  onSend,
}: {
  trip: Trip;
  onClose: () => void;
  onSend: (option: string, pct: number | null) => void;
}) {
  const t = useTranslations('field');
  const options = EMERGENCY_OPTIONS[trip.stage];
  const [pct, setPct] = useState(50);
  const unloading = trip.stage === 'unloading_started';
  return (
    <Sheet title={t('emergencyTitle')} onClose={onClose} closeLabel={t('cancel')}>
      {unloading && (
        <label className="block text-2xl">
          {t('pctUnloaded', { pct })}
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={pct}
            onChange={(e) => setPct(Number(e.target.value))}
            className="mt-2 w-full"
            data-testid="field-pct"
          />
        </label>
      )}
      <ul className="space-y-3">
        {options.map((o) => (
          <li key={o}>
            <button
              type="button"
              className="w-full rounded-2xl border-4 border-red-700 px-4 py-5 text-2xl font-extrabold text-red-700"
              onClick={() => onSend(o, unloading ? pct : null)}
              data-testid={`emergency-option-${o}`}
            >
              {t(`options.${o}` as never)}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
