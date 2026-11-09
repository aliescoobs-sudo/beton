import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from './cn';
import { TableShell } from './table-shell';

/** A table. On a phone each row becomes a card (see TableShell); `mobile="scroll"` keeps the columns instead. */
export function Table(props: HTMLAttributes<HTMLTableElement> & { mobile?: 'cards' | 'scroll' }) {
  return <TableShell {...props} />;
}

/** `numeric` aligns to the inline end (right in French, left in Arabic) with tabular figures. */
export function Th({
  numeric,
  className,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <th className={cn(numeric && 'is-num', className)} {...rest} />;
}

/** Numeric cells isolate their content as left-to-right so "1 234,56 MAD" never reorders in Arabic. */
export function Td({
  numeric,
  className,
  children,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td className={cn(numeric && 'is-num', className)} {...rest}>
      {numeric ? <bdi dir="ltr">{children}</bdi> : children}
    </td>
  );
}
