// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dropPhoto, queuedPhotos, queuePhoto, wipePhotos, type QueuedPhoto } from './photo-queue';

// R15B-04: a put or a delete is "done" when its TRANSACTION commits, not when its request succeeds. A request can succeed and the
// transaction still abort (a storage write failure); reporting "kept" or "erased" at the request would be a false assurance.
const photo = (key: string): QueuedPhoto => ({
  key,
  tripId: 't1',
  takenAt: '2026-11-08T08:00:00.000Z',
  blob: new Blob(['x']),
  userId: 'A',
});
const keys = async () => (await queuedPhotos()).map((p) => p.key).sort();

type Proto = { put: (...a: unknown[]) => IDBRequest; delete: (...a: unknown[]) => IDBRequest };
const store = IDBObjectStore.prototype as unknown as Proto;
const real = { put: store.put, delete: store.delete };
/** After the request succeeded, abort its transaction: the commit fails. */
function abortAfterSuccess(method: 'put' | 'delete') {
  store[method] = function (this: IDBObjectStore, ...args: unknown[]) {
    const req = real[method].apply(this, args) as IDBRequest;
    req.addEventListener('success', () => req.transaction?.abort());
    return req;
  };
}
beforeEach(async () => {
  await wipePhotos('everything', Number.MAX_SAFE_INTEGER);
});
afterEach(() => {
  store.put = real.put;
  store.delete = real.delete;
});

describe('photo storage reports success only after the transaction commits (R15B-04)', () => {
  it('a put whose transaction aborts is NOT reported as kept, and nothing is stored', async () => {
    abortAfterSuccess('put');
    await expect(queuePhoto(photo('p1'))).rejects.toBeTruthy();
    store.put = real.put;
    expect(await keys()).toEqual([]);
  });

  it('a normal put resolves true once committed, and the photo is there', async () => {
    await expect(queuePhoto(photo('p2'))).resolves.toBe(true);
    expect(await keys()).toEqual(['p2']);
  });

  it('a delete whose transaction aborts is NOT reported as done: the photo is still there', async () => {
    await queuePhoto(photo('p3'));
    abortAfterSuccess('delete');
    await expect(dropPhoto('p3')).rejects.toBeTruthy();
    store.delete = real.delete;
    expect(await keys()).toEqual(['p3']);
  });

  it('a stale photo whose compensating delete fails is exposed, not swallowed', async () => {
    let asked = 0;
    abortAfterSuccess('delete');
    // current when the write is issued, over by the time it has committed (the session ended while the write was on its way)
    await expect(queuePhoto(photo('p4'), () => ++asked === 1)).rejects.toThrow(/cleanup/i);
    store.delete = real.delete;
  });
});
