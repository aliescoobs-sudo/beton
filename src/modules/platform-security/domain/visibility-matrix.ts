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
    item: 'Client and supplier balances',
    enters: [],
    inDocument: BAL,
    balances: BAL,
    exports: [],
    keys: { balances: 'statements.read' },
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
  const bal = new Set<Role>(BAL);
  for (const row of rows) {
    for (const r of row.balances)
      if (!bal.has(r)) out.push(`${row.item}: ${r} sees balances, only owner, app_admin and support may`);
    for (const r of row.exports)
      if (!bal.has(r) && r !== 'accountant')
        out.push(`${row.item}: ${r} exports, only the accountant besides the money roles`);
    for (const r of row.enters)
      if (!bal.has(r) && row.balances.includes(r)) out.push(`${row.item}: entering gives ${r} the balance`);
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
