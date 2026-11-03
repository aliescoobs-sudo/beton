import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { overlay } from './messages';
import { routing } from './routing';

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  const messages = (await import(`../../messages/${locale === 'ary' ? 'ar' : locale}.json`)).default;
  // Darija (Arabic script) overlays the Arabic messages: what is not translated yet reads in Arabic.
  const darija = locale === 'ary' ? (await import('../../messages/ary.json')).default : null;
  return { locale, messages: darija ? overlay(messages, darija) : messages };
});
