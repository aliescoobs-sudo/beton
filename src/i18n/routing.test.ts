import { describe, expect, it } from 'vitest';
import { directionOf, routing } from './routing';

describe('i18n routing', () => {
  it('supports French and Arabic, French by default', () => {
    expect(routing.locales).toEqual(['fr', 'ar']);
    expect(routing.defaultLocale).toBe('fr');
  });

  it('renders Arabic right-to-left', () => {
    expect(directionOf('ar')).toBe('rtl');
  });

  it('renders French left-to-right', () => {
    expect(directionOf('fr')).toBe('ltr');
  });
});
