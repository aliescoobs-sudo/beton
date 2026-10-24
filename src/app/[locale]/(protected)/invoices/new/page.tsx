import { getTranslations, setRequestLocale } from 'next-intl/server';
import { InvoiceForm } from '@/modules/ledger/ui/invoices/invoice-form';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import { createInvoiceAction } from '../actions';

/** Invoice an order: owner and office (office types the order code and is shown a number, never an amount). */
export default async function NewInvoicePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requirePagePermission(locale, 'invoices.write');
  const t = await getTranslations('ledger.invoices');
  return (
    <div>
      <PageHeader title={t('newTitle')} description={t('newIntro')} />
      <InvoiceForm createAction={createInvoiceAction} />
    </div>
  );
}
