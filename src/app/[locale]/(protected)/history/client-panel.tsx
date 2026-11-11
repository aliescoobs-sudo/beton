import { getTranslations } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { historyClientVolume } from '@/modules/importer';
import { formatM3 } from '@/modules/operations/ui/format';
import { can, type SessionUser } from '@/modules/platform-security';
import { Table, Td, Th } from '@/ui';

/** Quantities by month the history holds for one client, labelled "historical (imported)". No amount: the files carry none. Nothing when there is none. */
export async function HistoryClientPanel({ user, clientId }: { user: SessionUser; clientId: string }) {
  if (!can(user.role, 'history.read')) return null;
  const rows = await historyClientVolume(getPool('app'), user, clientId);
  if (rows.length === 0) return null;
  const t = await getTranslations('historyImport');
  return (
    <section className="mt-8" data-testid="history-client-panel">
      <h2 className="mb-1 text-lg font-semibold">{t('clientPanel')}</h2>
      <p className="mb-2 text-sm text-muted">{t('badge')}</p>
      <Table>
        <thead>
          <tr>
            <Th>{t('recon.month')}</Th>
            <Th numeric>{t('recon.read')}</Th>
            <Th numeric>m³</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month}>
              <Td dir="ltr">{r.month}</Td>
              <Td numeric>{r.rows}</Td>
              <Td numeric>{formatM3(r.volumeL)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}
