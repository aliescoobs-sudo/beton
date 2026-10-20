import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatSimDate } from './format-sim-date';
import { SimBadge } from './sim-badge';

describe('SimBadge', () => {
  it('shows the simulated date in the business time zone', () => {
    const html = renderToStaticMarkup(
      <SimBadge label="SIMULATION" at={formatSimDate(new Date('2026-11-26T07:00:00Z'), 'fr')} />,
    );
    expect(html).toContain('data-testid="sim-badge"');
    expect(html).toContain('SIMULATION');
    expect(html).toContain('26');
    expect(html).toContain('07:00');
  });
});
