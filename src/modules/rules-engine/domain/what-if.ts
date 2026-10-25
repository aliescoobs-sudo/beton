import { type Centimes, subCentimes } from '@/lib/money';
import type { CashFlow } from './types';

/** A virtual change to the flows, to see the forecast it would give without writing anything (SPEC §3.2, AC-RE-10). */
export type Change =
  /** The flow happens on another date (both scenarios). */
  | { type: 'move'; flowId: string; to: string }
  /** The flow becomes another amount on another date (a discount: the net amount, earlier). */
  | { type: 'replace'; flowId: string; amount: Centimes; to: string }
  /** Part of the flow happens on another date; the rest stays. */
  | { type: 'split'; flowId: string; amount: Centimes; to: string }
  /** A flow that does not exist yet (an emergency purchase). */
  | { type: 'add'; flow: CashFlow };

/** The flows after the changes. Pure: the input is never modified; an unknown flow id changes nothing. */
export function applyChanges(flows: readonly CashFlow[], changes: readonly Change[]): CashFlow[] {
  let out = flows.map((f) => ({ ...f }));
  for (const change of changes) {
    if (change.type === 'add') {
      out.push({ ...change.flow });
      continue;
    }
    const i = out.findIndex((f) => f.id === change.flowId);
    const flow = out[i];
    if (!flow) continue;
    if (change.type === 'move') {
      out[i] = { ...flow, baseDate: change.to, worstDate: change.to, earlyPresentable: false };
    } else if (change.type === 'replace') {
      out[i] = {
        ...flow,
        amount: change.amount,
        baseDate: change.to,
        worstDate: change.to,
        earlyPresentable: false,
      };
    } else if (change.amount > 0 && change.amount < flow.amount) {
      out[i] = { ...flow, amount: subCentimes(flow.amount, change.amount) };
      out.push({
        ...flow,
        id: `${flow.id}~${change.to}`,
        amount: change.amount,
        baseDate: change.to,
        worstDate: change.to,
        earlyPresentable: false,
      });
    } else if (change.amount === flow.amount) {
      out[i] = { ...flow, baseDate: change.to, worstDate: change.to, earlyPresentable: false };
    }
  }
  out = out.sort((a, b) => a.baseDate.localeCompare(b.baseDate) || a.id.localeCompare(b.id));
  return out;
}
