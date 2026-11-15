import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { type ChargeStatus, listCharges } from '@/modules/ledger';
import { ChargeActions } from '@/modules/ledger/ui/charges/charge-actions';
import { ChargeForm } from '@/modules/ledger/ui/charges/charge-form';
import { can, recordMoneyView } from '@/modules/platform-security';
import { requireAnyPagePermission } from '@/modules/platform-security/next';
import {
  EmptyState,
  ExportButton,
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
import { addDocumentAction, decideChargeAction, payChargeAction, recordChargeAction } from './actions';

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
const STATUSES: ChargeStatus[] = [
  'recorded',
  'pending_validation',
  'pending_approval',
  'validated',
  'approved',
  'paid',
  'rejected',
  'reversed',
];
const PILL: Record<ChargeStatus, PillStatus> = {
  recorded: 'ontrack',
  pending_validation: 'due',
  pending_approval: 'due',
  validated: 'ontrack',
  approved: 'ontrack',
  paid: 'paid',
  rejected: 'cancelled',
  reversed: 'cancelled',
};

/** D245, D247: the charges register of the Assistante. The Responsable sees here only what waits for its validation; the owner approves the upper band. */
export default async function ChargesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  setRequestLocale(locale);
  const user = await requireAnyPagePermission(locale, ['charges.read', 'charges.decide']);
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:charges');
  const today = (await getRequestClock()).today();
  const all = await listCharges(pool, user);
  const t = await getTranslations('ledger.charges');
  const tl = await getTranslations('list');
  const path = `/${locale}/charges`;
  const reads = can(user.role, 'charges.read');
  const state = STATUSES.find((s) => s === first(q.state)) ?? '';
  const noDoc = first(q.nodoc) === '1';
  const text = first(q.q).trim().toLowerCase();
  const filtered = all.filter(
    (c) =>
      (!state || c.status === state) &&
      (!noDoc || c.noDocument) &&
      (!text || c.beneficiary.toLowerCase().includes(text) || c.category.includes(text)),
  );
  const sort = parseSort(q, ['date', 'beneficiary', 'ttc'], { key: 'date', dir: 'desc' });
  const page = paginate(
    sortRows(filtered, sort, {
      date: (c) => c.date,
      beneficiary: (c) => c.beneficiary,
      ttc: (c) => c.ttcCentimes,
    }),
    q,
  );
  return (
    <div>
      <PageHeader
        title={t('title')}
        description={reads ? t('intro') : t('introValidator')}
        actions={reads ? <ExportButton href={`${path}/export`} label={tl('export')} /> : undefined}
      />
      {reads && <ChargeForm today={today} record={recordChargeAction} />}
      {all.some((c) => c.noDocument) && (
        <p role="status" className="form-band mb-4 font-semibold" data-testid="charges-no-document">
          {t('noDocumentBanner', { count: all.filter((c) => c.noDocument).length })}
        </p>
      )}
      <FilterBar
        label={tl('filters')}
        applyLabel={tl('apply')}
        resetLabel={tl('reset')}
        resetHref={path}
        data-testid="charges-filters"
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
        current={state}
        param="state"
        chips={[
          { value: '', label: tl('statusAll'), count: all.length },
          ...STATUSES.filter((s) => all.some((c) => c.status === s)).map((s) => ({
            value: s,
            label: t(`status.${s}`),
            count: all.filter((c) => c.status === s).length,
          })),
        ]}
      />
      {page.total === 0 ? (
        <EmptyState
          title={all.length === 0 ? t('none') : tl('noMatch')}
          description={all.length === 0 ? undefined : tl('noMatchHint')}
        />
      ) : (
        <Table data-testid="charges-table">
          <thead>
            <tr>
              <SortTh id="date" sort={sort} path={path} q={q}>
                {t('date')}
              </SortTh>
              <SortTh id="beneficiary" sort={sort} path={path} q={q}>
                {t('beneficiary')}
              </SortTh>
              <Th>{t('category')}</Th>
              <SortTh id="ttc" sort={sort} path={path} q={q} numeric>
                {t('ttc')}
              </SortTh>
              <Th>{t('mode')}</Th>
              <Th>{t('statusCol')}</Th>
              <Th>{t('preparedBy')}</Th>
              <Th>{t('actions')}</Th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((c) => (
              <tr key={c.id} data-testid={`charge-row-${c.beneficiary}`} data-no-document={c.noDocument}>
                <Td>
                  <bdi dir="ltr">{c.date}</bdi>
                </Td>
                <Td>
                  <bdi>{c.beneficiary}</bdi>
                </Td>
                <Td>{t(`categories.${c.category as 'other'}`)}</Td>
                <Td numeric>
                  <Money centimes={c.ttcCentimes} />
                </Td>
                <Td>{t(`modes.${c.mode as 'cash'}`)}</Td>
                <Td>
                  <StatusPill status={PILL[c.status]}>{t(`status.${c.status}`)}</StatusPill>
                  {c.noDocument && (
                    <StatusPill status="late" className="ms-1" data-testid="charge-flag-no-document">
                      {t('noDocument')}
                    </StatusPill>
                  )}
                </Td>
                <Td>{c.preparedBy ?? '—'}</Td>
                <td>
                  <ChargeActions
                    id={c.id}
                    status={c.status}
                    canDecide={can(user.role, 'charges.decide')}
                    canWrite={reads}
                    isOwner={user.role === 'owner' || user.role === 'app_admin'}
                    noDocument={c.noDocument}
                    decide={decideChargeAction}
                    pay={payChargeAction}
                    addDocument={addDocumentAction}
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
