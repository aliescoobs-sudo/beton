import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkDispatch,
  clockText,
  type DispatchDriver,
  type DispatchOrder,
  type DispatchParams,
  type DispatchTruck,
  isBlocking,
  isDriverOverride,
  planDispatch,
  retime,
  rotationTimes,
} from './dispatch';

const P: DispatchParams = {
  dayStartMin: 420,
  loadingMin: 10,
  unloadingMin: 30,
  returnExtraMin: 10,
  workingMin: 600,
  concreteLimitMin: 90,
  defaultOneWayMin: 30,
};
const order = (code: string, remainingL: number, oneWayMin: number | null = 25): DispatchOrder => ({
  orderId: `o-${code}`,
  orderCode: code,
  clientCode: 'CLT-001',
  typeLabel: 'B25',
  siteLabel: null,
  zoneName: null,
  oneWayMin,
  remainingL,
});
const truck = (n: number, capacityL = 8000, available = true, defaultDriverId = `d${n}`): DispatchTruck => ({
  id: `t${n}`,
  code: `T${n}`,
  capacityL,
  available,
  defaultDriverId,
});
const drivers: DispatchDriver[] = [1, 2, 3, 4, 5].map((n) => ({
  id: `d${n}`,
  code: `CH-0${n}`,
  name: `Driver ${n}`,
}));

describe('rotation times (AC-OPS-13)', () => {
  it('zone 25 min, loading 10, unloading 30, extra return 10: 07:00 load, 07:10 depart, 07:35 arrive, 08:05 unloaded, 08:40 back', () => {
    const t = rotationTimes(420, 25, P);
    expect(t).toEqual({ loadMin: 420, departMin: 430, arriveMin: 455, unloadEndMin: 485, backMin: 520 });
    expect(clockText(t.loadMin)).toBe('07:00');
    expect(clockText(t.departMin)).toBe('07:10');
    expect(clockText(t.arriveMin)).toBe('07:35');
    expect(clockText(t.unloadEndMin)).toBe('08:05');
    expect(clockText(t.backMin)).toBe('08:40');
  });
  it('rolls past midnight in the text only', () => {
    expect(clockText(1510)).toBe('01:10');
  });
});

describe('planDispatch (AC-OPS-12)', () => {
  const orders = [order('CMD-1', 7000), order('CMD-2', 12000), order('CMD-3', 9000)];
  const trucks = [1, 2, 3, 4, 5].map((n) => truck(n));

  it('7, 12 and 9 m³ on 8 m³ trucks give 1 + 2 + 2 rotations, each within its truck, covering each order exactly', () => {
    const plan = planDispatch(orders, trucks, drivers, P);
    const per = (code: string) => plan.rotations.filter((r) => r.orderId === `o-${code}`);
    expect(per('CMD-1').map((r) => r.volumeL)).toEqual([7000]);
    expect(per('CMD-2').map((r) => r.volumeL)).toEqual([8000, 4000]);
    expect(per('CMD-3').map((r) => r.volumeL)).toEqual([8000, 1000]);
    expect(plan.conflicts).toEqual([]);
    for (const r of plan.rotations) expect(r.volumeL).toBeLessThanOrEqual(8000);
  });

  it('the first rotation of each truck starts at the day start, the next at its back time', () => {
    const plan = planDispatch([order('CMD-1', 24000)], [truck(1)], drivers, P);
    expect(plan.rotations.map((r) => r.loadMin)).toEqual([420, 520, 620]);
  });

  it('a truck in the breakdown log is never in the proposal', () => {
    const plan = planDispatch(orders, [truck(1, 8000, false), ...[2, 3].map((n) => truck(n))], drivers, P);
    expect(plan.rotations.every((r) => r.truckId !== 't1')).toBe(true);
    expect(plan.conflicts.some((c) => c.kind === 'TRUCK_BROKEN')).toBe(false);
  });

  it('no available truck: NO_TRUCK for each order, no rotation', () => {
    const plan = planDispatch(orders, [truck(1, 8000, false)], drivers, P);
    expect(plan.rotations).toEqual([]);
    expect(plan.conflicts.filter((c) => c.kind === 'NO_TRUCK').map((c) => c.orderId)).toEqual([
      'o-CMD-1',
      'o-CMD-2',
      'o-CMD-3',
    ]);
  });

  it("each rotation takes its truck's default driver; a default that is not an active driver leaves the rotation without one, a conflict (AC-INT-20)", () => {
    const plan = planDispatch(
      [order('CMD-1', 16000)],
      [truck(1), truck(2)],
      [drivers[0] as DispatchDriver],
      P,
    );
    expect(plan.driverOfTruck).toEqual({ t1: 'd1', t2: null });
    expect(plan.conflicts.filter((c) => c.kind === 'NO_DRIVER')).toHaveLength(1);
  });

  it("the default is the truck's own, not the next driver in code order; a truck with no default has no driver proposed", () => {
    const plan = planDispatch(
      [order('CMD-1', 16000)],
      [truck(1, 8000, true, 'd3'), { ...truck(2), defaultDriverId: null }],
      drivers,
      P,
    );
    expect(plan.driverOfTruck).toEqual({ t1: 'd3', t2: null });
  });

  it('a driver other than the default, or none where there is a default, is an override; on the default or a truck without one it is not', () => {
    const t = truck(1, 8000, true, 'd1');
    expect(isDriverOverride(t, 'd2')).toBe(true);
    expect(isDriverOverride(t, null)).toBe(true);
    expect(isDriverOverride(t, 'd1')).toBe(false);
    expect(isDriverOverride({ defaultDriverId: null }, 'd2')).toBe(false);
    expect(isDriverOverride(undefined, 'd2')).toBe(false);
  });

  it('an order with no zone uses the default and says so', () => {
    const plan = planDispatch([order('CMD-1', 8000, null)], [truck(1)], drivers, P);
    expect(plan.rotations[0]?.arriveMin).toBe(420 + 10 + 30);
    expect(plan.conflicts.map((c) => c.kind)).toContain('ZONE_UNKNOWN');
  });

  it('property: every order is covered exactly, no rotation exceeds its truck, no truck or driver overlaps itself', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 6 }),
        fc.array(fc.integer({ min: 4, max: 12 }), { minLength: 1, maxLength: 5 }),
        (m3s, caps) => {
          const os = m3s.map((m, i) => order(`CMD-${i + 1}`, m * 1000, 20 + i * 7));
          const ts = caps.map((c, i) => truck(i + 1, c * 1000));
          const plan = planDispatch(os, ts, drivers, P);
          for (const o of os) {
            const sum = plan.rotations
              .filter((r) => r.orderId === o.orderId)
              .reduce((s, r) => s + r.volumeL, 0);
            expect(sum).toBe(o.remainingL);
          }
          for (const r of plan.rotations)
            expect(r.volumeL).toBeLessThanOrEqual(ts.find((t) => t.id === r.truckId)?.capacityL ?? 0);
          expect(
            plan.conflicts.filter((c) => c.kind === 'TRUCK_OVERLAP' || c.kind === 'DRIVER_OVERLAP'),
          ).toEqual([]);
        },
      ),
    );
  });
});

