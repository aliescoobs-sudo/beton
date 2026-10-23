import { describe, expect, it } from 'vitest';
import { expectNoFields } from '../../../../tests/helpers/expect-no-fields';
import { defineVisibility, project, projectMany } from './projection';

// Sample entities shaped like the future order and delivery (SPEC §4, AC-SEC-05).
interface SampleOrder {
  code: string;
  concreteType: string;
  volumeL: number;
  deliveryDate: string;
  zone: string;
  unitPriceHtCentimes: number;
  totalTtcCentimes: number;
  clientPhone: string;
}
interface SampleDelivery {
  blNo: string;
  volumeL: number;
  marginCentimes: number;
  componentCostCentimes: number;
}

const orderVisibility = defineVisibility<SampleOrder>({
  owner: 'all',
  support: 'all',
  partner: ['code', 'concreteType', 'volumeL', 'deliveryDate', 'zone'],
  office: 'all',
  plant: ['code', 'concreteType', 'volumeL', 'deliveryDate', 'zone'],
});
const deliveryVisibility = defineVisibility<SampleDelivery>({
  owner: 'all',
  support: 'all',
  partner: ['blNo', 'volumeL'],
  office: ['blNo', 'volumeL'],
  plant: ['blNo', 'volumeL'],
});

const order: SampleOrder = {
  code: 'CMD-2026-00001',
  concreteType: 'B25',
  volumeL: 120_000,
  deliveryDate: '2026-11-27',
  zone: 'Fnideq',
  unitPriceHtCentimes: 78_000,
  totalTtcCentimes: 11_232_000,
  clientPhone: '+212600000017',
};
const delivery: SampleDelivery = {
  blNo: 'BL-2026-00001',
  volumeL: 8000,
  marginCentimes: 120_000,
  componentCostCentimes: 300_000,
};

describe('project (field visibility per role, default deny)', () => {
  it('plant sees an order without any price, total or client contact', () => {
    const seen = project(orderVisibility, 'plant', order);
    expect(seen).toEqual({
      code: 'CMD-2026-00001',
      concreteType: 'B25',
      volumeL: 120_000,
      deliveryDate: '2026-11-27',
      zone: 'Fnideq',
    });
    expectNoFields(seen, ['unitPriceHtCentimes', 'totalTtcCentimes', 'clientPhone']);
  });

  it('office sees a delivery without margin or cost', () => {
    expectNoFields(project(deliveryVisibility, 'office', delivery), [
      'marginCentimes',
      'componentCostCentimes',
    ]);
  });

  it('owner and support see everything', () => {
    expect(project(deliveryVisibility, 'owner', delivery)).toEqual(delivery);
    expect(project(orderVisibility, 'support', order)).toEqual(order);
  });

  it('drops a field added to the row but not to the allowlist (new fields are hidden by default)', () => {
    const extended = { ...order, internalNote: 'secret' } as SampleOrder & { internalNote: string };
    expectNoFields(project(orderVisibility, 'plant', extended), ['internalNote']);
  });

  it('projects lists', () => {
    expect(projectMany(deliveryVisibility, 'plant', [delivery, delivery])).toHaveLength(2);
  });
});

describe('expectNoFields', () => {
  it('finds a forbidden field at any depth, in objects and arrays', () => {
    expect(() => expectNoFields({ a: [{ b: { marginCentimes: 1 } }] }, ['marginCentimes'])).toThrow(
      /marginCentimes/,
    );
  });

  it('finds a forbidden field name in rendered HTML (data-field attributes)', () => {
    expect(() => expectNoFields('<td data-field="marginCentimes">12</td>', ['marginCentimes'])).toThrow();
    expect(() => expectNoFields('<td data-field="volumeL">8</td>', ['marginCentimes'])).not.toThrow();
  });
});
