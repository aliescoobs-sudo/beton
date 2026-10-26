import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { searchDocuments } from '@/modules/ledger';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, PageHeader } from '@/ui';

/**
 * Search by document number: exact or prefix, four characters at least. What is found is what the signed-in role may read, with a
 * link where it may open it; there is no search on names. Unknown probes are audited and rate-limited.
 */
export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'search.number');
  const raw = (await searchParams).q;
  const q = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  const t = await getTranslations('search');
  const result = q.trim() === '' ? null : await searchDocuments(getPool('app'), user, q);
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      <form method="get" role="search" className="mt-4 flex max-w-xl gap-2" data-testid="search-page-form">
        <input
          name="q"
          type="search"
          defaultValue={q}
          minLength={4}
          maxLength={40}
          required
          dir="ltr"
          autoComplete="off"
          placeholder="FA-2026-00001"
          aria-label={t('label')}
          className="input num flex-1"
          data-testid="search-input"
        />
        <button type="submit" className="btn btn-primary" data-testid="search-submit">
          {t('submit')}
        </button>
      </form>
      <div className="mt-6" data-testid="search-results">
        {result === null ? null : !result.ok ? (
          <p role="alert" className="field-error" data-testid="search-error">
            {t(`errors.${result.error}`)}
          </p>
        ) : result.value.length === 0 ? (
          <EmptyState title={t('none')} data-testid="search-none" />
        ) : (
          <ul className="space-y-1">
            {result.value.map((r) => (
              <li key={`${r.kind}-${r.code}`} data-testid={`search-hit-${r.code}`}>
                <span className="field-label me-2">{t(`kinds.${r.kind}`)}</span>
                {r.path ? (
                  <a href={`/${locale}${r.path}`} className="underline">
                    <bdi dir="ltr">{r.code}</bdi>
                  </a>
                ) : (
                  <bdi dir="ltr">{r.code}</bdi>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
