/**
 * Comparators on plain numbers. Money is never added or compared with arithmetic operators outside lib/money (AC-LED-11):
 * a branded amount passes through these parameters as an ordinary number to sort by, never to compute with.
 */
export const asc = (a: number, b: number): number => a - b;
export const desc = (a: number, b: number): number => b - a;
