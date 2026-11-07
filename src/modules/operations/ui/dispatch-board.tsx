'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { Button, Input, Select, StatusPill } from '@/ui';
import {
  checkDispatch,
  clockText,
  type Conflict,
  isBlocking,
  isDriverOverride,
  planDispatch,
  retime,
  type Rotation,
} from '../domain/dispatch';
import type { DispatchDay } from '../service/dispatch-service';
import { formatM3, ltr } from './format';

export type SaveDispatchResult =
  { ok: true; rotations: number; conflicts: number } | { ok: false; error: string };

/** 2026-10-23 → 23/10/2026 */
const formatDate = (iso: string): string => iso.split('-').reverse().join('/');

const BAR_COLOURS = [
  'var(--color-ink)',
  'var(--color-amber)',
  'var(--color-status-paid)',
  'var(--color-muted)',
];

/** The plan of a day: a proposal or the saved plan, editable truck by truck, judged live by the same rules the service applies. */
export function DispatchBoard({
  day,
  canWrite,
  save,
}: {
  day: DispatchDay;
  canWrite: boolean;
  save: (input: unknown) => Promise<SaveDispatchResult>;
}) {
  const t = useTranslations('operations.dispatch');
  const router = useRouter();
  const pathname = usePathname();
  // Rotations being driven stay as they are: they keep their trucks busy and are only judged against the plan.
  const fixed: Rotation[] = useMemo(() => day.saved.filter((s) => s.started), [day.saved]);
  const proposal = useMemo(
    () => planDispatch(day.orders, day.trucks, day.drivers, day.params, fixed),
    [day.orders, day.trucks, day.drivers, day.params, fixed],
  );
  const savedPlanned = day.saved.filter((s) => !s.started);
  const hasSaved = savedPlanned.length > 0;
  const [rotations, setRotations] = useState<Rotation[]>(() =>
    hasSaved
      ? savedPlanned.map((s) => ({
          key: s.key,
          orderId: s.orderId,
          seq: s.seq,
          truckId: s.truckId,
          driverId: s.driverId,
          volumeL: s.volumeL,
          loadMin: s.loadMin,
          departMin: s.departMin,
          arriveMin: s.arriveMin,
          unloadEndMin: s.unloadEndMin,
          backMin: s.backMin,
        }))
      : proposal.rotations,
  );
  const [reasons, setReasons] = useState<Record<string, string>>(() =>
    Object.fromEntries(savedPlanned.flatMap((s) => (s.overrideReason ? [[s.key, s.overrideReason]] : []))),
  );
  const [fromProposal, setFromProposal] = useState(!hasSaved);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // R14-01: a driver or a truck on two rotations at once is refused unless the person gives the reason of an explicit, audited exception.
  const [overlapAsked, setOverlapAsked] = useState(false);
  const [overlapReason, setOverlapReason] = useState('');

  const ctx = useMemo(
    () => ({ orders: day.orders, trucks: day.trucks, drivers: day.drivers, params: day.params, fixed }),
    [day, fixed],
  );
  const conflicts: Conflict[] = useMemo(
    () => [
      ...(hasSaved || !fromProposal || rotations.length > 0
        ? []
        : proposal.conflicts.filter((c) => c.kind === 'NO_TRUCK')),
      ...checkDispatch(rotations, ctx),
    ],
    [rotations, ctx, hasSaved, fromProposal, proposal.conflicts],
  );
  const driverOf = new Map(day.drivers.map((d) => [d.id, d]));
  const overrides = rotations.filter((r) =>
    isDriverOverride(
      day.trucks.find((k) => k.id === r.truckId),
      r.driverId,
    ),
  );
  const missingReason = overrides.some((r) => !(reasons[r.key] ?? '').trim());
  const blocked = conflicts.some(isBlocking) || missingReason;
  const orderById = new Map(day.orders.map((o) => [o.orderId, o]));
  const truckById = new Map(day.trucks.map((k) => [k.id, k]));
  const overdueCount = new Set(
    rotations.filter((r) => orderById.get(r.orderId)?.dueDate).map((r) => r.orderId),
  ).size;
  const rotationOrderCode = (key: string) => {
    const r = rotations.find((x) => x.key === key);
    return r ? (orderById.get(r.orderId)?.orderCode ?? '') : '';
  };
  const savedLabel = new Map(day.saved.map((s) => [s.key, s]));

  function edit(key: string, patch: Partial<Pick<Rotation, 'truckId' | 'driverId'>>) {
    setRotations((current) =>
      retime(
        current.map((r) => (r.key === key ? { ...r, ...patch } : r)),
        day.orders,
        day.params,
        fixed,
      ),
    );
    setFromProposal(false);
    setMessage(null);
  }

  async function saveAll() {
    setPending(true);
    setMessage(null);
    try {
      const sorted = [...rotations].sort((a, b) => a.loadMin - b.loadMin || a.key.localeCompare(b.key));
      const result = await save({
        date: day.date,
        rotations: sorted.map((r) => ({
          orderId: r.orderId,
          truckId: r.truckId,
          driverId: r.driverId,
          volumeL: r.volumeL,
          overrideReason: isDriverOverride(
            day.trucks.find((k) => k.id === r.truckId),
            r.driverId,
          )
            ? (reasons[r.key] ?? '').trim()
            : null,
        })),
        ...(overlapAsked && overlapReason.trim() ? { overlapReason: overlapReason.trim() } : {}),
      });
      if (!result.ok) {
        if (result.error === 'OVERLAP') setOverlapAsked(true);
        return setMessage(t(`errors.${result.error}` as never));
      }
      // The confirmation is shown by the page (the board is rebuilt from the saved plan): it travels in the address.
      router.replace(`${pathname}?date=${day.date}&saved=${result.rotations}`);
      router.refresh();
    } catch {
      setMessage(t('errors.INVALID'));
    } finally {
      setPending(false);
    }
  }

  const spanStart = day.params.dayStartMin;
  const spanEnd = Math.max(spanStart + day.params.workingMin, ...rotations.map((r) => r.backMin));
  const span = Math.max(1, spanEnd - spanStart);
  const orderColour = new Map(
    day.orders.map((o, i) => [o.orderId, BAR_COLOURS[i % BAR_COLOURS.length] as string]),
  );

  return (
    <div className="space-y-6" data-testid="dispatch-board">
      <p className="text-sm text-muted" data-testid="dispatch-source">
        {hasSaved && !fromProposal
          ? t('sourceSaved')
          : fromProposal && !hasSaved
            ? t('sourceProposal')
            : t('sourceEdited')}
      </p>

      {overdueCount > 0 && (
        <p className="text-sm" data-testid="dispatch-overdue-summary">
          <StatusPill status="late">{t('overdueFlag')}</StatusPill>{' '}
          {t('overdueSummary', { count: overdueCount })}
        </p>
      )}

      {conflicts.length > 0 ? (
        <section aria-labelledby="conflicts-title" className="border-s-4 border-status-late bg-surface p-4">
          <h2 id="conflicts-title" className="text-lg">
            {t('conflicts')}
          </h2>
          <ul className="mt-2 space-y-1 text-sm" data-testid="dispatch-conflicts">
            {conflicts.map((c, i) => (
              <li
                key={`${c.kind}-${i}`}
                data-conflict={c.kind}
                data-blocking={isBlocking(c) ? 'true' : 'false'}
              >
                <StatusPill status={isBlocking(c) ? 'late' : 'due'}>
                  {t(`conflict.${c.kind}` as never)}
                </StatusPill>{' '}
                {conflictText(t, c, orderById.get(c.orderId ?? '')?.orderCode, rotationOrderCode)}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-sm" data-testid="dispatch-clean">
          {t('noConflict')}
        </p>
      )}

      {fixed.length > 0 && (
        <section aria-labelledby="started-title">
          <h2 id="started-title" className="mb-2 text-xl">
            {t('started')}
          </h2>
          <ul className="space-y-1 text-sm" data-testid="dispatch-started">
            {day.saved
              .filter((r) => r.started)
              .map((r) => (
                <li key={r.key} data-testid={`started-${r.orderCode}-${r.seq}`}>
                  <bdi dir="ltr">{r.orderCode}</bdi> · <bdi dir="ltr">{r.truckCode}</bdi> ·{' '}
                  <bdi dir="ltr">{formatM3(r.volumeL)} m³</bdi> ·{' '}
                  <bdi dir="ltr">
                    {clockText(r.loadMin)} → {clockText(r.backMin)}
                  </bdi>
                </li>
              ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="timeline-title">
        <h2 id="timeline-title" className="mb-2 text-xl">
          {t('timeline')}
        </h2>
        <div className="overflow-x-auto" dir="ltr">
          <svg
            viewBox={`0 0 ${span} ${day.trucks.length * 30 + 20}`}
            preserveAspectRatio="none"
            className="block h-auto min-w-[640px] w-full bg-surface"
            role="img"
            aria-label={t('timeline')}
            data-testid="dispatch-timeline"
          >
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((h) => {
              const m = Math.ceil(spanStart / 60) * 60 + h * 60;
              return m <= spanEnd ? (
                <g key={h}>
                  <line
                    x1={m - spanStart}
                    x2={m - spanStart}
                    y1="0"
                    y2={day.trucks.length * 30 + 20}
                    stroke="var(--color-rule)"
                  />
                  <text
                    x={m - spanStart + 2}
                    y={day.trucks.length * 30 + 14}
                    fontSize="9"
                    fill="var(--color-muted)"
                  >
                    {clockText(m)}
                  </text>
                </g>
              ) : null;
            })}
            {day.trucks.map((k, row) => (
              <g key={k.id}>
                <text
                  x="2"
                  y={row * 30 + 11}
                  fontSize="9"
                  fill={k.available ? 'var(--color-ink)' : 'var(--color-status-late)'}
                >
                  {k.code}
                  {k.available ? '' : ` · ${t('unavailable')}`}
                </text>
                {[...fixed, ...rotations]
                  .filter((r) => r.truckId === k.id)
                  .map((r) => (
                    <g key={r.key} data-testid={`bar-${r.key}`}>
                      <rect
                        x={r.loadMin - spanStart}
                        y={row * 30 + 14}
                        width={Math.max(1, r.backMin - r.loadMin)}
                        height="12"
                        fill={orderColour.get(r.orderId)}
                        opacity={conflicts.some((c) => c.rotationKeys.includes(r.key)) ? 0.55 : 1}
                        stroke={
                          conflicts.some((c) => c.rotationKeys.includes(r.key))
                            ? 'var(--color-status-late)'
                            : fixed.some((f) => f.key === r.key)
                              ? 'var(--color-ink)'
                              : 'none'
                        }
                      />
                      <text
                        x={r.loadMin - spanStart + 2}
                        y={row * 30 + 23}
                        fontSize="8"
                        fill="var(--color-bg)"
                      >
                        {orderById.get(r.orderId)?.orderCode.slice(-5)}
                      </text>
                    </g>
                  ))}
              </g>
            ))}
          </svg>
        </div>
      </section>

      <section aria-labelledby="rotations-title">
        <h2 id="rotations-title" className="mb-2 text-xl">
          {t('rotations')}
        </h2>
        {rotations.length === 0 ? (
          <p className="text-sm text-muted" data-testid="dispatch-empty">
            {day.orders.length === 0 ? t('noOrders') : t('noRotations')}
          </p>
        ) : (
          <ol className="space-y-3" data-testid="dispatch-rotations">
            {[...rotations]
              .sort((a, b) => a.loadMin - b.loadMin || a.key.localeCompare(b.key))
              .map((r) => {
                const o = orderById.get(r.orderId);
                const flagged = conflicts.filter((c) => c.rotationKeys.includes(r.key));
                return (
                  <li
                    key={r.key}
                    className={`border border-rule bg-surface p-3 text-sm${o?.dueDate ? ' border-s-4 border-s-status-late' : ''}`}
                    data-testid={`rotation-${o?.orderCode}-${r.seq}`}
                    data-overdue={o?.dueDate ? 'true' : undefined}
                    data-conflicts={flagged.map((c) => c.kind).join(' ')}
                  >
                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                      <strong>
                        <bdi dir="ltr">{o?.orderCode}</bdi> · {t('rotation', { n: r.seq })}
                      </strong>
                      {o?.dueDate && (
                        <StatusPill status="late" data-testid={`overdue-${o.orderCode}-${r.seq}`}>
                          {t('overdue', { date: formatDate(o.dueDate) })}
                        </StatusPill>
                      )}
                      <span>
                        <bdi dir="ltr">{o?.clientCode}</bdi> · <bdi dir="ltr">{o?.typeLabel}</bdi>
                      </span>
                      <span>{[o?.siteLabel, o?.zoneName].filter(Boolean).join(' · ') || t('noZone')}</span>
                      <span>
                        <bdi dir="ltr">{formatM3(r.volumeL)} m³</bdi>
                      </span>
                    </div>
                    <p className="mt-1" dir="ltr" data-testid={`times-${o?.orderCode}-${r.seq}`}>
                      {t('milestones', {
                        load: clockText(r.loadMin),
                        depart: clockText(r.departMin),
                        arrive: clockText(r.arriveMin),
                        unloaded: clockText(r.unloadEndMin),
                        back: clockText(r.backMin),
                      })}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-3">
                      <label className="flex items-center gap-2">
                        {t('truck')}
                        <Select
                          value={r.truckId}
                          disabled={!canWrite}
                          onChange={(e) => edit(r.key, { truckId: e.target.value })}
                          data-testid={`truck-${o?.orderCode}-${r.seq}`}
                        >
                          {day.trucks.map((k) => (
                            <option key={k.id} value={k.id}>
                              {k.code} · {formatM3(k.capacityL)} m³
                              {k.available ? '' : ` · ${t('unavailable')}`}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <label className="flex items-center gap-2">
                        {t('driver')}
                        <Select
                          value={r.driverId ?? ''}
                          disabled={!canWrite}
                          onChange={(e) =>
                            edit(r.key, { driverId: e.target.value === '' ? null : e.target.value })
                          }
                          data-testid={`driver-${o?.orderCode}-${r.seq}`}
                        >
                          <option value="">{t('noDriver')}</option>
                          {day.drivers.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </Select>
                      </label>
                      {(() => {
                        const k = truckById.get(r.truckId);
                        const def = k?.defaultDriverId ? driverOf.get(k.defaultDriverId) : undefined;
                        const override = isDriverOverride(k, r.driverId);
                        return (
                          <>
                            <span
                              className="text-muted"
                              data-testid={`default-driver-${o?.orderCode}-${r.seq}`}
                            >
                              {def ? t('defaultDriver', { name: def.name }) : t('noDefaultDriver')}
                            </span>
                            {override && (
                              <label className="flex items-center gap-2">
                                {t('overrideReason')}
                                <Input
                                  value={reasons[r.key] ?? ''}
                                  maxLength={300}
                                  disabled={!canWrite}
                                  required
                                  onChange={(e) => setReasons((cur) => ({ ...cur, [r.key]: e.target.value }))}
                                  data-testid={`reason-${o?.orderCode}-${r.seq}`}
                                />
                              </label>
                            )}
                          </>
                        );
                      })()}
                      {savedLabel.get(r.key) && (
                        <span className="text-muted">
                          {t('savedRow', { truck: ltr(savedLabel.get(r.key)?.truckCode ?? '') })}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
          </ol>
        )}
      </section>

      {canWrite && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setRotations(proposal.rotations);
              setFromProposal(true);
              setMessage(null);
            }}
            data-testid="dispatch-propose"
          >
            {t('propose')}
          </Button>
          <Button
            type="button"
            disabled={pending || blocked || rotations.length === 0}
            onClick={() => void saveAll()}
            data-testid="dispatch-save"
          >
            {t('save')}
          </Button>
          {blocked && (
            <span className="text-sm text-status-late">
              {missingReason ? t('overrideNeeded') : t('blockedHint')}
            </span>
          )}
          {overlapAsked && (
            <label className="block">
              <span className="field-label">{t('overlapReason')}</span>
              <Input
                value={overlapReason}
                onChange={(e) => setOverlapReason(e.target.value)}
                minLength={3}
                maxLength={300}
                data-testid="dispatch-overlap-reason"
              />
            </label>
          )}
          {message && (
            <span role="status" className="text-sm" data-testid="dispatch-message">
              {message}
            </span>
          )}
        </div>
      )}
      <p className="sr-only">{truckById.size}</p>
    </div>
  );
}

function conflictText(
  t: (key: string, values?: Record<string, string | number>) => string,
  c: Conflict,
  orderCode: string | undefined,
  rotationOrderCode: (key: string) => string,
): string {
  const codes = [...new Set(c.rotationKeys.map(rotationOrderCode).filter(Boolean))].join(', ');
  const where = ltr(codes || orderCode || '');
  switch (c.kind) {
    case 'PAST_WORKING_DAY':
    case 'LONG_TRIP':
      return t('conflictDetailMin', { order: where, min: c.amount ?? 0 });
    case 'OVER_CAPACITY':
    case 'ORDER_NOT_COVERED':
    case 'OVER_PLANNED':
    case 'NO_TRUCK':
      return t('conflictDetailL', { order: where, m3: formatM3(c.amount ?? 0) });
    default:
      return t('conflictDetail', { order: where });
  }
}
