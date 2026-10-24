import { addCentimes, type Centimes, centimes, subCentimes, sumCentimes } from '@/lib/money';
import type { AccountKind } from './money-account';
import type { InstrumentDirection, InstrumentState } from './instrument';

export interface AccountInput {
  id: string;
  label: string;
  kind: AccountKind;
  /** The balance at the end of `openingAsOf` (movements up to that day are already in it). */
  openingCentimes: Centimes;
  openingAsOf: string | null;
  /** Signed: incoming positive, outgoing negative; reversals are movements too and net out. */
  movements: { date: string; amountCentimes: Centimes }[];
}

export interface InstrumentInput {
  direction: InstrumentDirection;
  amountCentimes: Centimes;
  state: InstrumentState;
  /** The bank account an incoming cheque or LCN was deposited to, once deposited. */
  depositAccountId: string | null;
}

export interface AccountPosition {
  id: string;
  label: string;
  kind: AccountKind;
  opening: Centimes;
  movements: Centimes;
  /** Encaissé: opening balance + cleared movements (R9). */
  real: Centimes;
  /** Deposited to this account and not cleared yet. */
  incomingDeposited: Centimes;
}

export interface CashPosition {
  accounts: AccountPosition[];
  /** Encaissé: Σ real over the accounts. */
  real: Centimes;
  /** Incoming cheques and LCN received or deposited, not cleared. */
  incomingUncleared: Centimes;
  /** Outgoing cheques and LCN issued, not cleared (a liability). */
  outgoingUncleared: Centimes;
  /** Total including uncleared (R9): real + incoming not cleared. */
  total: Centimes;
  /** The same after the outgoing payments still to clear. */
  totalAfterOutgoing: Centimes;
}

const pendingIn = (i: InstrumentInput) =>
  i.direction === 'in' && (i.state === 'received' || i.state === 'deposited');
const pendingOut = (i: InstrumentInput) => i.direction === 'out' && i.state === 'issued';

/**
 * The two views of money (R9, AC-LED-07): real cash (what the accounts hold) and the total including what is coming in
 * but not cleared. Pure: the service reads the rows, this adds them up. A bounced, cancelled, disputed or regularized
 * instrument counts for nothing here; a cleared one is already in the movements.
 */
export function cashPosition(
  accounts: AccountInput[],
  instruments: InstrumentInput[],
  accountId?: string,
): CashPosition {
  const chosen = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
  const positions = chosen.map<AccountPosition>((a) => {
    const counted = a.movements.filter((m) => a.openingAsOf === null || m.date > a.openingAsOf);
    const movements = sumCentimes(counted.map((m) => m.amountCentimes));
    return {
      id: a.id,
      label: a.label,
      kind: a.kind,
      opening: a.openingCentimes,
      movements,
      real: addCentimes(a.openingCentimes, movements),
      incomingDeposited: sumCentimes(
        instruments
          .filter((i) => pendingIn(i) && i.state === 'deposited' && i.depositAccountId === a.id)
          .map((i) => i.amountCentimes),
      ),
    };
  });
  const real = sumCentimes(positions.map((p) => p.real));
  // One account chosen: only what was deposited there; all accounts: everything not cleared (received ones have no account yet).
  const incomingUncleared = sumCentimes(
    instruments
      .filter(
        (i) => pendingIn(i) && (!accountId || (i.state === 'deposited' && i.depositAccountId === accountId)),
      )
      .map((i) => i.amountCentimes),
  );
  const outgoingUncleared = accountId
    ? centimes(0)
    : sumCentimes(instruments.filter(pendingOut).map((i) => i.amountCentimes));
  const total = addCentimes(real, incomingUncleared);
  return {
    accounts: positions,
    real,
    incomingUncleared,
    outgoingUncleared,
    total,
    totalAfterOutgoing: subCentimes(total, outgoingUncleared),
  };
}
