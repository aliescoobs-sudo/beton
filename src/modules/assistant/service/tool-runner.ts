import { can, ForbiddenError, inRequest, recordAuditEvent } from '@/modules/platform-security';
import type { ToolContext } from '../domain/tool-types';
import { findTool } from './tool-registry';

export type ToolOutcome = 'ok' | 'permission_denied' | 'invalid_args' | 'error';

export interface ToolRun {
  outcome: ToolOutcome;
  /** What goes to the model (before pseudonymization): the parsed output, or a short error that carries no data. */
  result: unknown;
  rowCount: number;
  /** The arguments that passed validation, for the audit; absent when they did not. */
  args?: unknown;
}

const NOT_AVAILABLE = { error: 'This tool is not available.' };
const BAD_ARGS = { error: 'The arguments are not valid.' };
const FAILED = { error: 'The tool could not answer.' };
const LOCKED = { error: 'Too many searches. Try again later.' };

/** A money key anywhere in a result: what a role without money may never be given, whatever a service returned. */
function hasMoneyKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasMoneyKey);
  if (value && typeof value === 'object')
    return Object.entries(value).some(([k, v]) => /Centimes$/.test(k) || hasMoneyKey(v));
  return false;
}

const countOf = (value: unknown): number => {
  const o = value as { count?: unknown } | null;
  return typeof o?.count === 'number' ? o.count : 0;
};

async function deny(ctx: ToolContext, name: string): Promise<void> {
  await inRequest(ctx.appPool, ctx.actor, (tx) =>
    recordAuditEvent(tx, {
      action: 'permission_denied',
      table: 'assistant_tool',
      reason: name.replace(/[^a-z_]/g, '').slice(0, 40) || 'unknown',
    }),
  );
}

/**
 * Runs one tool call asked by the model, as the asking user (SPEC-assistant §2, §5). In order: the tool exists and the user's
 * role is on its matrix row (else `permission_denied`, audited, no data); the arguments pass the tool's schema; the service runs
 * under the user's own row-level security; the answer goes through the role's output schema, which drops every key it does not
 * name. A service that refuses (ForbiddenError) is a `permission_denied` as well. Nothing here writes a business record.
 */
export async function runTool(ctx: ToolContext, name: string, rawArgs: unknown): Promise<ToolRun> {
  const tool = findTool(name);
  if (!tool || !tool.roles.includes(ctx.actor.role)) {
    await deny(ctx, name);
    return { outcome: 'permission_denied', result: NOT_AVAILABLE, rowCount: 0 };
  }
  const parsed = tool.params.safeParse(rawArgs ?? {});
  if (!parsed.success) return { outcome: 'invalid_args', result: BAD_ARGS, rowCount: 0 };
  try {
    const raw = await tool.run(ctx, parsed.data);
    const refused = (raw as { error?: unknown } | null)?.error;
    // A lock-out or a rate limit of a shared door (the search) is a refusal, not a bad argument.
    if (refused === 'LOCKED') return { outcome: 'permission_denied', result: LOCKED, rowCount: 0 };
    if (refused !== undefined) return { outcome: 'invalid_args', result: BAD_ARGS, rowCount: 0 };
    const shaped = tool.output(ctx.actor.role).safeParse(raw);
    if (!shaped.success) return { outcome: 'error', result: FAILED, rowCount: 0 };
    // Defence in depth: a role that reads no money gets no money key, even if a schema were widened by mistake.
    if (!can(ctx.actor.role, 'effects.money') && hasMoneyKey(shaped.data))
      return { outcome: 'error', result: FAILED, rowCount: 0 };
    return { outcome: 'ok', result: shaped.data, rowCount: countOf(shaped.data), args: parsed.data };
  } catch (error) {
    if (error instanceof ForbiddenError)
      return { outcome: 'permission_denied', result: NOT_AVAILABLE, rowCount: 0 };
    return { outcome: 'error', result: FAILED, rowCount: 0 };
  }
}
