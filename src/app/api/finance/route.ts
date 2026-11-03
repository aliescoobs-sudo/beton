import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import { currentAuthState } from '@/modules/platform-security/next';
import { executeFinance, financeEnabled, simulateSteel } from '@/modules/finance';
import { handleFinancePost } from '@/modules/finance/service/http';
// @permission finance.write — fresh TOTP for writes, own-origin only, module off => 404.
export async function POST(request: Request) {
  const pool = getPool('app');
  return handleFinancePost(request, {
    baseUrl: getEnv().APP_BASE_URL,
    getState: currentAuthState,
    enabled: () => financeEnabled(pool),
    execute: (session, input) => executeFinance(pool, session, input),
    simulate: (actor, input) => simulateSteel(pool, actor, input),
  });
}
