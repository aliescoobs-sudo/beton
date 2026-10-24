import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getClientStatement, getSupplierStatement, isRealDate, parseStatementFilter } from '@/modules/ledger';
import { StatementView } from '@/modules/ledger/ui/statements/statement-view';
import { recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';

/** One client's or supplier's statement, filtered by date, type and status. Owner and support only. */
export default async function StatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; kind: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, kind, id } = await params;
  setRequestLocale(locale);
  if (kind !== 'client' && kind !== 'supplier') notFound();
  const user = await requirePagePermission(locale, 'statements.read');
  const pool = getPool('app');
  await recordMoneyView(pool, user, `screen:statement-${kind}`);
  const raw = await searchParams;
  const one = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : '');
  const filter = parseStatementFilter({
    from: one('from'),
    to: one('to'),
    type: one('type'),
    status: one('status'),
  });
  const today = (await getRequestClock()).today();
  const result = await (kind === 'client' ? getClientStatement : getSupplierStatement)(
    pool,
    user,
    id,
    filter,
    { today },
  );
  if (!result) notFound();
  const t = await getTranslations('ledger.statements');
  const query = new URLSearchParams(
    Object.entries({ from: one('from'), to: one('to'), type: one('type'), status: one('status') }).filter(
      ([k, v]) => v && (k !== 'from' && k !== 'to' ? true : isRealDate(v)),
    ),
  ).toString();
  return (
    <div>
      <Link href={`/${locale}/statements`} className="mb-2 inline-block text-sm text-muted underline">
        {t('back')}
      </Link>
      <PageHeader
        title={
          <>
            <bdi dir="ltr" className="num">
              {result.code}
            </bdi>{' '}
            — <bdi>{result.name}</bdi>
          </>
        }
      />
      <StatementView
        statement={result.statement}
        kind={kind}
        exportHref={`/${locale}/statements/${kind}/${id}/export${query ? `?${query}` : ''}`}
        filter={{ from: one('from'), to: one('to'), type: one('type'), status: one('status') }}
      />
    </div>
  );
}
