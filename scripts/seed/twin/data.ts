// T20 (D251): the invented parties and places of the twin. Everything here is fictitious: company names say "(fictif)", people are generic codes,
// ICE and phone numbers are in a reserved fake range (all zeros, which no real number or ICE starts with), and there is no CIN, birth date or home address
// (D249). Names are written in different cases on purpose: that is how the real files look.

/** Reserved fake phone range: "0000 00 xxxx" cannot be dialled (00 is the international prefix and no country code starts with 0). */
export const fakePhone = (n: number): string => `0000 00 ${String(n).padStart(4, '0')}`;
/** Reserved fake ICE: 15 digits, ten zeros then five digits. A real ICE never starts with ten zeros. */
export const fakeIce = (n: number): string => `0000000000${String(n).padStart(5, '0')}`;
/** The fake phone and ICE ranges as a pattern, for the invariant test. */
export const FAKE_PHONE = /^0000 00 \d{4}$/;
export const FAKE_ICE = /^0{10}\d{5}$/;

export type Behaviour = 'good' | 'slow' | 'late' | 'bad';

export interface ClientSpec {
  name: string;
  kind: 'company' | 'person';
  zone: string;
  /** How much of the plants' volume the client takes (relative). */
  weight: number;
  behaviour: Behaviour;
  poRequired?: boolean;
  basis?: 'HT' | 'TTC';
  /** Payment terms in days (client record). */
  terms: number;
  aliases?: string[];
  /** Plant the client mostly orders from. */
  plant: 'TET' | 'CHF';
}

/** The 5 clients the master-data seed already holds are described by their exact names; the 25 others are created. */
export const PILOT_CLIENTS: ClientSpec[] = [
  {
    name: 'Entreprise Atlas BTP (fictif)',
    kind: 'company',
    zone: 'Tétouan centre',
    weight: 9,
    behaviour: 'good',
    poRequired: true,
    basis: 'HT',
    terms: 30,
    aliases: ['ATLAS BTP', 'Atlas Bâtiment'],
    plant: 'TET',
  },
  {
    name: 'Promotion Martil Immo (fictif)',
    kind: 'company',
    zone: 'Martil',
    weight: 7,
    behaviour: 'slow',
    basis: 'HT',
    terms: 45,
    aliases: ['martil immo'],
    plant: 'TET',
  },
  {
    name: 'SARL Rif Construction (fictif)',
    kind: 'company',
    zone: "M'diq",
    weight: 6,
    behaviour: 'late',
    poRequired: true,
    basis: 'TTC',
    terms: 30,
    plant: 'TET',
  },
  {
    name: 'Coopérative Oued Laou (fictif)',
    kind: 'company',
    zone: 'Oued Laou',
    weight: 3,
    behaviour: 'bad',
    basis: 'TTC',
    terms: 60,
    plant: 'CHF',
  },
  {
    name: 'Karim Test (fictif)',
    kind: 'person',
    zone: 'Fnideq',
    weight: 1,
    behaviour: 'good',
    basis: 'TTC',
    terms: 0,
    plant: 'TET',
  },
];

