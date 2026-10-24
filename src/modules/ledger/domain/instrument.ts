import { err, ok, type Result } from '@/lib/result';
import { addDaysIso } from './dates';
import { REGULARIZATION_WINDOW_DAYS } from './legal';

export const INSTRUMENT_DIRECTIONS = ['in', 'out'] as const;
export type InstrumentDirection = (typeof INSTRUMENT_DIRECTIONS)[number];

/** What actually arrived or left (a plan item may be labelled advance/installment; an instrument never is). */
export const INSTRUMENT_METHODS = ['cash', 'cheque', 'lcn', 'transfer'] as const;
export type InstrumentMethod = (typeof INSTRUMENT_METHODS)[number];

export const INSTRUMENT_STATES = [
  'received',
  'deposited',
  'cleared',
  'bounced',
  'regularized',
  'disputed',
  'issued',
  'cancelled',
] as const;
export type InstrumentState = (typeof INSTRUMENT_STATES)[number];

export const INSTRUMENT_EVENTS = ['deposit', 'clear', 'bounce', 'regularize', 'dispute', 'cancel'] as const;
export type InstrumentEvent = (typeof INSTRUMENT_EVENTS)[number];

export type TransitionError = 'ILLEGAL_TRANSITION';

const isPaper = (method: InstrumentMethod) => method === 'cheque' || method === 'lcn';

/** Where an instrument starts: what we receive is `received`, what we hand over is `issued`. */
export const initialState = (direction: InstrumentDirection): InstrumentState =>
  direction === 'in' ? 'received' : 'issued';

/** Final states: nothing follows. A cleared instrument entered by mistake is fixed by a reversing movement, not a state. */
export const isFinalState = (state: InstrumentState): boolean =>
  state === 'cleared' || state === 'regularized' || state === 'disputed' || state === 'cancelled';

/**
 * The next state, or ILLEGAL_TRANSITION (AC-LED-04). The same table is enforced by a trigger in the database.
 *  - incoming cheque/LCN: received → deposited → cleared | bounced; bounced → regularized | disputed
 *  - incoming cash/transfer: received → cleared (same day, nothing to deposit)
 *  - outgoing cheque/LCN: issued → cleared | bounced; outgoing cash/transfer: issued → cleared
 *  - any non-final state → cancelled
 */
export function nextState(
  direction: InstrumentDirection,
  method: InstrumentMethod,
  state: InstrumentState,
  event: InstrumentEvent,
): Result<InstrumentState, TransitionError> {
  const illegal = err('ILLEGAL_TRANSITION' as const);
  if (isFinalState(state)) return illegal;
  if (event === 'cancel') return ok('cancelled');
  if (direction === 'in') {
    if (state === 'received') {
      if (event === 'deposit' && isPaper(method)) return ok('deposited');
      if (event === 'clear' && !isPaper(method)) return ok('cleared');
      return illegal;
    }
    if (state === 'deposited' && isPaper(method)) {
      if (event === 'clear') return ok('cleared');
      if (event === 'bounce') return ok('bounced');
      return illegal;
    }
    if (state === 'bounced' && isPaper(method)) {
      if (event === 'regularize') return ok('regularized');
      if (event === 'dispute') return ok('disputed');
      return illegal;
    }
    return illegal;
  }
  if (state === 'issued') {
    if (event === 'clear') return ok('cleared');
    if (event === 'bounce' && isPaper(method)) return ok('bounced');
    return illegal;
  }
  return illegal;
}

/** Law 71.24: the last day to regularize a bounced cheque or LCN, 30 days after the bounce. */
export const regularizationDeadline = (bouncedDate: string): string =>
  addDaysIso(bouncedDate, REGULARIZATION_WINDOW_DAYS);
