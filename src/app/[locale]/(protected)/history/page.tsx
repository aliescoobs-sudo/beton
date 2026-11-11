import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { historyExpenses, historyVolume } from '@/modules/importer';
import { listPlants } from '@/modules/master-data';
import { formatM3 } from '@/modules/operations/ui/format';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, Money, PageHeader, Table, Td, Th } from '@/ui';

const FROM = '2000-01-01';
const TO = '2099-12-31';

/** The imported history (read-only, clearly labelled): volume by plant, by month and by concrete type; expenses by category (money roles only). */
export default async function HistoryPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'history.view');
  const pool = getPool('app');
  const t = await getTranslations('historyImport');
  const [volume, plants, expenses] = await Promise.all([
    can(user.role, 'history.read') ? historyVolume(pool, user, { from: FROM, to: TO }) : Promise.resolve([]),
    can(user.role, 'plants.read') ? listPlants(pool, user) : Promise.resolve([]),
    can(user.role, 'history.money')
      ? historyExpenses(pool, user, { from: FROM, to: TO })
      : Promise.resolve(null),
  ]);
  const plantCode = (id: string | null) => plants.find((p) => p.id === id)?.code ?? '—';
  const byMonth = new Map<string, { rows: number; volumeL: number }>();
  const byType = new Map<string, number>();
  for (const v of volume) {
    const k = `${plantCode(v.plantId)}|${v.month}`;
    const cur = byMonth.get(k) ?? { rows: 0, volumeL: 0 };
    byMonth.set(k, { rows: cur.rows + v.rows, volumeL: cur.volumeL + v.volumeL });
    byType.set(`${v.month}|${v.typeCode}`, (byType.get(`${v.month}|${v.typeCode}`) ?? 0) + v.volumeL);
  }
  const catRows = new Map<string, { amount: number; ml: number }>();
  for (const e of expenses ?? []) {
    const k = `${e.month}|${e.category}`;
    const cur = catRows.get(k) ?? { amount: 0, ml: 0 };
    catRows.set(k, { amount: cur.amount + e.amountCentimes, ml: cur.ml + (e.quantityMl ?? 0) });
  }
  return (
    <div className="space-y-8" data-testid="history-page">
      <PageHeader title={t('title')} description={t('badge')} />
      <p className="rounded border border-dashed p-3 text-sm" data-testid="history-badge">
        {t('badge')}
      </p>
      {volume.length === 0 && !(expenses && expenses.length > 0) ? (
        <EmptyState title={t('none')} data-testid="history-none" />
      ) : volume.length === 0 ? null : (
        <>
          <section>
            <h2 className="mb-2 text-lg font-semibold">{t('byPlantMonth')}</h2>
            <Table data-testid="history-by-month">
              <thead>
                <tr>
                  <Th>{t('recon.plant')}</Th>
                  <Th>{t('recon.month')}</Th>
                  <Th numeric>{t('recon.read')}</Th>
                  <Th numeric>m³</Th>
                </tr>
              </thead>
              <tbody>
                {[...byMonth.entries()].sort().map(([k, v]) => (
                  <tr key={k} data-testid={`history-month-${k}`}>
                    <Td dir="ltr">{k.split('|')[0]}</Td>
                    <Td dir="ltr">{k.split('|')[1]}</Td>
                    <Td numeric>{v.rows}</Td>
                    <Td numeric>{formatM3(v.volumeL)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </section>
          <section>
            <h2 className="mb-2 text-lg font-semibold">{t('byType')}</h2>
            <Table data-testid="history-by-type">
              <thead>
                <tr>
                  <Th>{t('recon.month')}</Th>
                  <Th>{t('type')}</Th>
                  <Th numeric>m³</Th>
                </tr>
              </thead>
              <tbody>
                {[...byType.entries()].sort().map(([k, litres]) => (
                  <tr key={k}>
                    <Td dir="ltr">{k.split('|')[0]}</Td>
                    <Td dir="ltr">{k.split('|')[1]}</Td>
                    <Td numeric>{formatM3(litres)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </section>
        </>
      )}
      {expenses && expenses.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">{t('expensesByCategory')}</h2>
          <Table data-testid="history-expenses">
            <thead>
              <tr>
                <Th>{t('recon.month')}</Th>
                <Th>{t('categoryTitle')}</Th>
                <Th numeric>{t('amount')}</Th>
                <Th numeric>{t('litres')}</Th>
              </tr>
            </thead>
            <tbody>
              {[...catRows.entries()].sort().map(([k, v]) => (
                <tr key={k}>
                  <Td dir="ltr">{k.split('|')[0]}</Td>
                  <Td>{t(`category.${k.split('|')[1]}`)}</Td>
                  <Td numeric>
                    <Money centimes={v.amount} />
                  </Td>
                  <Td numeric>{v.ml ? formatM3(v.ml) : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}
    </div>
  );
}
