import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from './cn';

export const inputClass = 'input';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(inputClass, className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(inputClass, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(inputClass, className)} {...rest} />;
}

/** Label + control + optional hint/error. The control is a child, so `<label>` wraps it and no id is needed. */
export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn('block', className)}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint block">{hint}</span>}
      {error && (
        <span role="alert" className="field-error block">
          {error}
        </span>
      )}
    </label>
  );
}
