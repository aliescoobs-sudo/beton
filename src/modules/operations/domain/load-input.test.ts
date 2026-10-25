import { describe, expect, it } from 'vitest';
import {
  parseBlReturnInput,
  parseCancelLoadInput,
  parseLoadInput,
  parseOpeningStockInput,
  parseReceiptInput,
  parseThresholdInput,
} from './load-input';

const id = '0192f3a0-0000-7000-8000-000000000001';

describe('operations inputs', () => {
  it('a load names an order and a truck; the volume is optional litres within a truck', () => {
    expect(parseLoadInput({ orderId: id, truckId: id }).ok).toBe(true);
    expect(parseLoadInput({ orderId: id, truckId: id, volumeL: 8000 }).ok).toBe(true);
    expect(parseLoadInput({ orderId: id, truckId: id, volumeL: 0 }).ok).toBe(false);
    expect(parseLoadInput({ orderId: id, truckId: id, volumeL: 30_001 }).ok).toBe(false);
    expect(parseLoadInput({ orderId: 'x', truckId: id }).ok).toBe(false);
  });
  it('a signed-BL return has a real date and a bounded unused volume (default 0)', () => {
    const r = parseBlReturnInput({ deliveryId: id, returnedOn: '2026-06-02' });
    expect(r.ok && r.value.returnedVolumeL).toBe(0);
    expect(parseBlReturnInput({ deliveryId: id, returnedOn: '2026-02-30' }).ok).toBe(false);
    expect(parseBlReturnInput({ deliveryId: id, returnedOn: '2026-06-02', returnedVolumeL: -1 }).ok).toBe(
      false,
    );
  });
  it('a cancellation needs a reason of 3 to 500 characters, spaces collapsed', () => {
    expect(parseCancelLoadInput({ deliveryId: id, reason: '  erreur   de  camion ' })).toMatchObject({
      ok: true,
      value: { reason: 'erreur de camion' },
    });
    expect(parseCancelLoadInput({ deliveryId: id, reason: 'ab' }).ok).toBe(false);
  });
  it('opening stock, receipts and thresholds', () => {
    expect(parseOpeningStockInput({ componentId: id, qtyBase: 1_000_000, date: '2026-01-01' }).ok).toBe(true);
    expect(parseOpeningStockInput({ componentId: id, qtyBase: 0, date: '2026-01-01' }).ok).toBe(false);
    expect(parseReceiptInput({ purchaseId: id }).ok).toBe(true);
    expect(parseReceiptInput({ purchaseId: id, receivedDate: '2026-06-02' }).ok).toBe(true);
    expect(parseReceiptInput({ purchaseId: id, receivedDate: 'hier' }).ok).toBe(false);
    expect(parseThresholdInput({ componentId: id, lowQtyBase: 5_000_000 }).ok).toBe(true);
    expect(parseThresholdInput({ componentId: id, lowQtyBase: 0 }).ok).toBe(false);
  });
});
