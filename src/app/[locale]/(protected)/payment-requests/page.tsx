import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import {
  listDueTomorrow,
  listPaymentRequests,
  listSmallPaymentsForReview,
  type RequestState,
} from '@/modules/ledger';
import { PaymentRequestActions } from '@/modules/ledger/ui/payment-control/payment-request-actions';
import { PaymentRequestForm } from '@/modules/ledger/ui/payment-control/payment-request-form';
import { listSuppliers } from '@/modules/master-data';
import { can, recordMoneyView } from '@/modules/platform-security';
import { requireAnyPagePermission } from '@/modules/platform-security/next';
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
  type PillStatus,
} from '@/ui';
import { decidePaymentAction, issueRequestedPaymentAction, preparePaymentAction } from './actions';

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
const STATES: RequestState[] = ['prepared', 'validated', 'approved', 'issued', 'rejected'];
const PILL: Record<RequestState, PillStatus> = {
  prepared: 'due',
  validated: 'ontrack',
  approved: 'ontrack',
  issued: 'paid',
  rejected: 'cancelled',
};

/** D247: outgoing payments prepared, validated or approved, then issued; the J-1 list of cheques due tomorrow; the owner's daily review of small payments. */
export default async function PaymentRequestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  setRequestLocale(locale);
  const user = await requireAnyPagePermission(locale, ['payments.prepare', 'payments.decide']);
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:payment-requests');
  const today = (await getRequestClock()).today();
  const prepares = can(user.role, 'payments.prepare');
  const owner = user.role === 'owner' || user.role === 'app_admin';
  const [all, suppliers, dueTomorrow, small] = await Promise.all([
    listPaymentRequests(pool, user),
    prepares ? listSuppliers(pool, user) : Promise.resolve([]),
    prepares ? listDueTomorrow(pool, user, today) : Promise.resolve([]),
    owner ? listSmallPaymentsForReview(pool, user, today) : Promise.resolve([]),
  ]);
  const t = await getTranslations('ledger.paymentRequests');
  const tl = await getTranslations('list');
  const path = `/${locale}/payment-requests`;
  const state = STATES.find((s) => s === first(q.state)) ?? '';
  const text = first(q.q).trim().toLowerCase();
  const filtered = all.filter(
    (r) =>
      (!state || r.state === state) &&
      (!text || r.supplierName.toLowerCase().includes(text) || r.supplierCode.toLowerCase().includes(text)),
  );
  const sort = parseSort(q, ['date', 'supplier', 'amount'], { key: 'date', dir: 'desc' });
  const page = paginate(
    sortRows(filtered, sort, {
      date: (r) => r.createdAt,
      supplier: (r) => r.supplierName,
      amount: (r) => r.amountCentimes,
    }),
    q,
  );
  return (
    <div>
      <PageHeader title={t('title')} description={prepares ? t('intro') : t('introValidator')} />
      {prepares && (
        <PaymentRequestForm
          suppliers={suppliers
            .filter((s) => s.status === 'active')
            .map((s) => ({ id: s.id, code: s.code, name: s.name }))}
          prepare={preparePaymentAction}
        />
      )}
      {prepares && (
        <section aria-labelledby="pr-j1" data-testid="pr-j1">
          <h2 id="pr-j1" className="mb-3 text-xl">
            {t('dueTomorrow')}
          </h2>
          {dueTomorrow.length === 0 ? (
            <p className="text-sm text-muted">{t('dueTomorrowNone')}</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>{t('supplier')}</Th>
                  <Th>{t('method')}</Th>
                  <Th>{t('number')}</Th>
                  <Th numeric>{t('amount')}</Th>
                  <Th>{t('writtenDate')}</Th>
                </tr>
              </thead>
              <tbody>
                {dueTomorrow.map((d) => (
                  <tr key={d.id}>
                    <Td>
                      <bdi>{d.supplierName}</bdi>
                    </Td>
                    <Td>{t(`methods.${d.method as 'cheque'}`)}</Td>
                    <Td>
                      <bdi dir="ltr">{d.number ?? '—'}</bdi>
                    </Td>
                    <Td numeric>
                      <Money centimes={d.amountCentimes} />
                    </Td>
                    <Td>
                      <bdi dir="ltr">{d.due}</bdi>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      )}
      {owner && (
        <section aria-labelledby="pr-small" className="mt-6" data-testid="pr-small">
          <h2 id="pr-small" className="mb-3 text-xl">
            {t('smallReview')}
          </h2>
          {small.length === 0 ? (
            <p className="text-sm text-muted">{t('smallNone')}</p>
          ) : (
            <ul>
              {small.map((s) => (
                <li key={s.id} className="row-item text-sm">
                  <bdi>{s.supplierName}</bdi> · {t(`methods.${s.method as 'cheque'}`)} ·{' '}
                  <Money centimes={s.amountCentimes} /> {s.by ? `· ${s.by}` : ''}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <FilterBar
        label={tl('filters')}
        applyLabel={tl('apply')}
        resetLabel={tl('reset')}
        resetHref={path}
        data-testid="pr-filters"
      >
        <label className="block sm:col-span-2">
          <span className="field-label">{tl('search')}</span>
          <input type="search" name="q" defaultValue={first(q.q)} className="input mt-1" />
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
          { value: '', label: tl('statusAll'), count: all.length },
          ...STATES.filter((s) => all.some((r) => r.state === s)).map((s) => ({
            value: s,
            label: t(`states.${s}`),
            count: all.filter((r) => r.state === s).length,
          })),
        ]}
      />
      {page.total === 0 ? (
        <EmptyState title={all.length === 0 ? t('none') : tl('noMatch')} />
      ) : (
        <Table data-testid="pr-table">
          <thead>
            <tr>
              <SortTh id="date" sort={sort} path={path} q={q}>
                {t('date')}
              </SortTh>
              <SortTh id="supplier" sort={sort} path={path} q={q}>
                {t('supplier')}
              </SortTh>
              <Th>{t('method')}</Th>
              <SortTh id="amount" sort={sort} path={path} q={q} numeric>
                {t('amount')}
              </SortTh>
              <Th>{t('control')}</Th>
              <Th>{t('stateCol')}</Th>
              <Th>{t('preparedBy')}</Th>
              <Th>{t('actions')}</Th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((r) => (
              <tr key={r.id} data-testid={`pr-row-${r.supplierName}`}>
                <Td>
                  <bdi dir="ltr">{r.createdAt}</bdi>
                </Td>
                <Td>
                  <bdi>{r.supplierName}</bdi>
                </Td>
                <Td>{t(`methods.${r.method}`)}</Td>
                <Td numeric>
                  <Money centimes={r.amountCentimes} />
                </Td>
                <Td>{t(`levels.${r.level}`)}</Td>
                <Td>
                  <StatusPill status={PILL[r.state]}>{t(`states.${r.state}`)}</StatusPill>
                </Td>
                <Td>{r.preparedBy ?? '—'}</Td>
                <td>
                  <PaymentRequestActions
                    id={r.id}
                    state={r.state}
                    level={r.level}
                    canDecide={can(user.role, 'payments.decide')}
                    isOwner={owner}
                    canIssue={prepares}
                    decide={decidePaymentAction}
                    issue={issueRequestedPaymentAction}
                  />
                </td>
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
    </div>
  );
}
