import { exact } from './money';
/** Money typed by the human, one conversion to integer centimes. */
export function financeAmount(text: string): number {
  const clean = text.replace(/[ \u00a0\u202f]/g, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean)) throw new Error('INVALID_AMOUNT');
  const [whole, decimal = ''] = clean.split('.');
  return exact(BigInt(whole!) * 100n + BigInt(decimal.padEnd(2, '0')));
}
