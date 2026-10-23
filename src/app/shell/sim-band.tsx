import { getTranslations } from 'next-intl/server';
import { businessDateOf, formatSimDate } from '@/modules/clock';
import { SimBadge } from '@/modules/clock/ui/sim-badge';
import { simDays } from '@/modules/clock/ui/sim-days';
import { AdvanceSlot } from '../advance-slot';
import { getRequestClock } from '../request-clock';

/** The simulation band: tag, simulated date, day strip and the owner's "+1 jour". Renders nothing in real mode. */
export async function SimBand({ locale }: { locale: string }) {
  const clock = await getRequestClock();
  if (!clock.simulated) return null;
  const t = await getTranslations('clock');
  return (
    <SimBadge
      label={t('simulation')}
      at={formatSimDate(clock.now(), locale)}
      days={simDays(businessDateOf(clock.now()))}
      daysLabel={t('days')}
      locale={locale}
    >
      <AdvanceSlot />
    </SimBadge>
  );
}
