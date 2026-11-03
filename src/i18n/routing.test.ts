import { describe, expect, it } from 'vitest';
import { directionOf, routing } from './routing';

describe('i18n routing', () => {
  it('supports French, Arabic and Darija, French by default', () => {
    expect(routing.locales).toEqual(['fr', 'ar', 'ary']);
    expect(routing.defaultLocale).toBe('fr');
  });

  it('renders Arabic right-to-left', () => {
    expect(directionOf('ar')).toBe('rtl');
  });

  it('renders Darija (Arabic script) right-to-left', () => {
    expect(directionOf('ary')).toBe('rtl');
  });

  it('renders French left-to-right', () => {
    expect(directionOf('fr')).toBe('ltr');
  });
});
