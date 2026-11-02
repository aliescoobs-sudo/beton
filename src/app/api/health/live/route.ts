// @permission none (liveness for the container health check: the process answers; nothing about the system is revealed)
export function GET(): Response {
  return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
