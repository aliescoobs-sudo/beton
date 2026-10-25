/**
 * Daily dispatch (SPEC-operations §7.3, AC-OPS-12…14): the orders of a day split into truck rotations. Pure and
 * deterministic: no clock, no database. `planDispatch` proposes; `checkDispatch` judges any plan, the proposed one or one
 * edited by hand, so the screen and the service cannot disagree. Times are minutes from midnight of the day.
 */

export interface DispatchParams {
  /** Minutes from midnight when the first rotation of a truck starts loading. */
  dayStartMin: number;
  loadingMin: number;
  unloadingMin: number;
  /** Added to the way back: washing the drum and handing back at the plant. */
  returnExtraMin: number;
  /** A truck is back by `dayStartMin + workingMin`. */
  workingMin: number;
  /** R4: concrete is discharged within this many minutes of the end of loading. */
  concreteLimitMin: number;
  /** One-way minutes used for an order whose site has no zone. */
  defaultOneWayMin: number;
}

export interface DispatchOrder {
  orderId: string;
  orderCode: string;
  clientCode: string;
  typeLabel: string;
  siteLabel: string | null;
  zoneName: string | null;
  /** The zone's one-way minutes; null when the order has no zone (the default is used and the plan says so). */
  oneWayMin: number | null;
  /** Litres still to load (never negative). */
  remainingL: number;
}

export interface DispatchTruck {
  id: string;
  code: string;
  capacityL: number;
  /** Not archived and not in the breakdown log on the day (master-data `isTruckAvailable`). */
  available: boolean;
}

export interface DispatchDriver {
  id: string;
  code: string;
  name: string;
}

/** One rotation of the plan. The times are derived from the position of the rotation in its truck's day. */
export interface Rotation {
  /** Stable id inside one plan (the saved id once persisted). */
  key: string;
  orderId: string;
  /** 1…n per order, in the order they are planned. */
  seq: number;
  truckId: string;
  driverId: string | null;
  volumeL: number;
  loadMin: number;
  departMin: number;
  arriveMin: number;
  unloadEndMin: number;
  backMin: number;
}

export type ConflictKind =
  | 'TRUCK_BROKEN'
  | 'OVER_CAPACITY'
  | 'TRUCK_OVERLAP'
  | 'DRIVER_OVERLAP'
  | 'NO_TRUCK'
  | 'NO_DRIVER'
  | 'PAST_WORKING_DAY'
  | 'LONG_TRIP'
  | 'ORDER_NOT_COVERED'
  | 'OVER_PLANNED'
  | 'ZONE_UNKNOWN';

export interface Conflict {
  kind: ConflictKind;
  /** The rotations concerned (empty for a conflict of an order as a whole). */
  rotationKeys: string[];
  orderId: string | null;
  /** Minutes for PAST_WORKING_DAY (how late), litres for ORDER_NOT_COVERED and OVER_PLANNED (how many). */
  amount: number | null;
}

/** Conflicts the database also refuses: a plan with one cannot be saved. */
export const BLOCKING_CONFLICTS: readonly ConflictKind[] = ['TRUCK_BROKEN', 'OVER_CAPACITY'];

export const isBlocking = (c: Conflict): boolean => BLOCKING_CONFLICTS.includes(c.kind);

/** The milestones of a rotation that starts loading at `startMin` (AC-OPS-13). */
export function rotationTimes(
  startMin: number,
  oneWayMin: number,
  p: Pick<DispatchParams, 'loadingMin' | 'unloadingMin' | 'returnExtraMin'>,
): Pick<Rotation, 'loadMin' | 'departMin' | 'arriveMin' | 'unloadEndMin' | 'backMin'> {
  const departMin = startMin + p.loadingMin;
  const arriveMin = departMin + oneWayMin;
  const unloadEndMin = arriveMin + p.unloadingMin;
  return {
    loadMin: startMin,
    departMin,
    arriveMin,
    unloadEndMin,
    backMin: unloadEndMin + oneWayMin + p.returnExtraMin,
  };
}

