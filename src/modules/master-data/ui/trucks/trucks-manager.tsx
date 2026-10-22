'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { formatCapacityM3, parseCapacityM3, type TruckStatusEntry } from '../../domain/truck';
import {
  createTruckAction,
  logTruckStatusAction,
  updateTruckAction,
  type TruckActionResult,
} from './actions';

export interface TruckRow {
  id: string;
  code: string;
  plate: string;
  capacityL: number;
  status: 'active' | 'archived';
}

/** The form shows m³; the server gets litres. Text that is not a capacity goes through as NaN and is refused (INVALID). */
const litres = (data: FormData) => {
  const parsed = parseCapacityM3(String(data.get('capacityM3') ?? ''));
  return parsed.ok ? parsed.value : Number.NaN;
};

const INPUT = 'input mt-1';
const BUTTON = 'btn btn-primary btn-sm';

/**
 * Everyone signed in reads trucks and their log; owner and partner edit trucks; the plant logs a breakdown or a
 * roadblock (the server checks the permission again on every write).
 */
export function TrucksManager({
  trucks,
  logs,
  canEdit,
  canLog,
}: {
  trucks: TruckRow[];
  logs: Record<string, TruckStatusEntry[]>;
  canEdit: boolean;
  canLog: boolean;
}) {
  const t = useTranslations('masterData.trucks');
  const router = useRouter();
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);

  async function submit(
    id: string,
    event: FormEvent<HTMLFormElement>,
    run: (data: FormData) => Promise<TruckActionResult>,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const result = await run(new FormData(form));
    if (result.ok) {
      setMessage({ id, text: t('saved') });
      if (id === 'new' || id.startsWith('log-')) form.reset();
      return router.refresh();
    }
    setMessage({
      id,
      text:
        result.error === 'DUPLICATE'
          ? t('duplicate')
          : result.error === 'INVALID'
            ? t('invalid')
            : t('error'),
    });
  }

  const note = (id: string) =>
    message?.id === id && (
      <p role="status" className="text-sm" data-testid="truck-message">
        {message.text}
      </p>
    );

  return (
    <div className="mt-6 space-y-4">
      {!canEdit && !canLog && <p className="text-sm text-muted">{t('readOnly')}</p>}
      <ul className="space-y-3">
        {trucks.map((truck) => (
          <li key={truck.id} className="card p-3" data-testid={`truck-${truck.code}`}>
            {canEdit ? (
              <form
                onSubmit={(e) =>
                  void submit(truck.id, e, (d) =>
                    updateTruckAction(
                      truck.id,
                      { plate: String(d.get('plate') ?? ''), capacityL: litres(d) },
                      d.get('archived') === 'on' ? 'archived' : 'active',
                    ),
                  )
                }
                className="flex flex-wrap items-end gap-3"
              >
                <span dir="ltr" className="font-medium">
                  {truck.code}
                </span>
                <label className="block">
                  <span className="field-label">{t('plate')}</span>
                  <input
                    name="plate"
                    defaultValue={truck.plate}
                    maxLength={20}
                    required
                    dir="ltr"
                    className={`${INPUT} w-40`}
                  />
                </label>
                <label className="block">
                  <span className="field-label">{t('capacity')}</span>
                  <input
                    name="capacityM3"
                    inputMode="decimal"
                    defaultValue={formatCapacityM3(truck.capacityL)}
                    required
                    dir="ltr"
                    className={`${INPUT} w-28`}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input name="archived" type="checkbox" defaultChecked={truck.status === 'archived'} />
                  {t('archived')}
                </label>
                <button type="submit" className={BUTTON}>
                  {t('save')}
                </button>
                {note(truck.id)}
              </form>
            ) : (
              <p className="flex flex-wrap gap-x-6">
                <span dir="ltr" className="font-medium">
                  {truck.code}
                </span>
                <span dir="ltr" data-testid="truck-plate">
                  {truck.plate}
                </span>
                <span>
                  <bdi dir="ltr">{formatCapacityM3(truck.capacityL)}</bdi> m³
                </span>
                {truck.status === 'archived' && <span className="text-muted">{t('archived')}</span>}
              </p>
            )}
            <ul className="mt-2 space-y-1 text-sm" data-testid={`truck-log-${truck.code}`}>
              {(logs[truck.id] ?? []).map((entry) => (
                <li key={entry.id}>
                  <span className="font-medium">{t(`status.${entry.status}`)}</span>{' '}
                  <bdi dir="ltr">
                    {entry.fromDate} → {entry.toDate ?? '…'}
                  </bdi>{' '}
                  — <bdi>{entry.reason}</bdi>
                </li>
              ))}
            </ul>
            {canLog && truck.status === 'active' && (
              <form
                onSubmit={(e) =>
                  void submit(`log-${truck.id}`, e, (d) =>
                    logTruckStatusAction({
                      truckId: truck.id,
                      status: String(d.get('status') ?? ''),
                      fromDate: String(d.get('fromDate') ?? ''),
                      toDate: String(d.get('toDate') ?? '') || null,
                      reason: String(d.get('reason') ?? ''),
                    }),
                  )
                }
                className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-line-strong bg-canvas/60 p-3"
                data-testid={`truck-log-form-${truck.code}`}
              >
                <label className="block">
                  <span className="field-label">{t('logStatus')}</span>
                  <select name="status" className={INPUT} defaultValue="breakdown">
                    <option value="breakdown">{t('status.breakdown')}</option>
                    <option value="roadblock">{t('status.roadblock')}</option>
                    <option value="available">{t('status.available')}</option>
                  </select>
                </label>
                <label className="block">
                  <span className="field-label">{t('fromDate')}</span>
                  <input name="fromDate" type="date" required dir="ltr" className={INPUT} />
                </label>
                <label className="block">
                  <span className="field-label">{t('toDate')}</span>
                  <input name="toDate" type="date" dir="ltr" className={INPUT} />
                </label>
                <label className="block">
                  <span className="field-label">{t('reason')}</span>
                  <input name="reason" maxLength={500} required className={`${INPUT} w-56`} />
                </label>
                <button type="submit" className={BUTTON}>
                  {t('log')}
                </button>
                {note(`log-${truck.id}`)}
              </form>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form
          onSubmit={(e) =>
            void submit('new', e, (d) =>
              createTruckAction({
                code: String(d.get('code') ?? ''),
                plate: String(d.get('plate') ?? ''),
                capacityL: litres(d),
              }),
            )
          }
          className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-line-strong bg-canvas/60 p-3"
          data-testid="truck-new"
        >
          <label className="block">
            <span className="field-label">{t('code')}</span>
            <input name="code" maxLength={4} required dir="ltr" className={`${INPUT} w-24`} />
          </label>
          <label className="block">
            <span className="field-label">{t('plate')}</span>
            <input name="plate" maxLength={20} required dir="ltr" className={`${INPUT} w-40`} />
          </label>
          <label className="block">
            <span className="field-label">{t('capacity')}</span>
            <input
              name="capacityM3"
              inputMode="decimal"
              defaultValue={formatCapacityM3(8000)}
              required
              dir="ltr"
              className={`${INPUT} w-28`}
            />
          </label>
          <button type="submit" className={BUTTON}>
            {t('add')}
          </button>
          {note('new')}
        </form>
      )}
    </div>
  );
}
