import { getPool } from '@/lib/db/pools';
import { engineParams } from '@/modules/rules-engine';
import { readParameters } from '@/modules/platform-security/service/parameter-service';

/** The engine's parameters as stored (defaults for the rest); `horizon` is the 7 or 14 days the screen asks for. */
export async function getEngineParams(horizon?: number) {
  const values = await readParameters(getPool('auth'));
  const asked = horizon === 7 || horizon === 14 ? horizon : undefined;
  return engineParams(values, asked);
}
