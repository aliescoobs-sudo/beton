'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Button, Dialog, Field, Input, useToast } from '@/ui';

/** Asks for a fresh TOTP before a sensitive action; the caller retries the action once on success. */
export function StepUpDialog({ onVerified, onCancel }: { onVerified: () => void; onCancel: () => void }) {
  const t = useTranslations('auth.stepUp');
  const toast = useToast();
  const [invalid, setInvalid] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setInvalid(false);
    try {
      const code = String(new FormData(event.currentTarget).get('code') ?? '').trim();
      const res = await fetch('/api/auth/two-factor/verify-totp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        toast.show(t('verified'));
        return onVerified();
      }
      setInvalid(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog title={t('title')} onClose={onCancel}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">{t('intro')}</p>
        <Field label={t('code')}>
          <Input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            autoFocus
            dir="ltr"
            className="num font-mono tracking-widest"
          />
        </Field>
        {invalid && (
          <p role="alert" className="field-error">
            {t('invalid')}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={pending} className="flex-1">
            {t('confirm')}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            {t('cancel')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
