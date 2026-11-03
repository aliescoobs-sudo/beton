import { describe, expect, it } from 'vitest';
import { overlay } from './messages';

describe('Darija overlays Arabic', () => {
  it('a translated key replaces the Arabic one and an untranslated key stays Arabic', () => {
    const ar = { a: { x: 'عربية', y: 'عربية 2' }, b: 'ب' };
    const ary = { a: { x: 'دارجة' } };
    expect(overlay(ar, ary)).toEqual({ a: { x: 'دارجة', y: 'عربية 2' }, b: 'ب' });
  });
  it('does not change its inputs', () => {
    const ar = { a: { x: '1' } };
    overlay(ar, { a: { x: '2' } });
    expect(ar).toEqual({ a: { x: '1' } });
  });
});
