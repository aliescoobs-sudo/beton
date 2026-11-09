import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { PublicFrame } from '../shell/public-frame';

/** The branded 404 (fr/ar): the KAYAS frame, one sentence, one way home. Reveals nothing about which addresses exist. */
export default async function NotFound() {
  const locale = await getLocale();
  const t = await getTranslations('shell.notFound');
  return (
    <PublicFrame locale={locale} title={t('title')} width="max-w-md">
      <p className="text-sm font-semibold text-muted" data-testid="not-found-code">
        <bdi dir="ltr">404</bdi> <span className="sr-only">{t('code')}</span>
      </p>
      <span aria-hidden="true" className="mt-3 block h-1 w-12 bg-citron" />
      <p className="mt-4" data-testid="not-found-body">
        {t('body')}
      </p>
      <Link href={`/${locale}`} className="btn btn-primary mt-6" data-testid="not-found-home">
        {t('home')}
      </Link>
    </PublicFrame>
  );
}
