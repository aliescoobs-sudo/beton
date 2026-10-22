import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** Class string for places that need the look without the component (links styled as buttons). */
export const buttonClass = (variant: ButtonVariant = 'primary', small = false) =>
  cn('btn', `btn-${variant}`, small && 'btn-sm');

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  small?: boolean;
}

/** `type` defaults to "button": a submit must say so. Primary (amber) is for the one main action of a view. */
export function Button({
  variant = 'primary',
  small = false,
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  return <button type={type} className={cn(buttonClass(variant, small), className)} {...rest} />;
}
