// Generates a VAPID key pair for web push (R5). Prints the two values for the server environment; keep the private one secret.
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const priv = privateKey.export({ format: 'jwk' });
const pub = publicKey.export({ format: 'jwk' });
const point = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(pub.x, 'base64url'),
  Buffer.from(pub.y, 'base64url'),
]);
console.log(`VAPID_PUBLIC_KEY=${point.toString('base64url')}`);
console.log(`VAPID_PRIVATE_KEY=${priv.d}`);
