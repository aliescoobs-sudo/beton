import { getPool } from '@/lib/db/pools';
import { readParameters } from '@/modules/platform-security/service/parameter-service';

/** Configured business time of a catalogue job (parameter), or its default. */
export async function jobTimeOf(parameterKey: string, defaultTime: string): Promise<string> {
  const values = await readParameters(getPool('auth'));
  const configured = (values as Record<string, unknown>)[parameterKey];
  return typeof configured === 'string' ? configured : defaultTime;
}
