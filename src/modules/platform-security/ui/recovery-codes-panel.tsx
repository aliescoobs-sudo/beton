'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { StepUpDialog } from './step-up-dialog';

/** Regenerate recovery codes (sensitive: step-up). The new set is shown once; the old set stops working. */
export function RecoveryCodesPanel() {
  const t = useTranslations('auth.security');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [problem, setProblem] = useState<'invalidPassword' | 'error' | null>(null);

  async function regenerate(pw: string) {
    setProblem(null);
    const res = await fetch('/api/auth/two-factor/generate-backup-codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    if (res.ok) {
      setPassword(null);
      return setCodes(((await res.json()) as { backupCodes: string[] }).backupCodes);
    }
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    if (body.code === 'STEP_UP_REQUIRED') return setStepUp(true);
    setPassword(null);
    setProblem(res.status === 400 || res.status === 401 ? 'invalidPassword' : 'error');
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pw = String(new FormData(event.currentTarget).get('password') ?? '');
    setPassword(pw);
    void regenerate(pw);
  }

  return (
    <section className="mt-6 space-y-3">
      <h2 className="text-xl">{t('recoveryTitle')}</h2>
      <p className="text-sm">{t('recoveryIntro')}</p>
      {codes ? (
        <div>
          <p className="text-sm font-medium">{t('newCodes')}</p>
          <ol dir="ltr" className="mt-2 grid grid-cols-2 gap-1 font-mono" data-testid="recovery-codes">
            {codes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ol>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="field-label">{t('password')}</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="input mt-1"
            />
          </label>
          {problem && (
            <p role="alert" className="text-sm text-danger">
              {t(problem)}
            </p>
          )}
          <button type="submit" className="btn btn-primary">
            {t('regenerate')}
          </button>
        </form>
      )}
      {stepUp && (
        <StepUpDialog
          onVerified={() => {
            setStepUp(false);
            if (password !== null) void regenerate(password); // retry once
          }}
          onCancel={() => {
            setStepUp(false);
            setPassword(null);
          }}
        />
      )}
    </section>
  );
}
