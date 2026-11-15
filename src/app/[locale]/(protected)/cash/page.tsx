import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getRequestClock } from '@/app/request-clock';
import { getCashDay, getCashPosition, isRealDate } from '@/modules/ledger';
import { can, recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Card, EmptyState, FilterBar, Money, PageHeader, Table, Td, Th } from '@/ui';

/** Encaissé (real) next to the total including what is not cleared yet (R9). Owner and support only. */
export default async function CashPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'cash.view');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:cash-position');
  const position = await getCashPosition(pool, user);
  const today = (await getRequestClock()).today();
  const asked = Array.isArray(q.date) ? q.date[0] : q.date;
  const date = asked && isRealDate(asked) ? asked : today;
  const day = await getCashDay(pool, user, date);
  const tl = await getTranslations('list');
  // the owner reads the whole position (bank included); the Assistante reads the cash accounts and the day only (D245)
  const whole = can(user.role, 'cash.read');
  const t = await getTranslations('ledger.cash');
  const tAccounts = await getTranslations('ledger.accounts');

  const figures = [
    { id: 'real', label: t('real'), hint: t('realHint'), value: position.real },
    { id: 'incoming', label: t('incoming'), hint: t('incomingHint'), value: position.incomingUncleared },
    { id: 'total', label: t('total'), hint: t('totalHint'), value: position.total },
    { id: 'outgoing', label: t('outgoing'), hint: t('outgoingHint'), value: position.outgoingUncleared },
  ];

  return (
    <div>
      <PageHeader title={t('title')} />
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {figures
          .filter((f) => whole || f.id === 'real')
          .map((f) => (
            <Card key={f.id} data-testid={`cash-${f.id}`}>
              <p className="field-label">{f.label}</p>
              <p className="mt-2 text-2xl font-semibold">
                <Money centimes={f.value} />
              </p>
              <p className="mt-1 text-sm text-muted">{f.hint}</p>
            </Card>
          ))}
      </div>
      {whole && (
        <p className="mt-4 text-sm text-muted" data-testid="cash-after-outgoing">
          {t('afterOutgoing')} <Money centimes={position.totalAfterOutgoing} />
        </p>
      )}
      <section aria-labelledby="cash-day" className="mt-8" data-testid="cash-day">
        <h2 id="cash-day" className="mb-3 text-xl">
          {t('dayTitle')}
        </h2>
        <FilterBar
          label={tl('filters')}
          applyLabel={tl('apply')}
          resetLabel={tl('reset')}
          resetHref={`/${locale}/cash`}
        >
          <label className="block">
            <span className="field-label">{t('day')}</span>
            <input type="date" name="date" dir="ltr" defaultValue={date} className="input mt-1" />
          </label>
        </FilterBar>
        {day.length === 0 ? (
          <EmptyState title={t('empty')} />
        ) : (
          day.map((d) => (
            <div key={d.accountId} className="mb-6" data-testid={`cash-day-${d.label}`}>
              <h3 className="mb-1 font-semibold">
                <bdi>{d.label}</bdi>
              </h3>
              <p className="mb-2 text-sm text-muted">
                {t('dayStart')} <Money centimes={d.startCentimes} /> · {t('dayIn')}{' '}
                <Money centimes={d.cashIn} /> · {t('dayOut')} <Money centimes={d.cashOut} /> · {t('dayEnd')}{' '}
                <Money centimes={d.endCentimes} />
              </p>
              {d.lines.length === 0 ? (
                <p className="text-sm text-muted">{t('dayNone')}</p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>{t('daySource')}</Th>
                      <Th numeric>{t('dayAmount')}</Th>
                      <Th numeric>{t('dayRunning')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.lines.map((l) => (
                      <tr key={l.id}>
                        <Td>{l.source}</Td>
                        <Td numeric>
                          <Money centimes={l.amountCentimes} />
                        </Td>
                        <Td numeric>
                          <Money centimes={l.runningCentimes} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          ))
        )}
      </section>
      {position.accounts.length === 0 ? (
        <p className="mt-6 text-sm text-muted">{t('empty')}</p>
      ) : (
        <div className="mt-6">
          <Table>
            <thead>
              <tr>
                <Th>{tAccounts('label')}</Th>
                <Th>{tAccounts('kind')}</Th>
                <Th numeric>{tAccounts('opening')}</Th>
                <Th numeric>{t('movements')}</Th>
                <Th numeric>{t('real')}</Th>
                <Th numeric>{t('deposited')}</Th>
              </tr>
            </thead>
            <tbody>
              {position.accounts.map((a) => (
                <tr key={a.id} data-testid={`cash-account-${a.label}`}>
                  <td className="font-medium">
                    <bdi>{a.label}</bdi>
                  </td>
                  <td>{tAccounts(a.kind)}</td>
                  <td className="is-num">
                    <Money centimes={a.opening} />
                  </td>
                  <td className="is-num">
                    <Money centimes={a.movements} />
                  </td>
                  <td className="is-num" data-testid="cash-account-real">
                    <Money centimes={a.real} />
                  </td>
                  <td className="is-num">
                    <Money centimes={a.incomingDeposited} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  );
}
