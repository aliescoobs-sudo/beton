import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { libraryKinds, listDocumentLibrary } from '@/modules/ledger';
import { isDocumentKind } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';

/** The document library (§16.2): only the types the role may open, every open checked again and audited. */
export default async function DocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ kind?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'documents.read');
  const { kind } = await searchParams;
  const filter = kind && isDocumentKind(kind) ? kind : undefined;
  const entries = await listDocumentLibrary(getPool('app'), user, filter);
  const kinds = libraryKinds(user.role);
  const t = await getTranslations('library');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      <nav className="mt-4 flex flex-wrap gap-2 text-sm" data-testid="library-kinds">
        <a href={`/${locale}/documents`} className="underline">
          {t('all')}
        </a>
        {kinds.map((k) => (
          <a
            key={k}
            href={`/${locale}/documents?kind=${k}`}
            className="underline"
            data-testid={`library-kind-${k}`}
          >
            {t(`kind.${k}`)}
          </a>
        ))}
      </nav>
      {entries.length === 0 ? (
        <p className="mt-6 text-sm text-muted">{t('empty')}</p>
      ) : (
        <ul className="mt-4 divide-y divide-border" data-testid="library-list">
          {entries.map((e) => (
            <li key={`${e.kind}-${e.id}`} className="flex items-center justify-between py-2 text-sm">
              <span>
                {t(`kind.${e.kind}`)} · {e.number} · {e.date}
                {e.party ? ` · ${e.party}` : ''}
              </span>
              <a className="underline" href={`/${locale}/documents/${e.kind}/${e.id}`}>
                {t('open')}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
