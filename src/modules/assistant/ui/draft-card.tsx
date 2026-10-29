'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { StepUpDialog } from '@/modules/platform-security/ui/step-up-dialog';
import type { CardField } from '../domain/drafts';
import { isolate } from './isolate';
import type { Card } from './types';

type T = ReturnType<typeof useTranslations>;

function fieldValue(t: T, f: CardField) {
  if (f.enumOf) return t(`card.enum.${f.enumOf}.${f.value}` as never);
  return f.ltr ? <bdi dir="ltr">{f.value}</bdi> : f.value;
}

const label = (t: T, key: string) => t(`card.field.${key}` as never);

/**
 * A draft the person reads and decides on (SPEC-assistant §7): what will be created, every figure computed by code, the checks left
 * to them, and two buttons. A draft that writes a money record asks for a fresh code when confirmed (the dialog opens, then the
 * same request is sent once more). A blind card (office) shows no amount, and says so.
 */
export function DraftCard({ card, onChange }: { card: Card; onChange: (card: Card) => void }) {
  const t = useTranslations('assistant');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);

  async function decide(action: 'confirm' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/assistant/proposals/${card.id}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const body = (await res.json().catch(() => null)) as { proposal?: Card; error?: string } | null;
      if (res.ok && body?.proposal) return onChange(body.proposal);
      if (body?.error === 'STEP_UP_REQUIRED') return setStepUp(true);
      setError(t(`card.error.${body?.error ?? 'generic'}` as never));
      // A draft that was decided elsewhere or has gone stale is shown as it now is.
      if (body?.error && body.error !== 'STEP_UP_REQUIRED') {
        const list = (await fetch('/api/assistant/proposals')
          .then((r) => r.json())
          .catch(() => null)) as { proposals?: Card[] } | null;
        const fresh = list?.proposals?.find((c) => c.id === card.id);
        if (fresh) onChange(fresh);
      }
    } catch {
      setError(t('error.network'));
    } finally {
      setBusy(false);
    }
  }

  const pending = card.status === 'pending';
  return (
    <section
      className="space-y-2 border border-rule bg-surface p-3"
      aria-label={t(`card.title.${card.action}` as never)}
      data-testid={`draft-card-${card.action}`}
      data-status={card.status}
    >
      <header className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold">{t(`card.title.${card.action}` as never)}</h3>
        <span className="pill pill-neutral" data-testid="draft-status">
          {t(`card.status.${card.status}` as never)}
        </span>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {card.fields.map((f) => (
          <div key={f.key} className="contents" data-testid={`draft-field-${f.key}`}>
            <dt className="text-muted">{label(t, f.key)}</dt>
            <dd className="font-medium">{fieldValue(t, f)}</dd>
          </div>
        ))}
      </dl>
      {card.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {card.rows[0]!.map((f) => (
                  <th key={f.key} className="pe-3 text-start font-normal text-muted">
                    {label(t, f.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {card.rows.map((row, i) => (
                <tr key={i} data-testid="draft-row">
                  {row.map((f) => (
                    <td key={f.key} className="pe-3 align-top">
                      {fieldValue(t, f)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {card.blind && (
        <p className="text-sm text-muted" data-testid="draft-blind">
          {t('card.blind')}
        </p>
      )}
      {pending && (
        <ul className="list-disc space-y-0.5 ps-5 text-sm text-muted">
          {card.notes.map((n) => (
            <li key={n}>{t(`card.note.${n}` as never)}</li>
          ))}
          {card.needsStepUp && <li>{t('card.stepUp')}</li>}
        </ul>
      )}
      {card.status === 'confirmed' && card.resultRef && (
        <p className="text-sm font-medium" data-testid="draft-result">
          {isolate(
            t(card.action === 'record_return' ? 'card.resultReturn' : 'card.result', { ref: card.resultRef }),
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm" data-testid="draft-error">
          {error}
        </p>
      )}
      {pending && (
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => void decide('confirm')}
            data-testid="draft-confirm"
          >
            {t('card.confirm')}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => void decide('reject')}
            data-testid="draft-reject"
          >
            {t('card.reject')}
          </button>
        </div>
      )}
      {stepUp && (
        <StepUpDialog
          onVerified={() => {
            setStepUp(false);
            void decide('confirm');
          }}
          onCancel={() => setStepUp(false)}
        />
      )}
    </section>
  );
}
