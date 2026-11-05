import { redirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getEnv } from '@/lib/server-env';
import { isTrainingEmail } from '@/lib/training';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { PublicFrame } from '../../shell/public-frame';
import { EnrolFlow } from '@/modules/platform-security/ui/enrol-flow';

export default async function EnrolPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const state = await currentAuthState();
  if (state.kind === 'anonymous') redirect(`/${locale}/login`);
  // R11-08: in training a password-only account may choose to enrol a real authenticator (finance needs one); nobody else may come here signed in.
  const voluntary =
    state.kind === 'authenticated' &&
    getEnv().TRAINING_MODE &&
    !state.user.twoFactorEnabled &&
    isTrainingEmail(state.user.email);
  if (state.kind === 'authenticated' && !voluntary) redirect(`/${locale}`);
  const t = await getTranslations('auth.enrol');
  return (
    <PublicFrame locale={locale} title={t('title')} width="max-w-md">
      <EnrolFlow locale={locale} />
    </PublicFrame>
  );
}
