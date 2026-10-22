import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, EmptyState, Money, PageHeader, StatusPill, Table, Td, Th } from './index';

describe('design tokens', () => {
  const css = readFileSync('src/app/globals.css', 'utf8');
  it.each([
    ['canvas', '#f6f5f3'],
    ['surface', '#ffffff'],
    ['line', '#e7e5e1'],
    ['ink', '#1f2328'],
    ['muted', '#6b6f76'],
    ['sidebar', '#2b3440'],
    ['accent', '#d9822b'],
    ['status-paid', '#2e7d4f'],
    ['status-ontrack', '#2f6db5'],
    ['status-due', '#c9a227'],
    ['status-late', '#c0392b'],
    ['status-cancelled', '#8a8f98'],
  ])('--color-%s is %s (D21/D22 status colours exactly)', (name, hex) => {
    expect(css).toContain(`--color-${name}: ${hex};`);
  });

  it('components use logical properties only (no left/right/margin-left in globals.css)', () => {
    const components = css.slice(css.indexOf('@layer components'));
    expect(components).not.toMatch(
      /\b(margin|padding|border)-(left|right)\b|\b(left|right):|text-align:\s*(left|right)/,
    );
  });
});

describe('kit', () => {
  it('Button defaults to type="button" and carries the variant class', () => {
    expect(renderToStaticMarkup(<Button>ok</Button>)).toContain('type="button"');
    expect(
      renderToStaticMarkup(
        <Button variant="danger" small>
          x
        </Button>,
      ),
    ).toMatch(/btn btn-danger btn-sm/);
  });

  it('StatusPill marks its status (colour comes from the token class)', () => {
    const html = renderToStaticMarkup(<StatusPill status="late">En retard</StatusPill>);
    expect(html).toContain('pill-late');
    expect(html).toContain('En retard');
  });

  it('numeric table cells align to the inline end and isolate their content left-to-right', () => {
    const html = renderToStaticMarkup(
      <Table>
        <thead>
          <tr>
            <Th numeric>Montant</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td numeric>1 234,56</Td>
          </tr>
        </tbody>
      </Table>,
    );
    expect(html).toContain('is-num');
    expect(html).toContain('<bdi dir="ltr">1 234,56</bdi>');
  });

  it('Money shows 1 234,56 MAD with Latin digits, left-to-right', () => {
    expect(renderToStaticMarkup(<Money centimes={123_456} />)).toBe(
      '<bdi dir="ltr" class="num">1 234,56 MAD</bdi>',
    );
  });

  it('PageHeader renders the one h1; EmptyState a title and description', () => {
    expect(renderToStaticMarkup(<PageHeader title="Clients" description="d" />)).toContain('<h1');
    const empty = renderToStaticMarkup(<EmptyState title="Rien" description="Bientôt" />);
    expect(empty).toContain('Rien');
    expect(empty).toContain('Bientôt');
  });
});
