import { getTranslations, setRequestLocale } from 'next-intl/server';
import { RecoveryCodesPanel } from '@/modules/platform-security/ui/recovery-codes-panel';

export default async function SecurityPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('auth.security');
  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <RecoveryCodesPanel />
    </main>
  );
}