describe('checkDispatch (AC-OPS-14)', () => {
  const orders = [order('CMD-1', 16000), order('CMD-2', 8000)];
  const trucks = [truck(1), truck(2), truck(3, 8000, false)];
  const ctx = { orders, trucks, drivers, params: P };
  const base = planDispatch(orders, [truck(1), truck(2)], drivers, P).rotations;

  it('the proposal is clean', () => {
    expect(checkDispatch(base, ctx)).toEqual([]);
  });

  it('a rotation on a truck in the log is TRUCK_BROKEN, and it blocks', () => {
    const moved = base.map((r, i) => (i === 0 ? { ...r, truckId: 't3' } : r));
    const found = checkDispatch(moved, ctx).filter((c) => c.kind === 'TRUCK_BROKEN');
    expect(found).toHaveLength(1);
    expect(isBlocking(found[0] as never)).toBe(true);
  });

  it('a rotation over its truck is OVER_CAPACITY (blocking)', () => {
    const big = base.map((r, i) => (i === 0 ? { ...r, volumeL: 9000 } : r));
    const found = checkDispatch(big, ctx).find((c) => c.kind === 'OVER_CAPACITY');
    expect(found?.amount).toBe(1000);
    expect(isBlocking(found as never)).toBe(true);
  });

  it('one truck on two overlapping rotations: TRUCK_OVERLAP naming both', () => {
    const [a, b] = [base[0], base[1]] as [(typeof base)[number], (typeof base)[number]];
    const clash = [
      a,
      {
        ...b,
        truckId: a.truckId,
        loadMin: a.loadMin + 5,
        departMin: a.departMin + 5,
        arriveMin: a.arriveMin + 5,
        unloadEndMin: a.unloadEndMin + 5,
        backMin: a.backMin + 5,
      },
    ];
    const found = checkDispatch(clash, ctx).find((c) => c.kind === 'TRUCK_OVERLAP');
    expect(found?.rotationKeys.sort()).toEqual([a.key, b.key].sort());
  });

  it('one driver on two overlapping rotations: DRIVER_OVERLAP', () => {
    const [a, b] = [base[0], base[1]] as [(typeof base)[number], (typeof base)[number]];
    const clash = [a, { ...b, driverId: a.driverId, truckId: 't2' }];
    expect(checkDispatch(clash, ctx).some((c) => c.kind === 'DRIVER_OVERLAP')).toBe(true);
  });

  it('a rotation back after the working day is PAST_WORKING_DAY with the minutes late', () => {
    const late = planDispatch([order('CMD-9', 8000)], [truck(1)], drivers, { ...P, workingMin: 60 });
    const found = checkDispatch(late.rotations, {
      ...ctx,
      orders: [order('CMD-9', 8000)],
      params: { ...P, workingMin: 60 },
    }).find((c) => c.kind === 'PAST_WORKING_DAY');
    // back 08:40 = 520, last allowed 420 + 60 = 480
    expect(found?.amount).toBe(40);
  });

  it('R4: a long trip is flagged only above the limit (25 + 30 = 55 ≤ 90; 60 + 30 = 90 fine; 65 + 30 = 95 not)', () => {
    const at = (oneWay: number) =>
      checkDispatch(planDispatch([order('CMD-1', 8000, oneWay)], [truck(1)], drivers, P).rotations, {
        ...ctx,
        orders: [order('CMD-1', 8000, oneWay)],
      }).some((c) => c.kind === 'LONG_TRIP');
    expect(at(25)).toBe(false);
    expect(at(60)).toBe(false);
    expect(at(65)).toBe(true);
  });

  it('an order planned for less than what is left is ORDER_NOT_COVERED, for more is OVER_PLANNED, an order with no rotation is not covered', () => {
    const less = base.filter((r) => !(r.orderId === 'o-CMD-1' && r.seq === 2));
    expect(checkDispatch(less, ctx).find((c) => c.kind === 'ORDER_NOT_COVERED')).toMatchObject({
      orderId: 'o-CMD-1',
      amount: 8000,
    });
    const over = base.map((r) => (r.orderId === 'o-CMD-2' ? { ...r, volumeL: 8000 } : r));
    const extra = [
      ...over,
      {
        ...(over[0] as (typeof over)[number]),
        key: 'x',
        orderId: 'o-CMD-2',
        loadMin: 900,
        departMin: 910,
        arriveMin: 935,
        unloadEndMin: 965,
        backMin: 1000,
      },
    ];
    expect(checkDispatch(extra, ctx).find((c) => c.kind === 'OVER_PLANNED')?.orderId).toBe('o-CMD-2');
    const none = base.filter((r) => r.orderId !== 'o-CMD-2');
    expect(checkDispatch(none, ctx).find((c) => c.kind === 'ORDER_NOT_COVERED')?.orderId).toBe('o-CMD-2');
  });
});

