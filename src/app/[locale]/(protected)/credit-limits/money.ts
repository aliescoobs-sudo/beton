/** "12 500,50" or "12500.5" to centimes by integer arithmetic only; anything else is refused. Empty means "remove the limit". */
export function madToCentimes(raw: string): number | null | 'INVALID' {
  const text = raw.replace(/[\s ]/g, '').replace(',', '.');
  if (text === '') return null;
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return 'INVALID';
  const centimes = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return centimes > 0 ? centimes : 'INVALID';
}
