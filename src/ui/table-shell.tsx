'use client';

import { type HTMLAttributes, useEffect, useRef } from 'react';
import { cn } from './cn';

/** The text of each column, from the last header row, one entry per grid column (a colSpan header counts for each column it covers). */
export function columnLabels(table: HTMLTableElement): string[] {
  const rows = table.tHead?.rows;
  const last = rows?.[rows.length - 1];
  if (!last) return [];
  const labels: string[] = [];
  for (const th of Array.from(last.cells)) {
    const text = (th.textContent ?? '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < Math.max(1, th.colSpan); i++) labels.push(text);
  }
  return labels;
}

function apply(table: HTMLTableElement) {
  const labels = columnLabels(table);
  for (const body of Array.from(table.tBodies)) {
    for (const row of Array.from(body.rows)) {
      let col = 0;
      for (const cell of Array.from(row.cells)) {
        const label = labels[col] ?? '';
        if (cell.dataset.label !== label) cell.dataset.label = label;
        col += Math.max(1, cell.colSpan);
      }
    }
  }
  // Once the table is shown as cards the browser drops its table semantics: say them again.
  if (table.getAttribute('role') !== 'table') table.setAttribute('role', 'table');
  for (const el of Array.from(table.querySelectorAll('thead, tbody, tfoot')))
    el.setAttribute('role', 'rowgroup');
  for (const el of Array.from(table.querySelectorAll('tr'))) el.setAttribute('role', 'row');
  for (const el of Array.from(table.querySelectorAll('th')))
    el.setAttribute('role', el.closest('thead') ? 'columnheader' : 'rowheader');
  for (const el of Array.from(table.querySelectorAll('td'))) el.setAttribute('role', 'cell');
}

/**
 * The table and its scroll container. On a phone (below md) each row is a card whose cells carry their column's header as a label
 * (`data-label`, set here from the header cells, so no page has to repeat it); `mobile="scroll"` keeps the columns, with the first one sticky
 * and an edge fade that shows where the strip continues. The page itself never scrolls sideways.
 */
export function TableShell({
  mobile = 'cards',
  className,
  ...rest
}: HTMLAttributes<HTMLTableElement> & { mobile?: 'cards' | 'scroll' }) {
  const ref = useRef<HTMLTableElement>(null);
  useEffect(() => {
    const table = ref.current;
    if (!table) return;
    apply(table);
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => apply(table));
    });
    observer.observe(table, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  return (
    <div className="table-wrap scroll-hint">
      <table ref={ref} data-mobile={mobile} className={cn('data-table', className)} {...rest} />
    </div>
  );
}
