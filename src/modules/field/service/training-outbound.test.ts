import { afterEach, describe, expect, it } from 'vitest';
import { mapLink, mapLinksOn } from './field-service';

// F07: the site address goes to no third party by default. The map link exists only when the operator turned MAP_LINKS_ENABLED on,
// and never in training mode (T1), whatever the flag says.
describe('mapLink (F07)', () => {
  afterEach(() => {
    delete process.env.TRAINING_MODE;
    delete process.env.MAP_LINKS_ENABLED;
  });
  it('is off by default: no external URL is built from an address', () => {
    expect(mapLinksOn()).toBe(false);
    expect(mapLink('12 rue du Chantier, Tétouan')).toBeNull();
    expect(mapLink(null)).toBeNull();
  });
  it('is built only when the operator switched it on', () => {
    process.env.MAP_LINKS_ENABLED = 'true';
    expect(mapLink('12 rue du Chantier, Tétouan')).toMatch(/^https:\/\/www\.google\.com\/maps/);
    expect(mapLink(null)).toBeNull();
  });
  it('stays off in training mode even when switched on', () => {
    process.env.MAP_LINKS_ENABLED = 'true';
    process.env.TRAINING_MODE = 'true';
    expect(mapLink('12 rue du Chantier, Tétouan')).toBeNull();
  });
  it.each(['1', 'yes', 'TRUE', ''])('treats %j as off (only the exact word true turns it on)', (v) => {
    process.env.MAP_LINKS_ENABLED = v;
    expect(mapLink('12 rue du Chantier, Tétouan')).toBeNull();
  });
});
