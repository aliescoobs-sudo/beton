import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { daysBetween, listInstruments } from '@/modules/ledger';
import { InstrumentsTable } from '@/modules/ledger/ui/instruments/instruments-table';
import { recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';

/** The instruments with their state, early and post-dated badges and the regularization countdown. Owner and support. */
export default async function InstrumentsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'instruments.read');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:instruments');
  const [instruments, clock] = await Promise.all([listInstruments(pool, user), getRequestClock()]);
  const today = clock.today();
  const t = await getTranslations('ledger.instruments');
  return (
    <div>
      <PageHeader title={t('title')} />
      <InstrumentsTable
        today={today}
        rows={instruments.map((i) => {
          const bounced = i.events.find((e) => e.event === 'bounced');
          return {
            ...i,
            daysLeft:
              i.state === 'bounced' && bounced?.regularizationDeadline
                ? daysBetween(today, bounced.regularizationDeadline)
                : null,
            deadline: bounced?.regularizationDeadline ?? null,
            earlyEvent: i.events.some((e) => e.early),
          };
        })}
      />
    </div>
  );
}
