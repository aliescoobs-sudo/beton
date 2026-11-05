'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/ui';
import type { MyDocumentRequest, PendingDocumentRequest } from '../service/document-request-service';

type Result = { ok: true } | { ok: false; error: string };

/** One page for the three things of R7: ask for a document (gate), decide, and the invoice timing and numbering. No amount anywhere. */
export function DocumentRequestsBoard({
  mine,
  pending,
  timing,
  canRequest,
  canDecide,
  canSetTiming,
  canSetSequence,
  actions,
}: {
  mine: MyDocumentRequest[];
  pending: PendingDocumentRequest[];
  timing: string;
  canRequest: boolean;
  canDecide: boolean;
  canSetTiming: boolean;
  canSetSequence: boolean;
  actions: {
    request: (input: unknown) => Promise<Result>;
    use: (id: string) => Promise<Result>;
    decide: (input: unknown) => Promise<Result>;
    setTiming: (timing: string) => Promise<Result>;
    setSequence: (input: { year: number; last: number }) => Promise<Result>;
  };
}) {
  const t = useTranslations('documentRequests');
  const locale = useLocale();
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const finish = (r: Result) => {
    setMessage(r.ok ? null : t(`errors.${r.error}` as never));
    if (r.ok) router.refresh();
  };
  return (
    <div className="mt-4 space-y-6" data-testid="document-requests">
      {message && (
        <p role="alert" className="text-sm text-danger" data-testid="document-requests-error">
          {message}
        </p>
      )}
      {(canSetTiming || canSetSequence) && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t('policy')}</h2>
          {canSetTiming && (
            <label className="block text-sm">
              {t('timing.label')}{' '}
              <select
                defaultValue={timing}
                data-testid="invoice-timing"
                onChange={async (e) => finish(await actions.setTiming(e.target.value))}
              >
                {(['per_delivery', 'monthly', 'full_payment'] as const).map((k) => (
                  <option key={k} value={k}>
                    {t(`timing.${k}` as never)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {canSetSequence && (
            <form
              className="flex flex-wrap items-end gap-2 text-sm"
              onSubmit={async (e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                finish(
                  await actions.setSequence({ year: Number(f.get('year')), last: Number(f.get('last')) }),
                );
              }}
            >
              <label>
                {t('sequence.year')} <input name="year" type="number" defaultValue={2026} className="w-24" />
              </label>
              <label>
                {t('sequence.last')} <input name="last" type="number" min={1} required className="w-32" />
              </label>
              <Button type="submit">{t('sequence.save')}</Button>
            </form>
          )}
        </section>
      )}
      {canRequest && (
        <section>
          <h2 className="text-lg font-semibold">{t('ask')}</h2>
          <form
            className="mt-2 flex flex-wrap items-end gap-2 text-sm"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              finish(
                await actions.request({
                  kind: f.get('kind'),
                  partyKind: f.get('partyKind'),
                  partyCode: f.get('partyCode'),
                  docRef: String(f.get('docRef') ?? '') || null,
                  note: String(f.get('note') ?? '') || null,
                }),
              );
            }}
          >
            <select name="kind" data-testid="request-kind">
              {(
                [
                  'releve',
                  'invoice_copy',
                  'quote_copy',
                  'avoir_copy',
                  'bl_copy',
                  'supplier_statement',
                ] as const
              ).map((k) => (
                <option key={k} value={k}>
                  {t(`kind.${k}` as never)}
                </option>
              ))}
            </select>
            <select name="partyKind">
              <option value="client">{t('party.client')}</option>
              <option value="supplier">{t('party.supplier')}</option>
            </select>
            <input name="partyCode" placeholder={t('partyCode')} required />
            <input name="docRef" placeholder={t('docRef')} />
            <Button type="submit" data-testid="request-submit">
              {t('send')}
            </Button>
          </form>
          <ul className="mt-3 space-y-1 text-sm">
            {mine.map((r) => (
              <li key={r.id} data-testid={`mine-${r.id}`}>
                {t(`kind.${r.kind}` as never)} · {r.partyCode} {r.docRef ?? ''} ·{' '}
                {t(`status.${r.status}` as never)}
                {r.status === 'approved' &&
                  (r.kind === 'releve' || r.kind === 'supplier_statement' ? (
                    <button
                      type="button"
                      className="ml-2 underline"
                      onClick={async () => finish(await actions.use(r.id))}
                    >
                      {t('release')}
                    </button>
                  ) : (
                    // F08: a document copy goes out by its download, which consumes the approval (once, 24 hours).
                    <a
                      className="ml-2 underline"
                      href={`/${locale}/documents/copy/${r.id}`}
                      data-testid={`download-${r.id}`}
                    >
                      {t('download')}
                    </a>
                  ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      {pending.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold">{t('pending')}</h2>
          <ul className="mt-2 space-y-2">
            {pending.map((p) => (
              <li key={p.id} className="rounded border p-3 text-sm" data-testid={`pending-${p.id}`}>
                {p.requesterName} → {t(`kind.${p.kind}` as never)} · {p.partyCode} {p.docRef ?? ''}
                {p.note && <span className="block text-muted">{p.note}</span>}
                {canDecide && (
                  <span className="mt-2 flex gap-2">
                    <Button onClick={async () => finish(await actions.decide({ id: p.id, approve: true }))}>
                      {t('approve')}
                    </Button>
                    <Button onClick={async () => finish(await actions.decide({ id: p.id, approve: false }))}>
                      {t('deny')}
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
