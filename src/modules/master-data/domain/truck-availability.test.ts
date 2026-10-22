import { describe, expect, it } from 'vitest';
import type { TruckStatusEntry } from './truck';
import { datesInRange, isTruckAvailable } from './truck-availability';

const active = { status: 'active' } as const;
let n = 0;
const entry = (
  status: TruckStatusEntry['status'],
  fromDate: string,
  toDate: string | null,
  createdAt = `2026-11-0${++n}T08:00:00.000Z`,
): TruckStatusEntry => ({ id: `e${n}`, truckId: 't', status, fromDate, toDate, reason: 'x', createdAt });

describe('isTruckAvailable (AC-MD-08)', () => {
  const log = [entry('breakdown', '2026-11-04', '2026-11-06')];

  it('a breakdown for [D4, D6) makes D4 and D5 unavailable and D6 available', () => {
    expect(isTruckAvailable(active, '2026-11-03', log)).toBe(true);
    expect(isTruckAvailable(active, '2026-11-04', log)).toBe(false);
    expect(isTruckAvailable(active, '2026-11-05', log)).toBe(false);
    expect(isTruckAvailable(active, '2026-11-06', log)).toBe(true);
  });

  it('a roadblock counts like a breakdown; an empty log means available', () => {
    expect(isTruckAvailable(active, '2026-11-04', [entry('roadblock', '2026-11-04', '2026-11-05')])).toBe(
      false,
    );
    expect(isTruckAvailable(active, '2026-11-04', [])).toBe(true);
  });

  it('an open-ended breakdown lasts until a later entry ends it', () => {
    const open = [entry('breakdown', '2026-11-04', null)];
    expect(isTruckAvailable(active, '2027-03-01', open)).toBe(false);
    const repaired = [...open, entry('available', '2026-11-08', null)];
    expect(isTruckAvailable(active, '2026-11-07', repaired)).toBe(false);
    expect(isTruckAvailable(active, '2026-11-08', repaired)).toBe(true);
  });

  it('the latest entry logged wins on shared days, whatever the order of the array', () => {
    const breakdown = entry('breakdown', '2026-11-04', '2026-11-10', '2026-11-04T08:00:00.000Z');
    const fixed = entry('available', '2026-11-05', '2026-11-10', '2026-11-05T09:00:00.000Z');
    for (const l of [
      [breakdown, fixed],
      [fixed, breakdown],
    ]) {
      expect(isTruckAvailable(active, '2026-11-04', l)).toBe(false);
      expect(isTruckAvailable(active, '2026-11-05', l)).toBe(true);
    }
  });

  it('an archived truck is never available', () => {
    expect(isTruckAvailable({ status: 'archived' }, '2026-11-01', [])).toBe(false);
  });
});

describe('datesInRange', () => {
  it('lists [from, to) across month and year ends, and nothing for an empty or reversed range', () => {
    expect(datesInRange('2026-12-30', '2027-01-02')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
    expect(datesInRange('2026-11-04', '2026-11-04')).toEqual([]);
    expect(datesInRange('2026-11-05', '2026-11-04')).toEqual([]);
  });
});
