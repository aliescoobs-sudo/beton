'use client';

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { cn } from './cn';

type ToastKind = 'info' | 'error';
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}
interface ToastApi {
  show: (text: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined });

/** Short confirmations that fade by themselves (5 s); the region is an aria-live status for screen readers. */
export function ToastProvider({
  children,
  dismissLabel = '×',
}: {
  children: ReactNode;
  dismissLabel?: string;
}) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (text: string, kind: ToastKind = 'info') => {
      const id = Math.random();
      setItems((all) => [...all.slice(-2), { id, kind, text }]);
      setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );
  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {items.map((item) => (
          <div
            key={item.id}
            className={cn('toast', item.kind === 'error' && 'toast-error')}
            data-testid="toast"
          >
            <span>{item.text}</span>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              aria-label={dismissLabel}
              className="opacity-80"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
