import { BUSINESS_TIME_ZONE } from '../domain/business-date';

/** "jeu. 26 nov. 2026 07:00" in the business time zone, in the viewer's locale. */
export function formatSimDate(at: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: BUSINESS_TIME_ZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
}
