import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { PaymentForm } from '@/modules/ledger/ui/instruments/payment-form';
import { listSelectableClients, listSuppliers } from '@/modules/master-data';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import { issuePaymentAction, receivePaymentAction } from './actions';

export default async function NewPaymentPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'instruments.write');
  const pool = getPool('app');
  const [clients, suppliers] = await Promise.all([
    listSelectableClients(pool, user),
    listSuppliers(pool, user),
  ]);
  const t = await getTranslations('ledger.payments');
  return (
    <div>
      <PageHeader title={t('title')} />
      <PaymentForm
        clients={clients.map((c) => ({ id: c.id, code: c.code, name: c.name }))}
        suppliers={suppliers
          .filter((s) => s.status === 'active')
          .map((s) => ({ id: s.id, code: s.code, name: s.name }))}
        receiveAction={receivePaymentAction}
        issueAction={issuePaymentAction}
      />
    </div>
  );
}
