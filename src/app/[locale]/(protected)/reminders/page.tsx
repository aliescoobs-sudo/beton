import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { listAccounts, listClientReminders } from '@/modules/ledger';
import { ReminderForm } from '@/modules/ledger/ui/reminders/reminder-form';
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
  Table,
  Td,
  Th,
} from '@/ui';
import { logReminderAction } from './actions';

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));

/** D245: the Responsable's reminder (relance) log: who owes, what is late, when the client was last reminded, and a note to log a new reminder. */
export default async function RemindersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'reminders.read');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:reminders');
  const today = (await getRequestClock()).today();
  const [accounts, reminders] = await Promise.all([
    listAccounts(pool, user, { today }),
    listClientReminders(pool, user),
  ]);
  const t = await getTranslations('ledger.reminders');
  const tl = await getTranslations('list');
  const path = `/${locale}/reminders`;
  const lastBy = new Map<string, string>();
  for (const r of reminders) if (!lastBy.has(r.clientId)) lastBy.set(r.clientId, r.createdAt.slice(0, 10));
  const rows = accounts
    .filter((a) => a.kind === 'client')
    .map((a) => ({ ...a, last: lastBy.get(a.partyId) ?? null }));
  const state = first(q.state) === 'late' ? 'late' : first(q.state) === 'never' ? 'never' : '';
  const text = first(q.q).trim().toLowerCase();
  const filtered = rows.filter(
    (r) =>
      (state !== 'late' || r.lateCentimes > 0) &&
      (state !== 'never' || (r.last === null && r.balanceCentimes > 0)) &&
      (!text || r.name.toLowerCase().includes(text) || r.code.toLowerCase().includes(text)),
  );
  const sort = parseSort(q, ['client', 'balance', 'late', 'last'], { key: 'late', dir: 'desc' });
  const page = paginate(
    sortRows(filtered, sort, {
      client: (r) => r.name,
      balance: (r) => r.balanceCentimes,
      late: (r) => r.lateCentimes,
      last: (r) => r.last,
    }),
    q,
  );
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      <FilterBar
        label={tl('filters')}
        applyLabel={tl('apply')}
        resetLabel={tl('reset')}
        resetHref={path}
        data-testid="reminders-filters"
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
          { value: '', label: tl('statusAll'), count: rows.length },
          { value: 'late', label: t('late'), count: rows.filter((r) => r.lateCentimes > 0).length },
          {
            value: 'never',
            label: t('neverReminded'),
            count: rows.filter((r) => r.last === null && r.balanceCentimes > 0).length,
          },
        ]}
      />
      {page.total === 0 ? (
        <EmptyState title={tl('noMatch')} description={tl('noMatchHint')} />
      ) : (
        <Table data-testid="reminders-table">
          <thead>
            <tr>
              <SortTh id="client" sort={sort} path={path} q={q}>
                {t('client')}
              </SortTh>
              <SortTh id="balance" sort={sort} path={path} q={q} numeric>
                {t('balance')}
              </SortTh>
              <SortTh id="late" sort={sort} path={path} q={q} numeric>
                {t('lateAmount')}
              </SortTh>
              <SortTh id="last" sort={sort} path={path} q={q}>
                {t('lastReminder')}
              </SortTh>
              <Th>{t('logOne')}</Th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((r) => (
              <tr key={r.partyId} data-testid={`reminder-row-${r.name}`}>
                <Td>
                  <Link href={`/${locale}/statements/client/${r.partyId}`} className="underline">
                    <bdi dir="ltr">{r.code}</bdi> — <bdi>{r.name}</bdi>
                  </Link>
                </Td>
                <Td numeric>
                  <Money centimes={r.balanceCentimes} />
                </Td>
                <Td numeric>{r.lateCentimes > 0 ? <Money centimes={r.lateCentimes} /> : '—'}</Td>
                <Td>{r.last ? <bdi dir="ltr">{r.last}</bdi> : t('never')}</Td>
                <td>
                  <ReminderForm clientId={r.partyId} log={logReminderAction} />
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
      <section aria-labelledby="rem-log" className="mt-8">
        <h2 id="rem-log" className="mb-3 text-xl">
          {t('recent')}
        </h2>
        {reminders.length === 0 ? (
          <p className="text-sm text-muted">{t('none')}</p>
        ) : (
          <ul data-testid="reminders-log">
            {reminders.slice(0, 20).map((r) => (
              <li key={r.id} className="row-item text-sm">
                <bdi dir="ltr">{r.createdAt.slice(0, 10)}</bdi> · <bdi>{r.clientName}</bdi> · {r.note}
                {r.byName ? ` (${r.byName})` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
