import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { isRealDate } from '@/modules/ledger';
import { listTrips } from '@/modules/operations';
import { TripBoard } from '@/modules/operations/ui/trip-board';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Button, Input, PageHeader } from '@/ui';
import { recordTripStepAction } from './actions';

/** The day's rotations on a phone: one tap per step (loaded, departed, arrived, unloading started and finished, back). */
export default async function TripsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'trips.read');
  const query = await searchParams;
  const today = (await getRequestClock()).today();
  const date = query.date && isRealDate(query.date) ? query.date : today;
  const trips = await listTrips(getPool('app'), user, date);
  const t = await getTranslations('operations.trips');
  if (!trips.ok) return <PageHeader title={t('title')} description={t('errors.INVALID')} />;
  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('intro')} />
      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="field-label">{t('date')}</span>
          <Input type="date" name="date" defaultValue={date} dir="ltr" data-testid="trips-date" />
        </label>
        <Button type="submit" variant="secondary">
          {t('show')}
        </Button>
      </form>
      <TripBoard trips={trips.value} canTrack={can(user.role, 'trips.track')} record={recordTripStepAction} />
    </div>
  );
}
