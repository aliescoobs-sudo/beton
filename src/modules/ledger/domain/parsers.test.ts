import { describe, expect, it } from 'vitest';
import {
  parseAllocateInput,
  parseBounceInput,
  parseCancelInput,
  parseClearInput,
  parseDepositInput,
  parseDisputeInput,
  parseIssueInput,
  parseOpeningInput,
  parsePartyOpeningInput,
  parseReceiveInput,
  parseRegularizeInput,
  parseReverseInput,
  parseUnallocateInput,
} from './index';
import { parseOrderInput } from './order';
import { parseStatementFilter } from './statement';

const id = '0192f3a0-0000-7000-8000-000000000001';
const id2 = '0192f3a0-0000-7000-8000-000000000002';

describe('instrument inputs', () => {
  it('a cheque needs its number and the date written on it; cash needs neither and drops them', () => {
    expect(parseReceiveInput({ clientId: id, method: 'cheque', amountCentimes: 1000 }).ok).toBe(false);
    const cheque = parseReceiveInput({
      clientId: id,
      method: 'cheque',
      amountCentimes: 1000,
      number: 'C1',
      writtenDate: '2026-06-01',
      orderCode: ' cmd-2026-00012 ',
    });
    expect(cheque.ok && cheque.value.orderCode).toBe('CMD-2026-00012');
    const cash = parseReceiveInput({
      clientId: id,
      method: 'cash',
      amountCentimes: 500,
      number: 'x',
      bank: 'y',
      writtenDate: '2026-06-01',
    });
    expect(cash.ok && [cash.value.number, cash.value.bank, cash.value.writtenDate]).toEqual([
      null,
      null,
      null,
    ]);
    expect(
      parseReceiveInput({ clientId: id, method: 'cash', amountCentimes: 500, orderCode: 'nope' }).ok,
    ).toBe(false);
    expect(parseReceiveInput({ clientId: id, method: 'cash', amountCentimes: 0 }).ok).toBe(false);
  });
  it('a supplier payment may name the purchase it pays', () => {
    const r = parseIssueInput({
      supplierId: id,
      method: 'transfer',
      amountCentimes: 1000,
      purchaseCode: 'ach-2026-00003',
    });
    expect(r.ok && r.value.purchaseCode).toBe('ACH-2026-00003');
    expect(
      parseIssueInput({
        supplierId: id,
        method: 'transfer',
        amountCentimes: 1000,
        purchaseCode: 'CMD-2026-00003',
      }).ok,
    ).toBe(false);
  });
  it('lifecycle inputs: dates must be real, reasons are trimmed and bounded, ids are uuids', () => {
    expect(parseClearInput({ instrumentId: id, accountId: id2, date: '2026-06-01' }).ok).toBe(true);
    expect(parseClearInput({ instrumentId: id, accountId: id2, date: '2026-02-30' }).ok).toBe(false);
    expect(parseCancelInput({ instrumentId: id, reason: '  trop  tôt ', date: '2026-06-01' })).toMatchObject({
      ok: true,
      value: { reason: 'trop tôt' },
    });
    expect(parseCancelInput({ instrumentId: id, reason: ' ', date: '2026-06-01' }).ok).toBe(false);
    expect(parseReverseInput({ movementId: id, reason: 'erreur' }).ok).toBe(true);
    expect(parseAllocateInput({ instrumentId: id, itemId: id2, amountCentimes: 5 }).ok).toBe(true);
    expect(parseAllocateInput({ instrumentId: id, itemId: id2, amountCentimes: -5 }).ok).toBe(false);
    expect(parseUnallocateInput({ allocationId: id, reason: 'erreur' }).ok).toBe(true);
    expect(parseDepositInput({ instrumentIds: [id, id2], accountId: id, date: '2026-06-01' }).ok).toBe(true);
    expect(parseDepositInput({ instrumentIds: [id, id], accountId: id, date: '2026-06-01' }).ok).toBe(false);
    expect(parseDepositInput({ instrumentIds: [], accountId: id, date: '2026-06-01' }).ok).toBe(false);
    expect(parseBounceInput({ instrumentId: id, date: '2026-06-01', feeCentimes: 2500 }).ok).toBe(true);
    expect(parseBounceInput({ instrumentId: id, date: '2026-06-01', feeCentimes: 0 }).ok).toBe(false);
    expect(parseRegularizeInput({ instrumentId: id, coveringInstrumentId: id2, date: '2026-06-01' }).ok).toBe(
      true,
    );
    expect(parseDisputeInput({ instrumentId: id, reason: 'litige', date: '2026-06-01' }).ok).toBe(true);
  });
});