export const EXTRA_CLIENTS: ClientSpec[] = [
  {
    name: 'TAZI TRAVAUX ET CONSTRUCTION (fictif)',
    kind: 'company',
    zone: 'Tétouan centre',
    weight: 8,
    behaviour: 'good',
    basis: 'HT',
    terms: 30,
    aliases: ['TAZI TRAVAUX'],
    plant: 'TET',
  },
  {
    name: 'sarl andalous bâtiment (fictif)',
    kind: 'company',
    zone: 'Martil',
    weight: 6,
    behaviour: 'slow',
    basis: 'HT',
    terms: 30,
    plant: 'TET',
  },
  {
    name: 'Groupe Cap Spartel Promotion (fictif)',
    kind: 'company',
    zone: 'Tétouan centre',
    weight: 7,
    behaviour: 'good',
    poRequired: true,
    basis: 'HT',
    terms: 45,
    aliases: ['GCS Promotion'],
    plant: 'TET',
  },
  {
    name: 'Bennani TP (fictif)',
    kind: 'company',
    zone: "M'diq",
    weight: 5,
    behaviour: 'late',
    basis: 'HT',
    terms: 30,
    plant: 'TET',
  },
  {
    name: 'HABITAT MARTIL COOP (fictif)',
    kind: 'company',
    zone: 'Martil',
    weight: 4,
    behaviour: 'slow',
    basis: 'TTC',
    terms: 60,
    plant: 'TET',
  },
  {
    name: 'Entreprise Fnideq Bâtiment (fictif)',
    kind: 'company',
    zone: 'Fnideq',
    weight: 4,
    behaviour: 'good',
    basis: 'HT',
    terms: 30,
    plant: 'TET',
  },
  {
    name: 'el idrissi et fils (fictif)',
    kind: 'company',
    zone: 'Tétouan centre',
    weight: 5,
    behaviour: 'late',
    basis: 'HT',
    terms: 30,
    aliases: ['Idrissi & Fils'],
    plant: 'TET',
  },
  {
    name: 'Résidence Les Oliviers SA (fictif)',
    kind: 'company',
    zone: 'Tétouan centre',
    weight: 6,
    behaviour: 'good',
    poRequired: true,
    basis: 'HT',
    terms: 45,
    plant: 'TET',
  },
  {
    name: 'Client particulier P-017 (fictif)',
    kind: 'person',
    zone: 'Martil',
    weight: 1,
    behaviour: 'good',
    basis: 'TTC',
    terms: 0,
    plant: 'TET',
  },
  {
    name: 'Client particulier P-023 (fictif)',
    kind: 'person',
    zone: 'Tétouan centre',
    weight: 1,
    behaviour: 'slow',
    basis: 'TTC',
    terms: 0,
    plant: 'TET',
  },
  {
    name: 'Client particulier P-031 (fictif)',
    kind: 'person',
    zone: "M'diq",
    weight: 1,
    behaviour: 'good',
    basis: 'TTC',
    terms: 0,
    plant: 'TET',
  },
  {
    name: 'Atlas Préfabriqués Nord (fictif)',
    kind: 'company',
    zone: 'Tétouan centre',
    weight: 4,
    behaviour: 'slow',
    basis: 'HT',
    terms: 30,
    plant: 'TET',
  },
  {
    name: 'CHAOUEN BATIMENT ET TRAVAUX (fictif)',
    kind: 'company',
    zone: 'Oued Laou',
    weight: 8,
    behaviour: 'good',
    poRequired: true,
    basis: 'HT',
    terms: 30,
    aliases: ['CHAOUEN BTP'],
    plant: 'CHF',
  },
  {
    name: 'Société Jbel Dersa Terrassement (fictif)',
    kind: 'company',
    zone: 'Oued Laou',
    weight: 5,
    behaviour: 'slow',
    basis: 'HT',
    terms: 45,
    plant: 'CHF',
  },
  {
    name: 'rif habitat promotion (fictif)',
    kind: 'company',
    zone: 'Oued Laou',
    weight: 6,
    behaviour: 'late',
    basis: 'TTC',
    terms: 30,
    plant: 'CHF',
  },
  {
    name: 'Coopérative Ketama Équipement (fictif)',
    kind: 'company',
    zone: 'Oued Laou',
    weight: 3,
    behaviour: 'bad',
    basis: 'TTC',
    terms: 60,
    plant: 'CHF',
  },
  {
    name: 'Commune Rurale Bab Taza (fictif)',
    kind: 'company',
    zone: 'Oued Laou',
    weight: 3,
    behaviour: 'slow',
    poRequired: true,
    basis: 'HT',
    terms: 90,
    plant: 'CHF',
  },
  {
    name: 'ENTREPRISE AKCHOUR GENIE CIVIL (fictif)',
    kind: 'company',
    zone: 'Oued Laou',
    weight: 5,
    behaviour: 'good',
    basis: 'HT',
    terms: 30,
    plant: 'CHF',
  },
  {
    name: 'Client particulier P-044 (fictif)',
    kind: 'person',
    zone: 'Oued Laou',
    weight: 1,
    behaviour: 'good',
    basis: 'TTC',
    terms: 0,
    plant: 'CHF',
  },
  {
    name: 'Client particulier P-052 (fictif)',
    kind: 'person',
    zone: 'Oued Laou',
    weight: 1,
    behaviour: 'late',
    basis: 'TTC',
    terms: 0,
    plant: 'CHF',
  },
  {
    name: 'Travaux Ouezzane Services (fictif)',
    kind: 'company',
    zone: 'Oued Laou',
    weight: 4,
    behaviour: 'slow',
    basis: 'HT',
    terms: 30,
    plant: 'CHF',
  },
  {
    name: 'Bâtisseurs du Rif SARL (fictif)',
    kind: 'company',
    zone: 'Fnideq',
    weight: 5,
    behaviour: 'good',
    basis: 'HT',
    terms: 30,
    plant: 'TET',
  },
  {
    name: 'Immo Khmiss Construction (fictif)',
    kind: 'company',
    zone: 'Tétouan centre',
    weight: 4,
    behaviour: 'late',
    basis: 'HT',
    terms: 30,
    plant: 'TET',
  },
  {
    name: 'Menuiserie et Bâtiment Ghazaoua (fictif)',
    kind: 'company',
    zone: 'Tétouan centre',
    weight: 2,
    behaviour: 'good',
    basis: 'TTC',
    terms: 15,
    plant: 'TET',
  },
  {
    name: 'ASSOCIATION ECOLES DU NORD (fictif)',
    kind: 'company',
    zone: 'Tétouan centre',
    weight: 3,
    behaviour: 'slow',
    poRequired: true,
    basis: 'HT',
    terms: 60,
    plant: 'TET',
  },
];

export interface SupplierSpec {
  name: string;
  category: 'cement' | 'aggregates' | 'admixture' | 'transport' | 'fuel' | 'other';
  terms: number;
  lead: number;
}

/** The 5 suppliers the master-data seed already holds (by name) are not listed here; these 7 are created: 12 in all. */
export const EXTRA_SUPPLIERS: SupplierSpec[] = [
  { name: 'Ciments Atlas Rif (fictif)', category: 'cement', terms: 45, lead: 3 },
  { name: 'Sablière Oued Martil (fictif)', category: 'aggregates', terms: 30, lead: 2 },
  { name: 'Granulats Chefchaouen (fictif)', category: 'aggregates', terms: 30, lead: 2 },
  { name: 'Chimie Béton Nord (fictif)', category: 'admixture', terms: 30, lead: 5 },
  { name: 'Transports Rifains (fictif)', category: 'transport', terms: 30, lead: 1 },
  { name: 'Station Chefchaouen Carburants (fictif)', category: 'fuel', terms: 15, lead: 1 },
  { name: 'Pièces Mixer Nord (fictif)', category: 'other', terms: 30, lead: 4 },
];

/** Plant codes the training base creates (scripts/seed-training.ts). */
export const PLANT_CODES = { TET: 'TETOUAN', CHF: 'CHEFCHN' } as const;
