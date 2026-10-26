import type pg from 'pg';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import { SYSTEM_ACTOR_ID } from '@/modules/platform-security';

/** Retention of the sealed payloads (SPEC-assistant §9; provisional, D116). */
export const PAYLOAD_RETENTION_DAYS = 90;

/**
 * Empties the sealed question and answer of the interactions older than the retention, as the system actor. The rows, the keyed
 * question hashes, the tool calls and the audit chain stay, so the chain remains verifiable (AC-ASSIST-14). Idempotent.
 */
export async function purgePayloads(
  systemPool: pg.Pool,
  days: number = PAYLOAD_RETENTION_DAYS,
): Promise<{ purged: number }> {
  return withRlsContext(
    systemPool,
    { userId: SYSTEM_ACTOR_ID, role: 'system', requestId: uuidv7(realClock.now()) },
    async (tx) => {
      const { rowCount } = await tx.query(
        `update ai_interaction set question_enc = null, output_enc = null, payload_purged_at = now()
          where payload_purged_at is null and created_at < now() - make_interval(days => $1)`,
        [days],
      );
      return { purged: rowCount ?? 0 };
    },
  );
}
