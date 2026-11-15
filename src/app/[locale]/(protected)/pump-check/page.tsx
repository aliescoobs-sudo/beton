import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { isRealDate } from '@/modules/ledger';
import { listPlants } from '@/modules/master-data';
import { loadPumpCheck, PUMP_CHECK_KINDS } from '@/modules/operations';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, PageHeader, StatusPill, Table, Td, Th } from '@/ui';

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * T17 G10 (D243): the pump check, per day and plant. Owner and app_admin see every plant; a plant manager sees his own (the database binds it). References and quantities only: no cost, no margin.
 */
export default async function PumpCheckPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'pump_check.read');
  const t = await getTranslations('pumpCheck');
  const today = (await getRequestClock()).today();
  const qTo = first(q.to);
  const qFrom = first(q.from);
  const to = qTo && isRealDate(qTo) ? qTo : today;
  const from = qFrom && isRealDate(qFrom) ? qFrom : addDays(to, -6);
  const pool = getPool('app');
  const owner = can(user.role, 'costs.manage');
  const plants = owner ? (await listPlants(pool, user)).filter((p) => p.status === 'active') : [];
  const plantId = owner ? (first(q.plant) ?? null) : null;
  const res = await loadPumpCheck(pool, user, { from, to, plantId: plantId || null });
  const rows = res.ok ? res.value : [];
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      <form
        method="get"
        className="form-band mb-4 flex flex-wrap items-end gap-3"
        data-testid="pump-check-filters"
      >
        <label className="block">
          <span className="field-label">{t('from')}</span>
          <input type="date" name="from" dir="ltr" defaultValue={from} className="input mt-1" />
        </label>
        <label className="block">
          <span className="field-label">{t('to')}</span>
          <input type="date" name="to" dir="ltr" defaultValue={to} className="input mt-1" />
        </label>
        {owner && (
          <label className="block">
            <span className="field-label">{t('plant')}</span>
            <select name="plant" defaultValue={plantId ?? ''} className="input mt-1">
              <option value="">—</option>
              {plants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" className="btn btn-primary" data-testid="pump-check-apply">
          {t('apply')}
        </button>
      </form>
      {!res.ok && (
        <p role="alert" className="field-error">
          {t('invalid')}
        </p>
      )}
      {res.ok && rows.length === 0 && <EmptyState title={t('none')} />}
      {PUMP_CHECK_KINDS.map((kind) => {
        const list = rows.filter((r) => r.kind === kind);
        return (
          <section key={kind} className="mt-6" data-testid={`pump-check-${kind}`}>
            <h2 className="text-lg font-semibold">
              {t(`kinds.${kind}.title`)}{' '}
              <StatusPill status={list.length > 0 ? 'late' : 'paid'}>{list.length}</StatusPill>
            </h2>
            <p className="text-sm text-muted">{t(`kinds.${kind}.note`)}</p>
            {list.length > 0 && (
              <Table>
                <thead>
                  <tr>
                    <Th>{t('day')}</Th>
                    <Th>{t('plant')}</Th>
                    <Th>{t('client')}</Th>
                    <Th>{kind === 'job_no_pompe_bl' ? t('site') : t('bl')}</Th>
                    <Th numeric>{t('volume')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r, i) => (
                    <tr key={`${r.blNo ?? r.jobId}-${i}`}>
                      <Td>
                        <bdi dir="ltr">{r.day}</bdi>
                      </Td>
                      <Td>
                        <bdi dir="ltr">{r.plantCode ?? '—'}</bdi>
                      </Td>
                      <Td>
                        {r.clientCode ? <bdi dir="ltr">{r.clientCode}</bdi> : '—'} {r.clientName}
                      </Td>
                      <Td>{kind === 'job_no_pompe_bl' ? r.siteLabel : <bdi dir="ltr">{r.blNo}</bdi>}</Td>
                      <Td numeric>{r.volumeL === null ? '—' : <bdi dir="ltr">{r.volumeL / 1000}</bdi>}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </section>
        );
      })}
    </div>
  );
}
