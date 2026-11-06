import { describe, expect, it } from 'vitest';
import {
  alertOf,
  buildBoard,
  localMidnightMs,
  plannedMs,
  projectTrip,
  slipMinutes,
  type StageEstimates,
  type TimingTrip,
  truckStatus,
  WATCH_TOLERANCE_MIN,
} from './trip-timing';
import { minuteOfDay } from './trip-times';

const DATE = '2026-11-10';
const DAY = localMidnightMs(DATE);
const MIN = 60_000;
const iso = (min: number) => new Date(DAY + min * MIN).toISOString();
// estimates: loading 10, to site 30, waiting 10, unloading 30, return 30, turnaround 0
const EST: StageEstimates = {
  loading: 10,
  to_site: 30,
  waiting: 10,
  unloading: 30,
  return: 30,
  turnaround: 0,
};
// a rotation planned 07:00 load, 07:10 depart, 07:40 arrive, 08:20 unload end, 08:50 back
const trip = (over: Partial<TimingTrip> = {}, load = 420): TimingTrip => ({
  tripId: `t${load}`,
  seq: 1,
  orderCode: `CMD-${load}`,
  plantId: 'P1',
  truckId: 'K1',
  truckCode: 'T1',
  driverId: 'D1',
  driverName: 'Chauffeur Démo',
  zoneId: 'Z1',
  zoneName: 'Zone',
  plan: {
    loadMin: load,
    departMin: load + 10,
    arriveMin: load + 40,
    unloadEndMin: load + 80,
    backMin: load + 110,
  },
  steps: {},
  dayStartMs: DAY,
  ...over,
});

describe('midnight Casablanca', () => {
  it.each(['2026-01-15', '2026-03-01', '2026-03-25', '2026-11-10'])(
    'is minute 0 of %s in the business time zone',
    (d) => {
      expect(minuteOfDay(new Date(localMidnightMs(d)).toISOString())).toBe(0);
    },
  );
});

describe('the planned timeline', () => {
  it('turns the plan minutes into instants; unloading starts when the truck arrives', () => {
    const p = plannedMs(trip());
    expect(p.loading_started).toBe(DAY + 420 * MIN);
    expect(p.back).toBe(DAY + 530 * MIN);
    expect(p.unloading_started).toBe(p.arrived);
  });
  it('a plan past midnight (minutes above 1440) lands on the next day, not before', () => {
    const late = trip({
      plan: { loadMin: 1400, departMin: 1410, arriveMin: 1440, unloadEndMin: 1480, backMin: 1510 },
    });
    expect(plannedMs(late).back).toBe(DAY + 1510 * MIN);
    expect(plannedMs(late).back).toBeGreaterThan(DAY + 24 * 60 * MIN);
  });
});

describe('the projection after a tap', () => {
  it('a rotation not started is projected as planned', () => {
    const p = projectTrip(trip(), EST, DAY + 400 * MIN);
    expect(p.started).toBe(false);
    expect(p.projectedBackMs).toBe(DAY + 530 * MIN);
  });
  it('projected return = the tap + the estimates of the remaining stages', () => {
    // departed 20 minutes late (07:30); remaining: to site 30, waiting 10, unloading 30, return 30 = 100 -> back 09:10
    const t = trip({ steps: { loading_started: iso(425), departed: iso(450) } });
    const p = projectTrip(t, EST, DAY + 451 * MIN);
    expect(p.lastStep).toBe('departed');
    expect(p.projectedBackMs).toBe(DAY + 550 * MIN);
    expect(p.timeline.arrived).toEqual({ ms: DAY + 480 * MIN, actual: false });
    expect(p.nextStep).toBe('arrived');
  });
  it('a stage still running cannot be projected into the past', () => {
    // departed 07:10, it is now 08:30: the 30-minute drive has run 80 minutes, so arrival is "now" and the rest follows from it
    const t = trip({ steps: { departed: iso(430) } });
    const p = projectTrip(t, EST, DAY + 510 * MIN);
    expect(p.timeline.arrived?.ms).toBe(DAY + 510 * MIN);
    expect(p.overUnderwayMin).toBe(50);
    expect(p.projectedBackMs).toBe(DAY + (510 + 10 + 30 + 30) * MIN);
  });
  it('a skipped stage leaves a hole and the projection continues from the last real tap', () => {
    const t = trip({ steps: { departed: iso(430), unloading_started: iso(500) } }); // arrived never tapped
    const p = projectTrip(t, EST, DAY + 505 * MIN);
    expect(p.lastStep).toBe('unloading_started');
    expect(p.timeline.arrived).toBeUndefined();
    expect(p.timeline.unloading_finished?.ms).toBe(DAY + 530 * MIN);
    expect(p.projectedBackMs).toBe(DAY + 560 * MIN);
  });
  it('an offline tap counts at the time the driver tapped, not the time it reached the server', () => {
    // tapped at 07:30, synced at 09:00: the projection is built on 07:30
    const t = trip({ steps: { departed: iso(450) } });
    const p = projectTrip(t, EST, DAY + 540 * MIN);
    expect(p.timeline.departed?.ms).toBe(DAY + 450 * MIN);
    expect(p.timeline.arrived?.ms).toBe(DAY + 540 * MIN); // 07:30 + 30 is long past: the stage is overdue, so "now"
  });
  it('a finished rotation is projected at its real return', () => {
    const t = trip({
      steps: {
        departed: iso(430),
        arrived: iso(460),
        unloading_started: iso(470),
        unloading_finished: iso(500),
        back: iso(540),
      },
    });
    const p = projectTrip(t, EST, DAY + 600 * MIN);
    expect(p.finished).toBe(true);
    expect(p.projectedBackMs).toBe(DAY + 540 * MIN);
  });
  it('crosses midnight: a rotation that ends after 24:00 projects onto the next day', () => {
    const t = trip({
      plan: { loadMin: 1380, departMin: 1390, arriveMin: 1420, unloadEndMin: 1460, backMin: 1490 },
      steps: { departed: iso(1400) },
    });
    const p = projectTrip(t, EST, DAY + 1401 * MIN);
    expect(p.projectedBackMs).toBe(DAY + (1400 + 100) * MIN);
    expect(p.projectedBackMs).toBeGreaterThan(DAY + 1440 * MIN);
  });
});

