'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LoginForm } from './login-form';
import { TwoFactorStep } from './two-factor-step';

/** Login: password, then (once enrolled) the second factor. */
export function LoginFlow({ locale }: { locale: string }) {
  const router = useRouter();
  const [step, setStep] = useState<'password' | 'second-factor'>('password');
  const done = () => {
    router.replace(`/${locale}`);
    router.refresh();
  };

  return step === 'password' ? (
    <LoginForm locale={locale} onTwoFactor={() => setStep('second-factor')} />
  ) : (
    <TwoFactorStep onDone={done} />
  );
}
