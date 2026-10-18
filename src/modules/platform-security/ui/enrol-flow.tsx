'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { totpQrForEnrolment } from './totp-qr-action';

type Enrolment = { totpURI: string; backupCodes: string[] };

/** Mandatory 2FA enrolment: confirm password → key + recovery codes (shown once) → confirm a first code. */
export function EnrolFlow({ locale, reenrol = false }: { locale: string; reenrol?: boolean }) {
  const t = useTranslations('auth.enrol');
  const router = useRouter();
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<'invalidPassword' | 'invalidCode' | 'error' | null>(null);
  const [pending, setPending] = useState(false);

  async function post(path: string, body: unknown) {
    return fetch(`/api/auth/two-factor/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setProblem(null);
    try {
      const res = await post('enable', { password: new FormData(event.currentTarget).get('password') });
      if (!res.ok) return setProblem(res.status === 400 || res.status === 401 ? 'invalidPassword' : 'error');
      const data = (await res.json()) as Enrolment;
      setEnrolment(data);
      setQr(await totpQrForEnrolment(data.totpURI).catch(() => null)); // the key + link below stay as fallback
    } finally {
      setPending(false);
    }
  }

  async function finish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setProblem(null);
    try {
      const code = String(new FormData(event.currentTarget).get('code') ?? '').trim();
      const res = await post('verify-totp', { code });
      if (!res.ok) return setProblem('invalidCode');
      router.replace(`/${locale}`);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  const error = problem && (
    <p role="alert" className="text-sm text-red-700">
      {t(problem)}
    </p>
  );
  const input = 'mt-1 block w-full rounded border border-gray-300 px-3 py-2';
  const button = 'w-full rounded bg-gray-900 px-4 py-2 font-medium text-white disabled:opacity-50';

  if (!enrolment) {
    return (
      <form onSubmit={start} className="mt-6 space-y-4">
        <p>{reenrol ? t('reenrolIntro') : t('intro')}</p>
        <label className="block">
          <span className="text-sm font-medium">{t('confirmPassword')}</span>
          <input name="password" type="password" autoComplete="current-password" required className={input} />
        </label>
        {error}
        <button type="submit" disabled={pending} className={button}>
          {t('start')}
        </button>
      </form>
    );
  }

  const secret = new URL(enrolment.totpURI).searchParams.get('secret') ?? '';
  return (
    <div className="mt-6 space-y-6">
      {qr && (
        <section>
          <p className="text-sm">{t('qrIntro')}</p>
          <Image
            unoptimized
            src={qr}
            alt={t('qrAlt')}
            width={192}
            height={192}
            className="mt-2 bg-white p-2"
            data-testid="totp-qr"
          />
        </section>
      )}
      <section>
        <p className="text-sm font-medium">{t('keyLabel')}</p>
        <p
          dir="ltr"
          className="mt-1 break-all rounded bg-gray-100 p-3 font-mono text-lg tracking-wider"
          data-testid="totp-secret"
        >
          {secret.match(/.{1,4}/g)?.join(' ')}
        </p>
        <a href={enrolment.totpURI} className="mt-2 inline-block text-sm underline">
          {t('openApp')}
        </a>
      </section>
      <section>
        <h2 className="font-medium">{t('codesTitle')}</h2>
        <p className="mt-1 text-sm">{t('codesIntro')}</p>
        <ol dir="ltr" className="mt-2 grid grid-cols-2 gap-1 font-mono" data-testid="recovery-codes">
          {enrolment.backupCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ol>
        <label className="mt-3 flex items-center gap-2">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <span className="text-sm">{t('codesSaved')}</span>
        </label>
      </section>
      {saved && (
        <form onSubmit={finish} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium">{t('confirmCode')}</span>
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              dir="ltr"
              className={input}
            />
          </label>
          {error}
          <button type="submit" disabled={pending} className={button}>
            {t('finish')}
          </button>
        </form>
      )}
    </div>
  );
}
