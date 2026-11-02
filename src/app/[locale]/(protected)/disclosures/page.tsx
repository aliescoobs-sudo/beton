import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listMyDisclosures } from '@/modules/ledger';
import { MyDisclosures } from '@/modules/ledger/ui/approvals/disclosure-ui';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import { requestDisclosureAction, viewDisclosureAction } from './actions';

/** A figure the role may not see by itself: ask for it here; the owner or app_admin decides (§16.3). */
export default async function DisclosuresPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'disclosure.request');
  const items = await listMyDisclosures(getPool('app'), user);
  const t = await getTranslations('ledger.disclosure');
  return (
    <div>
      <PageHeader title={t('pageTitle')} description={t('pageIntro')} />
      <MyDisclosures items={items} request={requestDisclosureAction} view={viewDisclosureAction} />
    </div>
  );
}
