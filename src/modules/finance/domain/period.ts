export type Period = 'month' | 'quarter' | 'half' | 'year';
export function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function periodRange(year: number, period: Period, index: number) {
  const months = { month: 1, quarter: 3, half: 6, year: 12 }[period];
  if (
    !Number.isInteger(year) ||
    year < 2000 ||
    year > 2200 ||
    !months ||
    !Number.isInteger(index) ||
    index < 1 ||
    index > 12 / months
  )
    throw new Error('INVALID_PERIOD');
  const month = (index - 1) * months;
  return {
    from: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(year, month + months, 0)).toISOString().slice(0, 10),
  };
}
export function addMonths(date: string, months: number): string {
  if (!validDate(date) || !Number.isInteger(months)) throw new Error('INVALID_DATE');
  const d = new Date(date),
    day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
