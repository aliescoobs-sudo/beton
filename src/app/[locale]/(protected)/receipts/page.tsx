import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listReceivable } from '@/modules/operations';
import { formatM3 } from '@/modules/operations/ui/format';
import { ReceiveButton } from '@/modules/operations/ui/receive-button';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, PageHeader, StatusPill, Table, Td, Th } from '@/ui';
import { receiveAction } from './actions';

/** Purchases with stocked lines: what is expected (receive it) and what came in. Quantities only, no price. */
export default async function ReceiptsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'receipts.read');
  const purchases = (await listReceivable(getPool('app'), user)).filter((p) => !p.cancelled);
  const canReceive = can(user.role, 'receipts.write');
  const t = await getTranslations('operations.receipts');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {purchases.length === 0 ? (
        <EmptyState title={t('none')} data-testid="receipts-none" />
      ) : (
        <Table data-testid="receipts-list">
          <thead>
            <tr>
              <Th>{t('purchase')}</Th>
              <Th>{t('supplier')}</Th>
              <Th>{t('date')}</Th>
              <Th>{t('lines')}</Th>
              <Th>{t('state')}</Th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p) => (
              <tr key={p.purchaseId} data-testid={`purchase-${p.code}`}>
                <Td>
                  <bdi dir="ltr">{p.code}</bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">{p.supplierCode}</bdi>
                </Td>
                <Td>
                  <bdi dir="ltr">{p.orderDate}</bdi>
                </Td>
                <Td>
                  <ul>
                    {p.lines.map((l, i) => (
                      <li key={i}>
                        {locale === 'ar' ? l.nameAr : l.nameFr} ·{' '}
                        <bdi dir="ltr">
                          {formatM3(l.qtyMilli)} {l.unitLabel}
                        </bdi>
                      </li>
                    ))}
                  </ul>
                </Td>
                <Td>
                  {p.status === 'complete' ? (
                    <StatusPill status="paid">
                      {t('receivedOn')} <bdi dir="ltr">{p.receivedOn}</bdi>
                    </StatusPill>
                  ) : (
                    <StatusPill status="due">{t('expected')}</StatusPill>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
