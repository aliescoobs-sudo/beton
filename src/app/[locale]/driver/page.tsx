import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { getEnv } from '@/lib/server-env';
import { FieldApp } from '@/modules/field/ui/field-app';

// The module flag is read per request, never baked into the build.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { manifest: '/driver.webmanifest', title: 'BELGOBETON' };

/** The driver and pump operator phone app (R4). Its own sign-in (code and PIN), outside the office navigation. */
export default async function DriverPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (!getEnv().FIELD_APP_ENABLED) notFound();
  const env = getEnv();
  // R11-07: no push subscription action in training mode (or without the notifications module).
  return <FieldApp locale={locale} pushAvailable={env.NOTIFICATIONS_ENABLED && !env.TRAINING_MODE} />;
}
