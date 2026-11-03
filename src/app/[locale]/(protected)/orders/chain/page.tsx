import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { getOrderChain, stageState, waitingFor } from '@/modules/ledger';
import { formatM3 } from '@/modules/operations/ui/format';
import { can, recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, PageHeader, StatusPill, Table, Td, Th } from '@/ui';

/**
 * The order chain: one row per order with ordered, planned, loaded, delivered, invoiced and paid. Every role reads quantities and
 * stages; "paid" is masked for everyone but the owner and support, and no amount is ever shown here.
 */
export default async function OrderChainPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'orders.chain');
  const pool = getPool('app');
  const money = can(user.role, 'orders.read_money');
  if (money) await recordMoneyView(pool, user, 'screen:order-chain');
  const rows = await getOrderChain(pool, user);
  const t = await getTranslations('ledger.orderChain');
  const tl = await getTranslations('timeline');
  const stages = ['planned', 'loaded', 'delivered', 'invoiced'] as const;
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {rows.length === 0 ? (
        <EmptyState title={t('none')} data-testid="chain-none" />
      ) : (
        <Table data-testid="chain-list">
          <thead>
            <tr>
              <Th>{t('order')}</Th>
              <Th>{t('client')}</Th>
              <Th>{t('type')}</Th>
              <Th numeric>{t('ordered')}</Th>
              {stages.map((s) => (
                <Th key={s} numeric>
                  {t(`stages.${s}`)}
                </Th>
              ))}
              <Th>{t('stages.paid')}</Th>
              <Th>{t('waiting')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const done = {
                planned: r.plannedL,
                loaded: r.loadedL,
                delivered: r.deliveredL,
                invoiced: r.invoicedL,
              };
              const states = {
                ordered: 'complete' as const,
                planned: stageState(done.planned, r.orderedL),
                loaded: stageState(done.loaded, r.orderedL),
                delivered: stageState(done.delivered, r.orderedL),
                invoiced: stageState(done.invoiced, r.orderedL),
              };
              const waiting = r.cancelled ? null : waitingFor(states, r.paidState);
              return (
                <tr key={r.orderId} data-testid={`chain-${r.code}`} data-waiting={waiting ?? 'none'}>
                  <Td>
                    {can(user.role, 'orders.read_money') ? (
                      <a href={`/${locale}/orders/${r.orderId}`} className="underline">
                        <bdi dir="ltr">{r.code}</bdi>
                      </a>
                    ) : (
                      <bdi dir="ltr">{r.code}</bdi>
                    )}
                    {getEnv().TRANSFERS_ENABLED && (
                      <a
                        href={`/${locale}/orders/timeline/${r.orderId}`}
                        className="ms-2 text-xs underline"
                        data-testid={`timeline-link-${r.code}`}
                      >
                        {tl('title')}
                      </a>
                    )}
                  </Td>
                  <Td>
                    <bdi dir="ltr">{r.clientCode}</bdi>
                  </Td>
                  <Td>
                    <bdi dir="ltr">{r.typeCode}</bdi>
                  </Td>
                  <Td numeric>{formatM3(r.orderedL)} m³</Td>
                  {stages.map((s) => (
                    <Td key={s} numeric data-state={states[s]} data-testid={`chain-${r.code}-${s}`}>
                      <span className="inline-flex flex-col items-end gap-1">
                        <span>{formatM3(done[s])} m³</span>
                        <progress
                          className="h-1.5 w-16"
                          max={r.orderedL}
                          value={Math.min(Math.max(done[s], 0), r.orderedL)}
                          aria-label={t(`stages.${s}`)}
                        />
                      </span>
                    </Td>
                  ))}
                  <Td data-testid={`chain-${r.code}-paid`}>
                    {r.cancelled ? (
                      <StatusPill status="cancelled">{t('cancelled')}</StatusPill>
                    ) : r.paidState === null ? (
                      <span className="text-muted" aria-label={t('masked')}>
                        —
                      </span>
                    ) : (
                      <StatusPill
                        status={r.paidState === 'paid' ? 'paid' : r.paidState === 'partial' ? 'due' : 'late'}
                      >
                        {t(`paidState.${r.paidState}`)}
                      </StatusPill>
                    )}
                  </Td>
                  <Td>{waiting ? t(`waitingFor.${waiting}`) : t('complete')}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
