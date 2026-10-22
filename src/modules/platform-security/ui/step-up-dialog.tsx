'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';

/** Asks for a fresh TOTP before a sensitive action; the caller retries the action once on success. */
export function StepUpDialog({ onVerified, onCancel }: { onVerified: () => void; onCancel: () => void }) {
  const t = useTranslations('auth.stepUp');
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
      if (res.ok) return onVerified();
      setInvalid(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="step-up-title"
      className="fixed inset-0 flex items-center justify-center bg-black/40 p-4"
    >
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded bg-white p-6 text-gray-900">
        <h2 id="step-up-title" className="text-lg font-medium">
          {t('title')}
        </h2>
        <p className="text-sm">{t('intro')}</p>
        <label className="block">
          <span className="text-sm font-medium">{t('code')}</span>
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            autoFocus
            dir="ltr"
            className="mt-1 block w-full rounded border border-gray-300 px-3 py-2 font-mono tracking-widest"
          />
        </label>
        {invalid && (
          <p role="alert" className="text-sm text-red-700">
            {t('invalid')}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={pending}
            className="flex-1 rounded bg-gray-900 px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            {t('confirm')}
          </button>
          <button type="button" onClick={onCancel} className="rounded border border-gray-300 px-4 py-2">
            {t('cancel')}
          </button>
        </div>
      </form>
    </div>
  );
}
