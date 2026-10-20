// Next.js-only entry of platform-security (pages and server actions). Kept out of index.ts on purpose: the index is
// also imported by CLI scripts under plain `node`, where `next/headers` and `next/navigation` do not resolve.
export { requirePagePermission } from './auth/page-guard';
export { currentAuthState } from './auth/request-state';
