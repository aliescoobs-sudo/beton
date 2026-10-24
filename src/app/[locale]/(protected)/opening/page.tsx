import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getOpeningState } from '@/modules/ledger';
import { OpeningManager } from '@/modules/ledger/ui/opening/opening-manager';
import { listSelectableClients, listSuppliers } from '@/modules/master-data';
import { can, recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import { addPartyOpeningBalanceAction, enterOpeningDateAction } from './actions';

export default async function OpeningPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'opening.read');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:opening');
  const [state, clients, suppliers] = await Promise.all([
    getOpeningState(pool, user),
    listSelectableClients(pool, user),
    listSuppliers(pool, user),
  ]);
  const t = await getTranslations('ledger.opening');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      <OpeningManager
        state={state}
        editable={can(user.role, 'opening.write')}
        clients={clients.map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))}
        suppliers={suppliers
          .filter((s) => s.status === 'active')
          .map((s) => ({ id: s.id, label: `${s.code} · ${s.name}` }))}
        dateAction={enterOpeningDateAction}
        partyAction={addPartyOpeningBalanceAction}
      />
    </div>
  );
}
