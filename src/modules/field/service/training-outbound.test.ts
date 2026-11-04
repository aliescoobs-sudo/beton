import { afterEach, describe, expect, it } from 'vitest';
import { mapLink } from './field-service';

// T1: the training instance sends an address to nobody. The map link of the phone app is off there, on elsewhere (F07 will decide it).
describe('mapLink in training mode', () => {
  afterEach(() => {
    delete process.env.TRAINING_MODE;
  });
  it('builds the link outside training and returns nothing in training', () => {
    expect(mapLink('12 rue du Chantier, Tétouan')).toMatch(/^https:\/\/www\.google\.com\/maps/);
    process.env.TRAINING_MODE = 'true';
    expect(mapLink('12 rue du Chantier, Tétouan')).toBeNull();
    expect(mapLink(null)).toBeNull();
  });
});
