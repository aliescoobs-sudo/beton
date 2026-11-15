import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { listOrders } from '@/modules/ledger';
import { formatM3 } from '@/modules/operations/ui/format';
import { recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import {
  EmptyState,
  FilterBar,
  Money,
  PageHeader,
  paginate,
  Pagination,
  parseSort,
  SortTh,
  sortRows,
  StatusChips,
  StatusPill,
  Table,
  Td,
  Th,
} from '@/ui';

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
const STATES = ['open', 'late', 'settled', 'cancelled'] as const;

/** The orders: what was ordered, delivered, invoiced and paid, with what is late. Owner and support (money). */
export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'orders.read_money');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:orders');
  const today = (await getRequestClock()).today();
  const orders = await listOrders(pool, user, { today });
  const t = await getTranslations('ledger.orderList');
  const tl = await getTranslations('list');
  const path = `/${locale}/orders`;
  const stateOf = (o: (typeof orders)[number]): (typeof STATES)[number] =>
    o.cancelled
      ? 'cancelled'
      : o.overdueCentimes > 0
        ? 'late'
        : o.coveredCentimes >= o.totalTtcCentimes
          ? 'settled'
          : 'open';
  const asked = first(q.state);
  const state = STATES.find((x) => x === asked) ?? '';
  const text = first(q.q).trim().toLowerCase();
  const sort = parseSort(q, ['code', 'client', 'deliveryDate', 'total'], undefined);
  const filtered = orders.filter(
    (o) =>
      (!state || stateOf(o) === state) &&
      (!text ||
        o.code.toLowerCase().includes(text) ||
        o.clientName.toLowerCase().includes(text) ||
        o.clientCode.toLowerCase().includes(text)),
  );
  const shown = sortRows(filtered, sort, {
    code: (o) => o.code,
    client: (o) => o.clientName,
    deliveryDate: (o) => o.deliveryDate,
    total: (o) => o.totalTtcCentimes,
  });
  const page = paginate(shown, q);
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {orders.length === 0 ? (
        <EmptyState title={t('none')} data-testid="orders-none" />
      ) : (
        <>
          <FilterBar
            label={tl('filters')}
            applyLabel={tl('apply')}
            resetLabel={tl('reset')}
            resetHref={path}
            data-testid="orders-filters"
          >
            <label className="block sm:col-span-2">
              <span className="field-label">{tl('search')}</span>
              <input
                type="search"
                name="q"
                defaultValue={first(q.q)}
                placeholder={`${t('code')}, ${t('client')}`}
                className="input mt-1"
                data-testid="orders-search"
              />
            </label>
            {state && <input type="hidden" name="state" value={state} />}
          </FilterBar>
          <StatusChips
            label={tl('status')}
            path={path}
            q={q}
            param="state"
            current={state}
            chips={[
              { value: '', label: tl('statusAll'), count: orders.length },
              ...STATES.map((x) => ({
                value: x,
                label: t(x),
                count: orders.filter((o) => stateOf(o) === x).length,
              })),
            ]}
          />
          {shown.length === 0 ? (
            <EmptyState title={tl('noMatch')} description={tl('noMatchHint')} data-testid="orders-no-match" />
          ) : (
            <Table data-testid="orders-list">
              <thead>
                <tr>
                  <SortTh id="code" sort={sort} path={path} q={q}>
                    {t('code')}
                  </SortTh>
                  <SortTh id="client" sort={sort} path={path} q={q}>
                    {t('client')}
                  </SortTh>
                  <Th>{t('type')}</Th>
                  <Th numeric>{t('delivered')}</Th>
                  <SortTh id="deliveryDate" sort={sort} path={path} q={q}>
                    {t('deliveryDate')}
                  </SortTh>
                  <SortTh id="total" sort={sort} path={path} q={q} numeric>
                    {t('total')}
                  </SortTh>
                  <Th numeric>{t('paid')}</Th>
                  <Th>{t('state')}</Th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((o) => (
                  <tr key={o.id} data-testid={`order-${o.code}`}>
                    <Td>
                      <a href={`/${locale}/orders/${o.id}`} className="underline">
                        <bdi dir="ltr">{o.code}</bdi>
                      </a>
                    </Td>
                    <Td>
                      <bdi dir="ltr" className="text-sm text-muted">
                        {o.clientCode}
                      </bdi>{' '}
                      {o.clientName}
                    </Td>
                    <Td>
                      <bdi dir="ltr">{o.typeCode}</bdi>
                    </Td>
                    <Td numeric>
                      {formatM3(o.deliveredL)} / {formatM3(o.volumeL)} m³
                    </Td>
                    <Td>
                      <bdi dir="ltr">{o.deliveryDate}</bdi>
                    </Td>
                    <Td numeric>
                      <Money centimes={o.totalTtcCentimes} />
                    </Td>
                    <Td numeric>
                      <Money centimes={o.coveredCentimes} />
                    </Td>
                    <Td>
                      {o.cancelled ? (
                        <StatusPill status="cancelled">{t('cancelled')}</StatusPill>
                      ) : o.overdueCentimes > 0 ? (
                        <StatusPill status="late">
                          {t('late')} <Money centimes={o.overdueCentimes} />
                        </StatusPill>
                      ) : o.coveredCentimes >= o.totalTtcCentimes ? (
                        <StatusPill status="paid">{t('settled')}</StatusPill>
                      ) : (
                        <StatusPill status="ontrack">{t('open')}</StatusPill>
                      )}
                      {o.invoiced && <StatusPill status="neutral">{t('invoiced')}</StatusPill>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <Pagination
            page={page}
            path={path}
            q={q}
            labels={{
              prev: tl('prev'),
              next: tl('next'),
              nav: tl('pageNav'),
              range: tl('range', { from: page.from, to: page.to, total: page.total }),
            }}
          />
        </>
      )}
    </div>
  );
}
