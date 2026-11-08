'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';

type Problem = 'invalid' | 'locked' | 'error' | null;

/** Password step. Shows only generic messages, so it never reveals whether an account exists. */
export function LoginForm({ locale, onTwoFactor }: { locale: string; onTwoFactor?: () => void }) {
  const t = useTranslations('auth.login');
  const [problem, setProblem] = useState<Problem>(null);
  const [pending, setPending] = useState(false);
  const router = useRouter();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setProblem(null);
    try {
      const res = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      });
      if (res.status === 429) return setProblem('locked');
      if (!res.ok) return setProblem(res.status === 401 || res.status === 400 ? 'invalid' : 'error');
      const body = (await res.json()) as { twoFactorRedirect?: boolean };
      if (body.twoFactorRedirect && onTwoFactor) return onTwoFactor();
      router.replace(`/${locale}`);
      router.refresh();
    } catch {
      setProblem('error');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <label className="block">
        <span className="field-label">{t('email')}</span>
        <input name="email" type="email" autoComplete="username" required dir="ltr" className="input mt-1" />
      </label>
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
      <button type="submit" disabled={pending} className="btn btn-primary w-full">
        {t('submit')}
      </button>
    </form>
  );
}
