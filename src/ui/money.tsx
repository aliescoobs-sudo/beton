import { formatCentimes } from '@/lib/money';
import { cn } from './cn';

/** "1 234,56 MAD" in both locales: Latin digits, thin-space thousands, decimal comma, always left-to-right. */
export function Money({
  centimes,
  suffix,
  className,
}: {
  centimes: number;
  suffix?: string;
  className?: string;
}) {
  return (
    <bdi dir="ltr" className={cn('num', className)}>
      {formatCentimes(centimes)} MAD{suffix ? ` ${suffix}` : ''}
    </bdi>
  );
}
