'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button, StatusPill } from '@/ui';
import type { CancellationCase, RedirectCandidate } from '../service/cancellation-service';

type Result = { ok: true } | { ok: false; error: string };

/** The cases of §8: what happened, what the tracking showed, and the redirect or loss to decide. Quantities only. */
export function CancellationsBoard({
  cases,
  policy,
  canDecide,
  canSetPolicy,
  decide,
  setPolicy,
  candidates,
}: {
  cases: CancellationCase[];
  policy: { plantMayDecide: boolean; clientCharged: boolean };
  canDecide: boolean;
  canSetPolicy: boolean;
  decide: (input: {
    caseId: string;
    decision: 'redirect' | 'loss' | 'return_extra' | 'join' | 'replacement_truck';
    redirectOrderId?: string;
    lossFuelL?: number;
    lossMinutes?: number;
  }) => Promise<Result>;
  setPolicy: ((input: { plantMayDecide: boolean; clientCharged: boolean }) => Promise<Result>) | null;
  candidates: (caseId: string) => Promise<RedirectCandidate[]>;
}) {
  const t = useTranslations('cancellations');
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [options, setOptions] = useState<Record<string, RedirectCandidate[]>>({});

  async function send(input: Parameters<typeof decide>[0]) {
    const r = await decide(input);
    setMessage(r.ok ? null : t(`errors.${r.error}` as never));
    if (r.ok) router.refresh();
  }

  const open = cases.filter((c) => c.status === 'open');
  const decided = cases.filter((c) => c.status === 'decided');
  return (
    <div className="mt-4 space-y-6" data-testid="cancellations-board">
      {message && (
        <p role="alert" className="text-sm text-danger" data-testid="cancellations-error">
          {message}
        </p>
      )}
      {setPolicy && canSetPolicy && (
        <form
          className="flex flex-wrap items-center gap-4 text-sm"
          data-testid="cancellation-policy"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const r = await setPolicy({
              plantMayDecide: f.get('plantMayDecide') === 'on',
              clientCharged: f.get('clientCharged') === 'on',
            });
            setMessage(r.ok ? null : t(`errors.${r.error}` as never));
            if (r.ok) router.refresh();
          }}
        >
          <label>
            <input type="checkbox" name="plantMayDecide" defaultChecked={policy.plantMayDecide} />{' '}
            {t('policy.plantMayDecide')}
          </label>
          <label>
            <input type="checkbox" name="clientCharged" defaultChecked={policy.clientCharged} />{' '}
            {t('policy.clientCharged')}
          </label>
          <Button type="submit">{t('policy.save')}</Button>
        </form>
      )}
      <section>
        <h2 className="text-lg font-semibold">{t('open')}</h2>
        {open.length === 0 && <p className="text-sm text-muted">{t('noneOpen')}</p>}
        <ul className="mt-2 space-y-3">
          {open.map((c) => (
            <li key={c.id} className="rounded border p-3" data-testid={`case-${c.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={c.caseNo >= 6 ? 'late' : 'due'}>
                  {t(`case.${c.caseNo}` as never)}
                </StatusPill>
                <span>{c.orderCode}</span>
                {c.blNo && <span className="text-muted">{c.blNo}</span>}
                {c.surplusL !== null && <span>{t('surplus', { m3: (c.surplusL / 1000).toFixed(1) })}</span>}
              </div>
              {c.reason && <p className="text-sm">{c.reason}</p>}
              {canDecide && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {c.caseNo === 6 ? (
                    (['return_extra', 'join', 'replacement_truck'] as const).map((d) => (
                      <Button key={d} onClick={() => send({ caseId: c.id, decision: d })}>
                        {t(`decision.${d}` as never)}
                      </Button>
                    ))
                  ) : (
                    <>
                      <Button
                        onClick={async () => setOptions({ ...options, [c.id]: await candidates(c.id) })}
                        data-testid={`propose-${c.id}`}
                      >
                        {t('proposeRedirect')}
                      </Button>
                      <Button
                        onClick={() => send({ caseId: c.id, decision: 'loss' })}
                        data-testid={`loss-${c.id}`}
                      >
                        {t('decision.loss')}
                      </Button>
                    </>
                  )}
                </div>
              )}
              {options[c.id] && (
                <ul className="mt-2 text-sm">
                  {options[c.id]!.length === 0 && <li>{t('noCandidate')}</li>}
                  {options[c.id]!.map((o) => (
                    <li key={o.orderId}>
                      <button
                        type="button"
                        className="underline"
                        onClick={() =>
                          send({ caseId: c.id, decision: 'redirect', redirectOrderId: o.orderId })
                        }
                      >
                        {o.orderCode} · {o.typeCode} · {(o.remainingL / 1000).toFixed(1)} m³
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="text-lg font-semibold">{t('decided')}</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {decided.map((c) => (
            <li key={c.id}>
              {t(`case.${c.caseNo}` as never)} · {c.orderCode} ·{' '}
              {c.decision ? t(`decision.${c.decision}` as never) : ''}
              {c.redirectOrderCode ? ` → ${c.redirectOrderCode}` : ''}
              {c.lossL ? ` · ${(c.lossL / 1000).toFixed(1)} m³` : ''}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
