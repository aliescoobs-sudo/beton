'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';

/** Second login step: a TOTP code, or a single-use recovery code. */
export function TwoFactorStep({ onDone }: { onDone: () => void }) {
  const t = useTranslations('auth.twoFactor');
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [problem, setProblem] = useState<'invalid' | 'locked' | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '').trim();
    setPending(true);
    setProblem(null);
    try {
      const path = mode === 'totp' ? 'verify-totp' : 'verify-backup-code';
      const res = await fetch(`/api/auth/two-factor/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (res.ok) return onDone();
      setProblem(res.status === 429 ? 'locked' : 'invalid');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <h2 className="text-lg font-medium">{t('title')}</h2>
      <label className="block">
        <span className="field-label">{mode === 'totp' ? t('codeLabel') : t('recoveryLabel')}</span>
        <input
          key={mode}
          name="code"
          inputMode={mode === 'totp' ? 'numeric' : 'text'}
          autoComplete="one-time-code"
          required
          dir="ltr"
          className="input num mt-1 font-mono tracking-widest"
        />
      </label>
      {problem && (
        <p role="alert" className="text-sm text-status-late">
          {t(problem)}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn btn-primary w-full">
        {t('submit')}
      </button>
      <button
        type="button"
        onClick={() => setMode(mode === 'totp' ? 'recovery' : 'totp')}
        className="text-sm underline"
      >
        {mode === 'totp' ? t('useRecovery') : t('useTotp')}
      </button>
    </form>
  );
}
