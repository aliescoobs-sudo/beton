import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatSimDate } from './format-sim-date';
import { SimBadge } from './sim-badge';
import { simDays } from './sim-days';

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

  it('draws the day strip: past days filled, today solid, future days dashed, the control after it', () => {
    const html = renderToStaticMarkup(
      <SimBadge label="محاكاة / Simulation" at="26/11" days={simDays('2026-11-26', 2, 2)}>
        <button type="button">+1</button>
      </SimBadge>,
    );
    expect(html).toContain('محاكاة / Simulation');
    expect(html.match(/sim-day-past/g)).toHaveLength(2);
    expect(html.match(/sim-day-today/g)).toHaveLength(1);
    expect(html.match(/sim-day-future/g)).toHaveLength(2);
    expect(html.indexOf('sim-day-future')).toBeLessThan(html.indexOf('+1'));
  });
});
