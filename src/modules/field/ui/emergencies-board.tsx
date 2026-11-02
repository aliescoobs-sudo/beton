'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button, StatusPill } from '@/ui';
import type { OpenEmergency } from '../service/field-service';

type Result = { ok: true } | { ok: false; error: string };

/** The office sees the alert and answers: continue, extra load, redirect (with the new address), or join another truck. */
export function EmergenciesBoard({
  emergencies,
  instruct,
  canInstruct,
}: {
  emergencies: OpenEmergency[];
  instruct: ((input: unknown) => Promise<Result>) | null;
  canInstruct: boolean;
}) {
  const t = useTranslations('field.board');
  const to = useTranslations('field.options');
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function send(emergencyId: string, form: HTMLFormElement) {
    const data = new FormData(form);
    const kind = String(data.get('kind'));
    const r = await instruct!({
      emergencyId,
      kind,
      address: String(data.get('address') ?? '').trim() || undefined,
      note: String(data.get('note') ?? '').trim() || undefined,
    });
    if (r.ok) {
      setMessage(t('sent'));
      setOpen(null);
      return router.refresh();
    }
    setMessage(t('error'));
  }

  return (
    <div className="mt-6 space-y-4" data-testid="emergencies">
      {message && (
        <p role="status" className="text-sm" data-testid="emergencies-message">
          {message}
        </p>
      )}
      {emergencies.length === 0 && (
        <p className="text-sm text-muted" data-testid="emergencies-none">
          {t('none')}
        </p>
      )}
      <ul className="space-y-3">
        {emergencies.map((e) => (
          <li key={e.id} className="card space-y-2 p-4" data-testid={`emergency-${e.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={e.resolvedAt ? 'paid' : 'late'}>
                {e.resolvedAt ? t('handled') : t('open')}
              </StatusPill>
              <strong>{to(e.option as never)}</strong>
              <span className="text-sm">{t('at', { step: e.step })}</span>
              {e.pctUnloaded !== null && <span className="text-sm">{t('pct', { pct: e.pctUnloaded })}</span>}
            </div>
            <p className="text-sm">
              {e.driverName} · <bdi dir="ltr">{e.truckCode}</bdi> · <bdi dir="ltr">{e.orderCode}</bdi> ·{' '}
              {e.clientName}
              {e.siteLabel ? ` · ${e.siteLabel}` : ''} ·{' '}
              <bdi dir="ltr">{(e.volumeL / 1000).toLocaleString('fr-FR')} m³</bdi>
            </p>
            {canInstruct && !e.resolvedAt && (
              <>
                <Button
                  type="button"
                  small
                  variant="secondary"
                  onClick={() => setOpen(open === e.id ? null : e.id)}
                  data-testid={`instruct-open-${e.id}`}
                >
                  {t('instruct')}
                </Button>
                {open === e.id && (
                  <form
                    className="form-band flex flex-wrap items-end gap-3"
                    onSubmit={(ev) => {
                      ev.preventDefault();
                      void send(e.id, ev.currentTarget);
                    }}
                    data-testid={`instruct-form-${e.id}`}
                  >
                    <label className="block">
                      <span className="field-label">{t('kind')}</span>
                      <select name="kind" className="input mt-1" defaultValue="continue">
                        {(['continue', 'extra_load', 'redirect'] as const).map((k) => (
                          <option key={k} value={k}>
                            {t(`kinds.${k}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="field-label">{t('address')}</span>
                      <input name="address" maxLength={300} className="input mt-1 w-64" />
                    </label>
                    <label className="block">
                      <span className="field-label">{t('note')}</span>
                      <input name="note" maxLength={300} className="input mt-1 w-56" />
                    </label>
                    <Button type="submit" data-testid={`instruct-send-${e.id}`}>
                      {t('send')}
                    </Button>
                  </form>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
