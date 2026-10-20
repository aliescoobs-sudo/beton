import { AdvanceControl } from '@/modules/clock';
import { can } from '@/modules/platform-security/domain/permissions';
import { currentAuthState } from '@/modules/platform-security/auth/request-state';
import { StepUpDialog } from '@/modules/platform-security/ui/step-up-dialog';
import { advanceClockAction } from './advance-action';

/** The "Avancer à" control, for a signed-in owner only (the action re-checks role and step-up). */
export async function AdvanceSlot() {
  const state = await currentAuthState();
  if (state.kind !== 'authenticated' || !can(state.user.role, 'simulation.control')) return null;
  return <AdvanceControl action={advanceClockAction} StepUp={StepUpDialog} />;
}
