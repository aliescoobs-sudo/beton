import { getLocale, getTranslations } from 'next-intl/server';
import { getEnv } from '@/lib/server-env';
import { offersFinanceEnrolment } from '@/lib/training';
import { currentAuthState } from '../auth/request-state';

/**
 * T1: a permanent banner on every page of the training instance, in the user's language, that cannot be mistaken for the
 * "données fictives" banner of the pilot: red, always shown, no checklist can switch it off.
 * R11-08: for a signed-in training account of a finance role without an authenticator, a link to the optional enrolment: the finance
 * module never accepts the password-only training sign-in, only a real TOTP.
 */
export async function TrainingBanner() {
  if (!getEnv().TRAINING_MODE) return null;
  const t = await getTranslations('training');
  const state = await currentAuthState().catch(() => null);
  const offerTotp = state?.kind === 'authenticated' && offersFinanceEnrolment(state.user);
  const locale = offerTotp ? await getLocale() : null;
  return (
    <div
      role="status"
      className="bg-signal px-4 py-2 text-center text-sm font-bold text-white"
      data-testid="training-banner"
    >
      {t('banner')}
      {offerTotp && (
        <>
          {' · '}
          <a href={`/${locale}/enrol`} className="underline" data-testid="training-enrol-link">
            {t('enrolForFinance')}
          </a>
        </>
      )}
    </div>
  );
}
