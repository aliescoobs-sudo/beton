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
    <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
      <label className="block">
        <span className="text-sm font-medium">{t('email')}</span>
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          dir="ltr"
          className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium">{t('password')}</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
        />
      </label>
      {problem && (
        <p role="alert" className="text-sm text-red-700">
          {t(problem)}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded bg-gray-900 px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        {t('submit')}
      </button>
    </form>
  );
}