describe('retime', () => {
  it('moving a rotation to another truck re-times both trucks without a gap or an overlap', () => {
    const orders = [order('CMD-1', 24000)];
    const plan = planDispatch(orders, [truck(1), truck(2)], drivers, P).rotations;
    const moved = retime(
      plan.map((r) => ({ ...r, truckId: 't1' })),
      orders,
      P,
    );
    expect(moved.map((r) => r.loadMin)).toEqual([420, 520, 620]);
    expect(
      checkDispatch(moved, { orders, trucks: [truck(1)], drivers, params: P }).some(
        (c) => c.kind === 'TRUCK_OVERLAP',
      ),
    ).toBe(false);
  });
});

describe('rotations that already started (fixed)', () => {
  const orders = [order('CMD-1', 8000)];
  const started = {
    key: 'started',
    orderId: 'o-done',
    seq: 1,
    truckId: 't1',
    driverId: 'd1',
    volumeL: 8000,
    ...rotationTimes(420, 25, P),
  };

  it('a truck is free again only when its started rotation is back', () => {
    const plan = planDispatch(orders, [truck(1)], drivers, P, [started]);
    expect(plan.rotations[0]?.loadMin).toBe(started.backMin);
    expect(plan.conflicts).toEqual([]);
  });

  it('retime keeps new rotations after the started one on the same truck', () => {
    const [r] = planDispatch(orders, [truck(2)], drivers, P).rotations;
    const moved = retime([{ ...(r as typeof started), truckId: 't1' }], orders, P, [started]);
    expect(moved[0]?.loadMin).toBe(started.backMin);
  });

  it('a new rotation that overlaps a started one is reported; two started ones are not judged', () => {
    const [r] = planDispatch(orders, [truck(2)], drivers, P).rotations;
    const clash = { ...(r as typeof started), truckId: 't1', driverId: 'd1' };
    const found = checkDispatch([clash], {
      orders,
      trucks: [truck(1)],
      drivers,
      params: P,
      fixed: [started],
    });
    expect(found.map((c) => c.kind)).toContain('TRUCK_OVERLAP');
    expect(found.map((c) => c.kind)).toContain('DRIVER_OVERLAP');
    const twin = { ...started, key: 'started2' };
    expect(
      checkDispatch([], { orders: [], trucks: [truck(1)], drivers, params: P, fixed: [started, twin] }),
    ).toEqual([]);
  });
});
