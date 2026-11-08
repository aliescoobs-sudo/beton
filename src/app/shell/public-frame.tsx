import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Brand } from '@/ui';
import { SimBand } from './sim-band';

/** Frame of the pages shown before sign-in (login, enrolment): the ink brand bar, the simulation band, one ruled block. */
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
      <header className="on-forest flex items-center bg-forest px-4 py-2 text-white md:px-8">
        <Brand tone="white" width={200} />
      </header>
      <SimBand locale={locale} />
      <main className="flex flex-1 items-start justify-center px-4 py-10 md:py-16">
        <div className={`w-full ${width}`}>
          <div className="border-t-[3px] border-forest pt-5">
            <h1 className="text-3xl">{title}</h1>
            <div className="mt-6">{children}</div>
          </div>
        </div>
      </main>
      {/* The descriptor is its own line, never part of the logo. */}
      <footer className="px-4 py-6 text-center text-sm text-muted" data-testid="brand-descriptor">
        {t('descriptor')}
      </footer>
    </div>
  );
}
