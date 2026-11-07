// The pure parts of the training seed (T1): the account plan, the random credentials and the file they are written to once.
// A leaf with no database access, so it is unit-tested without one.
import { randomBytes, randomInt } from 'node:crypto';
import {
  closeSync,
  existsSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { TRAINING_EMAIL_DOMAIN } from '../src/lib/training.ts';
import { parsePin } from '../src/modules/field/domain/pin.ts';

export type TrainingRole =
  | 'owner'
  | 'app_admin'
  | 'office_sales'
  | 'office_purchases'
  | 'plant_manager'
  | 'accountant'
  | 'driver'
  | 'pump_operator';

export interface PlannedAccount {
  /** Short label printed in the credentials file. */
  label: string;
  role: TrainingRole;
  name: string;
  /** Local part of the email (password accounts only). */
  login: string;
  locale: 'fr' | 'ar';
  /** For a plant manager: the plant code. */
  plant?: 'TET' | 'CHF';
}

/** One account per role, as the lead asked: plant managers for both plants, three drivers, one pump operator. */
export const PASSWORD_ACCOUNTS: readonly PlannedAccount[] = [
  { label: 'Propriétaire', role: 'owner', name: 'Propriétaire Démo', login: 'proprietaire', locale: 'fr' },
  { label: 'Administrateur', role: 'app_admin', name: 'Administrateur Démo', login: 'admin', locale: 'fr' },
  { label: 'Bureau ventes', role: 'office_sales', name: 'Bureau Ventes Démo', login: 'ventes', locale: 'fr' },
  {
    label: 'Bureau achats',
    role: 'office_purchases',
    name: 'Bureau Achats Démo',
    login: 'achats',
    locale: 'fr',
  },
  {
    label: 'Chef de centrale Tétouan',
    role: 'plant_manager',
    name: 'Chef Centrale Tétouan Démo',
    login: 'centrale-tetouan',
    locale: 'fr',
    plant: 'TET',
  },
  {
    label: 'Chef de centrale Chefchaouen',
    role: 'plant_manager',
    name: 'Chef Centrale Chefchaouen Démo',
    login: 'centrale-chefchaouen',
    locale: 'fr',
    plant: 'CHF',
  },
  { label: 'Comptable', role: 'accountant', name: 'Comptable Démo', login: 'comptable', locale: 'fr' },
];

export const emailOf = (login: string): string => `${login}@${TRAINING_EMAIL_DOMAIN}`;

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 16 characters from an alphabet without look-alikes (0/O, 1/l/I): random, long enough for the 12-character rule. */
export function generatePassword(pick: (max: number) => number = (max) => randomInt(max)): string {
  return Array.from({ length: 16 }, () => ALPHABET[pick(ALPHABET.length)]).join('');
}

/** A six-digit PIN that the PIN rules accept (not a run, not a repeat). */
export function generatePin(pick: (max: number) => number = (max) => randomInt(max)): string {
  for (;;) {
    const pin = Array.from({ length: 6 }, () => pick(10)).join('');
    if (parsePin(pin).ok) return pin;
  }
}

export interface IssuedCredential {
  label: string;
  role: string;
  /** Email for the password accounts, the driver code for the phone accounts. */
  login: string;
  secret: string;
  secretKind: 'password' | 'pin';
}

/** The text written once to the credentials file (training-accounts.local.txt). Never printed to a log. */
export function renderCredentialsFile(
  baseUrl: string,
  issued: readonly IssuedCredential[],
  at: Date,
): string {
  const lines = [
    'BELGOBETON — comptes de formation / حسابات التدريب',
    `Généré le ${at.toISOString()} — données fictives uniquement.`,
    `Adresse : ${baseUrl}`,
    '',
    'Ce fichier est lu une seule fois : il ne doit être ni commité, ni envoyé. Un nouveau `reset:training` génère de nouveaux mots de passe.',
    'Mot de passe seul (pas de code TOTP) pour les comptes e-mail ; code chauffeur + PIN sur le téléphone pour les chauffeurs et le pompiste.',
    '',
  ];
  for (const c of issued)
    lines.push(
      `${c.label} (${c.role})`,
      c.secretKind === 'password' ? `  e-mail : ${c.login}` : `  code   : ${c.login}`,
      `  ${c.secretKind === 'password' ? 'mot de passe' : 'PIN'} : ${c.secret}`,
      '',
    );
  return lines.join('\n');
}

// R11-04: the credentials file holds every training password and PIN. It is created privately and exclusively, then renamed into place;
// its folder must be ours and closed to writers; its name must be one the ignore rules cover.

/** The names `.gitignore` and `.dockerignore` cover (training-accounts*.local.txt): a custom path must still match. */
export const CREDENTIALS_NAME = /^training-accounts[A-Za-z0-9._-]*\.local\.txt$/;

/**
 * R12-02: the one place credentials may be written inside a container: the stock private volume. Anywhere else, the folder must not be
 * inside a checkout or a Docker build context (a folder, or an ancestor, that holds .git, a Dockerfile or a .dockerignore).
 */
export const STOCK_ACCOUNTS_DIR = '/app/out';

/**
 * R13: the stock exception is for a MOUNTED volume, not for a pathname. A directory is a mount point when the kernel lists it as one
 * (/proc/self/mountinfo, field 5, on Linux) or, where that file does not exist, when it lives on another device than its parent.
 */
export function isMountPoint(dir: string): boolean {
  try {
    const real = realpathSync(dir);
    if (existsSync('/proc/self/mountinfo')) {
      const unescape = (v: string) =>
        v.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
      return readFileSync('/proc/self/mountinfo', 'utf8')
        .split('\n')
        .some((line) => unescape(line.split(' ')[4] ?? '') === real);
    }
    const here = lstatSync(real);
    const up = lstatSync(path.dirname(real));
    return real === path.dirname(real) || here.dev !== up.dev; // the root is a mount
  } catch {
    return false;
  }
}

export interface PathChecks {
  /** The stock volume path and the mount test: injectable for tests only; the defaults are the container's. */
  stockDir?: string;
  isMount?: (dir: string) => boolean;
}
const BUILD_CONTEXT_MARKERS = ['.git', 'Dockerfile', '.dockerignore'];

function insideCheckoutOrBuildContext(dir: string): boolean {
  let d = dir;
  for (;;) {
    if (BUILD_CONTEXT_MARKERS.some((m) => lstatSync(path.join(d, m), { throwIfNoEntry: false }))) return true;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}

/** The name of a staged file: covered by `training-accounts*.local.txt` in both .gitignore and .dockerignore, never a hidden name. */
export const STAGING_NAME = /^training-accounts\.staging-[0-9a-f]{12}\.local\.txt$/;
/** Staged names of the first version (hidden, uncovered by the ignore rules): still swept if an old crash left one. */
const LEGACY_STAGING_NAME = /^\.training-accounts[A-Za-z0-9._-]*\.[0-9a-f]{12}$/;

/** Checks a destination for the credentials file and returns its absolute path; throws with the reason otherwise. */
export function validateCredentialsPath(file: string, checks: PathChecks = {}): string {
  const stockDir = checks.stockDir ?? STOCK_ACCOUNTS_DIR;
  const isMount = checks.isMount ?? isMountPoint;
  const abs = path.resolve(file);
  if (!CREDENTIALS_NAME.test(path.basename(abs)) || STAGING_NAME.test(path.basename(abs)))
    throw new Error(
      `credentials file refused: "${path.basename(abs)}" is not a name the ignore rules cover (training-accounts*.local.txt)`,
    );
  const dir = lstatSync(path.dirname(abs), { throwIfNoEntry: false });
  if (!dir || dir.isSymbolicLink() || !dir.isDirectory())
    throw new Error('credentials file refused: its folder does not exist or is a link');
  const realDir = realpathSync(path.dirname(abs));
  // the stock exception needs the folder to be an actual mount (the private accounts volume), not merely to have that name
  if (!(realDir === stockDir && isMount(realDir)) && insideCheckoutOrBuildContext(realDir))
    throw new Error(
      `credentials file refused: its folder is inside a checkout or a Docker build context. Give the output path of a private folder outside it (in the containers: ${STOCK_ACCOUNTS_DIR}).`,
    );
  const me = process.getuid?.();
  if (me !== undefined && dir.uid !== me)
    throw new Error('credentials file refused: its folder is not owned by the user running the seed');
  if ((dir.mode & 0o022) !== 0)
    throw new Error(
      'credentials file refused: its folder is writable by group or others (use a folder with mode 0700)',
    );
  const target = lstatSync(abs, { throwIfNoEntry: false });
  if (target && (target.isSymbolicLink() || !target.isFile()))
    throw new Error('credentials file refused: the destination exists and is not a regular file');
  if (target && me !== undefined && target.uid !== me)
    throw new Error('credentials file refused: the destination exists and belongs to somebody else');
  return abs;
}

export interface StagedCredentials {
  tmp: string;
  final: string;
}

/** Writes the content to a new file made exclusively (O_EXCL, no symlink following) with mode 0600, flushed to disk. Not yet in place. */
export function stageCredentialsFile(file: string, content: string): StagedCredentials {
  const final = validateCredentialsPath(file);
  const tmp = path.join(
    path.dirname(final),
    `training-accounts.staging-${randomBytes(6).toString('hex')}.local.txt`,
  );
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(tmp);
    throw error;
  }
  closeSync(fd);
  const made = lstatSync(tmp);
  if (!made.isFile() || (made.mode & 0o077) !== 0) {
    unlinkSync(tmp);
    throw new Error('credentials file refused: the staged file is not private');
  }
  return { tmp, final };
}

/** Puts the staged file in place (atomic rename). A rename that fails removes the staged file: no secret is left under a staging name. */
export function commitCredentialsFile(staged: StagedCredentials): void {
  try {
    renameSync(staged.tmp, staged.final);
  } catch (error) {
    discardCredentialsFile(staged.tmp);
    throw error;
  }
}

// ---- R14-12: the whole seed/output lifecycle is under ONE lock; the sweep only removes provably abandoned staging files -------------------
/** The lock file of the seed in the credentials folder (never a credentials name; no secret in it). */
export const SEED_LOCK_NAME = 'training-accounts.seed.lock';
/** A lock whose last heartbeat is older than this is abandoned (its seed died). A live seed touches it every HEARTBEAT_MS. */
export const SEED_LOCK_STALE_MS = 60_000;
const SEED_LOCK_HEARTBEAT_MS = 10_000;
/** A staged file younger than this is never swept, even under our own lock (a second line of defence for a lock taken over). */
export const STAGING_MIN_AGE_MS = 10 * 60_000;

export class SeedLockError extends Error {}

export interface SeedLock {
  readonly file: string;
  /** True while this process still holds it (not released, and nobody took the file over). */
  held(): boolean;
  release(): void;
}

/**
 * Takes the seed lock of the credentials folder, exclusively (O_EXCL, no link followed), and keeps it alive with a heartbeat. Another seed
 * that finds it live (heartbeat within SEED_LOCK_STALE_MS) is refused: it must not sweep, seed or stage anything. A lock whose heartbeat
 * stopped is taken over once. Call BEFORE the sweep and hold it until the seed has finished (marker written or everything discarded).
 */
export function acquireSeedLock(
  finalFile: string,
  opts: { now?: () => number; staleMs?: number; heartbeatMs?: number } = {},
): SeedLock {
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? SEED_LOCK_STALE_MS;
  const file = path.join(path.dirname(path.resolve(finalFile)), SEED_LOCK_NAME);
  const token = randomBytes(12).toString('hex');
  const create = (): boolean => {
    try {
      const fd = openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(fd, JSON.stringify({ token, pid: process.pid, at: now() }));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw new SeedLockError(
        `the credentials folder cannot take the seed lock (${(error as NodeJS.ErrnoException).code ?? 'error'}): nothing was seeded or claimed. Use a folder this user can write (mode 0700).`,
      );
    }
  };
  if (!create()) {
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (st && (!st.isFile() || now() - st.mtimeMs <= staleMs))
      throw new SeedLockError(
        'another training seed holds the credentials folder (its lock is live): wait for it to finish; nothing was swept, written or removed',
      );
    // abandoned: its heartbeat stopped. Removed once; if another seed wins the race for the new lock, this one is refused too.
    if (st) unlinkSync(file);
    if (!create())
      throw new SeedLockError(
        'another training seed took the credentials folder at the same moment: nothing was done',
      );
  }
  let released = false;
  const mine = (): boolean => {
    try {
      return (JSON.parse(readFileSync(file, 'utf8')) as { token?: string }).token === token;
    } catch {
      return false;
    }
  };
  const beat = setInterval(() => {
    try {
      if (mine()) utimesSync(file, new Date(now()), new Date(now()));
    } catch {
      // the next beat tries again
    }
  }, opts.heartbeatMs ?? SEED_LOCK_HEARTBEAT_MS);
  beat.unref();
  return {
    file,
    held: () => !released && mine(),
    release: () => {
      if (released) return;
      released = true;
      clearInterval(beat);
      if (mine()) discardCredentialsFile(file); // only our own lock file is ever removed
    },
  };
}

/**
 * Deletes what an earlier crashed seed left in the credentials folder: staged files of ours (regular files, never links) that are
 * PROVABLY abandoned: the caller holds the seed lock (so no other seed is writing) AND the file is older than STAGING_MIN_AGE_MS.
 * Returns how many were removed. Never touches the final file, and refuses to run without a held lock.
 */
export function sweepStaleStagedCredentials(
  finalFile: string,
  lock: SeedLock,
  opts: { now?: () => number; minAgeMs?: number } = {},
): number {
  if (!lock.held())
    throw new SeedLockError(
      'the stale staging sweep needs the seed lock: refusing to touch the credentials folder',
    );
  const now = opts.now ?? Date.now;
  const minAge = opts.minAgeMs ?? STAGING_MIN_AGE_MS;
  const dir = path.dirname(path.resolve(finalFile));
  const me = process.getuid?.();
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!STAGING_NAME.test(name) && !LEGACY_STAGING_NAME.test(name)) continue;
    const full = path.join(dir, name);
    const st = lstatSync(full, { throwIfNoEntry: false });
    if (!st || !st.isFile() || (me !== undefined && st.uid !== me)) continue;
    if (now() - st.mtimeMs < minAge) continue; // maybe in use: not provably abandoned
    unlinkSync(full);
    removed++;
  }
  return removed;
}

/** Removes a staged or committed file, ignoring one that is not there. */
export function discardCredentialsFile(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}
