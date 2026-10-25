import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getOrderDetail } from '@/modules/ledger';
import { CancelOrder } from '@/modules/ledger/ui/orders/cancel-order';
import { formatM3 } from '@/modules/operations/ui/format';
import { can, recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Card, Money, PageHeader, StatusPill, Table, Td, Th } from '@/ui';
import { cancelOrderAction } from '../actions';

const PILL = {
  pending: 'ontrack',
  partially_covered: 'due',
  covered: 'paid',
  overdue: 'late',
  cancelled: 'cancelled',
} as const;

/** One order: its plan with the state of each échéance, its loads, its invoices and the payments that cover it. */
export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'orders.read_money');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:order');
  const today = (await getRequestClock()).today();
  const detail = await getOrderDetail(pool, user, id, { today });
  if (!detail) notFound();
  const { order: o } = detail;
  const t = await getTranslations('ledger.orderDetail');
  const states = await getTranslations('ledger.itemStates');
  return (
    <div className="space-y-8">
      <PageHeader
        title={
          <>
            {t('title')} <bdi dir="ltr">{o.code}</bdi>
          </>
        }
        description={
          <>
            <bdi dir="ltr">{o.clientCode}</bdi> · {o.clientName}
          </>
        }
        actions={
          can(user.role, 'ledger.reverse') && !o.cancelled ? (
            <CancelOrder orderId={o.id} cancel={cancelOrderAction} />
          ) : undefined
        }
      />
      <Card>
        <dl className="grid gap-x-8 gap-y-2 sm:grid-cols-2" data-testid="order-head">
          <div>
            <dt className="field-label">{t('volume')}</dt>
            <dd>
              {formatM3(o.deliveredL)} / {formatM3(o.volumeL)} m³{' '}
              <span className="text-muted">
                (<bdi dir="ltr">{o.typeCode}</bdi>)
              </span>
            </dd>
          </div>
          <div>
            <dt className="field-label">{t('dates')}</dt>
            <dd>
              <bdi dir="ltr">
                {o.orderDate} → {o.deliveryDate}
              </bdi>
            </dd>
          </div>
          <div>
            <dt className="field-label">{t('unitPrice')}</dt>
            <dd>
              <Money centimes={o.unitPriceHtCentimes} suffix={t('perM3')} />
              {o.reason && <span className="ms-2 text-sm text-muted">({o.reason})</span>}
            </dd>
          </div>
          <div>
            <dt className="field-label">{t('totals')}</dt>
            <dd>
              <Money centimes={o.totalHtCentimes} /> + <Money centimes={o.totalVatCentimes} /> (
              {o.vatRateBp / 100} %) ={' '}
              <strong>
                <Money centimes={o.totalTtcCentimes} />
              </strong>
            </dd>
          </div>
        </dl>
        {o.cancelled && (
          <p role="status" className="mt-3 font-bold" data-testid="order-cancelled">
            {t('cancelled')}
          </p>
        )}
      </Card>

      <section>
        <h2 className="mb-3 text-xl">{t('plan')}</h2>
        <Table data-testid="order-plan">
          <thead>
            <tr>
              <Th>#</Th>
              <Th>{t('method')}</Th>
              <Th>{t('dueDate')}</Th>
              <Th numeric>{t('amount')}</Th>
              <Th numeric>{t('covered')}</Th>
              <Th>{t('state')}</Th>
            </tr>
          </thead>
          <tbody>
            {detail.items.map((i) => (
              <tr key={i.seq} data-testid={`plan-item-${i.seq}`} data-state={i.state}>
                <Td>{i.seq}</Td>
                <Td>{i.method}</Td>
                <Td>
                  <bdi dir="ltr">{i.dueDate}</bdi>
                </Td>
                <Td numeric>
                  <Money centimes={i.amountCentimes} />
                </Td>
                <Td numeric>
                  <Money centimes={i.coveredCentimes} />
                </Td>
                <Td>
                  <StatusPill status={PILL[i.state]}>{states(i.state)}</StatusPill>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>

      <section>
        <h2 className="mb-3 text-xl">{t('loads')}</h2>
        {detail.loads.length === 0 ? (
          <p className="text-muted">{t('noLoads')}</p>
        ) : (
          <Table data-testid="order-loads">
            <thead>
              <tr>
                <Th>{t('bl')}</Th>
                <Th>{t('dueDate')}</Th>
                <Th>{t('truck')}</Th>
                <Th numeric>{t('volumeShort')}</Th>
              </tr>
            </thead>
            <tbody>
              {detail.loads.map((l) => (
                <tr key={l.blNo}>
                  <Td>
                    <bdi dir="ltr">{l.blNo}</bdi>{' '}
                    {l.cancelled && <StatusPill status="cancelled">{t('cancelledShort')}</StatusPill>}
                  </Td>
                  <Td>
                    <bdi dir="ltr">{l.loadDate}</bdi>
                  </Td>
                  <Td>
                    <bdi dir="ltr">{l.truckCode}</bdi>
                  </Td>
                  <Td numeric>{formatM3(l.volumeL)} m³</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-xl">{t('invoices')}</h2>
        {detail.invoices.length === 0 ? (
          <p className="text-muted">{t('noInvoices')}</p>
        ) : (
          <Table data-testid="order-invoices">
            <tbody>
              {detail.invoices.map((i) => (
                <tr key={i.number}>
                  <Td>
                    <bdi dir="ltr">{i.number}</bdi>{' '}
                    {i.creditNote && <StatusPill status="cancelled">{t('creditNote')}</StatusPill>}
                  </Td>
                  <Td>
                    <bdi dir="ltr">{i.invoiceDate}</bdi>
                  </Td>
                  <Td numeric>
                    <Money centimes={i.totalTtcCentimes} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-xl">{t('payments')}</h2>
        {detail.payments.length === 0 ? (
          <p className="text-muted">{t('noPayments')}</p>
        ) : (
          <Table data-testid="order-payments">
            <tbody>
              {detail.payments.map((p, n) => (
                <tr key={n}>
                  <Td>
                    {p.method} <bdi dir="ltr">{p.number ?? ''}</bdi>
                  </Td>
                  <Td numeric>
                    <Money centimes={p.coveredCentimes} suffix={t('onThisOrder')} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}
