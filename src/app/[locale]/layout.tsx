import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { directionOf, routing } from '@/i18n/routing';
import { formatSimDate, SimBadge } from '@/modules/clock';
import { FakeDataBanner } from '@/modules/platform-security/ui/fake-data-banner';
import { AdvanceSlot } from '../advance-slot';
import { getRequestClock } from '../request-clock';
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
  const clock = await getRequestClock();
  const t = await getTranslations('clock');

  return (
    <html lang={locale} dir={directionOf(locale)}>
      <body>
        <NextIntlClientProvider>
          {clock.simulated && (
            <SimBadge label={t('simulation')} at={formatSimDate(clock.now(), locale)}>
              <AdvanceSlot />
            </SimBadge>
          )}
          <FakeDataBanner />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
