import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listMoneyAccounts } from '@/modules/ledger';
import { AccountsManager } from '@/modules/ledger/ui/accounts/accounts-manager';
import { can, recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import { createMoneyAccountAction, setOpeningBalanceAction } from './actions';

export default async function AccountsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'money_accounts.read');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:money-accounts');
  const accounts = await listMoneyAccounts(pool, user);
  const t = await getTranslations('ledger.accounts');
  return (
    <div>
      <PageHeader title={t('title')} />
      <AccountsManager
        accounts={accounts}
        editable={can(user.role, 'money_accounts.write')}
        createAction={createMoneyAccountAction}
        openingAction={setOpeningBalanceAction}
      />
    </div>
  );
}
