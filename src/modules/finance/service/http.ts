import type { FinanceActor, FinanceSession } from './request';
import { canFinance } from '../domain/permissions';
export interface HttpFinanceState {
  kind: string;
  user?: FinanceActor;
  session?: { twoFactorAt: Date | null };
}
export const financeNotFound = () =>
  new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
export async function handleFinancePost(
  request: Request,
  deps: {
    baseUrl: string;
    getState: () => Promise<HttpFinanceState>;
    enabled: () => Promise<boolean>;
    execute: (session: FinanceSession, input: unknown) => Promise<unknown>;
    configuration?: boolean;
    simulate?: (actor: FinanceActor, input: unknown) => Promise<unknown>;
  },
) {
  if (
    request.headers.get('origin') !== deps.baseUrl ||
    !request.headers.get('content-type')?.startsWith('application/json')
  )
    return financeNotFound();
  const state = await deps.getState();
  if (
    state.kind !== 'authenticated' ||
    !state.user ||
    !state.session ||
    !state.user.twoFactorEnabled ||
    !canFinance(state.user.role, 'finance.write')
  )
    return financeNotFound();
  if (!deps.configuration && !(await deps.enabled())) return financeNotFound();
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 131072) return new Response('Too large', { status: 413 });
    const input = JSON.parse(text);
    if (
      !input ||
      typeof input !== 'object' ||
      (deps.configuration ? input.action !== 'configure' : input.action === 'configure')
    )
      return financeNotFound();
    const result =
      input.action === 'simulateSteel' && deps.simulate
        ? await deps.simulate(state.user, input)
        : await deps.execute({ user: state.user, twoFactorAt: state.session.twoFactorAt }, input);
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const step = error instanceof Error && error.message === 'STEP_UP_REQUIRED';
    return Response.json(
      { error: step ? 'STEP_UP_REQUIRED' : 'REFUSED' },
      { status: step ? 409 : 422, headers: { 'cache-control': 'no-store' } },
    );
  }
}
