import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { SiloMark } from './brand';
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
      <header className="flex items-center gap-2.5 bg-ink px-4 py-3 text-white md:px-8">
        <SiloMark />
        <span className="font-display text-lg font-extrabold tracking-wide">{t('title')}</span>
      </header>
      <SimBand locale={locale} />
      <main className="flex flex-1 items-start justify-center px-4 py-10 md:py-16">
        <div className={`w-full ${width}`}>
          <div className="border-t-[3px] border-ink pt-5">
            <h1 className="text-3xl">{title}</h1>
            <div className="mt-6">{children}</div>
          </div>
        </div>
      </main>
    </div>
  );
}
