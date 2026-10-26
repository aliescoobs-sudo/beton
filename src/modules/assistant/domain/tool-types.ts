import type pg from 'pg';
import type { z } from 'zod';
import type { EngineParams } from '@/modules/rules-engine';
import type { Permission, Role, SessionUser } from '@/modules/platform-security';

export const READ_TOOL_NAMES = [
  'deliveries_today',
  'stock_and_cover',
  'uninvoiced_bls',
  'open_invoices',
  'forecast',
  'next_load',
  'order_chain',
  'find_document',
  'purchase_status',
  'consumption_variance',
] as const;
export const DRAFT_TOOL_NAMES = [
  'plan_order',
  'record_payment',
  'create_purchase',
  'record_return',
  'invoice_from_bls',
] as const;
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];
export type DraftToolName = (typeof DRAFT_TOOL_NAMES)[number];
export type ToolName = ReadToolName | DraftToolName;

/** What a tool may use: the asking user's own session through the same services as the screens, never a service role. */
export interface ToolContext {
  appPool: pg.Pool;
  actor: SessionUser;
  /** The business date (the request clock), never the machine's. */
  today: string;
  engine: EngineParams;
  /** The code of a client or supplier by the name a screen shows, or null: names never leave a tool, codes do. */
  codeOfName(name: string): string | null;
}

/**
 * One tool of the catalogue (SPEC-assistant §5): typed parameters, the roles of its matrix row, the permissions of the screens it
 * mirror, and an output schema per role that is the allow-list: what the service returned is parsed through it and every key it
 * does not name is dropped (the schema is `strip`, never `passthrough`).
 */
export interface AssistantTool<S extends z.ZodType = z.ZodType> {
  name: ReadToolName;
  kind: 'read';
  /** For the model, in English: what it returns and when to call it. Never a name or a number from the data. */
  description: string;
  params: S;
  roles: readonly Role[];
  /** The permissions of the screens it mirrors: the roles of the matrix are exactly the roles holding one of them (tested). */
  permissions: readonly Permission[];
  output(role: Role): z.ZodType;
  run(ctx: ToolContext, args: z.output<S>): Promise<unknown>;
}

/** The roles of the matrix, for tests: tool → roles. */
export type ToolMatrix = Record<ToolName, readonly Role[]>;
