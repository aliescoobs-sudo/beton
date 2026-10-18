import { getAuth } from '@/modules/platform-security';

// Better Auth endpoints; only the paths in ALLOWED_AUTH_PATHS answer, the rest return 404.
export const GET = (request: Request) => getAuth().handler(request);
export const POST = (request: Request) => getAuth().handler(request);
