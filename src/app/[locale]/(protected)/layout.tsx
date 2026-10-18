import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';

/** Every page in this group needs a fully authenticated (password + 2FA) session. */
export default async function ProtectedLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const state = await currentAuthState();
  if (state.kind === 'anonymous') redirect(`/${locale}/login`);
  if (state.kind === 'needs_enrolment') redirect(`/${locale}/enrol`);
  return <>{children}</>;
}
