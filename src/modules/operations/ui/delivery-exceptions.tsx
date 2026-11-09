import { getTranslations } from 'next-intl/server';
import type { DeliveryException } from '../service/trip-service';
import { formatM3 } from './format';

/**
 * The delivery exceptions (T9b, decision 206): flagged for the plant manager of the plant and for the owner, never corrected. Each line says what is
 * different and what is missing; a delivery the driver declared is never shown as delivered here, and none of these loads is billable until the plant side
 * has its own record through the billing gate.
 */
export async function DeliveryExceptions({ items }: { items: DeliveryException[] }) {
  const t = await getTranslations('operations.trips.exceptions');
  return (
    <section aria-labelledby="delivery-exceptions" data-testid="delivery-exceptions" className="space-y-2">
      <h2 id="delivery-exceptions" className="text-xl">
        {t('title')}
      </h2>
      <p className="text-sm text-muted">{t('intro')}</p>
      {items.length === 0 ? (
        <p className="text-sm text-muted" data-testid="delivery-exceptions-none">
          {t('none')}
        </p>
      ) : (
        <ul className="text-sm">
          {items.map((x) => (
            <li
              key={`${x.kind}-${x.tripId}`}
              className="row-item"
              data-kind={x.kind}
              data-testid={`exception-${x.kind}-${x.orderCode}`}
            >
              <strong>{t(`kind.${x.kind}` as never)}</strong> · <bdi dir="ltr">{x.orderCode}</bdi> ·{' '}
              <bdi dir="ltr">{x.truckCode}</bdi> · <bdi dir="ltr">{x.date}</bdi>
              {x.plantVolumeL !== null && (
                <>
                  {' · '}
                  {t('plant')} <bdi dir="ltr">{formatM3(x.plantVolumeL)} m³</bdi>
                </>
              )}
              {x.kind !== 'order_differs' &&
                x.plannedVolumeL !== null &&
                x.plantVolumeL !== null &&
                x.plantVolumeL !== x.plannedVolumeL && (
                  <>
                    {' · '}
                    {t('planned')} <bdi dir="ltr">{formatM3(x.plannedVolumeL)} m³</bdi>
                  </>
                )}
              {x.declaredVolumeL !== null && (
                <>
                  {' · '}
                  {t('declared')} <bdi dir="ltr">{formatM3(x.declaredVolumeL)} m³</bdi>
                </>
              )}
              {x.kind === 'order_differs' && x.orderVolumeL !== null && (
                <>
                  {' · '}
                  {t('order')} <bdi dir="ltr">{formatM3(x.orderVolumeL)} m³</bdi>
                </>
              )}
              <span className="text-muted"> — {t(`hint.${x.kind}` as never)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