/** Whole-minute clock text, "08:40". Minutes past midnight of the next day roll over ("25:10" is shown as "01:10"). */
export function clockText(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Truck codes T1, T2, T10 in numeric order. */
const byTruckCode = (a: { code: string }, b: { code: string }): number =>
  a.code.localeCompare(b.code, 'en', { numeric: true });

const oneWayOf = (o: DispatchOrder | undefined, p: DispatchParams): number =>
  o?.oneWayMin ?? p.defaultOneWayMin;

/** When a truck is free: the day's start, or the latest back time of its rotations that already started. */
const busyUntil = (fixed: readonly Rotation[], truckId: string, dayStartMin: number): number =>
  fixed.reduce((m, r) => (r.truckId === truckId ? Math.max(m, r.backMin) : m), dayStartMin);

/**
 * The proposal for a day (AC-OPS-12): each order, in code order, is cut into rotations of at most the carrying truck's
 * capacity; every rotation goes to the available truck that is free first (a tie goes to the smallest truck that carries
 * what is left, else the largest, then the code). Drivers are paired to the available trucks in code order. Nothing is
 * written: a person saves it.
 */
export function planDispatch(
  orders: readonly DispatchOrder[],
  trucks: readonly DispatchTruck[],
  drivers: readonly DispatchDriver[],
  p: DispatchParams,
  /** Rotations that already started and stay as they are: their trucks are busy until they are back. */
  fixed: readonly Rotation[] = [],
): { rotations: Rotation[]; conflicts: Conflict[]; driverOfTruck: Record<string, string | null> } {
  const usable = trucks.filter((t) => t.available).sort(byTruckCode);
  const sortedDrivers = [...drivers].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  const driverOfTruck: Record<string, string | null> = {};
  usable.forEach((t, i) => (driverOfTruck[t.id] = sortedDrivers[i]?.id ?? null));
  const freeAt = new Map(usable.map((t) => [t.id, busyUntil(fixed, t.id, p.dayStartMin)]));
  const rotations: Rotation[] = [];
  const noTruck: Conflict[] = [];

  for (const o of [...orders].sort((a, b) => a.orderCode.localeCompare(b.orderCode))) {
    let left = o.remainingL;
    let seq = 0;
    if (left <= 0) continue;
    if (usable.length === 0) {
      noTruck.push({ kind: 'NO_TRUCK', rotationKeys: [], orderId: o.orderId, amount: left });
      continue;
    }
    while (left > 0) {
      const earliest = Math.min(...usable.map((t) => freeAt.get(t.id) as number));
      const ready = usable.filter((t) => freeAt.get(t.id) === earliest);
      const fits = ready.filter((t) => t.capacityL >= left).sort((a, b) => a.capacityL - b.capacityL);
      const truck = fits[0] ?? [...ready].sort((a, b) => b.capacityL - a.capacityL)[0];
      if (!truck) break;
      const volumeL = Math.min(left, truck.capacityL);
      const times = rotationTimes(earliest, oneWayOf(o, p), p);
      seq += 1;
      rotations.push({
        key: `${o.orderId}:${seq}`,
        orderId: o.orderId,
        seq,
        truckId: truck.id,
        driverId: driverOfTruck[truck.id] ?? null,
        volumeL,
        ...times,
      });
      freeAt.set(truck.id, times.backMin);
      left -= volumeL;
    }
  }
  const conflicts = [...noTruck, ...checkDispatch(rotations, { orders, trucks, drivers, params: p, fixed })];
  return { rotations, conflicts, driverOfTruck };
}

/**
 * Re-times a plan after a hand edit (a rotation moved to another truck): per truck, the rotations keep their order of
 * loading time (then key) and follow each other, the first starting at the day's start. Volumes, trucks and drivers are
 * the caller's; the times are recomputed.
 */
export function retime(
  rotations: readonly Rotation[],
  orders: readonly DispatchOrder[],
  p: DispatchParams,
  /** Rotations that already started: a truck's next rotation cannot begin before they are back. */
  fixed: readonly Rotation[] = [],
): Rotation[] {
  const orderById = new Map(orders.map((o) => [o.orderId, o]));
  const next = new Map<string, number>();
  return [...rotations]
    .sort((a, b) => a.loadMin - b.loadMin || a.key.localeCompare(b.key))
    .map((r) => {
      const start = next.get(r.truckId) ?? busyUntil(fixed, r.truckId, p.dayStartMin);
      const times = rotationTimes(start, oneWayOf(orderById.get(r.orderId), p), p);
      next.set(r.truckId, times.backMin);
      return { ...r, ...times };
    });
}

const overlaps = (a: Rotation, b: Rotation): boolean => a.loadMin < b.backMin && b.loadMin < a.backMin;

export interface DispatchContext {
  /** Rotations that already started: only their overlaps with the plan are judged. */
  fixed?: readonly Rotation[];
  orders: readonly DispatchOrder[];
  trucks: readonly DispatchTruck[];
  drivers: readonly DispatchDriver[];
  params: DispatchParams;
}

/**
 * Every conflict of a plan (AC-OPS-14), each with the rotations it concerns. A plan with no rotation and orders to cover
 * reports them as not covered. `TRUCK_BROKEN` and `OVER_CAPACITY` are the ones the database refuses as well.
 */
export function checkDispatch(rotations: readonly Rotation[], ctx: DispatchContext): Conflict[] {
  const conflicts: Conflict[] = [];
  const truckById = new Map(ctx.trucks.map((t) => [t.id, t]));
  const orderById = new Map(ctx.orders.map((o) => [o.orderId, o]));
  const sorted = [...rotations].sort((a, b) => a.loadMin - b.loadMin || a.key.localeCompare(b.key));
  const lastMin = ctx.params.dayStartMin + ctx.params.workingMin;

  for (const r of sorted) {
    const truck = truckById.get(r.truckId);
    const at = (kind: ConflictKind, amount: number | null = null): void =>
      void conflicts.push({ kind, rotationKeys: [r.key], orderId: r.orderId, amount });
    if (!truck || !truck.available) at('TRUCK_BROKEN');
    else if (r.volumeL > truck.capacityL) at('OVER_CAPACITY', r.volumeL - truck.capacityL);
    if (r.driverId === null) at('NO_DRIVER');
    if (r.backMin > lastMin) at('PAST_WORKING_DAY', r.backMin - lastMin);
    // R4: from the end of loading to the end of unloading.
    if (r.unloadEndMin - r.departMin > ctx.params.concreteLimitMin)
      at('LONG_TRIP', r.unloadEndMin - r.departMin - ctx.params.concreteLimitMin);
    if (orderById.get(r.orderId)?.oneWayMin === null) at('ZONE_UNKNOWN');
  }

  for (const [field, kind] of [
    ['truckId', 'TRUCK_OVERLAP'],
    ['driverId', 'DRIVER_OVERLAP'],
  ] as const) {
    const all = [...sorted, ...(ctx.fixed ?? [])];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i] as Rotation;
        const b = all[j] as Rotation;
        // two rotations that already started are not this plan's business
        if (i >= sorted.length && j >= sorted.length) continue;
        if (a[field] !== null && a[field] === b[field] && overlaps(a, b))
          conflicts.push({ kind, rotationKeys: [a.key, b.key], orderId: null, amount: null });
      }
    }
  }

  const planned = new Map<string, number>();
  for (const r of rotations) planned.set(r.orderId, (planned.get(r.orderId) ?? 0) + r.volumeL);
  for (const o of ctx.orders) {
    const have = planned.get(o.orderId) ?? 0;
    // An order with no available truck is reported as NO_TRUCK by the proposal, not as a second conflict here.
    if (have < o.remainingL && have > 0)
      conflicts.push({
        kind: 'ORDER_NOT_COVERED',
        rotationKeys: [],
        orderId: o.orderId,
        amount: o.remainingL - have,
      });
    else if (have === 0 && o.remainingL > 0 && rotations.length > 0)
      conflicts.push({
        kind: 'ORDER_NOT_COVERED',
        rotationKeys: [],
        orderId: o.orderId,
        amount: o.remainingL,
      });
    if (have > o.remainingL)
      conflicts.push({
        kind: 'OVER_PLANNED',
        rotationKeys: [],
        orderId: o.orderId,
        amount: have - o.remainingL,
      });
  }
  return conflicts;
}
