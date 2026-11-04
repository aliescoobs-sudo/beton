import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { directionOf, routing } from '@/i18n/routing';
import { TrainingBanner } from '@/modules/platform-security/ui/training-banner';
import { FakeDataBanner } from '@/modules/platform-security/ui/fake-data-banner';
import { ToastProvider } from '@/ui';
import { fontClasses } from '../fonts';
import '../globals.css';

export const metadata = { manifest: '/app.webmanifest' };
// Every page depends on the session and the database: none is prerendered at build time (the image build has no secrets).
export const dynamic = 'force-dynamic';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations('shell');

  return (
    <html lang={locale} dir={directionOf(locale)} className={fontClasses}>
      <body>
        <NextIntlClientProvider>
          <TrainingBanner />
          <FakeDataBanner />
          <ToastProvider dismissLabel={t('dismiss')}>{children}</ToastProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
