import { getTranslations } from 'next-intl/server';
import { getEnv } from '@/lib/server-env';

/**
 * T1: a permanent banner on every page of the training instance, in the user's language, that cannot be mistaken for the
 * "données fictives" banner of the pilot: red, always shown, no checklist can switch it off.
 */
export async function TrainingBanner() {
  if (!getEnv().TRAINING_MODE) return null;
  const t = await getTranslations('training');
  return (
    <div
      role="status"
      className="bg-signal px-4 py-2 text-center text-sm font-bold text-white"
      data-testid="training-banner"
    >
      {t('banner')}
    </div>
  );
}
