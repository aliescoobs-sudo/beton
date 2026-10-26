import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { SupplierInvoiceForm } from '@/modules/ledger/ui/supplier-invoices/supplier-invoice-form';
import { listComponents } from '@/modules/master-data';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import { createSupplierInvoiceAction } from '../actions';

/** Enter a supplier's invoice: owner and office (office types the order code and is shown our code, never an amount). */
export default async function NewSupplierInvoicePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'supplier_invoices.write');
  const pool = getPool('app');
  const [components, clock] = await Promise.all([listComponents(pool, user), getRequestClock()]);
  const t = await getTranslations('ledger.supplierInvoices');
  return (
    <div>
      <PageHeader title={t('newTitle')} description={t('newIntro')} />
      <SupplierInvoiceForm
        components={components
          .filter((c) => c.status === 'active')
          .map((c) => ({ id: c.id, name: locale === 'ar' ? c.nameAr : c.nameFr }))}
        today={clock.today()}
        createAction={createSupplierInvoiceAction}
        aiEnabled={getEnv().AI_EXTRACTION_ENABLED}
      />
    </div>
  );
}
