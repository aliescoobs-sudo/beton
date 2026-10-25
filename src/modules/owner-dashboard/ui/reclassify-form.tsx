'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { StepUpDialog } from '@/modules/platform-security/ui/step-up-dialog';
import { Button } from '@/ui';

export type ReclassifyResult = { ok: true } | { ok: false; error: string };

/** The owner sets another severity with a mandatory reason (R18); a fresh second factor is asked. */
export function ReclassifyForm({
  alertKey,
  options,
  reclassify,
}: {
  alertKey: string;
  options: { value: string; label: string }[];
  reclassify: (input: { alertKey: string; severity: string; reason: string }) => Promise<ReclassifyResult>;
}) {
  const t = useTranslations('dashboard.reclassify');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => Promise<ReclassifyResult>) | null>(null);

  async function run(action: () => Promise<ReclassifyResult>) {
    const result = await action();
    if (result.ok) {
      setOpen(false);
      return router.refresh();
    }
    if (result.error === 'STEP_UP_REQUIRED') return setRetry(() => action);
    setMessage(
      result.error === 'SAME_SEVERITY' ? t('same') : result.error === 'INVALID' ? t('invalid') : t('error'),
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setMessage(null);
    void run(() =>
      reclassify({
        alertKey,
        severity: String(data.get('severity') ?? ''),
        reason: String(data.get('reason') ?? ''),
      }),
    );
  }

  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="reclassify-open">
        {t('button')}
      </Button>
    );
  return (
    <form onSubmit={submit} className="form-band space-y-3" data-testid="reclassify-form">
      <p className="field-label">{t('title')}</p>
      <label className="block">
        <span className="field-label">{t('severity')}</span>
        <select name="severity" className="input mt-1">
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="field-label">{t('reason')}</span>
        <input
          name="reason"
          required
          minLength={3}
          maxLength={500}
          className="input mt-1 w-full max-w-md"
          data-testid="reclassify-reason"
        />
      </label>
      <p className="text-sm text-muted">{t('hint')}</p>
      <div className="flex gap-2">
        <Button type="submit" data-testid="reclassify-confirm">
          {t('confirm')}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          {t('cancel')}
        </Button>
      </div>
      {message && (
        <p role="alert" className="text-sm font-semibold">
          {message}
        </p>
      )}
      {retry && (
        <StepUpDialog
          onVerified={() => {
            const again = retry;
            setRetry(null);
            void run(again);
          }}
          onCancel={() => setRetry(null)}
        />
      )}
    </form>
  );
}
