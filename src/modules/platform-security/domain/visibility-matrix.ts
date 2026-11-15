import { PERMISSIONS, type Role } from './permissions';

/**
 * §16.1 (REQUIREMENTS-V1): for every money item, four rights stated separately. Entering or printing never grants a
 * balance or an aggregate. The matrix is data: CP-PROD-PLAN.md prints it (a test fails when the two differ) and
 * `tests/visibility-matrix.int.test.ts` proves the balance column in the database.
 *
 * `keys` ties a right to the permission that implements it, so that the matrix cannot drift from the route and
 * service guards: a tied right must list exactly the roles of that permission.
 */
export interface VisibilityRow {
  item: string;
  enters: readonly Role[];
  /** Sees the item inside a document (an invoice, an order sheet, a cheque slip). */
  inDocument: readonly Role[];
  /** Sees balances and aggregates over the item. */
  balances: readonly Role[];
  exports: readonly Role[];
  /**
   * D245 (D-A): the ONE office role that may read this item's balances because it is the money of its own side
   * (office_sales: the client side; office_purchases: the supplier side and the cash accounts). Anything else is a violation.
   */
  officeSide?: 'office_sales' | 'office_purchases';
  keys?: {
    enters?: keyof typeof PERMISSIONS;
    balances?: keyof typeof PERMISSIONS;
    exports?: keyof typeof PERMISSIONS;
  };
}

const OA = ['owner', 'app_admin'] as const;
/** Balances and aggregates: owner and app_admin; support reads for maintenance (DECISIONS 81). */
const BAL = ['owner', 'app_admin', 'support'] as const;

export const VISIBILITY_MATRIX: readonly VisibilityRow[] = [
  {
    item: 'Reference average prices (sell and buy)',
    enters: OA,
    inDocument: [
      'owner',
      'app_admin',
      'office',
      'office_sales',
      'office_purchases',
      'plant',
      'plant_manager',
      'support',
    ],
    balances: [],
    exports: [],
    keys: { enters: 'selling_prices.write' },
  },
  {
    item: 'Order and quote prices and totals',
    enters: ['owner', 'app_admin', 'office', 'office_sales'],
    inDocument: ['owner', 'app_admin', 'office_sales', 'support'],
    balances: BAL,
    exports: ['owner', 'app_admin', 'support'],
    keys: { enters: 'orders.write', balances: 'orders.read_money' },
  },
  {
    item: 'Sales invoices and avoirs',
    enters: ['owner', 'app_admin', 'office', 'office_sales'],
    inDocument: ['owner', 'app_admin', 'office_sales', 'accountant', 'support'],
    balances: BAL,
    exports: ['owner', 'app_admin', 'accountant', 'support'],
    keys: { enters: 'invoices.write', exports: 'accounting.export' },
  },
  {
    item: 'Supplier invoices and purchase prices',
    enters: ['owner', 'app_admin', 'office', 'office_purchases'],
    inDocument: ['owner', 'app_admin', 'office_purchases', 'support'],
    balances: BAL,
    exports: ['owner', 'app_admin', 'accountant', 'support'],
    keys: { enters: 'supplier_invoices.write', balances: 'supplier_invoices.read' },
  },
  {
    item: 'Payments in and out (cash, cheque, LCN)',
    enters: ['owner', 'app_admin', 'office', 'office_sales', 'office_purchases'],
    inDocument: BAL,
    balances: BAL,
    exports: [],
    keys: { enters: 'instruments.write', balances: 'instruments.read' },
  },
  {
    item: 'Payments in (client side: receipts, cheques, LCN)',
    enters: [],
    inDocument: [...BAL, 'office_sales'],
    balances: [...BAL, 'office_sales'],
    exports: [],
    officeSide: 'office_sales',
    keys: { balances: 'instruments.read_in' },
  },
  {
    item: 'Payments out (supplier side)',
    enters: [],
    inDocument: [...BAL, 'office_purchases'],
    balances: [...BAL, 'office_purchases'],
    exports: [],
    officeSide: 'office_purchases',
    keys: { balances: 'instruments.read_out' },
  },
  {
    item: 'Client and supplier balances',
    enters: [],
    inDocument: BAL,
    balances: BAL,
    exports: [],
    keys: { balances: 'statements.read' },
  },
  {
    item: 'Client balances and statements',
    enters: [],
    inDocument: [...BAL, 'office_sales'],
    balances: [...BAL, 'office_sales'],
    exports: [...BAL, 'office_sales'],
    officeSide: 'office_sales',
    keys: { balances: 'statements.client' },
  },
  {
    item: 'Supplier balances and statements',
    enters: [],
    inDocument: [...BAL, 'office_purchases'],
    balances: [...BAL, 'office_purchases'],
    exports: [...BAL, 'office_purchases'],
    officeSide: 'office_purchases',
    keys: { balances: 'statements.supplier' },
  },
  {
    item: 'Client aging and client cheques due (30/60/90 days)',
    enters: [],
    inDocument: [...OA, 'office_sales'],
    balances: [...OA, 'office_sales'],
    exports: [...OA, 'office_sales'],
    officeSide: 'office_sales',
    keys: { balances: 'aging.client' },
  },
  {
    item: 'Supplier aging and issued cheques due (30/60/90 days)',
    enters: [],
    inDocument: [...OA, 'office_purchases'],
    balances: [...OA, 'office_purchases'],
    exports: [...OA, 'office_purchases'],
    officeSide: 'office_purchases',
    keys: { balances: 'aging.supplier' },
  },
  {
    item: 'Loan and leasing instalments and the net cash forecast',
    enters: OA,
    inDocument: OA,
    balances: OA,
    exports: [],
    keys: { enters: 'opening.write', balances: 'opening.write' },
  },
  {
    item: 'Cash accounts (the cash, never a bank account)',
    enters: [],
    inDocument: [...BAL, 'office_purchases'],
    balances: [...BAL, 'office_purchases'],
    exports: [],
    officeSide: 'office_purchases',
    keys: { balances: 'cash.view' },
  },
  {
    item: 'Cash, bank, treasury, forecast',
    enters: OA,
    inDocument: BAL,
    balances: BAL,
    exports: [],
    keys: { enters: 'money_accounts.write', balances: 'cash.read' },
  },
  {
    item: 'Fuel purchases (amounts)',
    enters: OA,
    inDocument: BAL,
    balances: BAL,
    exports: [],
    keys: { enters: 'fuel.purchase', balances: 'fuel.money' },
  },
];

