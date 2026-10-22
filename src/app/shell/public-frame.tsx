import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Card } from '@/ui';
import { SimPill } from './sim-pill';

/** Frame of the pages shown before sign-in (login, enrolment): brand, simulation pill, one centred card. */
export async function PublicFrame({
  locale,
  title,
  children,
  width = 'max-w-sm',
}: {
  locale: string;
  title: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  const t = await getTranslations('shell');
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-4 py-3 md:px-8">
        <span className="text-base font-semibold tracking-wide">{t('title')}</span>
        <SimPill locale={locale} />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 py-8 md:items-center">
        <Card className={`w-full ${width} p-6 md:p-8`}>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <div className="mt-5">{children}</div>
        </Card>
      </main>
    </div>
  );
}
