import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { listPlants } from '@/modules/master-data';
import { getDayCloseStatus, listDayCloses } from '@/modules/operations';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Button, PageHeader, StatusPill } from '@/ui';
import { closeDayAction } from './actions';

/** The day close per plant: unconfirmed loads, missing BLs, stock variance. Blocking items stop the close and go to the owner (§16.9). */
export default async function DayClosePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (!getEnv().TRANSFERS_ENABLED) notFound();
  const user = await requirePagePermission(locale, 'dayclose.read');
  const pool = getPool('app');
  const today = (await getRequestClock()).today();
  const plants = (await listPlants(pool, user)).filter((p) => p.status === 'active');
  const closes = await listDayCloses(pool, user, today, today);
  const statuses = await Promise.all(
    plants.map((p) => getDayCloseStatus(pool, user, { plantId: p.id, date: today })),
  );
  const t = await getTranslations('dayClose');
  const write = can(user.role, 'dayclose.write');
  const canForce = user.role === 'owner' || user.role === 'app_admin';
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro', { date: today })} />
      <div className="mt-4 space-y-4">
        {plants.map((p, index) => {
          const status = statuses[index]!;
          const closed = closes.find((c) => c.plantId === p.id);
          return (
            <section key={p.id} className="rounded border p-3" data-testid={`dayclose-${p.code}`}>
              <h2 className="font-semibold">
                {p.name}{' '}
                {closed && (
                  <StatusPill status="paid">{closed.forced ? t('closedForced') : t('closed')}</StatusPill>
                )}
              </h2>
              {status.ok && (
                <ul className="mt-2 text-sm">
                  {status.value.map((i) => (
                    <li key={i.kind}>
                      {t(`item.${i.kind}` as never)}: {i.n}{' '}
                      {i.blocking && i.n > 0 ? `· ${t('blocking')}` : ''}
                      {i.refs.length > 0 && <span className="text-muted"> ({i.refs.join(', ')})</span>}
                    </li>
                  ))}
                </ul>
              )}
              {write && !closed && (
                <form action={closeDayAction} className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <input type="hidden" name="plantId" value={p.id} />
                  <input type="hidden" name="date" value={today} />
                  {canForce && (
                    <>
                      <label>
                        <input type="checkbox" name="force" /> {t('force')}
                      </label>
                      <input name="note" placeholder={t('note')} />
                    </>
                  )}
                  <Button type="submit">{t('close')}</Button>
                </form>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
