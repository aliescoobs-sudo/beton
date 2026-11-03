import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { getOrderTimeline } from '@/modules/operations';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, PageHeader } from '@/ui';

/** One timeline per order: each step with who did it, the device time and the server sync time (§16.8). No amount. */
export default async function OrderTimelinePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  if (!getEnv().TRANSFERS_ENABLED) notFound();
  const user = await requirePagePermission(locale, 'timeline.read');
  const entries = await getOrderTimeline(getPool('app'), user, id);
  const t = await getTranslations('timeline');
  const fmt = (iso: string) => iso.replace('T', ' ').slice(0, 19);
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {entries.length === 0 ? (
        <EmptyState title={t('none')} />
      ) : (
        <ol className="mt-4 space-y-1 text-sm" data-testid="timeline">
          {entries.map((e, i) => (
            <li key={i} data-testid={`timeline-${e.step}`}>
              <strong>{t(`step.${e.step}` as never)}</strong> {e.ref && <bdi dir="ltr">{e.ref}</bdi>} ·{' '}
              {e.actorName ?? '—'} ·{' '}
              <span title={t('deviceTime')}>
                <bdi dir="ltr">{fmt(e.at)}</bdi>
              </span>
              {e.syncedAt !== e.at && (
                <span className="text-muted" title={t('syncTime')}>
                  {' '}
                  → <bdi dir="ltr">{fmt(e.syncedAt)}</bdi>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
