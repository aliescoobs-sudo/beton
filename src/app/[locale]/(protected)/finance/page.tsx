import { notFound } from 'next/navigation';
import { getPool } from '@/lib/db/pools';
import {
  canFinance,
  financeEnabled,
  getFinanceCash,
  getFinanceReferences,
  getFinanceReport,
  periodRange,
  validRange,
} from '@/modules/finance';
import { listPlants } from '@/modules/master-data';
import { currentAuthState } from '@/modules/platform-security/next';
import { FinanceWorkspace } from '@/modules/finance/ui/workspace';
import { financeLabels } from '@/modules/finance/ui/labels';
import { Button, Field, Input, PageHeader } from '@/ui';
import { getRequestClock } from '@/app/request-clock';
export const dynamic = 'force-dynamic';
// @permission finance.read — management finance is owner/app_admin only, module off => 404.
export default async function FinancePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { locale: raw } = await params,
    locale = raw === 'ar' ? 'ar' : 'fr',
    l = financeLabels[locale],
    pool = getPool('app'),
    state = await currentAuthState();
  if (
    state.kind !== 'authenticated' ||
    !canFinance(state.user.role, 'finance.read') ||
    !(await financeEnabled(pool))
  )
    notFound();
  const clock = await getRequestClock(),
    today = clock.today(),
    defaults = periodRange(Number(today.slice(0, 4)), 'month', Number(today.slice(5, 7))),
    q = await searchParams;
  const from = q.from ?? defaults.from,
    to = q.to ?? defaults.to;
  try {
    validRange(from, to);
  } catch {
    notFound();
  }
  const [report, cash, refs, plants] = await Promise.all([
    getFinanceReport(pool, state.user, from, to),
    getFinanceCash(
      pool,
      state.user,
      today,
      new Date(Date.parse(today) + 120 * 86400000).toISOString().slice(0, 10),
    ),
    getFinanceReferences(pool, state.user, from, to),
    listPlants(pool, state.user),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader title={l.title} description={l.summary} />
      <form className="flex flex-wrap items-end gap-3" method="get">
        <Field label={l.from}>
          <Input name="from" type="date" defaultValue={from} required />
        </Field>
        <Field label={l.to}>
          <Input name="to" type="date" defaultValue={to} required />
        </Field>
        <Button type="submit">{l.refresh}</Button>
      </form>
      <FinanceWorkspace
        report={report}
        cash={cash}
        refs={refs}
        plants={plants}
        locale={locale}
        today={today}
      />
    </div>
  );
}
