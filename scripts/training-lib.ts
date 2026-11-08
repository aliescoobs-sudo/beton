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
    'KAYAS — comptes de formation / حسابات التدريب',
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
export const STAGING_NAME = /^training-accounts\.staging-t?[0-9a-f]{12}\.local\.txt$/;
/**
 * R15A-05: a stage written by the lock protocol of this version is named after the attempt that made it
 * (`staging-t<first 12 hex of the lock token>`); the sweep can then tell WHOSE it is. A bare `staging-<12 hex>` name is from an earlier
 * version or a caller with no lock: its creator is unknown.
 */
const ATTEMPT_STAGING_NAME = /^training-accounts\.staging-t([0-9a-f]{12})\.local\.txt$/;
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
export function stageCredentialsFile(file: string, content: string, attempt?: string): StagedCredentials {
  const final = validateCredentialsPath(file);
  const tmp = path.join(
    path.dirname(final),
    attempt
      ? `training-accounts.staging-t${attempt}.local.txt`
      : `training-accounts.staging-${randomBytes(6).toString('hex')}.local.txt`,
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

// ---- R14-12, R15A-05: the whole seed/output lifecycle is under ONE lock; a displaced holder is fenced; the sweep only removes stages whose
// creating attempt provably cannot resume -------------------------------------------------------------------------------------------------
/**
 * The seed lock lives in the credentials folder as numbered EPOCH files `training-accounts.seed.lock.<n>` (no secret in them). The
 * highest number is the current lock. A file without a number is the lock of the first version (epoch 0).
 *   - A new lock is taken by creating the next number with O_EXCL. Creating a name that exists is refused by the file system, so of any
 *     number of concurrent takers exactly ONE wins an epoch, and nobody ever unlinks a lock they have not themselves superseded: there is
 *     no "stat, decide, unlink the pathname" step that could remove a living holder's NEW lock.
 *   - A lock is taken over only when its heartbeat (mtime) is older than SEED_LOCK_STALE_MS. A missing heartbeat is NOT proof that the
 *     holder is dead (a suspended or stalled process comes back), so the holder FENCES ITSELF: `held()` is true only while the holder's
 *     own last successful beat is younger than half of SEED_LOCK_STALE_MS (by its own clock) AND its epoch is still the highest. A
 *     taker waits the whole stale time; a holder stops committing at half of it. They cannot both be committing, except for the
 *     instant between a `held()` check and the action right after it (the residual, stated in decision 191).
 */
export const SEED_LOCK_NAME = 'training-accounts.seed.lock';
/** A lock whose last heartbeat is older than this may be taken over. A live seed touches it every HEARTBEAT_MS. */
export const SEED_LOCK_STALE_MS = 60_000;
const SEED_LOCK_HEARTBEAT_MS = 10_000;
/** A staged file younger than this is never swept, even when its attempt is superseded (a second line of defence, not the proof). */
export const STAGING_MIN_AGE_MS = 10 * 60_000;

export class SeedLockError extends Error {}

const LOCK_FILE = /^training-accounts\.seed\.lock(?:\.([0-9]+))?$/;
const epochFile = (dir: string, epoch: number): string => path.join(dir, `${SEED_LOCK_NAME}.${epoch}`);

export interface SeedLock {
  /** The current epoch file. */
  readonly file: string;
  /** The first 12 hex characters of this attempt's token: stamped into the name of every file it stages. */
  readonly attempt: string;
  /** True only while this attempt may still commit: not released, lease fresh by its own clock, and nobody holds a higher epoch. */
  held(): boolean;
  /** Throws SeedLockError (naming the step) unless held(). Call immediately before every commit. */
  assertHeld(step: string): void;
  release(): void;
}

function lockEpochs(dir: string): number[] {
  const found: number[] = [];
  for (const name of readdirSync(dir)) {
    const m = LOCK_FILE.exec(name);
    if (m) found.push(m[1] === undefined ? 0 : Number(m[1]));
  }
  return found.sort((x, y) => x - y);
}
const lockPath = (dir: string, epoch: number): string =>
  epoch === 0 ? path.join(dir, SEED_LOCK_NAME) : epochFile(dir, epoch);

/**
 * Takes the seed lock of the credentials folder (see above) and keeps it alive with a heartbeat. A seed that finds the lock live is
 * refused: it must not sweep, seed or stage anything. Call BEFORE the sweep and hold it until the seed has finished.
 */
export function acquireSeedLock(
  finalFile: string,
  opts: { now?: () => number; staleMs?: number; heartbeatMs?: number } = {},
): SeedLock {
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? SEED_LOCK_STALE_MS;
  const dir = path.dirname(path.resolve(finalFile));
  const token = randomBytes(12).toString('hex');
  const attempt = token.slice(0, 12);
  const refuse = (why: string): never => {
    throw new SeedLockError(why);
  };
  const create = (epoch: number): boolean => {
    try {
      const fd = openSync(
        epochFile(dir, epoch),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeSync(fd, JSON.stringify({ token, epoch, pid: process.pid, at: now() }));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      return refuse(
        `the credentials folder cannot take the seed lock (${(error as NodeJS.ErrnoException).code ?? 'error'}): nothing was seeded or claimed. Use a folder this user can write (mode 0700).`,
      );
    }
  };
  const epochs = lockEpochs(dir);
  const top = epochs.at(-1);
  if (top !== undefined) {
    const st = lstatSync(lockPath(dir, top), { throwIfNoEntry: false });
    if (st && (!st.isFile() || now() - st.mtimeMs <= staleMs))
      refuse(
        'another training seed holds the credentials folder (its lock is live): wait for it to finish; nothing was swept, written or removed',
      );
  }
  // The next number is created exclusively. Two takers that judged the same lock abandoned both try the SAME name: one wins, the other
  // is refused. The winner supersedes the older locks; it never removes anybody's current lock.
  const epoch = (top ?? 0) + 1;
  if (!create(epoch))
    return refuse('another training seed took the credentials folder at the same moment: nothing was done');
  const file = epochFile(dir, epoch);
  for (const old of epochs) discardCredentialsFile(lockPath(dir, old)); // superseded (or released) locks, best effort

  let released = false;
  let lastBeat = now();
  const mine = (): boolean => {
    try {
      if ((JSON.parse(readFileSync(file, 'utf8')) as { token?: string }).token !== token) return false;
      return (lockEpochs(dir).at(-1) ?? -1) === epoch; // nobody holds a higher epoch
    } catch {
      return false;
    }
  };
  const held = (): boolean => !released && now() - lastBeat < staleMs / 2 && mine();
  const beat = setInterval(() => {
    try {
      if (mine()) {
        utimesSync(file, new Date(now()), new Date(now()));
        lastBeat = now();
      }
    } catch {
      // the next beat tries again; the lease runs out meanwhile and held() turns false
    }
  }, opts.heartbeatMs ?? SEED_LOCK_HEARTBEAT_MS);
  beat.unref();
  return {
    file,
    attempt,
    held,
    assertHeld: (step) => {
      if (!held())
        throw new SeedLockError(
          `training seed stopped before "${step}": this attempt no longer holds the seed lock (it was stalled, or another seed took over). Nothing further was written by it.`,
        );
    },
    release: () => {
      if (released) return;
      released = true;
      clearInterval(beat);
      if (mine()) discardCredentialsFile(file); // only our own lock file is ever removed
    },
  };
}

/**
 * Deletes what an earlier seed attempt left in the credentials folder, only when that attempt provably cannot resume a commit:
 *   - a stage named after an attempt (`staging-t<attempt>`) whose attempt is NOT this one. The caller holds the highest epoch, so the
 *     creator either released its lock (finished or gave up) or was superseded; a superseded holder fences itself at half the stale
 *     time (see above) and takes its credentials file out of the question by failing its own `assertHeld` before the rename;
 *   - AND the file is at least STAGING_MIN_AGE_MS old: an extra, not the proof.
 * A stage whose creator is unknown (a bare `staging-<hex>` name, or the hidden names of the first version) is NEVER deleted here: nothing
 * proves that nobody can still rename it. Those are returned in `unknown` so the operator can remove them by hand once they know no seed
 * is running. Refuses to run without a held lock. Never touches the final file.
 */
export function sweepStaleStagedCredentials(
  finalFile: string,
  lock: SeedLock,
  opts: { now?: () => number; minAgeMs?: number } = {},
): { removed: number; unknown: string[] } {
  lock.assertHeld('sweep of abandoned staged files');
  const now = opts.now ?? Date.now;
  const minAge = opts.minAgeMs ?? STAGING_MIN_AGE_MS;
  const dir = path.dirname(path.resolve(finalFile));
  const me = process.getuid?.();
  let removed = 0;
  const unknown: string[] = [];
  for (const name of readdirSync(dir)) {
    const named = ATTEMPT_STAGING_NAME.exec(name);
    if (!named && !STAGING_NAME.test(name) && !LEGACY_STAGING_NAME.test(name)) continue;
    const full = path.join(dir, name);
    const st = lstatSync(full, { throwIfNoEntry: false });
    if (!st || !st.isFile() || (me !== undefined && st.uid !== me)) continue;
    if (!named) {
      unknown.push(name); // creator unknown: not provably abandoned
      continue;
    }
    if (named[1] === lock.attempt) continue; // ours
    if (now() - st.mtimeMs < minAge) continue; // the age gate, on top of the proof
    unlinkSync(full);
    removed++;
  }
  return { removed, unknown };
}

/** Removes a staged or committed file, ignoring one that is not there. */
export function discardCredentialsFile(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}
