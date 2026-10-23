'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { formatCapacityM3, parseCapacityM3, type TruckStatusEntry } from '../../domain/truck';
import { Table, Th } from '@/ui';
import { ActionsTh, AddButton, CancelButton, EditButton, FormRow, type Message, Notice } from '../read-mode';
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
  const [message, setMessage] = useState<Message | null>(null);
  // 'new' = the add form, a truck id = that row's edit form, `log-<id>` = its breakdown form; null = read mode.
  const [open, setOpen] = useState<string | null>(null);

  async function submit(
    id: string,
    event: FormEvent<HTMLFormElement>,
    run: (data: FormData) => Promise<TruckActionResult>,
  ) {
    event.preventDefault();
    const result = await run(new FormData(event.currentTarget));
    if (result.ok) {
      setMessage({ id, text: t('saved'), ok: true });
      setOpen(null);
      return router.refresh();
    }
    setMessage({
      id,
      ok: false,
      text:
        result.error === 'DUPLICATE'
          ? t('duplicate')
          : result.error === 'INVALID'
            ? t('invalid')
            : t('error'),
    });
  }

  const columns = 5;
  return (
    <div className="mt-6 space-y-4">
      {!canEdit && !canLog && <p className="text-sm text-muted">{t('readOnly')}</p>}
      <Notice message={message} testId="truck-message" />
      {canEdit &&
        (open === 'new' ? (
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
            className="form-band flex flex-wrap items-end gap-3"
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
            <CancelButton onClick={() => setOpen(null)} />
            <Notice message={message} id="new" testId="truck-message" />
          </form>
        ) : (
          <AddButton label={t('add')} onClick={() => setOpen('new')} testId="truck-add" />
        ))}
      <Table>
        <thead>
          <tr>
            <Th>{t('codeColumn')}</Th>
            <Th>{t('plate')}</Th>
            <Th numeric>{t('capacity')}</Th>
            <Th>{t('statusColumn')}</Th>
            {(canEdit || canLog) && <ActionsTh />}
          </tr>
        </thead>
        {trucks.map((truck) => {
          const entries = logs[truck.id] ?? [];
          const logging = canLog && truck.status === 'active';
          return (
            <tbody key={truck.id}>
              <tr data-testid={`truck-${truck.code}`}>
                {open === truck.id ? (
                  <FormRow columns={columns}>
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
                      className="flex flex-wrap items-end gap-3 py-2"
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
                      <CancelButton onClick={() => setOpen(null)} />
                      <Notice message={message} id={truck.id} testId="truck-message" />
                    </form>
                  </FormRow>
                ) : (
                  <>
                    <td className="font-medium">
                      <span dir="ltr">{truck.code}</span>
                    </td>
                    <td>
                      <span dir="ltr" data-testid="truck-plate">
                        {truck.plate}
                      </span>
                    </td>
                    <td className="is-num">
                      <bdi dir="ltr">{formatCapacityM3(truck.capacityL)}</bdi> m³
                    </td>
                    <td className="text-muted">{truck.status === 'archived' ? t('archived') : ''}</td>
                    {(canEdit || canLog) && (
                      <td className="whitespace-nowrap text-end">
                        {canEdit && <EditButton onClick={() => setOpen(truck.id)} testId="truck-edit" />}
                        {logging && (
                          <button
                            type="button"
                            onClick={() => setOpen(`log-${truck.id}`)}
                            className="btn btn-ghost btn-sm"
                            data-testid={`truck-log-open-${truck.code}`}
                          >
                            {t('logStatus')}
                          </button>
                        )}
                      </td>
                    )}
                  </>
                )}
              </tr>
              {(entries.length > 0 || open === `log-${truck.id}`) && (
                <tr>
                  <td colSpan={columns}>
                    <ul className="space-y-1 text-sm" data-testid={`truck-log-${truck.code}`}>
                      {entries.map((entry) => (
                        <li key={entry.id}>
                          <span className="font-medium">{t(`status.${entry.status}`)}</span>{' '}
                          <bdi dir="ltr">
                            {entry.fromDate} – {entry.toDate ?? '…'}
                          </bdi>{' '}
                          — <bdi>{entry.reason}</bdi>
                        </li>
                      ))}
                    </ul>
                    {logging && open === `log-${truck.id}` && (
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
                        className="form-band mt-3 flex flex-wrap items-end gap-3"
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
                        <CancelButton onClick={() => setOpen(null)} />
                        <Notice message={message} id={`log-${truck.id}`} testId="truck-message" />
                      </form>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          );
        })}
      </Table>
    </div>
  );
}
