/** Registry for the dedicated finance schema; checked independently of the legacy public-schema registry. */
export const FINANCE_TABLES = [
  'finance_setting',
  'finance_category',
  'finance_allocation',
  'finance_entry',
  'finance_obligation',
  'finance_payment',
  'finance_instrument_link',
  'finance_steel',
  'finance_facility',
  'finance_material_cost',
  'finance_holder',
  'finance_fuel_cost',
] as const;
