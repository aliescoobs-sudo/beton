import { redirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getEnv } from '@/lib/server-env';
import { offersFinanceEnrolment } from '@/lib/training';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { PublicFrame } from '../../shell/public-frame';
import { EnrolFlow } from '@/modules/platform-security/ui/enrol-flow';

export default async function EnrolPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const state = await currentAuthState();
  if (state.kind === 'anonymous') redirect(`/${locale}/login`);
  // R11-08 / R12-07: in training a password-only account of the owner, app_admin or accountant role may choose to enrol a real
  // authenticator (finance needs one). The page enforces that itself: any other signed-in account is sent home.
  const voluntary =
    state.kind === 'authenticated' && getEnv().TRAINING_MODE && offersFinanceEnrolment(state.user);
  if (state.kind === 'authenticated' && !voluntary) redirect(`/${locale}`);
  const t = await getTranslations('auth.enrol');
  return (
    <PublicFrame locale={locale} title={t('title')} width="max-w-md">
      <EnrolFlow locale={locale} />
    </PublicFrame>
  );
}
