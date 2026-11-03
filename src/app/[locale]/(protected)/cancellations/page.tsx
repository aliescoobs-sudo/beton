import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { getCancellationPolicy, listCancellations } from '@/modules/operations';
import { CancellationsBoard } from '@/modules/operations/ui/cancellations-board';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import { candidatesAction, decideCaseAction, setPolicyAction } from './actions';

/** The seven cancellation cases (REQUIREMENTS-V1 §8): open cases to decide, decided cases, and the owner's policy. */
export default async function CancellationsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (!getEnv().CANCELLATIONS_ENABLED) notFound();
  const user = await requirePagePermission(locale, 'cancellations.read');
  const [cases, policy] = await Promise.all([
    listCancellations(getPool('app'), user),
    getCancellationPolicy(getPool('app'), user),
  ]);
  const t = await getTranslations('cancellations');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      <CancellationsBoard
        cases={cases}
        policy={policy}
        canDecide={can(user.role, 'cancellations.decide')}
        canSetPolicy={can(user.role, 'cancellations.policy')}
        decide={decideCaseAction}
        setPolicy={can(user.role, 'cancellations.policy') ? setPolicyAction : null}
        candidates={candidatesAction}
      />
    </div>
  );
}
