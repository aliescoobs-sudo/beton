// The connection handling of the local-network relay (T11b, hardened by T10g R19B-11). A plain TCP relay: nothing is decrypted or logged. Kept apart from the
// command line so that a test can drive it on loopback.
//   - a connection from a source that is not allowed is destroyed at once;
//   - at most `maxConnections` connections are open at a time and at most `maxPerSource` from one address: further ones are destroyed at once, so a private
//     client can no longer hold hundreds of sockets for ten minutes;
//   - an idle connection is closed after `idleMs`; both halves of a pair are closed together.
import net from 'node:net';

export function createRelay({
  targetPort,
  isAllowedSource,
  maxConnections = 64,
  maxPerSource = 16,
  idleMs = 3 * 60 * 1000,
  targetHost = '127.0.0.1',
}) {
  let open = 0;
  const perSource = new Map();
  const stats = { accepted: 0, refusedSource: 0, refusedLimit: 0 };
  const server = net.createServer((client) => {
    const source = client.remoteAddress ?? '';
    if (!isAllowedSource(source)) {
      stats.refusedSource++;
      return client.destroy();
    }
    const n = perSource.get(source) ?? 0;
    if (open >= maxConnections || n >= maxPerSource) {
      stats.refusedLimit++;
      return client.destroy();
    }
    open++;
    perSource.set(source, n + 1);
    stats.accepted++;
    const upstream = net.connect({ host: targetHost, port: targetPort });
    let closed = false;
    const end = () => {
      if (closed) return;
      closed = true;
      open--;
      const left = (perSource.get(source) ?? 1) - 1;
      if (left <= 0) perSource.delete(source);
      else perSource.set(source, left);
      client.destroy();
      upstream.destroy();
    };
    client.pipe(upstream).pipe(client);
    client.on('error', end);
    upstream.on('error', end);
    client.on('close', end);
    upstream.on('close', end);
    client.setTimeout(idleMs, end);
  });
  return { server, stats, openCount: () => open };
}
