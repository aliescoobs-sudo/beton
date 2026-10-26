'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Money, Table, Td, Th } from '@/ui';
import type { Effect } from '../../domain/effects';
import { EffectsPanel } from '../effects/effects-panel';

type Result = { ok: true; number: string; effects: Effect[] } | { ok: false; error: string };

export interface QueueRow {
  id: string;
  blNo: string;
  noteHref: string;
  deliveredOn: string;
  typeCode: string;
  typeLabel: string;
  volumeLabel: string;
  /** Owner and support only; absent in the answer for office. */
  amountHtCentimes?: number;
}

/**
 * The BLs of one client with a box each: the ticked ones become ONE invoice, in one action (AC-INT-06). The answer is the
 * invoice number and what it changed, filtered for the role; office never sees an amount. Support reads, never invoices.
 */
export function QueueSelection({
  clientCode,
  rows,
  withAmounts,
  canInvoice,
  createAction,
}: {
  clientCode: string;
  rows: QueueRow[];
  withAmounts: boolean;
  canInvoice: boolean;
  createAction: (input: unknown) => Promise<Result>;
}) {
  const t = useTranslations('ledger.invoiceQueue');
  const tInv = useTranslations('ledger.invoices');
  const router = useRouter();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<{ number: string; effects: Effect[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allPicked = picked.size === rows.length && rows.length > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const due = String(new FormData(event.currentTarget).get('dueDate') ?? '').trim();
    setMessage(null);
    setDone(null);
    setBusy(true);
    try {
      const result = await createAction({ deliveryIds: [...picked], dueDate: due || null });
      if (result.ok) {
        setDone({ number: result.number, effects: result.effects });
        setPicked(new Set());
        router.refresh();
      } else
        setMessage(
          {
            INVALID: tInv('invalid'),
            NOT_FOUND: tInv('notFound'),
            NOTHING_TO_INVOICE: t('refused'),
            PAYMENT_TERM_TOO_LONG: tInv('termTooLong'),
            DUE_BEFORE_INVOICE: tInv('dueBefore'),
            CONFLICT: tInv('conflict'),
          }[result.error] ?? tInv('error'),
        );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} data-testid={`queue-form-${clientCode}`} noValidate>
      <Table data-testid={`queue-list-${clientCode}`}>
        <thead>
          <tr>
            {canInvoice && (
              <Th>
                <input
                  type="checkbox"
                  checked={allPicked}
                  onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.id)))}
                  aria-label={t('selectAll')}
                  data-testid={`queue-all-${clientCode}`}
                />
              </Th>
            )}
            <Th>{t('bl')}</Th>
            <Th>{t('delivered')}</Th>
            <Th>{t('product')}</Th>
            <Th numeric>{t('volume')}</Th>
            {withAmounts && <Th numeric>{t('amountHt')}</Th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-testid={`queue-row-${r.blNo}`}>
              {canInvoice && (
                <Td>
                  <input
                    type="checkbox"
                    checked={picked.has(r.id)}
                    onChange={() => toggle(r.id)}
                    aria-label={r.blNo}
                    data-testid={`queue-pick-${r.blNo}`}
                  />
                </Td>
              )}
              <Td>
                <a href={r.noteHref} className="underline">
                  <bdi dir="ltr">{r.blNo}</bdi>
                </a>
              </Td>
              <Td>
                <bdi dir="ltr">{r.deliveredOn}</bdi>
              </Td>
              <Td>
                <bdi dir="ltr">
                  {r.typeCode} · {r.typeLabel}
                </bdi>
              </Td>
              <Td numeric>
                <bdi dir="ltr">{r.volumeLabel}</bdi>
              </Td>
              {withAmounts && (
                <Td numeric>{r.amountHtCentimes !== undefined && <Money centimes={r.amountHtCentimes} />}</Td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
      {canInvoice && (
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <label className="text-sm">
            <span className="field-label">{t('dueDate')}</span>
            <input name="dueDate" type="date" dir="ltr" className="input mt-1" />
          </label>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || picked.size === 0}
            data-testid={`queue-invoice-${clientCode}`}
          >
            {t('invoiceSelection', { count: picked.size })}
          </button>
        </div>
      )}
      {message && (
        <p role="alert" className="field-error mt-2" data-testid={`queue-error-${clientCode}`}>
          {message}
        </p>
      )}
      {done && (
        <div className="mt-3" data-testid={`queue-saved-${clientCode}`}>
          <p role="status" className="font-medium">
            {tInv('saved')} <bdi dir="ltr">{done.number}</bdi>
          </p>
          <EffectsPanel effects={done.effects} testId={`queue-effects-${clientCode}`} />
        </div>
      )}
    </form>
  );
}
