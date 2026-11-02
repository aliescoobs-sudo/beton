'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  applyOutcomes,
  EMERGENCY_OPTIONS,
  enqueue,
  newKey,
  nextDriverTap,
  nextPumpStep,
  parseQueue,
  type QueueAction,
  type SyncOutcome,
} from '../domain/index-client';

// The phone app. One big button per step, an emergency button that is always there, large text. Every tap is queued with the
// phone's own time and sent when there is a network; the last day read is kept for the road. No price exists in anything it gets.

const QUEUE_KEY = 'bb_field_queue';
const DAY_KEY = 'bb_field_day';
const DEVICE_KEY = 'bb_field_device';

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
  | { kind: 'driver'; date: string; trips: Trip[]; instructions: Instruction[] }
  | { kind: 'pump_operator'; date: string; jobs: PumpJob[] };

const read = <T,>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};
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
  const syncing = useRef(false);
  const queueRef = useRef<QueueAction[]>([]);

  const saveQueue = useCallback((q: QueueAction[]) => {
    queueRef.current = q;
    setQueue(q);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  }, []);

  const loadDay = useCallback(async () => {
    try {
      const res = await fetch('/api/field/session', { cache: 'no-store' });
      if (res.status === 401) return setSession('out');
      if (!res.ok) throw new Error('bad');
      const data = (await res.json()) as Day;
      localStorage.setItem(DAY_KEY, JSON.stringify(data));
      setDay(data);
      setSession('in');
      setOnline(true);
    } catch {
      // No network: the last day read stays on screen.
      const cached = read<Day>(DAY_KEY);
      if (cached) {
        setDay(cached);
        setSession('in');
      } else setSession('out');
      setOnline(false);
    }
  }, []);

  const sync = useCallback(async () => {
    if (syncing.current || queueRef.current.length === 0) return;
    syncing.current = true;
    try {
      const res = await fetch('/api/field/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actions: queueRef.current }),
      });
      if (res.status === 401) return setSession('out'); // the queue stays: it is sent after the next sign-in
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
  }, [loadDay, saveQueue]);

  useEffect(() => {
    if ('serviceWorker' in navigator)
      void navigator.serviceWorker.register('/driver-sw.js').catch(() => undefined);
    // The stored queue is read after mount (localStorage does not exist on the server), then the day and the sync follow.
    void Promise.resolve()
      .then(() => saveQueue(parseQueue(localStorage.getItem(QUEUE_KEY))))
      .then(() => loadDay())
      .then(() => sync());
    const up = () => {
      setOnline(true);
      void sync();
    };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    const timer = setInterval(() => void sync(), 20_000);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      clearInterval(timer);
    };
  }, [loadDay, saveQueue, sync]);

  function push(action: QueueAction) {
    saveQueue(enqueue(queueRef.current, action));
    void sync();
  }

  // The tap shows at once: the local copy of the day takes the step, the server confirms (or corrects) on the next sync.
  function applyLocal(update: (d: Day) => Day) {
    setDay((d) => {
      if (!d) return d;
      const next = update(d);
      localStorage.setItem(DAY_KEY, JSON.stringify(next));
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
    await fetch('/api/field/logout', { method: 'POST' }).catch(() => null);
    localStorage.removeItem(DAY_KEY);
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
                {i.address && <p className="text-2xl">{i.address}</p>}
                {i.joinTruckCode && (
                  <p className="text-2xl">{t('instruction.joinTruck', { code: i.joinTruckCode })}</p>
                )}
                {i.mapUrl && (
                  <a
                    href={i.mapUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={`${big} block bg-white text-center text-black underline`}
                  >
                    {t('openMap')}
                  </a>
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
                {trip.address && <p className="text-2xl">{trip.address}</p>}
                {trip.mapUrl && (
                  <a href={trip.mapUrl} target="_blank" rel="noreferrer" className="block text-2xl underline">
                    {t('openMap')}
                  </a>
                )}
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
                {job.address && <p className="text-2xl">{job.address}</p>}
                {job.mapUrl && (
                  <a href={job.mapUrl} target="_blank" rel="noreferrer" className="block text-2xl underline">
                    {t('openMap')}
                  </a>
                )}
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
