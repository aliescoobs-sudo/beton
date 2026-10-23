import { getTranslations } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { realClock } from '@/modules/clock';
import { getChecklist } from '../service/checklist';

let cached: { complete: boolean; at: number } | undefined;

/** Fail-safe: shown unless the checklist is known to be complete (re-checked at most every 30 s). */
async function checklistComplete(): Promise<boolean> {
  const now = realClock.now().getTime();
  if (cached && now - cached.at < 30_000) return cached.complete;
  try {
    const { complete } = await getChecklist({
      systemPool: getPool('system'),
      authPool: getPool('auth'),
      clock: realClock,
    });
    cached = { complete, at: now };
    return complete;
  } catch {
    return false;
  }
}

/** "Données fictives uniquement" on every page until the security checklist is complete (SPEC §8). */
export async function FakeDataBanner() {
  if (await checklistComplete()) return null;
  const t = await getTranslations('checklist');
  return (
    <div
      role="status"
      className="bg-amber px-4 py-1 text-center text-xs font-semibold text-ink"
      data-testid="fake-data-banner"
    >
      {t('banner')}
    </div>
  );
}
