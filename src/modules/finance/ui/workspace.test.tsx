import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { FinanceWorkspace } from './workspace';
import { managementReport } from '../domain/report';
import { cashForecast } from '../domain/forecast';
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
const report = managementReport({
  from: '2026-11-01',
  to: '2026-11-30',
  plants: [
    { id: 'a', name: 'Tétouan' },
    { id: 'b', name: 'Chefchaouen' },
  ],
  facts: [],
  leasingTreatment: 'expense',
  missingValuations: 1,
});
const cash = {
  accounts: [],
  openingCentimes: 0,
  flows: [],
  scheduled: cashForecast(0, '2026-11-01', '2026-11-02', []),
  conservative: cashForecast(0, '2026-11-01', '2026-11-02', [], true),
};
const refs = {
  instruments: [],
  fuel: [],
  categories: [],
  allocations: [],
  obligations: [],
  entries: [],
  steel: [],
  materials: [],
};
describe('finance report presentation', () => {
  it('orders plant results before central costs and total; reports incomplete evidence', () => {
    const html = renderToStaticMarkup(
      <FinanceWorkspace report={report} cash={cash} refs={refs} plants={[]} locale="fr" today="2026-11-01" />,
    );
    expect(html.indexOf('Tétouan')).toBeLessThan(html.indexOf('Charges centrales'));
    expect(html).toContain('Rapport incomplet');
    expect(html).toContain('Résultat de gestion (données enregistrées)');
    expect(html).toContain('dir="ltr"');
    expect(html).not.toContain('net profit');
  });
  it('provides Arabic labels and an export in both locales', () => {
    const html = renderToStaticMarkup(
      <FinanceWorkspace report={report} cash={cash} refs={refs} plants={[]} locale="ar" today="2026-11-01" />,
    );
    expect(html).toContain('المصاريف المركزية');
    expect(html).toContain('/ar/finance/export?from=');
  });
});
