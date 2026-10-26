import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getPurchaseDetail } from '@/modules/ledger';
import { CancelPurchase } from '@/modules/ledger/ui/purchases/cancel-purchase';
import { formatM3 } from '@/modules/operations/ui/format';
import { can, recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Card, Money, PageHeader, StatusPill, Table, Td, Th } from '@/ui';
import { cancelPurchaseAction } from '../actions';

/** One purchase: lines, payment plan, receipt. Owner and support. */
export default async function PurchaseDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'purchases.read_money');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:purchase');
  const detail = await getPurchaseDetail(pool, user, id);
  if (!detail) notFound();
  const { purchase: p } = detail;
  const t = await getTranslations('ledger.purchaseDetail');
  return (
    <div className="space-y-8">
      <PageHeader
        title={
          <>
            {t('title')} <bdi dir="ltr">{p.code}</bdi>
          </>
        }
        description={
          <>
            <bdi dir="ltr">{p.supplierCode}</bdi> · {p.supplierName}
          </>
        }
        actions={
          can(user.role, 'ledger.reverse') && !p.reversed ? (
            <CancelPurchase purchaseId={p.id} cancel={cancelPurchaseAction} />
          ) : undefined
        }
      />
      <Card>
        <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2" data-testid="purchase-head">
          <div>
            <dt className="field-label">{t('invoice')}</dt>
            <dd>
              <bdi dir="ltr">{p.supplierInvoiceNo ?? '—'}</bdi>
            </dd>
          </div>
          <div>
            <dt className="field-label">{t('dates')}</dt>
            <dd>
              <bdi dir="ltr">
                {p.orderDate} → {p.dueDate}
              </bdi>
            </dd>
          </div>
          <div>
            <dt className="field-label">{t('totals')}</dt>
            <dd>
              <Money centimes={p.totalHtCentimes} /> + <Money centimes={p.totalVatCentimes} /> (
              {p.vatRateBp / 100} %) ={' '}
              <strong>
                <Money centimes={p.totalTtcCentimes} />
              </strong>
            </dd>
          </div>
          <div>
            <dt className="field-label">{t('receipt')}</dt>
            <dd>
              {detail.receivedOn ? (
                <StatusPill status="paid">
                  {t('receivedOn')} <bdi dir="ltr">{detail.receivedOn}</bdi>
                </StatusPill>
              ) : (
                <StatusPill status="due">{t('expected')}</StatusPill>
              )}
            </dd>
          </div>
        </dl>
        {p.reversed && (
          <p role="status" className="mt-3 font-bold" data-testid="purchase-cancelled">
            {t('cancelled')}
          </p>
        )}
      </Card>
      <section>
        <h2 className="mb-3 text-xl">{t('lines')}</h2>
        <Table data-testid="purchase-lines">
          <thead>
            <tr>
              <Th>{t('label')}</Th>
              <Th numeric>{t('qty')}</Th>
              <Th numeric>{t('price')}</Th>
              <Th numeric>{t('lineTotal')}</Th>
            </tr>
          </thead>
          <tbody>
            {detail.lines.map((l) => (
              <tr key={l.seq}>
                <Td>{l.label}</Td>
                <Td numeric>
                  {formatM3(l.qtyMilli)} {l.unitLabel ?? ''}
                </Td>
                <Td numeric>
                  <Money centimes={l.unitPriceHtCentimes} />
                </Td>
                <Td numeric>
                  <Money centimes={l.lineHtCentimes} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
      <section>
        <h2 className="mb-3 text-xl">{t('plan')}</h2>
        {detail.items.length === 0 && (
          <p className="mb-3 text-sm text-muted" data-testid="purchase-no-payable">
            {t('noPayable')}
          </p>
        )}
        <Table data-testid="purchase-plan">
          <tbody>
            {detail.items.map((i) => (
              <tr key={i.seq}>
                <Td>{i.method}</Td>
                <Td>
                  <bdi dir="ltr">{i.dueDate}</bdi>
                </Td>
                <Td numeric>
                  <Money centimes={i.amountCentimes} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
    </div>
  );
}
