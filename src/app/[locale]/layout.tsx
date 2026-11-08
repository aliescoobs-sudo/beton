import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { directionOf, routing } from '@/i18n/routing';
import { TrainingBanner } from '@/modules/platform-security/ui/training-banner';
import { FakeDataBanner } from '@/modules/platform-security/ui/fake-data-banner';
import { ToastProvider } from '@/ui';
import '../globals.css';

export const metadata: Metadata = {
  title: { default: 'KAYAS', template: '%s · KAYAS' },
  manifest: '/app.webmanifest',
  icons: {
    icon: [
      { url: '/icons/favicon.ico', sizes: '16x16 32x32 48x48' },
      { url: '/icons/32/kayas-favicon-colour-on-white.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/48/kayas-favicon-colour-on-white.png', sizes: '48x48', type: 'image/png' },
    ],
    apple: [{ url: '/icons/180/kayas-apple-touch-white-on-forest.png', sizes: '180x180', type: 'image/png' }],
  },
};
export const viewport: Viewport = { themeColor: '#01592b' };
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
    <html lang={locale} dir={directionOf(locale)}>
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
