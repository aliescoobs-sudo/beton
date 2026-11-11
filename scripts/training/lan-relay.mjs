// A plain TCP relay for the local-network door of the training instance (T11b). Colima's Docker runs in a VM that does not own the Mac's
// Wi-Fi address, so the lan-proxy is published on the Mac's loopback only (127.0.0.1:8443) and this relay listens on ONE private address of
// the Mac and forwards the (already TLS) byte stream to it. Nothing is decrypted or logged. No dependency.
//   node scripts/training/lan-relay.mjs <private ipv4> [listen port 8443] [target port 8443]
// It refuses to start on anything but a private address, and drops a connection whose source is not a private address.
import net from 'node:net';

const [listenIp, listenPortArg = '8443', targetPortArg = '8443'] = process.argv.slice(2);
const octets = (listenIp ?? '').split('.').map(Number);
const valid = octets.length === 4 && octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255);
const isPrivate = (o) =>
  o[0] === 10 || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31);
if (!valid || !isPrivate(octets)) {
  console.error('lan-relay: give a private IPv4 address (10.x, 172.16-31.x, 192.168.x): refused');
  process.exit(2);
}
const listenPort = Number(listenPortArg);
const targetPort = Number(targetPortArg);
const privateSource = (addr) => {
  const m = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr ?? '');
  return !!m && isPrivate([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]);
};
const server = net.createServer((client) => {
  if (!privateSource(client.remoteAddress)) return client.destroy();
  const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
  client.pipe(upstream).pipe(client);
  const end = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', end);
  upstream.on('error', end);
  client.on('close', end);
  upstream.on('close', end);
  client.setTimeout(10 * 60 * 1000, end);
});
server.on('error', (e) => {
  console.error(`lan-relay: ${e.code ?? 'error'}`);
  process.exit(1);
});
server.listen(listenPort, listenIp, () =>
  console.log(`lan-relay: ${listenIp}:${listenPort} -> 127.0.0.1:${targetPort}`),
);
