import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listCreditLimits } from '@/modules/ledger';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Button, Money, PageHeader } from '@/ui';
import { setCreditLimitAction } from './actions';

/** The credit limit of each client: above it, or with a late invoice, a new order waits for the owner (R3, §5). Owner and app_admin only. */
export default async function CreditLimitsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'credit_limit.write');
  const rows = await listCreditLimits(getPool('app'), user);
  const t = await getTranslations('creditLimits');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      <ul className="mt-4 space-y-2" data-testid="credit-limits">
        {rows.map((r) => (
          <li
            key={r.clientId}
            className="flex flex-wrap items-center gap-3 text-sm"
            data-testid={`credit-${r.clientCode}`}
          >
            <bdi dir="ltr" className="w-24">
              {r.clientCode}
            </bdi>
            <span className="w-56">{r.clientName}</span>
            <span className="w-32">
              {r.limitCentimes === null ? t('none') : <Money centimes={r.limitCentimes} />}
            </span>
            <form action={setCreditLimitAction} className="flex gap-2">
              <input type="hidden" name="clientId" value={r.clientId} />
              <input name="limit" inputMode="decimal" placeholder={t('placeholder')} className="w-32" />
              <Button type="submit">{t('save')}</Button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
