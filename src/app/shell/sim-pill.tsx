import { getTranslations } from 'next-intl/server';
import { formatSimDate } from '@/modules/clock';
import { SimBadge } from '@/modules/clock/ui/sim-badge';
import { AdvanceSlot } from '../advance-slot';
import { getRequestClock } from '../request-clock';

/** The compact "SIMULATION — date" pill, with the owner's "Avancer à" control in its popover. Renders nothing in real mode. */
export async function SimPill({ locale }: { locale: string }) {
  const clock = await getRequestClock();
  if (!clock.simulated) return null;
  const t = await getTranslations('clock');
  return (
    <SimBadge label={t('simulation')} at={formatSimDate(clock.now(), locale)}>
      <AdvanceSlot />
    </SimBadge>
  );
}
