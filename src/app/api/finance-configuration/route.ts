import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { currentAuthState } from '@/modules/platform-security/next';
import { executeFinance } from '@/modules/finance';
import { handleFinancePost } from '@/modules/finance/service/http';
// @permission finance.write — administrative switch, also when the module is off; requires fresh TOTP.
export async function POST(request: Request) {
  const pool = getPool('app');
  return handleFinancePost(request, {
    baseUrl: getEnv().APP_BASE_URL,
    getState: currentAuthState,
    // Off at the environment: the administrative switch answers 404 too (module flag FINANCE_ENABLED, default off).
    enabled: async () => getEnv().FINANCE_ENABLED,
    configuration: true,
    execute: (session, input) => executeFinance(pool, session, input),
  });
}
