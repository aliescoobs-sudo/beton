import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getCashPosition } from '@/modules/ledger';
import { recordMoneyView } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Card, Money, PageHeader, Table, Th } from '@/ui';

/** Encaissé (real) next to the total including what is not cleared yet (R9). Owner and support only. */
export default async function CashPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'cash.view');
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:cash-position');
  const position = await getCashPosition(pool, user);
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
        {figures.map((f) => (
          <Card key={f.id} data-testid={`cash-${f.id}`}>
            <p className="field-label">{f.label}</p>
            <p className="mt-2 text-2xl font-semibold">
              <Money centimes={f.value} />
            </p>
            <p className="mt-1 text-sm text-muted">{f.hint}</p>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-sm text-muted" data-testid="cash-after-outgoing">
        {t('afterOutgoing')} <Money centimes={position.totalAfterOutgoing} />
      </p>
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
