import type pg from 'pg';
import type { z } from 'zod';
import type { Result } from '@/lib/result';
import type { Permission, Role, SessionUser } from '@/modules/platform-security';
import type { ProposalCard, StoredDraft } from '../../domain/drafts';
import type { Pseudonymizer } from '../../domain/pseudonymizer';
import type { DraftToolName, ToolContext } from '../../domain/tool-types';

export type DraftError =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'NOT_ALLOWED'
  | 'NEEDS_AMOUNT'
  | 'NEEDS_PRICE'
  | 'NEEDS_UNIT'
  | 'INCOMPLETE'
  | 'ALREADY_RECORDED'
  | 'OVER_LOAD'
  | 'STALE'
  | 'REFUSED';

/** A draft being prepared: the person's own session, and the means to read back what they typed (amounts, numbers). */
export interface DraftContext extends ToolContext {
  ps: Pseudonymizer;
  authPool: pg.Pool;
}

/** A draft being confirmed: the human as actor, nothing from the model. */
export interface ExecContext {
  appPool: pg.Pool;
  actor: SessionUser;
  today: string;
}

export type CardBody = Omit<ProposalCard, 'id' | 'status' | 'expiresAt' | 'resultRef'>;

export interface Prepared {
  stored: StoredDraft;
  card: CardBody;
}

/**
 * A draft tool (SPEC-assistant §5, §7). `prepare` validates, resolves every code through the person's own services, previews with
 * the real service (rehearsed and rolled back) and builds the card; it writes nothing. `execute` runs only at confirmation, as
 * the human, through the same service as the form.
 */
export interface DraftTool<S extends z.ZodType = z.ZodType> {
  name: DraftToolName;
  kind: 'draft';
  description: string;
  params: S;
  roles: readonly Role[];
  permissions: readonly Permission[];
  prepare(ctx: DraftContext, args: z.output<S>): Promise<Result<Prepared, DraftError>>;
  execute(ctx: ExecContext, stored: StoredDraft): Promise<Result<{ ref: string | null }, DraftError>>;
}
