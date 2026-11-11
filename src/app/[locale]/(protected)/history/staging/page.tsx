import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import {
  type LabelKind,
  listLabels,
  listQuarantine,
  mappingTargets,
  reconciliation,
} from '@/modules/importer';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Button, EmptyState, Input, PageHeader, Select, Table, Td, Th } from '@/ui';
import { decideLabelAction, decideQuarantineAction } from './actions';

const TABS = ['clients', 'trucks', 'drivers', 'types', 'pumps', 'categories', 'quarantine', 'recon'] as const;
type Tab = (typeof TABS)[number];
const KIND_OF: Partial<Record<Tab, LabelKind>> = {
  clients: 'client',
  trucks: 'truck',
  drivers: 'driver',
  types: 'type',
  pumps: 'pump',
  categories: 'category',
};
const m3 = (litres: number) => `${Math.floor(litres / 1000)},${String(litres % 1000).padStart(3, '0')}`;
const mad = (c: number) => `${Math.floor(c / 100)},${String(c % 100).padStart(2, '0')}`;

/** The owner's staging screens of the history import: labels to map, rows in quarantine, and the reconciliation per plant and month. */
export default async function HistoryStagingPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ tab?: string; open?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'history.admin');
  const query = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(query.tab ?? '') ? (query.tab as Tab) : 'clients';
  const onlyOpen = query.open === '1';
  const t = await getTranslations('historyImport');
  const pool = getPool('app');
  const kind = KIND_OF[tab];

  return (
    <div className="space-y-6">
      <PageHeader title={t('staging.title')} description={t('staging.intro')} />
      <nav className="flex flex-wrap gap-2" data-testid="history-tabs">
        {TABS.map((x) => (
          <a
            key={x}
            href={`?tab=${x}`}
            className={x === tab ? 'font-semibold underline' : 'underline'}
            data-testid={`history-tab-${x}`}
          >
            {t(`tabs.${x}`)}
          </a>
        ))}
        {kind && (
          <a
            href={`?tab=${tab}&open=${onlyOpen ? 0 : 1}`}
            className="ms-4 underline"
            data-testid="history-only-open"
          >
            {onlyOpen ? t('showAll') : t('onlyOpen')}
          </a>
        )}
      </nav>
      {kind
        ? await LabelsTab({ kind, onlyOpen })
        : tab === 'quarantine'
          ? await QuarantineTab()
          : await ReconTab()}
    </div>
  );

  async function LabelsTab({ kind, onlyOpen }: { kind: LabelKind; onlyOpen: boolean }) {
    const [{ labels, groups }, targets] = await Promise.all([
      listLabels(pool, user, { kind, onlyOpen }),
      mappingTargets(pool, user),
    ]);
    if (labels.length === 0) return <EmptyState title={t('none')} data-testid="history-labels-none" />;
    const groupOf = new Map(groups.flatMap((g, i) => g.map((k) => [k, i + 1] as const)));
    const options =
      kind === 'client'
        ? targets.clients.map((c) => [c.id, `${c.code} ${c.name}`] as const)
        : kind === 'truck'
          ? targets.trucks.map((x) => [x.id, `${x.code} ${x.plate}`] as const)
          : kind === 'driver'
            ? targets.drivers.map((d) => [d.id, `${d.code} ${d.name}`] as const)
            : kind === 'type'
              ? targets.typeCodes.map((c) => [c, c] as const)
              : kind === 'pump'
                ? ([
                    ['pump', t('pump.pump')],
                    ['chute', t('pump.chute')],
                    ['unknown', t('pump.unknown')],
                  ] as const)
                : (['fuel', 'parts', 'tyres', 'wages_advance', 'office', 'other'] as const).map(
                    (c) => [c, t(`category.${c}`)] as const,
                  );
    return (
      <Table data-testid="history-labels">
        <thead>
          <tr>
            <Th>{t('label')}</Th>
            <Th numeric>{t('uses')}</Th>
            {kind === 'client' && <Th>{t('similar')}</Th>}
            <Th>{t('status.title')}</Th>
            <Th>{t('decide')}</Th>
          </tr>
        </thead>
        <tbody>
          {labels.map((l) => (
            <tr key={l.id} data-testid={`history-label-${l.key}`}>
              <Td dir="ltr">{l.label}</Td>
              <Td numeric>{l.uses}</Td>
              {kind === 'client' && <Td>{groupOf.get(l.key) ? `#${groupOf.get(l.key)}` : ''}</Td>}
              <Td>{t(`status.${l.status}`)}</Td>
              <Td>
                <form action={decideLabelAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="kind" value={l.kind} />
                  <input type="hidden" name="key" value={l.key} />
                  <Select name="choice" defaultValue="" aria-label={t('decide')}>
                    <option value="" disabled>
                      {t('choose')}
                    </option>
                    {options.map(([value, text]) => (
                      <option key={value} value={`map:${value}`}>
                        {t('mapTo', { target: text })}
                      </option>
                    ))}
                    {kind === 'client' && <option value="new">{t('createNew')}</option>}
                    {(kind === 'client' || kind === 'driver') && (
                      <option value="label_only">{t('labelOnly')}</option>
                    )}
                    {kind !== 'client' && kind !== 'driver' && (
                      <option value="unknown">{t('unknown')}</option>
                    )}
                  </Select>
                  <Button type="submit" variant="secondary">
                    {t('save')}
                  </Button>
                </form>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    );
  }

  async function QuarantineTab() {
    const rows = await listQuarantine(pool, user, { onlyOpen });
    if (rows.length === 0) return <EmptyState title={t('none')} data-testid="history-quarantine-none" />;
    return (
      <Table data-testid="history-quarantine">
        <thead>
          <tr>
            <Th>{t('where')}</Th>
            <Th>{t('reason')}</Th>
            <Th>{t('cells')}</Th>
            <Th>{t('status.title')}</Th>
            <Th>{t('decide')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((q) => (
            <tr key={q.id} data-testid={`history-q-${q.id}`}>
              <Td dir="ltr">{`${q.fileOrd}/${q.sheetPos}/${q.rowNo}`}</Td>
              <Td>{t(`reasons.${q.reason}`)}</Td>
              <Td dir="ltr">
                {[q.raw.date, q.raw.client ?? q.raw.label, q.raw.m3 ?? q.raw.amount]
                  .filter(Boolean)
                  .join(' · ')}
              </Td>
              <Td>{t(`qstatus.${q.status}`)}</Td>
              <Td>
                {q.status === 'open' ? (
                  <form action={decideQuarantineAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="id" value={q.id} />
                    <Input name="v_date" placeholder={t('fix.date')} dir="ltr" aria-label={t('fix.date')} />
                    <Input
                      name={q.kind === 'deliveries' ? 'v_m3' : 'v_amount'}
                      placeholder={q.kind === 'deliveries' ? 'm³' : 'MAD'}
                      dir="ltr"
                      aria-label={q.kind === 'deliveries' ? 'm³' : 'MAD'}
                    />
                    <Button type="submit" name="action" value="fix" variant="secondary">
                      {t('fix.fix')}
                    </Button>
                    <Button type="submit" name="action" value="discard" variant="secondary">
                      {t('fix.discard')}
                    </Button>
                  </form>
                ) : null}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    );
  }

  async function ReconTab() {
    const rows = await reconciliation(pool, user);
    if (rows.length === 0) return <EmptyState title={t('none')} data-testid="history-recon-none" />;
    return (
      <Table data-testid="history-recon">
        <thead>
          <tr>
            <Th>{t('recon.plant')}</Th>
            <Th>{t('recon.kind')}</Th>
            <Th>{t('recon.month')}</Th>
            <Th numeric>{t('recon.read')}</Th>
            <Th numeric>{t('recon.imported')}</Th>
            <Th numeric>{t('recon.quarantined')}</Th>
            <Th numeric>{t('recon.sumRead')}</Th>
            <Th numeric>{t('recon.sumImported')}</Th>
            <Th>{t('status.title')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.batchId}${r.month}`}
              data-testid={`history-recon-${r.plantCode ?? 'none'}-${r.month}`}
            >
              <Td dir="ltr">{r.plantCode ?? '—'}</Td>
              <Td>{t(`kinds.${r.kind}`)}</Td>
              <Td dir="ltr">{r.month}</Td>
              <Td numeric>{r.rowsRead}</Td>
              <Td numeric>{r.rowsImported}</Td>
              <Td numeric>{r.rowsQuarantined}</Td>
              <Td numeric>
                {r.kind === 'deliveries' ? `${m3(r.quantityRead)} m³` : `${mad(r.quantityRead)} MAD`}
              </Td>
              <Td numeric>
                {r.kind === 'deliveries' ? `${m3(r.quantityImported)} m³` : `${mad(r.quantityImported)} MAD`}
              </Td>
              <Td>{t(`batch.${r.status}`)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    );
  }
}
