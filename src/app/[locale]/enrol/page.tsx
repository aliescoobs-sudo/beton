import { redirect } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { PublicFrame } from '../../shell/public-frame';
import { EnrolFlow } from '@/modules/platform-security/ui/enrol-flow';

export default async function EnrolPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const state = await currentAuthState();
  if (state.kind === 'anonymous') redirect(`/${locale}/login`);
  if (state.kind === 'authenticated') redirect(`/${locale}`);
  const t = await getTranslations('auth.enrol');
  return (
    <PublicFrame locale={locale} title={t('title')} width="max-w-md">
      <EnrolFlow locale={locale} />
    </PublicFrame>
  );
}
