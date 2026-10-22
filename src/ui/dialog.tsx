'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';
import { cn } from './cn';

/**
 * Modal dialog: role="dialog", labelled by its title, focus moves in and returns on close, Escape calls `onClose`,
 * Tab stays inside. It sets its own text colour: it is also rendered inside coloured parents (the simulation pill).
 */
export function Dialog({
  title,
  onClose,
  children,
  className,
}: {
  title: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>('[autofocus],input,select,textarea,button');
    first?.focus();
    return () => previous?.focus?.();
  }, []);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape' && onClose) {
      event.stopPropagation();
      return onClose();
    }
    if (event.key !== 'Tab' || !panel.current) return;
    const focusable = [
      ...panel.current.querySelectorAll<HTMLElement>('input,select,textarea,button,a[href]'),
    ].filter((el) => !el.hasAttribute('disabled'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="dialog-overlay" onKeyDown={onKeyDown}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn('dialog-panel text-ink', className)}
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        <div className="mt-3 space-y-4">{children}</div>
      </div>
    </div>
  );
}
