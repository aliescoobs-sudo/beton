// The pure vocabulary of the charges register (T19 item 6): safe to import from a client component.
export const CHARGE_CATEGORIES = [
  'rent',
  'electricity_water',
  'telecom',
  'insurance',
  'maintenance',
  'transport',
  'taxes_fees',
  'bank_fees',
  'supplies',
  'other',
] as const;
export const CHARGE_MODES = ['cash', 'cheque', 'transfer', 'card'] as const;
