import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { listAccounts } from '@/modules/ledger';
import { AccountsTable } from '@/modules/ledger/ui/statements/accounts-table';
import { recordMoneyView } from '@/modules/platform-security';
import { requireAnyPagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';

/** The accounts of clients and suppliers: owner and support both sides; office_sales the clients, office_purchases the suppliers (D245). */
export default async function StatementsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requireAnyPagePermission(locale, [
    'statements.read',
    'statements.client',
    'statements.supplier',
  ]);
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:accounts');
  const rows = await listAccounts(pool, user, { today: (await getRequestClock()).today() });
  const t = await getTranslations('ledger.statements');
  return (
    <div>
      <PageHeader title={t('title')} />
      <AccountsTable rows={rows} locale={locale} />
    </div>
  );
}
