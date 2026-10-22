import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { directionOf, routing } from '@/i18n/routing';
import { FakeDataBanner } from '@/modules/platform-security/ui/fake-data-banner';
import { ToastProvider } from '@/ui';
import { plexArabic, plexSans } from '../fonts';
import '../globals.css';

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
    <html lang={locale} dir={directionOf(locale)} className={`${plexSans.variable} ${plexArabic.variable}`}>
      <body>
        <NextIntlClientProvider>
          <FakeDataBanner />
          <ToastProvider dismissLabel={t('dismiss')}>{children}</ToastProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
