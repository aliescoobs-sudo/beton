import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from './cn';

/** Scrolls sideways inside its card on a phone (the page itself never overflows); the header stays sticky. */
export function Table({ className, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="table-wrap">
      <table className={cn('data-table', className)} {...rest} />
    </div>
  );
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
