import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  INSTRUMENT_DIRECTIONS,
  INSTRUMENT_EVENTS,
  INSTRUMENT_METHODS,
  INSTRUMENT_STATES,
  initialState,
  isFinalState,
  nextState,
  regularizationDeadline,
  type InstrumentDirection,
  type InstrumentEvent,
  type InstrumentMethod,
  type InstrumentState,
} from './instrument';

// The whole legal table, written out. Anything not here must be refused (AC-LED-04).
const LEGAL: [InstrumentDirection, InstrumentMethod, InstrumentState, InstrumentEvent, InstrumentState][] = [
  ['in', 'cheque', 'received', 'deposit', 'deposited'],
  ['in', 'lcn', 'received', 'deposit', 'deposited'],
  ['in', 'cheque', 'deposited', 'clear', 'cleared'],
  ['in', 'lcn', 'deposited', 'clear', 'cleared'],
  ['in', 'cheque', 'deposited', 'bounce', 'bounced'],
  ['in', 'lcn', 'deposited', 'bounce', 'bounced'],
  ['in', 'cheque', 'bounced', 'regularize', 'regularized'],
  ['in', 'lcn', 'bounced', 'regularize', 'regularized'],
  ['in', 'cheque', 'bounced', 'dispute', 'disputed'],
  ['in', 'lcn', 'bounced', 'dispute', 'disputed'],
  ['in', 'cash', 'received', 'clear', 'cleared'],
  ['in', 'transfer', 'received', 'clear', 'cleared'],
  ['out', 'cheque', 'issued', 'clear', 'cleared'],
  ['out', 'lcn', 'issued', 'clear', 'cleared'],
  ['out', 'cheque', 'issued', 'bounce', 'bounced'],
  ['out', 'lcn', 'issued', 'bounce', 'bounced'],
  ['out', 'cash', 'issued', 'clear', 'cleared'],
  ['out', 'transfer', 'issued', 'clear', 'cleared'],
];
const key = (d: string, m: string, s: string, e: string) => `${d}/${m}/${s}/${e}`;
const legalKeys = new Map(LEGAL.map(([d, m, s, e, to]) => [key(d, m, s, e), to]));
const NON_FINAL_REACHABLE = (d: InstrumentDirection, s: InstrumentState) =>
  !isFinalState(s) && (d === 'in' ? s !== 'issued' : s === 'issued' || s === 'bounced');

describe('nextState', () => {
  it.each(LEGAL)('%s %s: %s --%s--> %s', (d, m, s, e, to) => {
    expect(nextState(d, m, s, e)).toEqual({ ok: true, value: to });
  });

  it('rejects every combination that is neither in the table nor a cancel of a non-final state', () => {
    for (const d of INSTRUMENT_DIRECTIONS)
      for (const m of INSTRUMENT_METHODS)
        for (const s of INSTRUMENT_STATES)
          for (const e of INSTRUMENT_EVENTS) {
            const result = nextState(d, m, s, e);
            const expected = legalKeys.get(key(d, m, s, e));
            if (expected) expect(result, key(d, m, s, e)).toEqual({ ok: true, value: expected });
            else if (e === 'cancel' && !isFinalState(s)) expect(result.ok, key(d, m, s, e)).toBe(true);
            else expect(result, key(d, m, s, e)).toEqual({ ok: false, error: 'ILLEGAL_TRANSITION' });
          }
  });

  it('a cleared instrument cannot bounce, a cheque cannot clear without a deposit (AC-LED-04)', () => {
    expect(nextState('in', 'cheque', 'cleared', 'bounce').ok).toBe(false);
    expect(nextState('in', 'cheque', 'received', 'clear').ok).toBe(false);
    expect(nextState('in', 'cash', 'received', 'deposit').ok).toBe(false);
  });

  it('final states accept nothing, not even a cancel', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...INSTRUMENT_DIRECTIONS),
        fc.constantFrom(...INSTRUMENT_METHODS),
        fc.constantFrom('cleared', 'regularized', 'disputed', 'cancelled' as const),
        fc.constantFrom(...INSTRUMENT_EVENTS),
        (d, m, s, e) => !nextState(d, m, s as InstrumentState, e).ok,
      ),
    );
  });

  it('every non-final state can be cancelled that the machine can reach', () => {
    for (const d of INSTRUMENT_DIRECTIONS)
      for (const s of INSTRUMENT_STATES.filter((x) => NON_FINAL_REACHABLE(d, x)))
        expect(nextState(d, 'cheque', s, 'cancel')).toEqual({ ok: true, value: 'cancelled' });
  });

  it('starts at received for incoming and issued for outgoing', () => {
    expect(initialState('in')).toBe('received');
    expect(initialState('out')).toBe('issued');
  });
});

describe('regularizationDeadline (law 71.24)', () => {
  it('is 30 days after the bounce', () => {
    expect(regularizationDeadline('2026-03-03')).toBe('2026-04-02');
    expect(regularizationDeadline('2026-12-15')).toBe('2027-01-14');
    expect(regularizationDeadline('2028-01-30')).toBe('2028-02-29');
  });
});
