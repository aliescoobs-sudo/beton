'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import type { ManagedUser } from '../../service/user-admin';
import { StepUpDialog } from '../step-up-dialog';
import {
  type AdminActionResult,
  createUserAction,
  resetTwoFactorAction,
  setUserStatusAction,
} from './actions';

type Pending = () => Promise<AdminActionResult>;

/** Owner's user list and actions. Every action is sensitive: a stale second factor opens the step-up dialog. */
export function UsersAdmin({ users, selfId }: { users: ManagedUser[]; selfId: string }) {
  const t = useTranslations('admin');
  const router = useRouter();
  const [retry, setRetry] = useState<Pending | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: Pending, success?: string) {
    setMessage(null);
    const result = await action();
    if (result.ok) {
      if (success) setMessage(success);
      return router.refresh();
    }
    if (result.error === 'STEP_UP_REQUIRED') return setRetry(() => action);
    setMessage(result.message ?? t('error'));
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    void run(() => createUserAction(data), t('created')).then(() => form.reset());
  }

  const cell = 'border-b border-gray-200 px-2 py-2 text-start';
  const input = 'mt-1 block w-full rounded border border-gray-300 px-3 py-2';

  return (
    <div className="mt-6 space-y-8">
      {message && (
        <p role="status" className="text-sm" data-testid="admin-message">
          {message}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="users-table">
          <thead>
            <tr>
              {(['name', 'email', 'role', 'status', 'twoFactor', 'actions'] as const).map((h) => (
                <th key={h} className={`${cell} font-medium`}>
                  {t(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} data-testid={`user-${u.email}`}>
                <td className={cell}>{u.name}</td>
                <td className={cell} dir="ltr">
                  {u.email}
                </td>
                <td className={cell}>{t(`roles.${u.role}`)}</td>
                <td className={cell} data-testid="status">
                  {u.status === 'active' ? t('active') : t('disabled')}
                </td>
                <td className={cell} data-testid="two-factor">
                  {u.twoFactorEnabled ? t('enrolled') : t('notEnrolled')}
                </td>
                <td className={`${cell} space-x-2 whitespace-nowrap rtl:space-x-reverse`}>
                  {u.role !== 'owner' && (
                    <button
                      type="button"
                      className="underline"
                      onClick={() =>
                        void run(() =>
                          setUserStatusAction(u.id, u.status === 'active' ? 'disabled' : 'active'),
                        )
                      }
                    >
                      {u.status === 'active' ? t('disable') : t('enable')}
                    </button>
                  )}
                  {u.id !== selfId && u.twoFactorEnabled && (
                    <button
                      type="button"
                      className="underline"
                      onClick={() => {
                        if (window.confirm(t('confirmReset'))) void run(() => resetTwoFactorAction(u.id));
                      }}
                    >
                      {t('reset2fa')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={create} className="max-w-md space-y-3" data-testid="create-user">
        <h2 className="font-medium">{t('createTitle')}</h2>
        <label className="block">
          <span className="text-sm">{t('name')}</span>
          <input name="name" required className={input} />
        </label>
        <label className="block">
          <span className="text-sm">{t('email')}</span>
          <input name="email" type="email" required dir="ltr" className={input} />
        </label>
        <label className="block">
          <span className="text-sm">{t('role')}</span>
          <select name="role" className={input} defaultValue="office">
            {(['partner', 'office', 'plant'] as const).map((r) => (
              <option key={r} value={r}>
                {t(`roles.${r}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-sm">{t('locale')}</span>
          <select name="locale" className={input} defaultValue="fr">
            <option value="fr">Français</option>
            <option value="ar">العربية</option>
          </select>
        </label>
        <label className="block">
          <span className="text-sm">{t('password')}</span>
          <input name="password" type="password" autoComplete="new-password" required className={input} />
        </label>
        <button type="submit" className="rounded bg-gray-900 px-4 py-2 font-medium text-white">
          {t('create')}
        </button>
      </form>

      {retry && (
        <StepUpDialog
          onVerified={() => {
            const again = retry;
            setRetry(null);
            void run(again); // retry once
          }}
          onCancel={() => setRetry(null)}
        />
      )}
    </div>
  );
}
