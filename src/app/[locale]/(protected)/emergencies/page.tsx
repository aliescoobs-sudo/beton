import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { listEmergencies } from '@/modules/field';
import { EmergenciesBoard } from '@/modules/field/ui/emergencies-board';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import { instructAction } from './actions';

/** The driver's emergency button lands here (and in the notifications of R5): who, where, at which step. */
export default async function EmergenciesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'field.emergencies');
  const emergencies = await listEmergencies(getPool('app'), user);
  const t = await getTranslations('field.board');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      <EmergenciesBoard
        emergencies={emergencies}
        canInstruct={can(user.role, 'field.instruct')}
        instruct={can(user.role, 'field.instruct') ? instructAction : null}
      />
    </div>
  );
}
