import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

// SecLists top-10k (MIT, see data/LICENSE-common-passwords.md). Read once, from the repo root.
let common: Set<string> | undefined;
function commonPasswords(): Set<string> {
  common ??= new Set(
    readFileSync(join(process.cwd(), 'src/modules/platform-security/data/common-passwords.txt'), 'utf8')
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean),
  );
  return common;
}

export type PasswordCheck = { ok: true } | { ok: false; reason: 'too_short' | 'too_long' | 'too_common' };

/** Length 12–128 and not a common password; no composition rules (SPEC-platform-security §5). */
export function checkPassword(password: string): PasswordCheck {
  if (password.length < PASSWORD_MIN) return { ok: false, reason: 'too_short' };
  if (password.length > PASSWORD_MAX) return { ok: false, reason: 'too_long' };
  if (commonPasswords().has(password.toLowerCase())) return { ok: false, reason: 'too_common' };
  return { ok: true };
}
