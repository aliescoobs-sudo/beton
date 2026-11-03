import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { isRealDate } from '@/modules/ledger';
import { getPumpCoordination, listPumpOptions } from '@/modules/operations';
import { PumpBoard } from '@/modules/operations/ui/pump-board';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Button, Input, PageHeader } from '@/ui';
import { markPumpedAction, reschedulePumpAction, resolveConflictAction, schedulePumpAction } from './actions';

/** Pump coordination of a day (REQUIREMENTS-V1 §16.6): pumped pours, pumps on site, conflicts. Times and quantities only. */
export default async function PumpsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'pumps.read');
  const query = await searchParams;
  const today = (await getRequestClock()).today();
  const date = query.date && isRealDate(query.date) ? query.date : today;
  const pool = getPool('app');
  const [day, options] = await Promise.all([
    getPumpCoordination(pool, user, date),
    listPumpOptions(pool, user),
  ]);
  const t = await getTranslations('pumps');
  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('intro')} />
      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="field-label">{t('date')}</span>
          <Input type="date" name="date" defaultValue={date} dir="ltr" data-testid="pumps-date" />
        </label>
        <Button type="submit" variant="secondary">
          {t('show')}
        </Button>
      </form>
      <PumpBoard
        date={date}
        board={day.board}
        waiting={day.waiting}
        conflicts={day.conflicts}
        pumps={options.pumps}
        operators={options.operators}
        editable={can(user.role, 'pumps.plan')}
        markPumped={markPumpedAction}
        schedule={schedulePumpAction}
        reschedule={reschedulePumpAction}
        resolve={resolveConflictAction}
      />
    </div>
  );
}
