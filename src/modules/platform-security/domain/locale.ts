/**
 * R8 (REQUIREMENTS-V1 §13): Arabic, French and Darija (Arabic script, `ary`). Each account has a main language it can switch.
 * `src/i18n/routing.ts` lists the same codes (a unit test proves they agree); Darija falls back to Arabic for any message it
 * does not translate (`src/i18n/messages.ts`).
 */
export const USER_LOCALES = ['fr', 'ar', 'ary'] as const;
export type UserLocale = (typeof USER_LOCALES)[number];
export function isUserLocale(value: unknown): value is UserLocale {
  return typeof value === 'string' && (USER_LOCALES as readonly string[]).includes(value);
}
/** Surfaces that only know French and Arabic (the assistant) serve a Darija speaker in Arabic. */
export function baseLocale(locale: UserLocale): 'fr' | 'ar' {
  return locale === 'fr' ? 'fr' : 'ar';
}
