'use server';

import { getTranslations } from 'next-intl/server';
import { getEngineParams } from '@/app/engine-params';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { renderDrafts, type T } from '@/modules/owner-dashboard';
import { authorize, ForbiddenError, withStepUp } from '@/modules/platform-security';
import { currentAuthState } from '@/modules/platform-security/next';
import { confirmExcess } from '@/modules/operations';
import { applyOption, computeRun, reclassifyAlert } from '@/modules/rules-engine';

type ApplyResult = { ok: true; draftText: string; deposited: number } | { ok: false; error: string };

const LOCALES = ['fr', 'ar', 'ary'] as const;

// @permission cash.decide (owner) + sensitive action cash.apply_option: confirming an option records a decision with the
// figures the engine computes now and, for an early deposit, presents the cheques; nothing is sent to anyone
export async function applyOptionAction(input: {
  alertKey: string;
  optionId: string;
  accountId?: string;
  expectedGainCentimes?: number;
  locale: string;
}): Promise<ApplyResult> {
  const allowed = await authorize('cash.decide', { getState: currentAuthState, appPool: getPool('app') });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  const locale = (LOCALES as readonly string[]).includes(input.locale) ? input.locale : 'fr';
  try {
    const today = (await getRequestClock()).today();
    const params = await getEngineParams();
    const t = (await getTranslations({ locale, namespace: 'dashboard' })) as unknown as T;
    const result = await withStepUp(
      'cash.apply_option',
      (user) =>
        applyOption(
          getPool('app'),
          user,
          {
            alertKey: input.alertKey,
            optionId: input.optionId,
            accountId: input.accountId,
            expectedGainCentimes: input.expectedGainCentimes,
          },
          { today, params, renderDrafts: (drafts) => renderDrafts(t, locale, drafts) },
        ),
      { getState: currentAuthState },
    );
    if (!result.ok) return { ok: false, error: result.error };
    return result.value.ok
      ? { ok: true, draftText: result.value.value.draftText, deposited: result.value.value.deposited }
      : { ok: false, error: result.value.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission alerts.reclassify (owner) + sensitive action alert.reclassify: a severity and a reason, one more event
export async function reclassifyAction(input: {
  alertKey: string;
  severity: string;
  reason: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const allowed = await authorize('alerts.reclassify', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const today = (await getRequestClock()).today();
    const params = await getEngineParams();
    const result = await withStepUp(
      'alert.reclassify',
      async (user) => {
        const run = await computeRun(getPool('app'), user, today, params);
        return reclassifyAlert(getPool('app'), user, input, { today, hits: run.hits });
      },
      { getState: currentAuthState },
    );
    if (!result.ok) return { ok: false, error: result.error };
    return result.value.ok ? { ok: true } : { ok: false, error: result.value.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}

// @permission deliveries.excess_confirm (owner) + sensitive action load.confirm_excess: the load stands and is billed at the order's price
export async function confirmExcessAction(input: {
  excessId: string;
  note: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const allowed = await authorize('deliveries.excess_confirm', {
    getState: currentAuthState,
    appPool: getPool('app'),
  });
  if (!allowed.ok) return { ok: false, error: allowed.reason };
  try {
    const result = await withStepUp(
      'load.confirm_excess',
      (user) =>
        confirmExcess(getPool('app'), user, {
          excessId: input.excessId,
          note: input.note.trim() === '' ? null : input.note,
        }),
      { getState: currentAuthState },
    );
    if (!result.ok) return { ok: false, error: result.error };
    return result.value.ok ? { ok: true } : { ok: false, error: result.value.error };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: 'FORBIDDEN' };
    throw error;
  }
}
