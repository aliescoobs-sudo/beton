import { ForbiddenError, inRequest, recordAuditEvent } from '@/modules/platform-security';
import type { Prepared } from './drafts/types';
import { findDraftTool } from './drafts/registry';
import type { DraftContext } from './drafts/types';
import type { ToolOutcome } from './tool-runner';

export interface DraftRun {
  outcome: ToolOutcome;
  /** What the model is told: that a draft exists and a person must confirm it, or why none could be made. No amount, no name. */
  result: unknown;
  prepared?: Prepared;
  args?: unknown;
}

const NOT_AVAILABLE = { error: 'This tool is not available.' };
const BAD_ARGS = { error: 'The arguments are not valid.' };

/**
 * Runs a draft tool asked by the model (SPEC-assistant §7). It validates the arguments, resolves every code through the asking
 * person's own services and previews with the real service (rehearsed and rolled back): nothing is written to any business table.
 * What the model is told back is a fixed sentence and, on a refusal, the code of the reason (not enough to guess at data).
 */
export async function runDraft(ctx: DraftContext, name: string, rawArgs: unknown): Promise<DraftRun> {
  const tool = findDraftTool(name);
  if (!tool || !tool.roles.includes(ctx.actor.role)) {
    await inRequest(ctx.appPool, ctx.actor, (tx) =>
      recordAuditEvent(tx, {
        action: 'permission_denied',
        table: 'assistant_tool',
        reason: name.replace(/[^a-z_]/g, '').slice(0, 40) || 'unknown',
      }),
    );
    return { outcome: 'permission_denied', result: NOT_AVAILABLE };
  }
  const parsed = tool.params.safeParse(rawArgs ?? {});
  if (!parsed.success) return { outcome: 'invalid_args', result: BAD_ARGS };
  try {
    const prepared = await tool.prepare(ctx, parsed.data);
    if (!prepared.ok)
      return {
        outcome: 'invalid_args',
        result: { error: 'The draft could not be prepared.', reason: prepared.error },
      };
    return {
      outcome: 'ok',
      result: {
        drafted: true,
        action: tool.name,
        note: 'A draft card is shown to the person, who must check and confirm it. Nothing is created yet.',
      },
      prepared: prepared.value,
      args: parsed.data,
    };
  } catch (error) {
    if (error instanceof ForbiddenError) return { outcome: 'permission_denied', result: NOT_AVAILABLE };
    return { outcome: 'error', result: { error: 'The tool could not answer.' } };
  }
}