const roleSet = (r: readonly Role[]) => [...r].sort();

/** Violations of the rules of §16.1; the unit test expects none. */
export function matrixViolations(rows: readonly VisibilityRow[] = VISIBILITY_MATRIX): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const bal = new Set<Role>(row.officeSide ? [...BAL, row.officeSide] : BAL);
    for (const r of row.balances)
      if (!bal.has(r)) out.push(`${row.item}: ${r} sees balances, only owner, app_admin and support may`);
    for (const r of row.exports)
      if (!bal.has(r) && r !== 'accountant')
        out.push(`${row.item}: ${r} exports, only the accountant besides the money roles`);
    for (const r of row.enters)
      if (!bal.has(r) && row.balances.includes(r)) out.push(`${row.item}: entering gives ${r} the balance`);
    // D245: the office exception is only ever ONE role, on its own side
    if (row.officeSide && row.balances.some((r) => r.startsWith('office') && r !== row.officeSide))
      out.push(`${row.item}: only ${row.officeSide} may read this side`);
    for (const [right, key] of Object.entries(row.keys ?? {})) {
      const list = (row as unknown as Record<string, readonly Role[]>)[right] ?? [];
      const perm = PERMISSIONS[key as keyof typeof PERMISSIONS] as readonly Role[];
      if (JSON.stringify(roleSet(list)) !== JSON.stringify(roleSet(perm)))
        out.push(`${row.item}: ${right} differs from permission ${key}`);
    }
  }
  return out;
}

/** The matrix as the markdown table printed in CP-PROD-PLAN.md. */
export function matrixMarkdown(rows: readonly VisibilityRow[] = VISIBILITY_MATRIX): string {
  const cell = (r: readonly Role[]) => (r.length ? r.join(', ') : '—');
  const head =
    '| Item | Enters | Sees in a document | Sees balances and aggregates | Exports |\n|---|---|---|---|---|';
  return [
    head,
    ...rows.map(
      (x) =>
        `| ${x.item} | ${cell(x.enters)} | ${cell(x.inDocument)} | ${cell(x.balances)} | ${cell(x.exports)} |`,
    ),
  ].join('\n');
}

/** F09: does this role see balances and aggregates over this item (§16.1)? Services use it to avoid calling a balance door a role is refused. */
export function seesBalances(role: Role, item: string): boolean {
  return VISIBILITY_MATRIX.find((r) => r.item === item)?.balances.includes(role) ?? false;
}
export const INVOICE_ITEM = 'Sales invoices and avoirs';
