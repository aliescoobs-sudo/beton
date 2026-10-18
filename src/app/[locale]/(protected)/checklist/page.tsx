import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { realClock } from '@/modules/clock';
import { requirePagePermission } from '@/modules/platform-security/auth/page-guard';
import { getChecklist } from '@/modules/platform-security/service/checklist';
import { ChecklistPanel } from '@/modules/platform-security/ui/checklist/checklist-panel';

export default async function ChecklistPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requirePagePermission(locale, 'checklist.manage');
  const checklist = await getChecklist({
    systemPool: getPool('system'),
    authPool: getPool('auth'),
    clock: realClock,
  });
  const t = await getTranslations('checklist');
  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <ChecklistPanel items={checklist.items} complete={checklist.complete} />
    </main>
  );
}
