import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { QuoteForm } from '@/modules/ledger/ui/quotes/quote-form';
import { listSelectableClients, listSelectableConcreteTypes } from '@/modules/master-data';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import { createQuoteAction } from '../actions';

/** A quote: owner and office (office enters it blind and is shown a code, never an amount). */
export default async function NewQuotePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'quotes.write');
  const pool = getPool('app');
  const [clients, types] = await Promise.all([
    listSelectableClients(pool, user),
    listSelectableConcreteTypes(pool, user),
  ]);
  const t = await getTranslations('ledger.quotes');
  return (
    <div>
      <PageHeader title={t('newTitle')} description={t('newIntro')} />
      <QuoteForm
        clients={clients.map((c) => ({ id: c.id, code: c.code, name: c.name }))}
        types={types.map((c) => ({ id: c.id, code: c.code, label: c.label }))}
        createAction={createQuoteAction}
      />
    </div>
  );
}
