import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { listPlants } from '@/modules/master-data';
import { getFuelTankLevels, listTransfers } from '@/modules/operations';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { Button, PageHeader, StatusPill } from '@/ui';
import {
  fuelTankOpeningAction,
  pickUpTransferAction,
  receiveTransferAction,
  sendTransferAction,
} from './actions';

/** Transfers of material and fuel between the plants: sent, in transit, received, with the variance and who did each step (§16.5). */
export default async function TransfersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (!getEnv().TRANSFERS_ENABLED) notFound();
  const user = await requirePagePermission(locale, 'transfers.read');
  const pool = getPool('app');
  const [transfers, plants, tanks] = await Promise.all([
    listTransfers(pool, user),
    listPlants(pool, user),
    getFuelTankLevels(pool, user),
  ]);
  const name = (id: string) => plants.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const t = await getTranslations('transfers');
  const write = can(user.role, 'transfers.write');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      {write && (
        <form
          action={sendTransferAction}
          className="mt-4 flex flex-wrap items-end gap-2 text-sm"
          data-testid="transfer-send"
        >
          <select name="kind">
            <option value="material">{t('kind.material')}</option>
            <option value="fuel">{t('kind.fuel')}</option>
          </select>
          <select name="fromPlant">
            {plants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span>→</span>
          <select name="toPlant">
            {plants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input name="componentId" placeholder={t('componentId')} />
          <input name="qty" type="number" min={1} required placeholder={t('qty')} />
          <Button type="submit">{t('send')}</Button>
        </form>
      )}
      <section className="mt-6" data-testid="fuel-tanks">
        <h2 className="text-lg font-semibold">{t('tanksTitle')}</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {tanks.map((k) => (
            <li key={k.plantId} data-testid={`fuel-tank-${k.plantId}`}>
              {k.plantName} · <bdi dir="ltr">{k.levelL.toLocaleString('fr-FR')} L</bdi>
              {k.inTransitL > 0 && ` · ${t('inTransit')} ${k.inTransitL.toLocaleString('fr-FR')} L`}
              {write && k.asOf === null && (
                <form action={fuelTankOpeningAction} className="ms-2 inline-flex gap-1">
                  <input type="hidden" name="plantId" value={k.plantId} />
                  <input
                    name="litres"
                    type="number"
                    min={0}
                    required
                    placeholder={t('openingL')}
                    className="w-28"
                  />
                  <Button type="submit">{t('setOpening')}</Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </section>
      <ul className="mt-4 space-y-2" data-testid="transfers">
        {transfers.map((x) => (
          <li key={x.id} className="rounded border p-3 text-sm" data-testid={`transfer-${x.id}`}>
            <StatusPill status={x.status === 'received' ? (x.variance ? 'due' : 'paid') : 'ontrack'}>
              {t(`status.${x.status}` as never)}
            </StatusPill>{' '}
            {t(`kind.${x.kind}` as never)} · {name(x.fromPlant)} → {name(x.toPlant)} · {x.qty}
            {x.receivedQty !== null && ` → ${x.receivedQty} (${t('variance')} ${x.variance})`}
            {write && x.status === 'sent' && (
              <form action={pickUpTransferAction}>
                <input type="hidden" name="id" value={x.id} />
                <Button type="submit">{t('pickUp')}</Button>
              </form>
            )}
            {write && x.status === 'in_transit' && (
              <form action={receiveTransferAction} className="mt-1 flex gap-2">
                <input type="hidden" name="id" value={x.id} />
                <input name="qty" type="number" min={0} required placeholder={t('receivedQty')} />
                <Button type="submit">{t('receive')}</Button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
