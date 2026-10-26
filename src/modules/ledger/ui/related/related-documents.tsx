import { getTranslations } from 'next-intl/server';
import type { RelatedDocument, RelatedKind } from '../../domain/related';

/**
 * "Documents liés": the neighbours of a document, each by its number; a link only where the caller can open it, a plain number
 * otherwise (AC-INT-17). The items come from the database relations and the caller's own row-level security.
 */
export async function RelatedDocuments({
  items,
  locale,
  className,
}: {
  items: readonly RelatedDocument[];
  locale: string;
  className?: string;
}) {
  const t = await getTranslations('related');
  if (items.length === 0) return null;
  const kinds = [...new Set(items.map((i) => i.kind))] as RelatedKind[];
  return (
    <section
      aria-labelledby="related-title"
      className={`no-print ${className ?? ''}`}
      data-testid="related-documents"
    >
      <h2 id="related-title" className="mb-2 text-xl">
        {t('title')}
      </h2>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
        {kinds.map((kind) => (
          <div key={kind} className="contents" data-testid={`related-${kind}`}>
            <dt className="field-label">{t(`kinds.${kind}`)}</dt>
            <dd>
              {items
                .filter((i) => i.kind === kind)
                .map((i, n) => (
                  <span key={`${i.code}-${n}`}>
                    {n > 0 && ', '}
                    {i.path ? (
                      <a
                        href={`/${locale}${i.path}`}
                        className="underline"
                        data-testid={`related-link-${i.code}`}
                      >
                        <bdi dir="ltr">{i.code}</bdi>
                      </a>
                    ) : (
                      <bdi dir="ltr" data-testid={`related-plain-${i.code}`}>
                        {i.code}
                      </bdi>
                    )}
                  </span>
                ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
