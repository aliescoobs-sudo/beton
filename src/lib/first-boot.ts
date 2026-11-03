/**
 * The protected first start (C2, FIRST_BOOT=true): the only paths a server with REAL_DATA and an incomplete security checklist
 * serves. Everything else answers 503 until the owner has enrolled, worked the checklist and created the accounts and plants, and the
 * flag has been removed. Pure so that it can be tested and used by the edge proxy.
 */
const LOCALES = ['fr', 'ar', 'ary'];
const PAGES = ['login', 'enrol', 'checklist', 'admin/users', 'parameters', 'master-data/plants'];
const API = ['/api/auth/', '/api/health/'];

export function firstBootAllows(pathname: string): boolean {
  if (API.some((prefix) => pathname.startsWith(prefix))) return true;
  const segments = pathname.split('/').filter(Boolean);
  const [locale, ...rest] = segments;
  if (!locale || !LOCALES.includes(locale)) return false;
  if (rest.length === 0) return true; // the home page after sign-in (empty on a new server)
  const path = rest.join('/');
  return PAGES.some((page) => path === page || path.startsWith(`${page}/`));
}
