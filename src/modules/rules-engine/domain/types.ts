import type { Centimes } from '@/lib/money';

/** Alert severities (DECISIONS 22): risk 🔴, urgent 🟠, important 🟡, probable 🔵. Always shown with a label too. */
export const SEVERITIES = ['risk', 'urgent', 'important', 'probable'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Lower is worse. */
export const severityRank = (s: Severity): number => SEVERITIES.indexOf(s);

export type Direction = 'in' | 'out';
export type PaymentMethod = 'cash' | 'cheque' | 'lcn' | 'transfer';

/** Incoming flows are probable (R11: not cleared, not certain); what we owe is committed. Cleared money is `encaisse`. */
export type Certainty = 'committed' | 'probable';

export interface FlowRef {
  type: 'instrument' | 'order' | 'purchase';
  id: string;
  /** The code a person recognises: cheque number and bank, CMD-…, ACH-…. */
  code: string;
}

/** One dated movement of money still to happen, with the two dates of the two scenarios (DECISIONS 62). */
export interface CashFlow {
  id: string;
  direction: Direction;
  /** Always positive; the direction carries the sign. */
  amount: Centimes;
  /** The normal scenario. */
  baseDate: string;
  /** The worst scenario: the same as the base date, except an outgoing post-dated instrument counted from its issue date. */
  worstDate: string;
  certainty: Certainty;
  source: 'instrument' | 'plan';
  method: string;
  instrumentState: 'received' | 'deposited' | 'issued' | null;
  ref: FlowRef;
  partyId: string;
  partyName: string;
  /** An outgoing post-dated instrument: the bank may present it before its written date. */
  earlyPresentable: boolean;
  /** A plan flow of an order: the order's total and delivery date, used by the advance option. */
  orderTotal?: Centimes;
  deliveryDate?: string;
  /** A virtual flow added by a what-if (a purchase not made yet): never offered as something to postpone. */
  draft?: boolean;
}

/** An instrument not cleared yet (the service reads its last event). */
export interface InstrumentFact {
  id: string;
  direction: Direction;
  method: PaymentMethod;
  amount: Centimes;
  state: 'received' | 'deposited' | 'issued';
  writtenDate: string | null;
  receivedDate: string;
  depositedOn: string | null;
  partyId: string;
  partyName: string;
  /** Cheque or LCN number and bank. */
  label: string;
}

/** What is left to cover on a payment-plan item of an order (we receive) or a purchase (we pay). */
export interface PlanItemFact {
  id: string;
  direction: Direction;
  kind: 'order' | 'purchase';
  documentId: string;
  documentCode: string;
  partyId: string;
  partyName: string;
  dueDate: string;
  /** Centimes not covered by an allocation yet; zero or less is not passed. */
  remaining: Centimes;
  method: string;
  /** Orders only. */
  documentTotal?: Centimes;
  deliveryDate?: string;
}

export interface OverdueReceivable {
  id: string;
  documentId: string;
  documentCode: string;
  partyId: string;
  partyName: string;
  dueDate: string;
  daysLate: number;
  amount: Centimes;
}