describe('opening inputs', () => {
  it('the opening is a real date; a party balance names a client or a supplier, not both, and a positive amount', () => {
    expect(parseOpeningInput({ openingDate: '2026-01-01' }).ok).toBe(true);
    expect(parseOpeningInput({ openingDate: '2026-13-01' }).ok).toBe(false);
    expect(
      parsePartyOpeningInput({ clientId: id, amountCentimes: 100, reference: ' solde  repris ' }).ok,
    ).toBe(true);
    expect(parsePartyOpeningInput({ supplierId: id, amountCentimes: 100 }).ok).toBe(true);
    expect(parsePartyOpeningInput({ clientId: id, supplierId: id2, amountCentimes: 100 }).ok).toBe(false);
    expect(parsePartyOpeningInput({ amountCentimes: 100 }).ok).toBe(false);
    expect(parsePartyOpeningInput({ clientId: id, amountCentimes: 0 }).ok).toBe(false);
  });
});

describe('order input', () => {
  const base = {
    clientId: id,
    concreteTypeId: id2,
    dischargeMethod: 'GOULOTTE',
    volumeL: 8000,
    deliveryDate: '2026-06-05',
    plan: { preset: 'cash' },
  };
  it('D239 d: the discharge method is required, exactly GOULOTTE or POMPE, with no default', () => {
    const { dischargeMethod: _omitted, ...without } = base;
    void _omitted;
    expect(parseOrderInput(without).ok).toBe(false);
    expect(parseOrderInput({ ...base, dischargeMethod: null }).ok).toBe(false);
    expect(parseOrderInput({ ...base, dischargeMethod: '' }).ok).toBe(false);
    expect(parseOrderInput({ ...base, dischargeMethod: 'BETON' }).ok).toBe(false);
    expect(parseOrderInput({ ...base, dischargeMethod: 'goulotte' }).ok).toBe(false);
    expect(parseOrderInput({ ...base, dischargeMethod: 'POMPE' }).ok).toBe(true);
  });
  it('accepts a preset, a custom plan with one kind of share per item, an override and a quote', () => {
    expect(parseOrderInput(base).ok).toBe(true);
    expect(parseOrderInput({ ...base, quoteId: id }).ok).toBe(true);
    expect(
      parseOrderInput({ ...base, priceOverride: { unitPriceHtCentimes: 70_000, reason: ' remise  test ' } }),
    ).toMatchObject({ ok: true, value: { priceOverride: { reason: 'remise test' } } });
    expect(
      parseOrderInput({ ...base, priceOverride: { unitPriceHtCentimes: 70_000, reason: 'ab' } }).ok,
    ).toBe(false);
    expect(
      parseOrderInput({
        ...base,
        plan: { preset: 'custom', items: [{ method: 'cheque', dueDate: '2026-07-01', percentBp: 10_000 }] },
      }).ok,
    ).toBe(true);
    expect(
      parseOrderInput({
        ...base,
        plan: {
          preset: 'custom',
          items: [{ method: 'cheque', dueDate: '2026-07-01', percentBp: 5000, amountCentimes: 5 }],
        },
      }).ok,
    ).toBe(false);
  });
  it('refuses a zero volume, a bad date, an unknown preset', () => {
    expect(parseOrderInput({ ...base, volumeL: 0 }).ok).toBe(false);
    expect(parseOrderInput({ ...base, deliveryDate: '2026-02-30' }).ok).toBe(false);
    expect(parseOrderInput({ ...base, plan: { preset: 'weird' } }).ok).toBe(false);
  });
});

describe('parseStatementFilter', () => {
  it('keeps real dates, a known type and a known status; ignores anything else', () => {
    expect(
      parseStatementFilter({ from: '2026-06-01', to: '2026-06-30', type: 'payment', status: 'cleared' }),
    ).toEqual({
      from: '2026-06-01',
      to: '2026-06-30',
      types: ['payment'],
      statuses: ['cleared'],
    });
    expect(parseStatementFilter({ from: 'x', to: '', type: 'weird', status: 'what' })).toEqual({});
    expect(parseStatementFilter({ type: 'invoice' })).toEqual({ types: ['invoice'] });
  });
});
