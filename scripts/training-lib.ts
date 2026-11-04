// The pure parts of the training seed (T1): the account plan, the random credentials and the file they are written to once.
// A leaf with no database access, so it is unit-tested without one.
import { randomInt } from 'node:crypto';
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
