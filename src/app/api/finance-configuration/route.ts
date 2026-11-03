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
    enabled: async () => false,
    configuration: true,
    execute: (session, input) => executeFinance(pool, session, input),
  });
}
