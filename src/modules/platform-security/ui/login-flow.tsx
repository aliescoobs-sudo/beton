'use client';

import { LoginForm } from './login-form';

/** Login steps. T9: password only; the TOTP step is added in T10. */
export function LoginFlow({ locale }: { locale: string }) {
  return <LoginForm locale={locale} />;
}
