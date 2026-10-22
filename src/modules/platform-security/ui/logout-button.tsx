'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

/** Ends the session server-side, then returns to the login page. */
export function LogoutButton({ locale }: { locale: string }) {
  const t = useTranslations('auth.session');
  const router = useRouter();
  async function logout() {
    await fetch('/api/auth/sign-out', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    router.replace(`/${locale}/login`);
    router.refresh();
  }
  return (
    <button
      type="button"
      onClick={logout}
      className="btn btn-ghost w-full justify-start"
      data-testid="logout"
      role="menuitem"
    >
      {t('logout')}
    </button>
  );
}
