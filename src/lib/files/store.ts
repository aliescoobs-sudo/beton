import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Keyring } from '@/lib/crypto/keyring';

/**
 * Where the encrypted content of stored documents lives: a directory outside any public path, one file per document named by
 * its random id, sealed with the keyring and bound to that id (a blob copied under another id does not open). The database
 * keeps who, what and when; this keeps the bytes. Nothing here decides who may read: callers do, through RLS.
 */
export interface FileStore {
  put(id: string, bytes: Uint8Array): Promise<void>;
  get(id: string): Promise<Buffer>;
  /** Re-seals the file with the current key; false when it already is. For `pnpm crypto:rotate`. */
  rotate(id: string): Promise<boolean>;
  /** Every stored id, and whether a file still sits on a retired key (for `crypto:rotate`). */
  ids(): Promise<string[]>;
  onRetiredKey(id: string): Promise<boolean>;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createDiskStore(dir: string, keyring: Keyring): FileStore {
  const root = path.resolve(dir);
  const locate = (id: string) => {
    if (!ID.test(id)) throw new Error('Invalid file id');
    return path.join(root, id.slice(0, 2), `${id}.bin`);
  };
  const aad = (id: string) => Buffer.from(`file:${id}`, 'utf8');
  return {
    async put(id, bytes) {
      const target = locate(id);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, keyring.encryptBytes(bytes, aad(id)), { mode: 0o600, flag: 'wx' });
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
    async get(id) {
      return keyring.decryptBytes(await readFile(locate(id)), aad(id));
    },
    async ids() {
      const found: string[] = [];
      const shards = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const shard of shards.filter((d) => d.isDirectory())) {
        for (const name of await readdir(path.join(root, shard.name))) {
          const id = name.replace(/\.bin$/, '');
          if (name.endsWith('.bin') && ID.test(id)) found.push(id);
        }
      }
      return found;
    },
    async onRetiredKey(id) {
      return keyring.needsRotationBytes(await readFile(locate(id)));
    },
    async rotate(id) {
      const target = locate(id);
      const sealed = await readFile(target);
      if (!keyring.needsRotationBytes(sealed)) return false;
      const temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, keyring.encryptBytes(keyring.decryptBytes(sealed, aad(id)), aad(id)), {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temp, target);
      return true;
    },
  };
}
