import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { canFinance, financeEnabled, getFinanceCash } from '@/modules/finance';
import { listPlants } from '@/modules/master-data';
import { getDayCloseStatus, listDayCloses } from '@/modules/operations';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Button, Money, PageHeader, StatusPill } from '@/ui';
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
  // Cash per holder is money: only the roles that read the finance module, only when it is on. The balance at the end of the day is
  // the opening balance of the next one. Holders are not plants, so it is one figure for the whole company, not one per plant.
  const showCash =
    canFinance(user.role, 'finance.read') && getEnv().FINANCE_ENABLED && (await financeEnabled(pool));
  let cashByHolder: { holder: string; centimes: number }[] = [];
  if (showCash) {
    const next = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const cash = await getFinanceCash(pool, user, next, next);
    const sums = new Map<string, number>();
    for (const a of cash.accounts) sums.set(a.holder, (sums.get(a.holder) ?? 0) + a.balanceCentimes);
    cashByHolder = [...sums].map(([holder, centimes]) => ({ holder, centimes }));
  }
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
        {showCash && (
          <section className="rounded border p-3" data-testid="dayclose-cash">
            <h2 className="font-semibold">{t('cash.title')}</h2>
            <p className="text-sm text-muted">{t('cash.note')}</p>
            {cashByHolder.length === 0 ? (
              <p className="mt-2 text-sm">{t('cash.none')}</p>
            ) : (
              <ul className="mt-2 text-sm">
                {cashByHolder.map((h) => (
                  <li key={h.holder} data-testid={`dayclose-cash-${h.holder}`}>
                    {t(`cash.holder.${h.holder}` as never)}: <Money centimes={h.centimes} />
                  </li>
                ))}
                <li className="font-medium">
                  {t('cash.total')}: <Money centimes={cashByHolder.reduce((s, h) => s + h.centimes, 0)} />
                </li>
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
