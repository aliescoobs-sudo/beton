import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getStockLevels, listReorderRequests } from '@/modules/operations';
import { formatStockQty } from '@/modules/operations/ui/format';
import { ReorderCreateForm, ReorderRowActions } from '@/modules/operations/ui/reorder-board';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { EmptyState, PageHeader, StatusPill, Table, Td, Th } from '@/ui';
import { cancelReorderAction, createReorderAction, linkReorderAction, seenReorderAction } from './actions';

/** Reorder requests: the plant manager asks, office_purchases reads, marks seen and converts to a purchase. Quantities only, no price. */
export default async function ReordersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'reorder.read');
  const t = await getTranslations('operations.reorders');
  const requests = await listReorderRequests(getPool('app'), user);
  const canCreate = can(user.role, 'reorder.create');
  const canHandle = can(user.role, 'reorder.handle');
  const options = canCreate
    ? (await getStockLevels(getPool('app'), user, { plantId: null })).map((l) => ({
        id: l.componentId,
        name: locale === 'ar' ? l.nameAr : l.nameFr,
        baseUnit: l.baseUnit,
      }))
    : [];
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {canCreate && <ReorderCreateForm components={options} create={createReorderAction} />}
      {requests.length === 0 ? (
        <EmptyState title={t('none')} data-testid="reorders-none" />
      ) : (
        <Table data-testid="reorders-list">
          <thead>
            <tr>
              <Th>{t('plant')}</Th>
              <Th>{t('component')}</Th>
              <Th>{t('qty')}</Th>
              <Th>{t('neededBy')}</Th>
              <Th>{t('reason')}</Th>
              <Th>{t('state')}</Th>
              <Th>{t('actions')}</Th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => {
              const q = formatStockQty(r.qtyBase, r.baseUnit);
              return (
                <tr key={r.id} data-testid={`reorder-${r.id}`}>
                  <Td>
                    <bdi dir="ltr">{r.plantCode}</bdi>
                  </Td>
                  <Td>{locale === 'ar' ? r.nameAr : r.nameFr}</Td>
                  <Td>
                    <bdi dir="ltr">
                      {q.value} {q.unit}
                    </bdi>
                  </Td>
                  <Td>
                    <bdi dir="ltr">{r.neededBy}</bdi>
                  </Td>
                  <Td>
                    {r.auto ? `${t('auto')} · ` : ''}
                    {r.reason}
                  </Td>
                  <Td>
                    <StatusPill
                      status={r.state === 'ordered' ? 'paid' : r.state === 'cancelled' ? 'cancelled' : 'due'}
                    >
                      {t(`states.${r.state}` as never)}
                      {r.purchaseCode ? (
                        <>
                          {' '}
                          <bdi dir="ltr">{r.purchaseCode}</bdi>
                        </>
                      ) : null}
                    </StatusPill>
                  </Td>
                  <Td>
                    <ReorderRowActions
                      id={r.id}
                      state={r.state}
                      canHandle={canHandle}
                      canCancel={canCreate || user.role === 'owner' || user.role === 'app_admin'}
                      seen={seenReorderAction}
                      link={linkReorderAction}
                      cancel={cancelReorderAction}
                    />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}
