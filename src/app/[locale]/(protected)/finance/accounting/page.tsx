import { notFound } from 'next/navigation';
import { getPool } from '@/lib/db/pools';
import { canFinance, financeEnabled, periodRange } from '@/modules/finance';
import { currentAuthState } from '@/modules/platform-security/next';
import { financeLabels } from '@/modules/finance/ui/labels';
import { Button, Field, Input, PageHeader } from '@/ui';
import { getRequestClock } from '@/app/request-clock';
export const dynamic = 'force-dynamic';
// @permission finance.export — separate accountant page, no management report or treasury data loaded.
export default async function AccountingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params,
    locale = raw === 'ar' ? 'ar' : 'fr',
    l = financeLabels[locale],
    state = await currentAuthState(),
    pool = getPool('app');
  if (
    state.kind !== 'authenticated' ||
    !canFinance(state.user.role, 'finance.export') ||
    !(await financeEnabled(pool))
  )
    notFound();
  const clock = await getRequestClock(),
    today = clock.today(),
    period = periodRange(Number(today.slice(0, 4)), 'month', Number(today.slice(5, 7)));
  return (
    <div className="space-y-6">
      <PageHeader title={l.export} description={l.accountingNote} />
      <form action={`/${locale}/finance/export`} className="flex flex-wrap items-end gap-3">
        <Field label={l.from}>
          <Input type="date" name="from" defaultValue={period.from} required />
        </Field>
        <Field label={l.to}>
          <Input type="date" name="to" defaultValue={period.to} required />
        </Field>
        <Button type="submit">{l.export}</Button>
      </form>
    </div>
  );
}
