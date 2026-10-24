import { addCentimes, type Centimes, centimes, sumCentimes } from '@/lib/money';

// Account statements (SPEC-ledger AC-LED-19..21): what a client owes us, or what we owe a supplier, as one list of
// dated lines with a running balance, kept in two sections (the commercial side: what was ordered, invoiced, bought;
// the financial side: what was paid). Pure: the service reads the rows, this arranges and adds them up.

export type StatementSection = 'commercial' | 'financial';
export type StatementLineType =
  'opening' | 'order' | 'order_cancelled' | 'invoice' | 'credit_note' | 'payment';
export type LineStatus =
  | 'booked'
  | 'cancelled'
  | 'received'
  | 'deposited'
  | 'issued'
  | 'cleared'
  | 'bounced'
  | 'regularized'
  | 'disputed';

export interface StatementLine {
  id: string;
  section: StatementSection;
  date: string;
  type: StatementLineType;
  /** The document code (CMD-…) or the cheque number, when there is one. */
  code: string | null;
  status: LineStatus;
  /** Signed from the party's side: positive means the party owes more, negative less. */
  amountCentimes: Centimes;
  /** Does it count in the balance? Bounced, disputed, cancelled and regularized-away payments do not. */
  counted: boolean;
}

/** An open payment-plan item, to tell what is still due from what is late. */
export interface DueItem {
  dueDate: string;
  amountCentimes: Centimes;
  coveredCentimes: Centimes;
}

export interface StatementFilter {
  from?: string;
  to?: string;
  types?: readonly StatementLineType[];
  statuses?: readonly LineStatus[];
}

export interface StatementRow extends StatementLine {
  /** What the party owes after this line, over every counted line up to it (filters never change it). */
  balanceAfter: Centimes;
}

export interface StatementSummary {
  /** Orders still standing. */
  ordered: Centimes;
  /** Orders that were cancelled. */
  cancelled: Centimes;
  /** Invoices net of their credit notes (an invoice is a document on top of the order: it never moves the balance). */
  invoiced: Centimes;
  /** Payments cleared. */
  paid: Centimes;
  /** Payments received, deposited or issued, not cleared yet. */
  pending: Centimes;
  /** Open items not yet due. */
  due: Centimes;
  /** Open items past their due date. */
  late: Centimes;
  nextDueDate: string | null;
}

export interface Statement {
  commercial: StatementRow[];
  financial: StatementRow[];
  /** Balance carried into the range (everything counted before `from`); the opening balance of an unfiltered statement is zero. */
  carriedIn: Centimes;
  /** The balance after the last line of the range. */
  closing: Centimes;
  summary: StatementSummary;
}

const ORDER: Record<StatementSection, number> = { commercial: 0, financial: 1 };

const zero = centimes(0);

export function buildStatement(
  lines: readonly StatementLine[],
  dueItems: readonly DueItem[],
  today: string,
  filter: StatementFilter = {},
): Statement {
  const sorted = [...lines].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      ORDER[a.section] - ORDER[b.section] ||
      (a.code ?? '').localeCompare(b.code ?? '') ||
      a.id.localeCompare(b.id),
  );
  const counted = (l: StatementLine) => (l.counted ? l.amountCentimes : zero);
  const before = filter.from ? sorted.filter((l) => l.date < (filter.from as string)) : [];
  const carriedIn = sumCentimes(before.map(counted));

  const inRange = sorted.filter(
    (l) => (!filter.from || l.date >= filter.from) && (!filter.to || l.date <= filter.to),
  );
  let running = carriedIn;
  const rows: StatementRow[] = inRange.map((l) => {
    running = addCentimes(running, counted(l));
    return { ...l, balanceAfter: running };
  });
  const shown = rows.filter(
    (r) =>
      (!filter.types || filter.types.includes(r.type)) &&
      (!filter.statuses || filter.statuses.includes(r.status)),
  );

  const total = (pick: (l: StatementLine) => boolean) =>
    sumCentimes(sorted.filter(pick).map((l) => l.amountCentimes));
  const open = dueItems
    .map((i) => ({
      dueDate: i.dueDate,
      open: centimes(Math.max(0, Number(i.amountCentimes) - Number(i.coveredCentimes))),
    }))
    .filter((i) => i.open > 0);
  const future = open.filter((i) => i.dueDate >= today);
  return {
    commercial: shown.filter((r) => r.section === 'commercial'),
    financial: shown.filter((r) => r.section === 'financial'),
    carriedIn,
    closing: running,
    summary: {
      ordered: total((l) => l.type === 'order' && l.status !== 'cancelled'),
      cancelled: total((l) => l.type === 'order' && l.status === 'cancelled'),
      invoiced: total((l) => l.type === 'invoice' || l.type === 'credit_note'),
      paid: negate(total((l) => l.type === 'payment' && l.status === 'cleared')),
      pending: negate(
        total((l) => l.type === 'payment' && ['received', 'deposited', 'issued'].includes(l.status)),
      ),
      due: sumCentimes(future.map((i) => i.open)),
      late: sumCentimes(open.filter((i) => i.dueDate < today).map((i) => i.open)),
      nextDueDate: future.map((i) => i.dueDate).sort()[0] ?? null,
    },
  };
}

const negate = (a: Centimes): Centimes => centimes(-Number(a));

const TYPES: readonly StatementLineType[] = [
  'opening',
  'order',
  'order_cancelled',
  'invoice',
  'credit_note',
  'payment',
];
const STATUSES: readonly LineStatus[] = [
  'booked',
  'cancelled',
  'received',
  'deposited',
  'issued',
  'cleared',
  'bounced',
  'regularized',
  'disputed',
];
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The filter of a statement page or export from raw query strings: anything that is not a date, type or status is ignored. */
export function parseStatementFilter(raw: {
  from?: string;
  to?: string;
  type?: string;
  status?: string;
}): StatementFilter {
  const filter: { from?: string; to?: string; types?: StatementLineType[]; statuses?: LineStatus[] } = {};
  if (raw.from && DATE.test(raw.from)) filter.from = raw.from;
  if (raw.to && DATE.test(raw.to)) filter.to = raw.to;
  const type = TYPES.find((t) => t === raw.type);
  if (type) filter.types = [type];
  const status = STATUSES.find((s) => s === raw.status);
  if (status) filter.statuses = [status];
  return filter;
}
