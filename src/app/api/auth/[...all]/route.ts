import { getAuth } from '@/modules/platform-security';

// @permission public — Better Auth endpoints; each one enforces its own session/2FA rules (hooks).
// Better Auth endpoints; only the paths in ALLOWED_AUTH_PATHS answer, the rest return 404.
export const GET = (request: Request) => getAuth().handler(request);
export const POST = (request: Request) => getAuth().handler(request);
