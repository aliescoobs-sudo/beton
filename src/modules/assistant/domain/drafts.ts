import { z } from 'zod';
import type { Role } from '@/modules/platform-security';
import type { DraftToolName } from './tool-types';

/** The five draft actions and nothing else: anything outside is refused before display (SPEC-assistant §7). */
export const DRAFT_ACTIONS = [
  'plan_order',
  'record_payment',
  'create_purchase',
  'record_return',
  'invoice_from_bls',
] as const;

/** Whether confirming writes a money record: it then needs a second factor less than ten minutes old, for every role. */
export const MONEY_ACTIONS: readonly DraftToolName[] = [
  'plan_order',
  'record_payment',
  'create_purchase',
  'invoice_from_bls',
];
export const needsStepUp = (action: DraftToolName): boolean => MONEY_ACTIONS.includes(action);

/** The roles of each draft tool: the rows of the matrix (SPEC-assistant §5). Office is blind to money in all of them. */
export const DRAFT_ROLES: Record<DraftToolName, readonly Role[]> = {
  plan_order: ['owner', 'office'],
  record_payment: ['owner', 'office'],
  create_purchase: ['owner', 'office'],
  record_return: ['owner', 'partner', 'office', 'plant'],
  invoice_from_bls: ['owner', 'office'],
};

/** A draft lives 24 hours. */
export const PROPOSAL_TTL_HOURS = 24;

// What the model may write in a draft: codes, enumerations, bounded numbers, dates, and references to what the person typed
// (placeholders). Never an amount: the amount is `{{AMT_n}}`, the number of a cheque `{{NUM_n}}`, resolved from the question by code.
export const AMOUNT_REF = z.string().regex(/^\{\{AMT_\d+\}\}$/, 'a reference to an amount of the question');
export const NUMBER_REF = z.string().regex(/^\{\{NUM_\d+\}\}$/, 'a reference to a number of the question');
const CLIENT = z.string().regex(/^CLT-\d{1,6}$/);
const SUPPLIER = z.string().regex(/^FRN-\d{1,6}$/);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const QTY = z
  .number()
  .positive()
  .max(1_000_000)
  .refine((n) => Math.round(n * 1000) / 1000 === n, 'at most three decimals');

export const PLAN_PRESETS = ['cash', 'advance50', 'installments3', 'cheque30'] as const;

export const planOrderParams = z
  .object({
    client: CLIENT,
    type: z.string().regex(/^[A-Za-z0-9-]{1,12}$/),
    m3: QTY.max(200),
    date: DATE,
    site: z
      .string()
      .regex(/^SITE-\d{1,6}-\d{1,3}$/)
      .optional(),
    plan: z.enum(PLAN_PRESETS).optional(),
    price: AMOUNT_REF.optional(),
  })
  .strict();

export const recordPaymentParams = z
  .object({
    client: CLIENT,
    method: z.enum(['cash', 'cheque', 'lcn', 'transfer']),
    amount: AMOUNT_REF,
    number: NUMBER_REF.optional(),
    written_date: DATE.optional(),
    order_code: z
      .string()
      .regex(/^CMD-\d{4}-\d{5,}$/)
      .optional(),
  })
  .strict();

export const createPurchaseParams = z
  .object({
    supplier: SUPPLIER,
    component: z.string().min(1).max(60),
    quantity: QTY,
    unit: z.string().min(1).max(30).optional(),
    unit_price: AMOUNT_REF.optional(),
  })
  .strict();

export const LOSS_REASONS = ['rejected_by_client', 'returned_unused', 'too_old', 'quality', 'other'] as const;
export const recordReturnParams = z
  .object({
    bl: z.string().regex(/^BL-\d{4}-\d{5,}$/),
    m3: QTY.max(100).optional(),
    reason: z.enum(LOSS_REASONS),
  })
  .strict();

export const invoiceFromBlsParams = z
  .object({
    client: CLIENT,
    bl_numbers: z
      .array(z.string().regex(/^BL-\d{4}-\d{5,}$/))
      .min(1)
      .max(30),
  })
  .strict();

/**
 * What is stored, sealed, behind a proposal: the draft with every reference resolved by code from the person's own question and
 * services, in the units of the services (litres, centimes, thousandths). Re-validated, and its codes re-resolved, at confirmation.
 */
export type StoredDraft =
  | {
      action: 'plan_order';
      client: string;
      type: string;
      volumeL: number;
      date: string;
      site: string | null;
      plan: (typeof PLAN_PRESETS)[number];
      unitPriceCentimes: number | null;
    }
  | {
      action: 'record_payment';
      client: string;
      method: 'cash' | 'cheque' | 'lcn' | 'transfer';
      amountCentimes: number;
      number: string | null;
      writtenDate: string | null;
      orderCode: string | null;
    }
  | {
      action: 'create_purchase';
      supplier: string;
      component: string;
      unit: string | null;
      qtyMilli: number;
      unitPriceCentimes: number;
    }
  | { action: 'record_return'; bl: string; volumeL: number | null; reason: (typeof LOSS_REASONS)[number] }
  | { action: 'invoice_from_bls'; client: string; bls: string[] };

/** One line of a card: a key the screen translates, and a value as text, already shaped for the role that reads it. */
export interface CardField {
  key: string;
  value: string;
  /** Latin text (codes, numbers, dates) to be shown left to right inside Arabic. */
  ltr?: boolean;
  /** The value is one of a closed list the screen translates (a plan, a payment method, a reason, a volume). */
  enumOf?: 'plan' | 'method' | 'reason' | 'volume';
}

/** What a human reads before confirming (SPEC-assistant §7): what will be created, every figure computed by code. */
export interface ProposalCard {
  id: string;
  action: DraftToolName;
  status: 'pending' | 'confirming' | 'confirmed' | 'rejected' | 'expired' | 'failed';
  needsStepUp: boolean;
  /** Office: no price, total or balance is shown (D81, D84). */
  blind: boolean;
  expiresAt: string;
  fields: CardField[];
  /** Lines of a table inside the card (the invoice's groups, the plan's items), each a list of fields. */
  rows: CardField[][];
  /** Keys of the checks the person must still make. */
  notes: string[];
  /** After confirmation: the number of the document it made. */
  resultRef: string | null;
}