describe('the slip of the next rotation', () => {
  it('is the projected return plus the turnaround, past the next planned start, never negative', () => {
    expect(slipMinutes(DAY + 550 * MIN, 0, DAY + 530 * MIN)).toBe(20);
    expect(slipMinutes(DAY + 550 * MIN, 10, DAY + 530 * MIN)).toBe(30);
    expect(slipMinutes(DAY + 500 * MIN, 0, DAY + 530 * MIN)).toBe(0);
  });
});

describe('the alert', () => {
  const next = trip({}, 530); // next rotation of the same truck planned to load at 08:50
  it('critical, with the minutes and the order, when the next rotation will start late', () => {
    const t = trip({ steps: { loading_started: iso(425), departed: iso(450) } }); // back projected 09:10 = 550
    const a = alertOf(t, next, projectTrip(t, EST, DAY + 451 * MIN), EST, DAY + 451 * MIN);
    expect(a).toMatchObject({
      level: 'critical',
      slipMin: 20,
      nextOrderCode: 'CMD-530',
      cause: 'next_trip_delayed',
    });
  });
  it('watch when a stage ran over its estimate but the next rotation is not touched', () => {
    // to-site took 45 min against 30, but the return is short enough
    const loose = { ...EST, return: 10, unloading: 10 };
    const t = trip({ steps: { departed: iso(430), arrived: iso(475) } });
    const a = alertOf(t, next, projectTrip(t, loose, DAY + 476 * MIN), loose, DAY + 476 * MIN);
    expect(a).toMatchObject({ level: 'watch', cause: 'stage_over_estimate' });
    expect(a.overMin).toBe(15);
  });
  it('none when everything is within the tolerance, and an early rotation (negative delay) is fine', () => {
    const t = trip({ steps: { departed: iso(425), arrived: iso(452) } }); // five minutes early, a stage shorter than estimated
    expect(alertOf(t, next, projectTrip(t, EST, DAY + 453 * MIN), EST, DAY + 453 * MIN).level).toBe('none');
    expect(WATCH_TOLERANCE_MIN).toBe(5);
  });
  it('a next rotation that has already started is not affected', () => {
    const started = trip({ steps: { loading_started: iso(535) } }, 530);
    const t = trip({ steps: { departed: iso(450) } });
    expect(alertOf(t, started, projectTrip(t, EST, DAY + 451 * MIN), EST, DAY + 451 * MIN).level).not.toBe(
      'critical',
    );
  });
  it('a rotation that has not started and whose start is long past is a watch (late start)', () => {
    const t = trip();
    const a = alertOf(t, next, projectTrip(t, EST, DAY + 440 * MIN), EST, DAY + 440 * MIN);
    expect(a).toMatchObject({ level: 'watch', cause: 'late_start', overMin: 20 });
  });
});

describe('the board', () => {
  it('groups by truck in order, shows status, and carries the worst alert of the truck', () => {
    const t1 = trip({ steps: { loading_started: iso(425), departed: iso(450) } });
    const t2 = trip({}, 530);
    const other = trip({ truckId: 'K2', truckCode: 'T2', driverId: 'D2' }, 600);
    const board = buildBoard([t2, t1, other], () => EST, DAY + 460 * MIN);
    expect(board.map((b) => b.truckCode)).toEqual(['T1', 'T2']);
    const k1 = board[0]!;
    expect(k1.trips.map((x) => x.trip.orderCode)).toEqual(['CMD-420', 'CMD-530']);
    expect(k1.status).toBe('en_route');
    expect(k1.alert).toMatchObject({ level: 'critical', slipMin: 20 });
    expect(k1.trips[0]!.cumulativeDelayMin).toBe(20);
    expect(board[1]!.status).toBe('available');
  });
  it('truck status follows the last step: loading, en route, returning, available', () => {
    const at = (steps: TimingTrip['steps']) =>
      truckStatus(projectTrip(trip({ steps }), EST, DAY + 700 * MIN));
    expect(at({ loading_started: iso(425) })).toBe('loading');
    expect(at({ departed: iso(430) })).toBe('en_route');
    expect(at({ unloading_finished: iso(500) })).toBe('returning');
    expect(at({ back: iso(520) })).toBe('available');
  });
});
