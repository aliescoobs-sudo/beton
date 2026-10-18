import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { z } from 'zod';
import { getPool } from '@/lib/db/pools';
import { can, SERVICE_AUDIT_ACTIONS } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/auth/page-guard';
import { listAuditEvents } from '@/modules/platform-security/service/audit-query';
import { AuditHistory } from '@/modules/platform-security/ui/audit/audit-history';

const ACTIONS = ['insert', 'update', ...SERVICE_AUDIT_ACTIONS] as const;
const filtersSchema = z.object({
  from: z.iso.date().optional().catch(undefined),
  to: z.iso.date().optional().catch(undefined),
  person: z.uuid().optional().catch(undefined),
  table: z
    .string()
    .regex(/^[A-Za-z_]+$/)
    .optional()
    .catch(undefined),
  action: z.enum(ACTIONS).optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
});

// Business dates are Casablanca dates; Morocco is on UTC+0 since 20 Sept 2026 (DECISIONS / SPEC-clock).
const dayStart = (date: string) => new Date(`${date}T00:00:00Z`);

export default async function HistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const viewer = await requirePagePermission(locale, 'audit.read_own');
  const f = filtersSchema.parse(
    Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])),
  );
  const seesAll = can(viewer.role, 'audit.read_all');

  const result = await listAuditEvents(getPool('app'), viewer, {
    from: f.from ? dayStart(f.from) : undefined,
    to: f.to ? new Date(dayStart(f.to).getTime() + 86_400_000) : undefined,
    actorId: f.person,
    table: f.table,
    action: f.action,
    page: f.page,
  });

  // Display names only (the auth role reads them); events are already scoped by RLS.
  const { rows: people } = await getPool('auth').query<{ id: string; name: string }>(
    seesAll ? 'select id, name from "user" order by name' : 'select id, name from "user" where id = $1',
    seesAll ? [] : [viewer.id],
  );
  const names = Object.fromEntries(people.map((p) => [p.id, p.name]));
  const t = await getTranslations('history');
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const link = (page: number) => {
    const q = new URLSearchParams(
      Object.entries({ ...f, page: String(page) }).filter(([, v]) => v !== undefined) as [string, string][],
    );
    return `/${locale}/historique?${q.toString()}`;
  };
  const input = 'mt-1 block rounded border border-gray-300 px-2 py-1';

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      {!seesAll && <p className="mt-2 text-sm text-gray-600">{t('ownOnly')}</p>}
      <form method="get" className="mt-4 flex flex-wrap items-end gap-3 text-sm">
        <label>
          {t('from')}
          <input type="date" name="from" defaultValue={f.from} className={input} />
        </label>
        <label>
          {t('to')}
          <input type="date" name="to" defaultValue={f.to} className={input} />
        </label>
        {seesAll && (
          <label>
            {t('person')}
            <select name="person" defaultValue={f.person ?? ''} className={input}>
              <option value="">{t('everyone')}</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          {t('table')}
          <input name="table" defaultValue={f.table} dir="ltr" className={input} />
        </label>
        <label>
          {t('action')}
          <select name="action" defaultValue={f.action ?? ''} className={input}>
            <option value="">{t('any')}</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded bg-gray-900 px-3 py-1 text-white">
          {t('filter')}
        </button>
      </form>
      <AuditHistory rows={result.rows} names={names} locale={locale} />
      <nav className="mt-4 flex items-center gap-4 text-sm">
        {result.page > 1 && <Link href={link(result.page - 1)}>{t('prev')}</Link>}
        <span>{t('pageOf', { page: result.page, pages })}</span>
        {result.page < pages && <Link href={link(result.page + 1)}>{t('next')}</Link>}
      </nav>
    </main>
  );
}
