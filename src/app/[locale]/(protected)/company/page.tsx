import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getCompanyProfile, legalMentions, listCompanyProfiles } from '@/modules/ledger';
import { CompanyForm } from '@/modules/ledger/ui/company/company-form';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Card, PageHeader, Table, Td } from '@/ui';
import { saveCompanyAction } from './actions';

/** Our legal identity as printed on documents. Everyone reads it; the owner enters a new version. */
export default async function CompanyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'company.read');
  const pool = getPool('app');
  const today = (await getRequestClock()).today();
  const [current, versions] = await Promise.all([
    getCompanyProfile(pool, user, { today }),
    listCompanyProfiles(pool, user),
  ]);
  const t = await getTranslations('ledger.company');
  return (
    <div className="space-y-8">
      <PageHeader title={t('title')} description={t('intro')} />
      <Card>
        {current ? (
          <div data-testid="company-current">
            {legalMentions(current).map((line) => (
              <p key={line}>
                <bdi dir="ltr">{line}</bdi>
              </p>
            ))}
          </div>
        ) : (
          <p data-testid="company-none">{t('none')}</p>
        )}
      </Card>
      {can(user.role, 'company.write') && <CompanyForm current={current} save={saveCompanyAction} />}
      {versions.length > 1 && (
        <section>
          <h2 className="mb-3 text-xl">{t('history')}</h2>
          <Table>
            <tbody>
              {versions.map((v) => (
                <tr key={`${v.effectiveFrom}-${v.legalName}-${v.ice}`}>
                  <Td>
                    <bdi dir="ltr">{v.effectiveFrom}</bdi>
                  </Td>
                  <Td>{v.legalName}</Td>
                  <Td>
                    <bdi dir="ltr">ICE {v.ice}</bdi>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}
    </div>
  );
}
